// A phone in Node: speaks the relay's HTTP API and the end-to-end protocol exactly like the web
// app, with a software passkey. Used by the end-to-end tests and for smoke-testing a deployment.
import { createRequire } from 'node:module';
import { decoder, encoder, fromB64u, toB64u } from '../../shared/bytes.js';
import { ephemeralKey, loginChallenge, openBox, pairChallenge, pairProof, pairingId, startResume } from '../../shared/channel.js';
import { OP, OUTER, controlFrame, dataFrame, handshakeFrame, outer, parseInner, parseOuter } from '../../shared/frames.js';

const require = createRequire(new URL('../../relay/package.json', import.meta.url));
const WebSocket = require('ws');

export async function waitFor(check, { timeout = 10_000, what = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export class FakePhone {
  constructor({ base, origin }) {
    this.base = base; // where to connect, e.g. http://127.0.0.1:3040
    this.origin = origin; // what the browser would send, e.g. http://localhost:3040
    this.cookie = null;
  }

  async post(path, body, { origin = this.origin } = {}) {
    const response = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: JSON.stringify(body),
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const line of setCookie) {
      const [pair] = line.split(';');
      if (/=.+/.test(pair)) this.cookie = pair;
    }
    return { status: response.status, json: await response.json().catch(() => null) };
  }

  async pair(pairingUrl, passkey, name = 'Test Phone') {
    const secret = fromB64u(new URL(pairingUrl).hash.slice(1));
    const pid = await pairingId(secret);
    const phone = await ephemeralKey();
    const start = await this.post('/api/pair/options', { pid, e: toB64u(phone.pub) });
    if (start.status !== 200) throw Object.assign(new Error(`pair options ${start.status}`), { reply: start });
    const { hid, e, n, options } = start.json;
    const challenge = await pairChallenge({ pid, phonePub: phone.pub, agentPub: fromB64u(e), agentNonce: fromB64u(n) });
    if (toB64u(challenge) !== options.challenge) throw new Error('relay altered the pairing challenge');
    const response = passkey.create(options);
    const proof = await pairProof(secret, fromB64u(response.response.clientDataJSON), fromB64u(response.response.attestationObject));
    const finish = await this.post('/api/pair/verify', { pid, hid, response, proof: toB64u(proof), name });
    if (finish.status !== 200) throw Object.assign(new Error(`pair verify ${finish.status}`), { reply: finish });
    const opened = await openBox({ privateKey: phone.privateKey, peerPub: fromB64u(e), salt: secret, context: challenge }, fromB64u(finish.json.sealed));
    return JSON.parse(decoder.decode(opened));
  }

  async login(passkey, { tamper } = {}) {
    const phone = await ephemeralKey();
    const start = await this.post('/api/login/options', { e: toB64u(phone.pub) });
    if (start.status !== 200) throw Object.assign(new Error(`login options ${start.status}`), { reply: start });
    const { lid, n, agent, options } = start.json;
    const challenge = await loginChallenge({
      relayNonce: fromB64u(n),
      phonePub: phone.pub,
      agent: agent && { hid: agent.hid, pub: fromB64u(agent.e), nonce: fromB64u(agent.n) },
    });
    if (toB64u(challenge) !== options.challenge) throw new Error('relay altered the login challenge');
    const response = passkey.get(options, tamper);
    const finish = await this.post('/api/login/verify', { lid, response });
    if (finish.status !== 200) throw Object.assign(new Error(`login verify ${finish.status}`), { reply: finish });
    if (!finish.json.sealed) return { ticket: null, agentError: finish.json.agentError };
    const opened = await openBox({ privateKey: phone.privateKey, peerPub: fromB64u(agent.e), context: challenge }, fromB64u(finish.json.sealed));
    return { ticket: JSON.parse(decoder.decode(opened)) };
  }

  connect(ticket, { origin = this.origin, cookie = this.cookie } = {}) {
    return new Connection(`${this.base.replace(/^http/, 'ws')}/ws`, ticket, { origin, cookie });
  }
}

export class Connection {
  constructor(url, ticket, { origin, cookie }) {
    this.ticket = ticket;
    this.status = [];
    this.rejects = [];
    this.controls = [];
    this.raw = [];
    this.screens = new Map(); // channel -> text received (snapshot resets it)
    this.received = new Map(); // channel -> bytes received, for acks
    this.channel = null;
    this.closed = null;
    this.inbox = Promise.resolve();
    this.ws = new WebSocket(url, { headers: { origin, ...(cookie ? { cookie } : {}) } });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error(`upgrade refused: ${res.statusCode}`), { status: res.statusCode })));
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data, isBinary) => {
      this.inbox = this.inbox.then(() => this.handle(data, isBinary)).catch((error) => {
        this.error = error;
      });
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
  }

  async handle(data, isBinary) {
    if (!isBinary) {
      const message = JSON.parse(data);
      this.status.push(message);
      if (message.type === 'agent' && message.online) await this.hello();
      if (message.type === 'agent' && !message.online) this.channel = null;
      return;
    }
    const bytes = new Uint8Array(data);
    this.raw.push(bytes);
    const frame = parseOuter(bytes);
    if (frame.type === OUTER.HANDSHAKE) {
      if (frame.message.t === 'welcome') this.channel = await this.pending.finish(frame.message);
      else this.rejects.push(frame.message);
      return;
    }
    await this.channel.receive(frame.payload, (plain) => {
      const inner = parseInner(plain);
      if (inner.op === OP.CONTROL) {
        this.controls.push(inner.message);
        return;
      }
      const previous = inner.op === OP.SNAPSHOT ? '' : (this.screens.get(inner.channel) ?? '');
      this.screens.set(inner.channel, previous + decoder.decode(inner.data));
      const count = (this.received.get(inner.channel) ?? 0) + inner.data.length;
      this.received.set(inner.channel, count);
      this.send({ t: 'ack', ch: inner.channel, n: count });
    });
  }

  async hello() {
    this.channel = null;
    this.pending = await startResume({ tid: this.ticket.tid, key: fromB64u(this.ticket.k) });
    this.ws.send(handshakeFrame(this.pending.hello));
  }

  sealed(plain) {
    return this.channel.send(plain, (ciphertext) => this.ws.send(outer(OUTER.SEALED, ciphertext)));
  }

  send(message) {
    return this.sealed(controlFrame(message));
  }

  input(ch, text) {
    return this.sealed(dataFrame(OP.INPUT, ch, encoder.encode(text)));
  }

  ready() {
    return waitFor(() => this.controls.find((message) => message.t === 'ready'), { what: 'ready' });
  }

  reply(predicate, what) {
    return waitFor(() => this.controls.find(predicate), { what });
  }

  close() {
    this.ws.close();
  }
}
