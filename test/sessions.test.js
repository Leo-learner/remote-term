import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import headless from '../agent/node_modules/@xterm/headless/lib-headless/xterm-headless.js';
import { LIMITS, SessionError, SessionManager } from '../agent/sessions.js';

const { Terminal } = headless;
const decoder = new TextDecoder();
const managers = [];

after(() => {
  for (const manager of managers) manager.dispose();
});

async function waitFor(check, { timeout = 8000, what = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// A login zsh with the integration, but an empty home so the owner's own dotfiles stay out.
async function makeManager(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'rt-home-'));
  await writeFile(join(home, '.zshrc'), "PS1='%# '\nunsetopt PROMPT_SP\n");
  const manager = new SessionManager({
    shell: '/bin/zsh',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USER: 'tester', LANG: 'en_US.UTF-8', REMOTE_TERM_SECRET: 'x' },
    ...options,
  });
  managers.push(manager);
  return { manager, home };
}

function recorder() {
  const record = { events: [], text: '', bytes: 0 };
  record.sink = {
    snapshot(bytes, size) {
      record.events.push({ kind: 'snapshot', size, text: decoder.decode(bytes) });
      record.text = decoder.decode(bytes);
      record.bytes += bytes.length;
    },
    output(bytes) {
      record.events.push({ kind: 'output', text: decoder.decode(bytes) });
      record.text += decoder.decode(bytes);
      record.bytes += bytes.length;
    },
  };
  return record;
}

async function ready(session) {
  await waitFor(() => session.promptMarker, { what: 'first prompt' });
}

test('shell integration reports commands, exit codes and the working directory', async () => {
  const { manager } = await makeManager();
  const ends = [];
  manager.on('command-end', (session, details) => ends.push(details));
  const session = manager.create({ cols: 80, rows: 24 });
  await ready(session);
  session.write('cd /usr/bin && (exit 3)\r');
  await waitFor(() => ends.length === 1, { what: 'command end' });
  assert.equal(ends[0].exitCode, 3);
  assert.equal(ends[0].text, 'cd /usr/bin && (exit 3)');
  assert.ok(ends[0].durationMs >= 0);
  await waitFor(() => session.cwd === '/usr/bin', { what: 'cwd from OSC 7' });
  assert.equal(session.command, null);
});

test('the shell environment is clean: no ZDOTDIR or agent variables leak into it', async () => {
  const { manager, home } = await makeManager();
  const session = manager.create();
  await ready(session);
  const record = recorder();
  session.attach(record.sink);
  session.write('print -r -- "Z=${ZDOTDIR-unset} R=${RT_USER_ZDOTDIR-unset} S=${REMOTE_TERM_SECRET-unset} H=$HISTFILE T=$TERM_PROGRAM C=$COLORTERM"\r');
  const line = await waitFor(() => /Z=\S+ R=\S+ S=\S+ H=\S+ T=\S+ C=\S+/.exec(record.text.replace(/print -r[^\n]*/, ''))?.[0], { what: 'env line' });
  assert.equal(line, `Z=unset R=unset S=unset H=${home}/.zsh_history T=remote-term C=truecolor`);
});

test('attaching sends the current screen first, then live output, in order', async () => {
  const { manager } = await makeManager();
  const session = manager.create({ cols: 60, rows: 20 });
  await ready(session);
  let ends = 0;
  manager.on('command-end', () => { ends += 1; });
  session.write('echo before-中文-😀\r');
  await waitFor(() => ends === 1, { what: 'first command' });

  const record = recorder();
  session.attach(record.sink);
  await waitFor(() => record.events.length > 0, { what: 'snapshot' });
  assert.equal(record.events[0].kind, 'snapshot');
  assert.deepEqual(record.events[0].size, { cols: 60, rows: 20 });
  assert.match(record.events[0].text, /before-中文-😀/);

  session.write('echo after\r');
  // The output line follows the integration's OSC 133;C mark, not a newline.
  await waitFor(() => /(?<!echo )after\r\n/.test(record.text), { what: 'live output' });
  assert.ok(record.events.slice(1).every((event) => event.kind === 'output'));
});

test('a phone rebuilding the screen from snapshot + live output matches the Mac, even mid-stream', async () => {
  const { manager } = await makeManager();
  const session = manager.create({ cols: 50, rows: 12 });
  await ready(session);
  let ends = 0;
  manager.on('command-end', () => { ends += 1; });
  session.write('for i in {1..4000}; do print "line $i \\e[3${i: -1}mcolour\\e[0m"; done; print done\r');
  await waitFor(() => session.lastOutputAt > session.createdAt + 50 && session.term.buffer.active.length > 300, { what: 'output under way' });

  const record = recorder();
  session.attach(record.sink, { lines: 3000 });
  await waitFor(() => ends === 1, { what: 'loop to finish', timeout: 20000 });
  await new Promise((resolve) => session.term.write('', resolve));

  const phone = new Terminal({ cols: 50, rows: 12, scrollback: 5000, allowProposedApi: true });
  for (const event of record.events) {
    if (event.kind === 'snapshot') phone.reset();
    await new Promise((resolve) => phone.write(event.text, resolve));
  }
  const lines = (term) => {
    const buffer = term.buffer.active;
    const out = [];
    for (let y = Math.max(0, buffer.length - 400); y < buffer.length; y += 1) out.push(buffer.getLine(y).translateToString(true));
    return out.join('\n');
  };
  assert.equal(lines(phone), lines(session.term));
  assert.match(lines(phone), /line 4000/);
});

test('a phone that stops acknowledging stalls, then gets a fresh snapshot instead of the backlog', async () => {
  const { manager } = await makeManager();
  const session = manager.create();
  await ready(session);
  const record = recorder();
  const subscription = session.attach(record.sink);
  await waitFor(() => subscription.state === 'live', { what: 'live' });
  subscription.ack(subscription.sent);

  session.write('head -c 3000000 /dev/zero | tr "\\0" "x"; echo; echo finished\r');
  await waitFor(() => subscription.state === 'stalled', { what: 'stall', timeout: 20000 });
  assert.ok(subscription.sent - subscription.acked <= LIMITS.flowHigh, 'never more than the window in flight');
  const snapshotsBefore = record.events.filter((event) => event.kind === 'snapshot').length;

  await waitFor(() => /finished/.test(session.preview()) || /finished/.test(session.term.buffer.active.getLine(session.term.buffer.active.baseY + session.term.buffer.active.cursorY - 1)?.translateToString(true) ?? ''), { what: 'command to finish on the Mac', timeout: 20000 });
  subscription.ack(subscription.sent); // the phone catches up
  await waitFor(() => record.events.filter((event) => event.kind === 'snapshot').length === snapshotsBefore + 1, { what: 'resync snapshot' });
  await waitFor(() => subscription.state === 'live', { what: 'live again' });
  assert.match(record.events.findLast((event) => event.kind === 'snapshot').text, /finished/);
});

test('resize reaches the program; exit is reported with its code; input after exit is refused', async () => {
  const { manager } = await makeManager();
  const exits = [];
  manager.on('exit', (session, details) => exits.push(details));
  const session = manager.create({ cols: 80, rows: 24 });
  await ready(session);
  const record = recorder();
  session.attach(record.sink);
  assert.equal(session.resize(101, 33), true);
  assert.equal(session.resize(101, 33), false);
  session.write('stty size\r');
  await waitFor(() => /33 101/.test(record.text), { what: 'stty size' });
  session.write('exit 7\r');
  await waitFor(() => exits.length === 1, { what: 'exit' });
  assert.equal(exits[0].code, 7);
  assert.equal(session.write('echo nope\r'), false);
  assert.equal(session.summary().exit.code, 7);
});

test('removing a running session hangs up its processes', async () => {
  const { manager } = await makeManager();
  const session = manager.create();
  await ready(session);
  const { pid } = session;
  session.write('sleep 30\r');
  await waitFor(() => session.command, { what: 'sleep to start' });
  assert.equal(manager.remove(session.id), true);
  assert.equal(manager.get(session.id), null);
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, { what: 'shell to exit' });
});

test('bells and OSC 9 / 777 notifications are reported; ConEmu progress is not', async () => {
  const { manager } = await makeManager();
  const session = manager.create();
  await ready(session);
  const bells = [];
  const notes = [];
  manager.on('bell', (s) => bells.push(s.id));
  manager.on('notify', (s, details) => notes.push(details));
  session.write("printf '\\a'; printf '\\e]9;4;1;50\\a'; printf '\\e]9;hello from nine\\a'; printf '\\e]777;notify;Title;Body;with;semicolons\\a'\r");
  await waitFor(() => bells.length === 1 && notes.length === 2, { what: 'bell and notifications' });
  assert.deepEqual(notes, [{ title: '', body: 'hello from nine' }, { title: 'Title', body: 'Body;with;semicolons' }]);
});

test('the preview is the last output line above an idle prompt', async () => {
  const { manager } = await makeManager();
  const session = manager.create();
  await ready(session);
  let ends = 0;
  manager.on('command-end', () => { ends += 1; });
  session.write('echo preview-line\r');
  await waitFor(() => ends === 1, { what: 'command' });
  await waitFor(() => session.summary().preview === 'preview-line', { what: 'preview' });
});

test('session limits and bad working directories', async () => {
  const { manager, home } = await makeManager({ maxSessions: 2 });
  const first = manager.create({ cwd: '/definitely/not/here' });
  assert.equal(first.cwd, home);
  const second = manager.create({ cwd: '/usr' });
  assert.equal(second.cwd, '/usr');
  assert.throws(() => manager.create(), (error) => error instanceof SessionError && error.code === 'too-many-sessions');
  assert.equal(manager.list().length, 2);
});
