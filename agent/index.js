// remote-term agent: holds this Mac's terminal sessions and serves them to paired phones through
// the relay. stdout carries one JSON object per line for the menu bar launcher.
//   node agent/index.js            run
//   node agent/index.js --pair     run and print a pairing QR code (before the launcher exists)
import { hostname, userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { loadConfig, paths } from './config.js';
import { Link } from './link.js';
import { Notifier, sessionLabel } from './notify.js';
import { PasskeyAuthority } from './passkeys.js';
import { startRelayClient } from './relay-client.js';
import { SessionManager } from './sessions.js';
import { TicketStore } from './tickets.js';

const VERSION = '0.1.0';
const RPC_METHODS = ['pair-start', 'pair-finish', 'login-start', 'login-finish'];

const { values: flags } = parseArgs({ options: { pair: { type: 'boolean', default: false } } });
const report = (event, details = {}) => process.stdout.write(`${JSON.stringify({ event, ...details, ts: Date.now() })}\n`);

const config = await loadConfig();
const links = new Map(); // relay link id -> Link
let client = null;

const tickets = await new TicketStore({ file: paths.tickets }).load();
const authority = await new PasskeyAuthority({
  file: paths.credentials,
  rpId: config.rpId,
  origin: config.origin,
  tickets,
  onChange: () => client?.sendJson({ type: 'credentials', list: authority.publicCredentials(), pairing: authority.pairingState() }),
}).load();
const notifier = await new Notifier({
  file: paths.push,
  subject: config.origin,
  proxy: config.pushProxy,
  log: report,
  isFocused: (sessionId) => [...links.values()].some((link) => link.isFocused(sessionId)),
}).load();
// zsh cannot take its startup files from a non-ASCII path (see sessions.js); a development state
// directory under "01-项目" falls back to the temporary folder.
const sessions = new SessionManager({ integrationDir: /^[\x20-\x7e]+$/.test(paths.zsh) ? paths.zsh : undefined, log: report });

const info = () => ({ version: VERSION, host: hostname().replace(/\.local$/, ''), user: userInfo().username });

// ---- sessions → phones and notifications ----------------------------------------------------

sessions.on('list', (items) => {
  for (const link of links.values()) if (link.state === 'open') link.control({ t: 'sessions', items });
  report('sessions', { count: items.length });
});
sessions.on('removed', (session) => {
  for (const link of links.values()) link.sessionRemoved(session.id);
});
sessions.on('command-end', (session, finished) => notifier.notify({
  kind: 'command', sessionId: session.id, label: sessionLabel(session),
  command: finished.text, exitCode: finished.exitCode, durationMs: finished.durationMs,
}));
sessions.on('bell', (session) => notifier.notify({ kind: 'bell', sessionId: session.id, label: sessionLabel(session) }));
sessions.on('notify', (session, { title, body }) => notifier.notify({
  kind: 'program', sessionId: session.id, label: sessionLabel(session), process: session.foreground(), title, body,
}));

// ---- relay ----------------------------------------------------------------------------------

function openLink(id) {
  links.get(id)?.close();
  const link = new Link({
    id,
    send: (bytes) => client.sendFrame(id, bytes),
    drop: (reason) => {
      if (links.get(id) === link) links.delete(id);
      client.sendJson({ type: 'drop', link: id, reason });
      report('links', { count: links.size });
    },
    tickets,
    sessions,
    authority,
    notifier,
    info,
    log: report,
  });
  links.set(id, link);
  report('links', { count: links.size });
}

function closeLink(id) {
  links.get(id)?.close();
  links.delete(id);
  report('links', { count: links.size });
}

async function answerRpc({ rid, method, params }) {
  if (typeof rid !== 'string') return;
  if (!RPC_METHODS.includes(method)) return client.sendJson({ type: 'rpc-result', rid, ok: false, error: 'unknown-method' });
  const call = {
    'pair-start': () => authority.pairStart(params ?? {}),
    'pair-finish': () => authority.pairFinish(params ?? {}),
    'login-start': () => authority.loginStart(params ?? {}),
    'login-finish': () => authority.loginFinish(params ?? {}),
  }[method];
  try {
    const result = await call();
    client.sendJson({ type: 'rpc-result', rid, ok: true, result });
    report('auth', { method, ok: true });
  } catch (error) {
    client.sendJson({ type: 'rpc-result', rid, ok: false, error: error.code ?? 'internal' });
    report('auth', { method, ok: false, error: error.code ?? 'internal', ...(error.code ? {} : { message: error.message }) });
  }
}

client = startRelayClient({
  url: config.relayUrl,
  token: config.deviceToken,
  hello: () => ({ type: 'hello', version: VERSION, credentials: authority.publicCredentials(), pairing: authority.pairingState() }),
  onStatus(status, details) {
    report('status', { status, ...details });
    if (status === 'disconnected') for (const id of [...links.keys()]) closeLink(id);
  },
  onMessage(message) {
    if (message.type === 'link-open' && Number.isInteger(message.link)) openLink(message.link);
    else if (message.type === 'link-close' && Number.isInteger(message.link)) closeLink(message.link);
    else if (message.type === 'rpc') answerRpc(message);
  },
  onFrame(linkId, payload) {
    links.get(linkId)?.receive(payload);
  },
});

// ---- pairing, the launcher pipe, shutdown -----------------------------------------------------

async function openPairing() {
  const pairing = await authority.openPairing();
  report('pairing', { url: pairing.url, expiresAt: pairing.expiresAt });
  return pairing;
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  client.stop();
  for (const link of links.values()) link.close();
  sessions.dispose();
  await Promise.allSettled([tickets.flush(), authority.flush(), notifier.flush()]);
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdout.on('error', stop); // EPIPE: the launcher is gone

// Under the launcher, stdin is a pipe it holds open: EOF means it is gone, even if it was killed.
// Requests arrive as {id, cmd} lines and are answered on stdout as {event:'reply', id, ...}.
if (process.env.REMOTE_TERM_PARENT_PIPE === '1') {
  const commands = {
    pair: async () => {
      const { url, expiresAt } = await openPairing();
      return { url, expiresAt };
    },
    status: () => ({
      sessions: sessions.sessions.size,
      links: [...links.values()].filter((link) => link.state === 'open').length,
      devices: authority.credentials.length,
      pairing: authority.pairingState(),
    }),
  };
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      const command = Object.hasOwn(commands, request.cmd) ? commands[request.cmd] : null;
      try {
        if (!command) throw Object.assign(new Error('unknown command'), { code: 'unknown-command' });
        report('reply', { id: request.id, ok: true, ...(await command()) });
      } catch (error) {
        report('reply', { id: request.id, ok: false, error: error.code ?? 'internal' });
      }
    }
    if (buffer.length > 4096) buffer = '';
  });
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.stdin.resume();
}

report('started', { version: VERSION, relay: new URL(config.relayUrl).host, origin: config.origin });

if (flags.pair) {
  const { url, expiresAt } = await openPairing();
  const { default: qrcode } = await import('qrcode-terminal');
  process.stderr.write(`\nScan with the phone camera within 10 minutes (until ${new Date(expiresAt).toLocaleTimeString()}):\n${url}\n\n`);
  qrcode.generate(url, { small: true }, (code) => process.stderr.write(`${code}\n`));
}
