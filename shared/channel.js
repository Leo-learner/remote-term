// End-to-end channel between the phone and the Mac. The relay carries every byte but holds no key.
//
//   pairing   phone scans a QR code from the Mac (secret S), creates a passkey; the Mac checks an
//             HMAC with S and answers with a sealed ticket
//   login     one passkey assertion over a challenge that binds the relay nonce and both sides'
//             ephemeral ECDH keys; relay and Mac verify it independently; the Mac answers with a
//             sealed ticket
//   resume    every WebSocket connection: ticket-keyed HMAC hello, fresh ECDH, HKDF → two AES-GCM
//             keys; the Mac proves it derived the same keys before anything else is sent
//
// See docs/protocol.md for the reasoning behind each step.
import { bytes, concat, fromB64u, randomBytes, toB64u } from './bytes.js';

const subtle = globalThis.crypto.subtle;
const P256 = { name: 'ECDH', namedCurve: 'P-256' };
const ZERO_SALT = new Uint8Array(32);

export const SIZES = { tid: 16, hid: 16, pid: 16, nonce: 32, pub: 65, key: 32, mac: 32 };

const LABEL = {
  helloMac: 'rt1 hello mac',
  hello: 'rt1 hello',
  psk: 'rt1 psk',
  keys: 'rt1 keys',
  welcome: 'rt1 welcome',
  seal: 'rt1 seal',
  pairId: 'rt1 pair id',
  pair: 'rt1 pair',
  proof: 'rt1 pair proof',
  login: 'rt1 login',
};

const DIRECTION = { phoneToAgent: 1, agentToPhone: 2 };

export class ChannelError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

// ---- primitives -------------------------------------------------------------------------

export async function sha256(...parts) {
  return new Uint8Array(await subtle.digest('SHA-256', concat(...parts)));
}

export async function ephemeralKey() {
  const pair = await subtle.generateKey(P256, false, ['deriveBits']);
  return { privateKey: pair.privateKey, pub: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

async function ecdh(privateKey, peerPub) {
  let peer;
  try {
    peer = await subtle.importKey('raw', bytes(peerPub), P256, false, []);
  } catch {
    throw new ChannelError('bad-public-key');
  }
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
}

// Ticket keys live as non-extractable HKDF keys: page scripts can use them, never read them.
export function importTicketKey(raw) {
  return subtle.importKey('raw', bytes(raw), 'HKDF', false, ['deriveBits']);
}

async function hkdf(ikm, salt, info, bits) {
  const key = ikm instanceof CryptoKey ? ikm : await subtle.importKey('raw', bytes(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bytes(salt), info: bytes(info) }, key, bits));
}

function hmacKey(raw, usage) {
  return subtle.importKey('raw', bytes(raw), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

async function hmac(raw, ...parts) {
  return new Uint8Array(await subtle.sign('HMAC', await hmacKey(raw, 'sign'), concat(...parts)));
}

// subtle.verify compares in constant time.
async function hmacVerify(raw, mac, ...parts) {
  return subtle.verify('HMAC', await hmacKey(raw, 'verify'), bytes(mac), concat(...parts));
}

function aesKey(raw, usage) {
  return subtle.importKey('raw', bytes(raw), 'AES-GCM', false, usage);
}

function decode(value, size, field) {
  try {
    return fromB64u(value, size);
  } catch {
    throw new ChannelError('bad-message', `bad ${field}`);
  }
}

// ---- resume handshake (every connection) ------------------------------------------------

async function deriveChannelKeys(ticketKey, shared, transcript) {
  const psk = await hkdf(ticketKey, ZERO_SALT, concat(LABEL.psk, transcript), 256);
  const material = await hkdf(shared, psk, concat(LABEL.keys, transcript), 768);
  return {
    phoneToAgent: material.slice(0, 32),
    agentToPhone: material.slice(32, 64),
    confirm: material.slice(64, 96),
  };
}

// Phone: build the hello, then call finish(welcome) to get the channel.
// `ticket` is { tid: base64url, key: CryptoKey (HKDF) | raw bytes }.
export async function startResume(ticket) {
  const tid = decode(ticket.tid, SIZES.tid, 'tid');
  const key = ticket.key instanceof CryptoKey ? ticket.key : await importTicketKey(ticket.key);
  const eph = await ephemeralKey();
  const nonce = randomBytes(SIZES.nonce);
  const macKey = await hkdf(key, ZERO_SALT, LABEL.helloMac, 256);
  const mac = await hmac(macKey, LABEL.hello, tid, eph.pub, nonce);
  return {
    hello: { t: 'hello', v: 1, tid: ticket.tid, e: toB64u(eph.pub), n: toB64u(nonce), m: toB64u(mac) },
    async finish(welcome) {
      if (welcome?.t !== 'welcome') throw new ChannelError('bad-message', 'expected welcome');
      const agentPub = decode(welcome.e, SIZES.pub, 'e');
      const agentNonce = decode(welcome.n, SIZES.nonce, 'n');
      const confirm = decode(welcome.m, SIZES.mac, 'm');
      const transcript = await sha256(LABEL.hello, tid, eph.pub, nonce, agentPub, agentNonce);
      const keys = await deriveChannelKeys(key, await ecdh(eph.privateKey, agentPub), transcript);
      if (!(await hmacVerify(keys.confirm, confirm, LABEL.welcome, transcript))) {
        throw new ChannelError('bad-agent-proof');
      }
      return Channel.create({
        sendKey: keys.phoneToAgent, sendDir: DIRECTION.phoneToAgent,
        recvKey: keys.agentToPhone, recvDir: DIRECTION.agentToPhone,
      });
    },
  };
}

// Mac: check the hello against a stored ticket and answer. `lookupTicket(tid)` returns
// { key: raw bytes | CryptoKey } for a ticket that may be used now, or null.
export async function answerResume(hello, lookupTicket) {
  if (hello?.t !== 'hello' || hello.v !== 1) throw new ChannelError('bad-message', 'expected hello v1');
  const tid = decode(hello.tid, SIZES.tid, 'tid');
  const phonePub = decode(hello.e, SIZES.pub, 'e');
  const phoneNonce = decode(hello.n, SIZES.nonce, 'n');
  const mac = decode(hello.m, SIZES.mac, 'm');
  const ticket = await lookupTicket(hello.tid);
  if (!ticket) throw new ChannelError('unknown-ticket');
  const key = ticket.key instanceof CryptoKey ? ticket.key : await importTicketKey(ticket.key);
  const macKey = await hkdf(key, ZERO_SALT, LABEL.helloMac, 256);
  if (!(await hmacVerify(macKey, mac, LABEL.hello, tid, phonePub, phoneNonce))) {
    throw new ChannelError('bad-ticket-proof');
  }
  const eph = await ephemeralKey();
  const nonce = randomBytes(SIZES.nonce);
  const transcript = await sha256(LABEL.hello, tid, phonePub, phoneNonce, eph.pub, nonce);
  const keys = await deriveChannelKeys(key, await ecdh(eph.privateKey, phonePub), transcript);
  const confirm = await hmac(keys.confirm, LABEL.welcome, transcript);
  return {
    welcome: { t: 'welcome', e: toB64u(eph.pub), n: toB64u(nonce), m: toB64u(confirm) },
    channel: await Channel.create({
      sendKey: keys.agentToPhone, sendDir: DIRECTION.agentToPhone,
      recvKey: keys.phoneToAgent, recvDir: DIRECTION.phoneToAgent,
    }),
  };
}

// ---- encrypted frames -------------------------------------------------------------------

// AES-GCM with an implicit counter: the IV is (direction, sequence number) and never travels.
// WebSocket delivers in order without loss, so any dropped, replayed, reordered or forged frame
// makes this or a later frame fail to decrypt, and the caller closes the connection.
export class Channel {
  static async create({ sendKey, sendDir, recvKey, recvDir }) {
    return new Channel(await aesKey(sendKey, ['encrypt']), sendDir, await aesKey(recvKey, ['decrypt']), recvDir);
  }

  constructor(sendKey, sendDir, recvKey, recvDir) {
    this.sendKey = sendKey;
    this.sendDir = sendDir;
    this.recvKey = recvKey;
    this.recvDir = recvDir;
    this.sendSeq = 0n;
    this.recvSeq = 0n;
    this.sendTail = Promise.resolve();
    this.recvTail = Promise.resolve();
  }

  static iv(direction, seq) {
    const iv = new Uint8Array(12);
    const view = new DataView(iv.buffer);
    view.setUint32(0, direction);
    view.setBigUint64(4, seq);
    return iv;
  }

  // Encrypts now, delivers in call order. Returns the delivery promise.
  send(plaintext, deliver) {
    const iv = Channel.iv(this.sendDir, this.sendSeq);
    this.sendSeq += 1n;
    const sealed = subtle.encrypt({ name: 'AES-GCM', iv }, this.sendKey, bytes(plaintext));
    this.sendTail = this.sendTail.then(() => sealed).then((ciphertext) => deliver(new Uint8Array(ciphertext)));
    return this.sendTail;
  }

  // Decrypts in arrival order and hands each plaintext to `handle` in that order.
  // Rejects with ChannelError('bad-frame') when a frame does not authenticate.
  receive(ciphertext, handle) {
    const iv = Channel.iv(this.recvDir, this.recvSeq);
    this.recvSeq += 1n;
    const opened = subtle.decrypt({ name: 'AES-GCM', iv }, this.recvKey, bytes(ciphertext))
      .catch(() => { throw new ChannelError('bad-frame'); });
    this.recvTail = this.recvTail.then(() => opened).then((plaintext) => handle(new Uint8Array(plaintext)));
    return this.recvTail;
  }
}

// ---- ceremonies (pairing, login) --------------------------------------------------------

// The pairing secret stays in the URL fragment, which browsers never send to the server.
// The relay only ever learns this id.
export async function pairingId(secret) {
  return toB64u((await sha256(LABEL.pairId, bytes(secret))).subarray(0, SIZES.pid));
}

export function pairChallenge({ pid, phonePub, agentPub, agentNonce }) {
  return sha256(LABEL.pair, decode(pid, SIZES.pid, 'pid'), bytes(phonePub), bytes(agentPub), bytes(agentNonce));
}

// `agent` is null when the Mac was offline: the relay then logs in alone and no ticket follows.
export function loginChallenge({ relayNonce, phonePub, agent }) {
  const agentPart = agent
    ? concat([1], decode(agent.hid, SIZES.hid, 'hid'), bytes(agent.pub), bytes(agent.nonce))
    : new Uint8Array([0]);
  return sha256(LABEL.login, bytes(relayNonce), bytes(phonePub), agentPart);
}

// Proves the new passkey came from someone who saw the QR code on the Mac: the HMAC covers the
// signed client data (which holds the challenge) and the attestation (which holds the public key).
export async function pairProof(secret, clientDataJSON, attestationObject) {
  const key = await hkdf(bytes(secret), ZERO_SALT, LABEL.proof, 256);
  return hmac(key, LABEL.proof, await sha256(bytes(clientDataJSON)), await sha256(bytes(attestationObject)));
}

export async function verifyPairProof(secret, proof, clientDataJSON, attestationObject) {
  const key = await hkdf(bytes(secret), ZERO_SALT, LABEL.proof, 256);
  return hmacVerify(key, bytes(proof), LABEL.proof, await sha256(bytes(clientDataJSON)), await sha256(bytes(attestationObject)));
}

// A one-shot box from the Mac to the phone (the ticket). The key is fresh per ceremony because
// the context is that ceremony's challenge, so a fixed IV is safe. `salt` is the pairing secret
// during pairing and zeros during login.
async function boxKey({ privateKey, peerPub, salt = ZERO_SALT, context }, usage) {
  const shared = await ecdh(privateKey, peerPub);
  return aesKey(await hkdf(shared, salt, concat(LABEL.seal, bytes(context)), 256), usage);
}

export async function sealBox(params, plaintext) {
  const key = await boxKey(params, ['encrypt']);
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, bytes(plaintext)));
}

export async function openBox(params, sealed) {
  const key = await boxKey(params, ['decrypt']);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, bytes(sealed)));
  } catch {
    throw new ChannelError('bad-box');
  }
}
