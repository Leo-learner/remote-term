// remote-term relay: the public entry point. It serves the web app behind a passkey login and
// joins each phone's WebSocket to the Mac agent's outbound WebSocket. Terminal traffic is
// encrypted end to end between phone and Mac, so this process forwards bytes it cannot read, and
// logging in here is not enough to open a shell: the Mac checks the passkey again itself.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import express from 'express';
import { WebSocketServer } from 'ws';
import { fromB64u, toB64u } from '../shared/bytes.js';
import { SIZES, loginChallenge } from '../shared/channel.js';
import { LIMITS, linkFrame, parseLinkFrame } from '../shared/frames.js';
import { RateLimit, SessionStore, Throttle } from './auth.js';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const SHARED_ROOT = fileURLToPath(new URL('../shared/', import.meta.url));

const LOGIN_TTL_MS = 2 * 60_000;
const MAX_PENDING_LOGINS = 64;
const MAX_PHONES = 16;
const MAX_PHONES_PER_SESSION = 4;
const PHONE_BUFFER_LIMIT = 4 * 1024 * 1024; // a phone this far behind is dropped; it reconnects and resyncs
const AGENT_BUFFER_LIMIT = 16 * 1024 * 1024;
const PHONE_FRAME_BURST = 300;
const PHONE_FRAMES_PER_MS = 0.2; // 200 frames a second: keystrokes, paste chunks, acks
const COOKIE_MAX_AGE_S = 90 * 24 * 3600;
// Link drops that mean "ask for Face ID", sent to the phone as WebSocket close code 4401.
const LOCK_REASONS = new Set(['unknown-ticket', 'bad-ticket-proof', 'ticket-expired', 'locked', 'device-removed']);

export function configFromEnv(env = process.env) {
  if (!/^[0-9a-f]{64}$/i.test(env.AGENT_TOKEN_SHA256 ?? '')) {
    throw new Error('AGENT_TOKEN_SHA256 must be the 64 hex characters printed by agent/setup.js');
  }
  const port = Number(env.PORT || 3040);
  const publicOrigin = (env.PUBLIC_ORIGIN || `http://localhost:${port}`).replace(/\/$/, '');
  const { hostname, protocol } = new URL(publicOrigin);
  if (protocol !== 'https:' && hostname !== 'localhost') throw new Error('PUBLIC_ORIGIN must be https:// (http:// only for localhost)');
  return {
    port,
    host: env.HOST || '127.0.0.1',
    publicOrigin,
    rpId: hostname,
    agentTokenSha256: env.AGENT_TOKEN_SHA256.toLowerCase(),
    dataDir: env.RELAY_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)),
  };
}

const csp = (parts) => parts.join('; ');

export async function createRelay(config) {
  const secure = config.publicOrigin.startsWith('https://');
  const cookieName = secure ? '__Host-rt' : 'rt';
  const wsOrigin = config.publicOrigin.replace(/^http/, 'ws');
  const agentDigest = Buffer.from(config.agentTokenSha256, 'hex');
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });

  const sessions = await new SessionStore({ file: join(config.dataDir, 'sessions.json') }).load();
  const loginThrottle = new Throttle();
  const pairThrottle = new Throttle({ globalLimit: 20 });
  const startLimit = new RateLimit({ burst: 10, perMinute: 20 });

  // ---- audit trail ---------------------------------------------------------------------------
  const auditFile = join(config.dataDir, 'audit.jsonl');
  let auditTail = Promise.resolve();
  function audit(entry) {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    auditTail = auditTail.then(() => appendFile(auditFile, line, { mode: 0o600 })).catch(() => {});
  }

  // ---- passkeys the Mac has accepted (the Mac is the source of truth) ---------------------------
  const credentialsFile = join(config.dataDir, 'credentials.json');
  let credentials = new Map();
  let pairing = null; // { pid, expiresAt } while the Mac shows a pairing QR code
  try {
    for (const item of JSON.parse(await readFile(credentialsFile, 'utf8')).credentials ?? []) credentials.set(item.id, item);
  } catch {
    // none yet
  }

  let credentialsTail = Promise.resolve();
  function updateCredentials(list, nextPairing) {
    if (Array.isArray(list)) {
      const next = new Map();
      for (const item of list.slice(0, 50)) {
        if (typeof item?.id !== 'string' || typeof item.publicKey !== 'string') continue;
        next.set(item.id, {
          id: item.id,
          publicKey: item.publicKey,
          counter: Number.isSafeInteger(item.counter) ? item.counter : 0,
          transports: Array.isArray(item.transports) ? item.transports.filter((t) => typeof t === 'string').slice(0, 8) : [],
        });
      }
      credentials = next;
      const snapshot = JSON.stringify({ credentials: [...next.values()] });
      credentialsTail = credentialsTail.then(async () => {
        await writeFile(`${credentialsFile}.tmp`, snapshot, { mode: 0o600 });
        await rename(`${credentialsFile}.tmp`, credentialsFile);
      }).catch(() => {});
    }
    pairing = typeof nextPairing?.pid === 'string' && Number.isFinite(nextPairing.expiresAt)
      ? { pid: nextPairing.pid, expiresAt: nextPairing.expiresAt }
      : null;
  }

  // ---- the agent link and requests to it -------------------------------------------------------
  let agent = null; // { ws, alive, version }
  const rpcs = new Map();

  function rpc(method, params, timeoutMs = 10_000) {
    return new Promise((resolve) => {
      if (!agent) return resolve({ ok: false, error: 'agent-offline' });
      const rid = randomBytes(12).toString('base64url');
      const timer = setTimeout(() => {
        rpcs.delete(rid);
        resolve({ ok: false, error: 'agent-timeout' });
      }, timeoutMs);
      rpcs.set(rid, { resolve, timer });
      agent.ws.send(JSON.stringify({ type: 'rpc', rid, method, params }));
    });
  }

  function settle(message) {
    const pending = rpcs.get(message.rid);
    if (!pending) return;
    rpcs.delete(message.rid);
    clearTimeout(pending.timer);
    pending.resolve(message.ok === true ? { ok: true, result: message.result } : { ok: false, error: String(message.error ?? 'internal') });
  }

  // ---- phones ------------------------------------------------------------------------------------
  const phones = new Map(); // link id -> { id, ws, sessionKey, alive, tokens, at }
  let lastLinkId = 0;

  function nextLinkId() {
    do lastLinkId = (lastLinkId % 0xfffffffe) + 1; while (phones.has(lastLinkId));
    return lastLinkId;
  }

  function sendStatus(phone) {
    if (phone.ws.readyState === phone.ws.OPEN) phone.ws.send(JSON.stringify({ type: 'agent', online: Boolean(agent) }));
  }

  // ---- HTTP --------------------------------------------------------------------------------------
  const PUBLIC_CSP = csp([
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
    "worker-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
  ]);
  // xterm.js writes a few <style> rules at runtime, hence 'unsafe-inline' for styles (not scripts).
  const APP_CSP = csp([
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
    `connect-src 'self' ${wsOrigin}`, "worker-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'self'",
    "frame-ancestors 'none'", "object-src 'none'",
  ]);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': req.path.startsWith('/app') ? APP_CSP : PUBLIC_CSP,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
    });
    next();
  });

  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const cookieValue = (headers) => {
    for (const part of (headers.cookie ?? '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === cookieName) return rest.join('=');
    }
    return null;
  };
  const sessionOf = (req) => sessions.touch(cookieValue(req.headers));
  const setCookie = (res, id, maxAge = COOKIE_MAX_AGE_S) => res.set(
    'Set-Cookie',
    `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
  );
  const pageSession = (req, res, next) => (sessionOf(req) ? next() : res.redirect(302, '/'));
  const apiSession = (req, res, next) => {
    const found = sessionOf(req);
    if (!found) return res.status(401).json({ ok: false, error: 'unauthenticated' });
    req.sessionKey = found.key;
    next();
  };
  // Cookies are SameSite=Strict already; requiring our own Origin is the second lock.
  const sameOrigin = (req, res, next) => (req.get('origin') === config.publicOrigin
    ? next()
    : res.status(403).json({ ok: false, error: 'bad-origin' }));
  const gate = (throttle) => (req, res, next) => {
    const verdict = throttle.check(req.ip);
    if (verdict.allowed) return next();
    const retryAfterSec = Math.ceil(verdict.retryAfterMs / 1000);
    res.set('Retry-After', String(retryAfterSec)).status(429).json({ ok: false, error: 'too-many-attempts', retryAfterSec });
  };
  const limited = (req, res, next) => (startLimit.take(req.ip) ? next() : res.status(429).json({ ok: false, error: 'slow-down' }));
  const decode = (value, size) => {
    try {
      return fromB64u(value, size);
    } catch {
      return null;
    }
  };

  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  app.get('/', noStore, (req, res) => (sessionOf(req)
    ? res.redirect(302, '/app/')
    : res.sendFile(join(WEB_ROOT, 'public', 'login.html'))));
  app.get('/pair', noStore, (req, res) => res.sendFile(join(WEB_ROOT, 'public', 'pair.html')));
  app.use('/shared', (req, res, next) => (/^\/[a-z]+\.js$/.test(req.path) ? next() : res.status(404).end()),
    express.static(SHARED_ROOT, { index: false, maxAge: '10m' }));
  app.use(express.static(join(WEB_ROOT, 'public'), {
    index: false,
    maxAge: '10m',
    setHeaders: (res, path) => {
      if (path.endsWith('sw.js')) res.set('Cache-Control', 'no-cache');
    },
  }));

  // -- login: one passkey assertion; the relay checks it for its cookie, the Mac for a ticket --
  const pendingLogins = new Map(); // lid -> { relayNonce, e, agent, challenge, at }

  app.post('/api/login/options', noStore, sameOrigin, gate(loginThrottle), limited, express.json({ limit: '4kb' }), async (req, res) => {
    if (credentials.size === 0) return res.status(409).json({ ok: false, error: 'not-paired' });
    const phonePub = decode(req.body?.e, SIZES.pub);
    if (!phonePub) return res.status(400).json({ ok: false, error: 'bad-request' });
    const at = Date.now();
    for (const [lid, item] of pendingLogins) if (at - item.at > LOGIN_TTL_MS) pendingLogins.delete(lid);
    if (pendingLogins.size >= MAX_PENDING_LOGINS) return res.status(503).json({ ok: false, error: 'busy' });

    let agentPart = null;
    const reply = await rpc('login-start', { e: req.body.e }, 5000);
    if (reply.ok && decode(reply.result?.hid, SIZES.hid) && decode(reply.result?.e, SIZES.pub) && decode(reply.result?.n, SIZES.nonce)) {
      agentPart = { hid: reply.result.hid, e: reply.result.e, n: reply.result.n };
    }
    const relayNonce = randomBytes(SIZES.nonce);
    const challenge = await loginChallenge({
      relayNonce,
      phonePub,
      agent: agentPart && { hid: agentPart.hid, pub: fromB64u(agentPart.e), nonce: fromB64u(agentPart.n) },
    });
    const lid = randomBytes(16).toString('base64url');
    pendingLogins.set(lid, { relayNonce, e: req.body.e, agent: agentPart, challenge, at });
    res.json({
      ok: true,
      lid,
      n: toB64u(relayNonce),
      agent: agentPart,
      options: {
        challenge: toB64u(challenge),
        rpId: config.rpId,
        timeout: 60_000,
        userVerification: 'required',
        allowCredentials: [...credentials.values()].map(({ id, transports }) => ({ id, type: 'public-key', transports })),
      },
    });
  });

  app.post('/api/login/verify', noStore, sameOrigin, gate(loginThrottle), express.json({ limit: '16kb' }), async (req, res) => {
    const lid = req.body?.lid;
    const pending = typeof lid === 'string' ? pendingLogins.get(lid) : undefined;
    if (!pending || Date.now() - pending.at > LOGIN_TTL_MS) return res.status(400).json({ ok: false, error: 'expired' });
    pendingLogins.delete(lid); // one attempt per challenge

    const response = req.body?.response;
    const credential = credentials.get(response?.id);
    let verified = false;
    if (credential) {
      try {
        const result = await verifyAuthenticationResponse({
          response,
          expectedChallenge: toB64u(pending.challenge),
          expectedOrigin: config.publicOrigin,
          expectedRPID: config.rpId,
          credential: { id: credential.id, publicKey: fromB64u(credential.publicKey), counter: credential.counter, transports: credential.transports },
          requireUserVerification: true,
        });
        verified = result.verified;
      } catch {
        verified = false;
      }
    }
    if (!verified) {
      loginThrottle.fail(req.ip);
      audit({ event: 'login-failed', ip: req.ip });
      return res.status(401).json({ ok: false, error: 'invalid-credentials' });
    }
    loginThrottle.succeed(req.ip);
    setCookie(res, sessions.create({ ip: req.ip, ua: req.get('user-agent') }));
    audit({ event: 'login', ip: req.ip, credential: credential.id.slice(0, 8) });

    let sealed = null;
    let agentError = null;
    if (!pending.agent) agentError = 'agent-offline';
    else {
      const reply = await rpc('login-finish', { hid: pending.agent.hid, relayNonce: toB64u(pending.relayNonce), e: pending.e, response }, 15_000);
      if (reply.ok && typeof reply.result?.sealed === 'string') sealed = reply.result.sealed;
      else agentError = reply.error ?? 'internal';
    }
    res.json({ ok: true, sealed, agentError });
  });

  // -- pairing: only while the Mac shows a QR code; the Mac checks the proof and the passkey --
  app.post('/api/pair/options', noStore, sameOrigin, gate(pairThrottle), limited, express.json({ limit: '4kb' }), async (req, res) => {
    const { pid, e } = req.body ?? {};
    if (!pairing || pairing.pid !== pid || pairing.expiresAt <= Date.now()) return res.status(410).json({ ok: false, error: 'pairing-closed' });
    if (!decode(e, SIZES.pub)) return res.status(400).json({ ok: false, error: 'bad-request' });
    const reply = await rpc('pair-start', { pid, e }, 10_000);
    if (!reply.ok) return res.status(reply.error === 'agent-offline' ? 503 : 400).json(reply);
    res.json({ ok: true, ...reply.result });
  });

  app.post('/api/pair/verify', noStore, sameOrigin, gate(pairThrottle), express.json({ limit: '32kb' }), async (req, res) => {
    const { pid, hid, response, proof, name } = req.body ?? {};
    if (!pairing || pairing.pid !== pid) return res.status(410).json({ ok: false, error: 'pairing-closed' });
    const reply = await rpc('pair-finish', { pid, hid, response, proof, name: String(name ?? '').slice(0, 60) }, 20_000);
    if (!reply.ok || typeof reply.result?.sealed !== 'string') {
      if (reply.error !== 'agent-offline' && reply.error !== 'agent-timeout') pairThrottle.fail(req.ip);
      audit({ event: 'pair-failed', ip: req.ip, error: reply.error });
      return res.status(reply.error === 'agent-offline' ? 503 : 400).json({ ok: false, error: reply.error ?? 'internal' });
    }
    setCookie(res, sessions.create({ ip: req.ip, ua: req.get('user-agent') }));
    audit({ event: 'paired', ip: req.ip });
    res.json({ ok: true, sealed: reply.result.sealed });
  });

  app.post('/api/logout', noStore, sameOrigin, (req, res) => {
    const id = cookieValue(req.headers);
    if (id) {
      const key = sessions.destroy(id);
      for (const phone of phones.values()) if (phone.sessionKey === key) phone.ws.close(4401, 'logged-out');
    }
    setCookie(res, '', 0);
    res.json({ ok: true });
  });

  app.get('/api/status', noStore, apiSession, (req, res) => {
    res.json({ ok: true, online: Boolean(agent), version: agent?.version ?? null, paired: credentials.size > 0 });
  });

  // The app itself is only ever sent to a logged-in browser.
  app.use('/app', pageSession, (req, res, next) => {
    res.set('Cache-Control', 'no-cache');
    next();
  }, express.static(join(WEB_ROOT, 'app'), { index: 'index.html' }));

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = error.status ?? error.statusCode ?? 500;
    res.status(status).json({ ok: false, error: status === 400 ? 'bad-request' : status === 413 ? 'too-large' : 'internal' });
  });

  // ---- WebSockets ---------------------------------------------------------------------------------
  const server = createServer(app);
  const phoneServer = new WebSocketServer({ noServer: true, maxPayload: LIMITS.phoneFrame, perMessageDeflate: false });
  const agentServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    const reject = (status) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let pathname;
    try {
      pathname = new URL(req.url, 'http://relay').pathname;
    } catch {
      return reject('400 Bad Request');
    }
    if (pathname === '/agent') {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
      const digest = createHash('sha256').update(token ?? '').digest();
      if (!token || !timingSafeEqual(digest, agentDigest)) {
        audit({ event: 'agent-rejected' });
        return reject('401 Unauthorized');
      }
      return agentServer.handleUpgrade(req, socket, head, (ws) => agentConnected(ws));
    }
    if (pathname === '/ws') {
      const found = sessions.touch(cookieValue(req.headers));
      if (!found) return reject('401 Unauthorized');
      if (req.headers.origin !== config.publicOrigin) return reject('403 Forbidden');
      if (phones.size >= MAX_PHONES) return reject('503 Service Unavailable');
      // A phone that reconnects before its old socket timed out must not lock itself out.
      const mine = [...phones.values()].filter((phone) => phone.sessionKey === found.key);
      if (mine.length >= MAX_PHONES_PER_SESSION) mine[0].ws.close(4429, 'replaced');
      return phoneServer.handleUpgrade(req, socket, head, (ws) => phoneConnected(ws, found.key));
    }
    reject('404 Not Found');
  });

  function phoneConnected(ws, sessionKey) {
    const phone = { id: nextLinkId(), ws, sessionKey, alive: true, tokens: PHONE_FRAME_BURST, at: Date.now() };
    phones.set(phone.id, phone);
    ws._socket?.setNoDelay?.(true);
    sendStatus(phone);
    agent?.ws.send(JSON.stringify({ type: 'link-open', link: phone.id }));

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return; // phones only ever send end-to-end frames
      const at = Date.now();
      phone.tokens = Math.min(PHONE_FRAME_BURST, phone.tokens + (at - phone.at) * PHONE_FRAMES_PER_MS);
      phone.at = at;
      if (phone.tokens < 1) return ws.close(4408, 'too-fast');
      phone.tokens -= 1;
      if (!agent) return;
      if (agent.ws.bufferedAmount > AGENT_BUFFER_LIMIT) return ws.close(4503, 'busy');
      agent.ws.send(linkFrame(phone.id, data), { binary: true });
    });
    ws.on('pong', () => {
      phone.alive = true;
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (phones.get(phone.id) !== phone) return;
      phones.delete(phone.id);
      agent?.ws.send(JSON.stringify({ type: 'link-close', link: phone.id }));
    });
  }

  function agentConnected(ws) {
    if (agent) agent.ws.close(4000, 'replaced by a newer connection');
    const link = { ws, alive: true, version: '' };
    agent = link;
    ws._socket?.setNoDelay?.(true);
    audit({ event: 'agent-connected' });
    for (const phone of phones.values()) {
      ws.send(JSON.stringify({ type: 'link-open', link: phone.id }));
      sendStatus(phone);
    }

    ws.on('message', (data, isBinary) => {
      if (agent !== link) return;
      if (isBinary) {
        const frame = parseLinkFrame(data);
        const phone = frame && phones.get(frame.linkId);
        if (!phone || phone.ws.readyState !== phone.ws.OPEN) return;
        if (phone.ws.bufferedAmount > PHONE_BUFFER_LIMIT) return phone.ws.close(4503, 'slow');
        phone.ws.send(frame.payload, { binary: true });
        return;
      }
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.type === 'hello') {
        link.version = String(message.version ?? '').slice(0, 20);
        updateCredentials(message.credentials, message.pairing);
      } else if (message.type === 'credentials') {
        updateCredentials(message.list, message.pairing);
      } else if (message.type === 'rpc-result') {
        settle(message);
      } else if (message.type === 'drop') {
        const phone = phones.get(message.link);
        const reason = String(message.reason ?? '').replace(/[^a-z-]/g, '').slice(0, 60);
        phone?.ws.close(LOCK_REASONS.has(reason) ? 4401 : 4400, reason);
      }
    });
    ws.on('pong', () => {
      link.alive = true;
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (agent !== link) return;
      agent = null;
      for (const pending of rpcs.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, error: 'agent-offline' });
      }
      rpcs.clear();
      for (const phone of phones.values()) sendStatus(phone);
      audit({ event: 'agent-disconnected' });
    });
  }

  // Dead sockets (a phone that walked out of coverage) are only noticed by a missing pong.
  const heartbeat = setInterval(() => {
    for (const peer of [...phones.values(), ...(agent ? [agent] : [])]) {
      if (!peer.alive) {
        peer.ws.terminate();
        continue;
      }
      peer.alive = false;
      peer.ws.ping();
    }
    sessions.sweep();
  }, 25_000);
  heartbeat.unref();

  return {
    server,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    async close() {
      clearInterval(heartbeat);
      for (const client of [...phoneServer.clients, ...agentServer.clients]) client.terminate();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      await Promise.allSettled([auditTail, credentialsTail, sessions.tail]);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configFromEnv();
  const relay = await createRelay(config);
  const port = await relay.listen();
  console.log(`relay listening on ${config.host}:${port} (public origin ${config.publicOrigin})`);
  const stop = () => relay.close().finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
