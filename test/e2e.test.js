// The whole path with nothing mocked but the passkey: a real relay, the real agent as a child
// process with its own state directory, and a phone speaking the protocol from Node.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { toB64u } from '../shared/bytes.js';
import { createRelay } from '../relay/server.js';
import { SoftPasskey } from './helpers/authenticator.js';
import { FakePhone, waitFor } from './helpers/phone.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const encoder = new TextEncoder();

let relay;
let port;
let origin;
let dataDir;
let agentHome;
let shellHome;
let agent = null;
let agentEvents = [];
let passkey;
let ticket;
let phone;

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port: free } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return free;
}

function startAgent() {
  agentEvents = [];
  const child = spawn(process.execPath, ['agent/index.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: shellHome, REMOTE_TERM_HOME: agentHome, REMOTE_TERM_PARENT_PIPE: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        agentEvents.push(JSON.parse(line));
      } catch {
        // not a report line
      }
    }
  });
  agent = child;
  return waitFor(() => agentEvents.some((event) => event.event === 'status' && event.status === 'connected'), { what: 'agent to connect' });
}

async function stopAgent() {
  const child = agent;
  agent = null;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.end(); // the launcher pipe closing stops the agent
  await exited;
}

let commandId = 0;
async function agentCommand(cmd) {
  commandId += 1;
  const id = String(commandId);
  agent.stdin.write(`${JSON.stringify({ id, cmd })}\n`);
  return waitFor(() => agentEvents.find((event) => event.event === 'reply' && event.id === id), { what: `reply to ${cmd}` });
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rt-relay-'));
  agentHome = await mkdtemp(join(tmpdir(), 'rt-agent-'));
  shellHome = await mkdtemp(join(tmpdir(), 'rt-shellhome-'));
  await writeFile(join(shellHome, '.zshrc'), "PS1='%# '\nunsetopt PROMPT_SP\n");
  const deviceToken = randomBytes(32).toString('base64url');
  port = await freePort();
  origin = `http://localhost:${port}`;
  relay = await createRelay({
    port, host: '127.0.0.1', publicOrigin: origin, rpId: 'localhost', dataDir,
    agentTokenSha256: createHash('sha256').update(deviceToken).digest('hex'),
  });
  await relay.listen();
  await writeFile(join(agentHome, 'agent.json'), JSON.stringify({ relayUrl: `ws://127.0.0.1:${port}/agent`, deviceToken, origin }));
  await startAgent();
  passkey = new SoftPasskey({ rpId: 'localhost', origin });
  phone = new FakePhone({ base: `http://127.0.0.1:${port}`, origin });
});

after(async () => {
  if (agent) await stopAgent();
  await relay?.close();
});

test('before login: no app, no API, no socket, and a crawler is told to stay away', async () => {
  const app = await fetch(`http://127.0.0.1:${port}/app/`, { redirect: 'manual' });
  assert.equal(app.status, 302);
  assert.equal(app.headers.get('location'), '/');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 401);
  const robots = await fetch(`http://127.0.0.1:${port}/robots.txt`);
  assert.match(await robots.text(), /Disallow: \//);
  assert.equal(robots.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal((await fetch(`http://127.0.0.1:${port}/shared/package.json`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/shared/channel.js`)).status, 200);
  const stranger = new FakePhone({ base: `http://127.0.0.1:${port}`, origin });
  await assert.rejects(stranger.connect({ tid: toB64u(randomBytes(16)), k: toB64u(randomBytes(32)) }).opened, { status: 401 });
  const { status, json } = await stranger.post('/api/login/options', { e: toB64u(randomBytes(65)) });
  assert.equal(status, 409, 'nobody has paired yet');
  assert.equal(json.error, 'not-paired');
});

test('pairing needs the QR code: a guessed pairing id is refused', async () => {
  const outsider = new FakePhone({ base: `http://127.0.0.1:${port}`, origin });
  const fakeUrl = `${origin}/pair#${toB64u(randomBytes(32))}`;
  await assert.rejects(outsider.pair(fakeUrl, new SoftPasskey({ rpId: 'localhost', origin })), (error) => error.reply?.status === 410);
});

test('pairing through the relay stores the passkey on the Mac and logs the phone in', async () => {
  const reply = await agentCommand('pair');
  assert.equal(reply.ok, true);
  assert.match(reply.url, new RegExp(`^${origin}/pair#`));
  ticket = await phone.pair(reply.url, passkey, 'iPhone e2e');
  assert.equal(typeof ticket.tid, 'string');
  assert.ok(phone.cookie, 'the relay set its cookie');
  const status = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie: phone.cookie } });
  assert.deepEqual(await status.json(), { ok: true, online: true, version: '0.1.0', paired: true });
  const saved = JSON.parse(await readFile(join(agentHome, 'credentials.json'), 'utf8'));
  assert.equal(saved.credentials[0].id, passkey.id);
  assert.equal(saved.credentials[0].name, 'iPhone e2e');
  const again = await phone.post('/api/pair/options', { pid: 'x', e: toB64u(randomBytes(65)) });
  assert.equal(again.status, 410, 'the QR code worked once');
});

test('a paired phone runs a command over the end-to-end channel, and the relay only sees ciphertext', async () => {
  const connection = phone.connect(ticket);
  await connection.opened;
  const ready = await connection.ready();
  assert.equal(ready.agent.version, '0.1.0');
  assert.deepEqual(ready.sessions, []);

  await connection.send({ t: 'create', ref: 'c1', cols: 70, rows: 20 });
  const created = await connection.reply((message) => message.t === 'created' && message.ref === 'c1', 'created');
  await connection.send({ t: 'attach', ref: 'a1', ch: 1, id: created.id, cols: 70, rows: 20 });
  await connection.reply((message) => message.t === 'screen' && message.ch === 1, 'screen');
  await waitFor(() => /% $/.test(connection.screens.get(1) ?? '') || connection.controls.some((m) => m.t === 'sessions' && m.items[0]?.cwd), { what: 'prompt' });

  await connection.input(1, 'echo e2e-$((6*7))\r');
  await waitFor(() => /e2e-42\r\n/.test(connection.screens.get(1) ?? ''), { what: 'command output' });
  const sessions = await connection.reply((message) => message.t === 'sessions' && message.items.some((item) => item.lastCommand?.text === 'echo e2e-$((6*7))'), 'session list with the command');
  assert.equal(sessions.items[0].lastCommand.exitCode, 0);

  const everything = Buffer.concat(connection.raw.map((frame) => Buffer.from(frame)));
  assert.equal(everything.includes(Buffer.from('e2e-42')), false, 'output is not visible on the wire');
  assert.equal(everything.includes(Buffer.from('echo e2e')), false, 'input echo is not visible on the wire');
  connection.close();
});

test('logging in with the passkey mints a fresh ticket from the Mac', async () => {
  const laptop = new FakePhone({ base: `http://127.0.0.1:${port}`, origin });
  const { ticket: fresh } = await laptop.login(passkey);
  assert.ok(fresh);
  assert.notEqual(fresh.tid, ticket.tid);
  const connection = laptop.connect(fresh);
  await connection.opened;
  const ready = await connection.ready();
  assert.equal(ready.sessions.length, 1, 'the session from the other phone is still there');
  connection.close();
});

test('the relay refuses logins from unknown passkeys and sockets from other origins', async () => {
  const intruder = new FakePhone({ base: `http://127.0.0.1:${port}`, origin });
  await assert.rejects(intruder.login(new SoftPasskey({ rpId: 'localhost', origin })), (error) => error.reply?.status === 401);
  await assert.rejects(intruder.login(passkey, { tamper: { flags: 0x01 } }), (error) => error.reply?.status === 401, 'Face ID is required');
  await assert.rejects(phone.connect(ticket, { origin: 'https://evil.example' }).opened, { status: 403 });
  const crossSite = await phone.post('/api/login/options', { e: toB64u(randomBytes(65)) }, { origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
});

test('a made-up ticket gets a plain reject and close code 4401 (show Face ID)', async () => {
  const connection = phone.connect({ tid: toB64u(randomBytes(16)), k: toB64u(randomBytes(32)) });
  await connection.opened;
  await waitFor(() => connection.closed, { what: 'close' });
  assert.deepEqual(connection.rejects, [{ t: 'reject', reason: 'unknown-ticket' }]);
  assert.equal(connection.closed.code, 4401);
});

test('a phone stays connected through an agent restart and resumes with the same ticket', async () => {
  const connection = phone.connect(ticket);
  await connection.opened;
  await connection.ready();
  await stopAgent();
  await waitFor(() => connection.status.some((message) => message.type === 'agent' && !message.online), { what: 'offline notice' });
  assert.equal(connection.closed, null, 'the phone socket stays open while the Mac is away');
  connection.controls.length = 0;
  await startAgent();
  const ready = await connection.ready();
  assert.deepEqual(ready.sessions, [], 'sessions end with the agent process');
  connection.close();
});

test('locking revokes the ticket; the next connection needs Face ID again', async () => {
  const connection = phone.connect(ticket);
  await connection.opened;
  await connection.ready();
  await connection.send({ t: 'lock' });
  await waitFor(() => connection.closed, { what: 'close after lock' });
  assert.equal(connection.closed.code, 4401);
  assert.ok(connection.controls.some((message) => message.t === 'locked'), 'the phone was told why before the socket closed');

  const retry = phone.connect(ticket);
  await retry.opened;
  await waitFor(() => retry.closed, { what: 'reject' });
  assert.equal(retry.rejects[0]?.reason, 'unknown-ticket');
  ({ ticket } = await phone.login(passkey));
  assert.ok(ticket);
});

test('logging out closes the phone sockets of that session', async () => {
  const connection = phone.connect(ticket);
  await connection.opened;
  await connection.ready();
  const { status } = await phone.post('/api/logout', {});
  assert.equal(status, 200);
  await waitFor(() => connection.closed, { what: 'close after logout' });
  assert.equal(connection.closed.code, 4401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie: phone.cookie } })).status, 401);
  assert.ok(encoder);
});
