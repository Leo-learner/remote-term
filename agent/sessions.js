// Terminal sessions on this Mac. Each one is a login shell in a PTY plus a headless xterm that
// parses everything the shell prints. A phone that attaches, or re-attaches after its connection
// dropped, is sent the screen as it is now (scrollback, colours, cursor, modes) and then the live
// stream, never a replay of every byte since the session started.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import headless from '@xterm/headless';
import pty from 'node-pty';

const { Terminal } = headless;
const encoder = new TextEncoder();

export const LIMITS = {
  sessions: 12,
  scrollback: 5000,
  snapshotLines: 1000,
  cols: [10, 500],
  rows: [4, 200],
  flowHigh: 512 * 1024, // bytes a phone may leave unacknowledged before it is considered behind
  flowLow: 64 * 1024,
  parseHigh: 4 * 1024 * 1024, // characters waiting for the headless parser before the PTY is paused
  parseLow: 512 * 1024,
};

const INTEGRATION_SOURCE = fileURLToPath(new URL('./shell/zsh', import.meta.url));
const INTEGRATION_FILES = ['.zshenv', '.zprofile', '.zshrc', 'remote-term.zsh'];
const VERSION = '0.1.0';

const isAscii = (path) => /^[\x20-\x7e]+$/.test(path);

// zsh mangles a ZDOTDIR that holds some multibyte characters once a startup file reassigns it
// (the "目" of "01-项目" breaks it), so the startup files are copied to an ASCII-only directory,
// and rewritten whenever they are missing or stale (macOS prunes old files in the temp folder).
export function installIntegration(target) {
  if (!isAscii(target)) throw new Error('the zsh integration directory must be an ASCII path');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of INTEGRATION_FILES) {
    const source = readFileSync(join(INTEGRATION_SOURCE, name));
    const destination = join(target, name);
    let current = null;
    try {
      current = readFileSync(destination);
    } catch {
      // first run
    }
    if (!current?.equals(source)) writeFileSync(destination, source, { mode: 0o600 });
  }
  return target;
}

export class SessionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

const clamp = (value, [min, max], fallback) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const clip = (text, length) => String(text ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, length);

function decodePercent(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

// OSC 7 carries file://host/path with the path percent-encoded.
function cwdFromOsc7(data) {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
  const path = match && decodePercent(match[1]);
  return path && isAbsolute(path) ? path : null;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ---- one phone's view of one session ------------------------------------------------------

// sink.snapshot(bytes, { cols, rows }) resets the phone's terminal and writes the screen;
// sink.output(bytes) appends live output. The phone acknowledges the bytes it has received.
export class Subscription {
  constructor(session, sink, { lines = LIMITS.snapshotLines } = {}) {
    this.session = session;
    this.sink = sink;
    this.lines = clamp(lines, [0, LIMITS.scrollback], LIMITS.snapshotLines);
    this.state = 'idle'; // idle → syncing → live ⇄ stalled; closed
    this.sent = 0;
    this.acked = 0;
    this.queue = [];
    this.queued = 0;
    this.overflow = false;
  }

  // Everything written to the parser before this call is in the snapshot; everything after it
  // is queued and follows the snapshot, so nothing is lost or shown twice.
  sync() {
    if (this.state === 'closed') return;
    this.state = 'syncing';
    this.queue = [];
    this.queued = 0;
    this.overflow = false;
    this.session.term.write('', () => {
      if (this.state !== 'syncing') return;
      if (this.overflow) return this.sync();
      const screen = encoder.encode(this.session.serializer.serialize({ scrollback: this.lines }));
      this.sent += screen.length;
      this.sink.snapshot(screen, { cols: this.session.cols, rows: this.session.rows });
      const queued = this.queue;
      this.queue = [];
      this.queued = 0;
      this.state = 'live';
      for (const chunk of queued) this.push(chunk);
    });
  }

  push(chunk) {
    if (this.state === 'live') {
      if (this.sent - this.acked + chunk.length > LIMITS.flowHigh) {
        this.state = 'stalled'; // drop from here on; a fresh snapshot replaces what was skipped
        return;
      }
      this.sent += chunk.length;
      this.sink.output(chunk);
    } else if (this.state === 'syncing' && !this.overflow) {
      this.queue.push(chunk);
      this.queued += chunk.length;
      if (this.queued > LIMITS.flowHigh) {
        this.overflow = true;
        this.queue = [];
        this.queued = 0;
      }
    }
  }

  ack(count) {
    if (!Number.isSafeInteger(count) || count < this.acked || count > this.sent) return;
    this.acked = count;
    if (this.state === 'stalled' && this.sent - this.acked <= LIMITS.flowLow) this.sync();
  }

  close() {
    this.state = 'closed';
    this.queue = [];
    this.session.subscriptions.delete(this);
  }
}

// ---- a session ---------------------------------------------------------------------------

export class Session extends EventEmitter {
  constructor({ id, shell, args, cwd, env, cols, rows, scrollback, spawn }) {
    super();
    this.id = id;
    this.name = '';
    this.title = '';
    this.cwd = cwd;
    this.cols = cols;
    this.rows = rows;
    this.createdAt = Date.now();
    this.lastOutputAt = this.createdAt;
    this.lastInputAt = 0;
    this.command = null; // { text, startedAt } while a command runs (needs shell integration)
    this.lastCommand = null; // { text, startedAt, exitCode, durationMs }
    this.pendingCommand = null;
    this.exit = null; // { code, signal, at }
    this.subscriptions = new Set();
    this.promptMarker = null;
    this.parsePending = 0;
    this.parsePaused = false;
    this.changeTimer = null;
    this.activityTimer = null;
    this.disposed = false;

    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11'; // must match the phone, or wide characters wrap differently
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.watchTerminal();

    try {
      this.pty = spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env, encoding: 'utf8' });
    } catch (error) {
      this.term.dispose();
      throw new SessionError('spawn-failed', error.message);
    }
    this.pid = this.pty.pid;
    this.pty.onData((data) => this.output(data));
    this.pty.onExit(({ exitCode, signal }) => this.exited(exitCode, signal));
  }

  watchTerminal() {
    const { term } = this;
    term.onTitleChange((title) => {
      this.title = clip(title, 120);
      this.changed();
    });
    term.onBell(() => this.emit('bell'));
    term.parser.registerOscHandler(7, (data) => {
      const cwd = cwdFromOsc7(data);
      if (cwd && cwd !== this.cwd) {
        this.cwd = cwd;
        this.changed();
      }
      return true;
    });
    term.parser.registerOscHandler(133, (data) => {
      this.mark(data);
      return true;
    });
    term.parser.registerOscHandler(6973, (data) => {
      if (data.startsWith('cmd;')) this.pendingCommand = clip(decodePercent(data.slice(4)) ?? '', 200);
      return true;
    });
    // Programs that want to notify: OSC 9 (iTerm2; "9;4;…" is ConEmu progress, not a message),
    // OSC 777;notify;title;body (urxvt, Ghostty).
    term.parser.registerOscHandler(9, (data) => {
      if (!/^\d+;/.test(data)) this.emit('notify', { title: '', body: clip(data, 300) });
      return true;
    });
    term.parser.registerOscHandler(777, (data) => {
      const [kind, title = '', ...body] = data.split(';');
      if (kind === 'notify') this.emit('notify', { title: clip(title, 120), body: clip(body.join(';'), 300) });
      return true;
    });
  }

  mark(data) {
    const [kind, value] = data.split(';');
    if (kind === 'A') {
      if (this.term.buffer.active.type === 'normal') {
        this.promptMarker?.dispose();
        this.promptMarker = this.term.registerMarker(0) ?? null;
      }
    } else if (kind === 'C') {
      this.command = { text: this.pendingCommand ?? '', startedAt: Date.now() };
      this.pendingCommand = null;
      this.changed();
      this.emit('command-start', this.command);
    } else if (kind === 'D' && this.command) {
      const exitCode = Number.parseInt(value, 10);
      this.lastCommand = {
        ...this.command,
        exitCode: Number.isFinite(exitCode) ? exitCode : null,
        durationMs: Date.now() - this.command.startedAt,
      };
      this.command = null;
      this.changed();
      this.emit('command-end', this.lastCommand);
    }
  }

  output(data) {
    if (this.disposed) return;
    this.lastOutputAt = Date.now();
    this.parsePending += data.length;
    this.term.write(data, () => {
      this.parsePending -= data.length;
      if (this.parsePaused && this.parsePending < LIMITS.parseLow) {
        this.parsePaused = false;
        this.pty.resume();
      }
    });
    // A command that prints faster than the parser keeps up waits on its own write() instead.
    if (!this.parsePaused && this.parsePending > LIMITS.parseHigh) {
      this.parsePaused = true;
      this.pty.pause();
    }
    if (this.subscriptions.size > 0) {
      const chunk = encoder.encode(data);
      for (const subscription of this.subscriptions) subscription.push(chunk);
    }
    if (!this.activityTimer) {
      this.activityTimer = setTimeout(() => {
        this.activityTimer = null;
        this.changed();
      }, 1000);
      this.activityTimer.unref?.();
    }
  }

  exited(code, signal) {
    this.exit = { code, signal: signal || null, at: Date.now() };
    this.command = null;
    if (this.disposed) return;
    // Let the parser take in the last output first, so the final screen and preview are complete.
    this.term.write('', () => {
      this.changed();
      this.emit('exit', this.exit);
    });
  }

  changed() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit('changed');
    }, 250);
    this.changeTimer.unref?.();
  }

  attach(sink, options) {
    const subscription = new Subscription(this, sink, options);
    this.subscriptions.add(subscription);
    subscription.sync();
    return subscription;
  }

  write(input) {
    if (this.exit) return false;
    this.lastInputAt = Date.now();
    this.pty.write(input);
    return true;
  }

  resize(cols, rows) {
    const nextCols = clamp(cols, LIMITS.cols, this.cols);
    const nextRows = clamp(rows, LIMITS.rows, this.rows);
    if (nextCols === this.cols && nextRows === this.rows) return false;
    this.cols = nextCols;
    this.rows = nextRows;
    if (!this.exit) {
      try {
        this.pty.resize(nextCols, nextRows);
      } catch {
        // the process may be exiting; the parser still follows the new size
      }
    }
    this.term.resize(nextCols, nextRows);
    this.emit('resize', { cols: nextCols, rows: nextRows });
    this.changed();
    return true;
  }

  rename(name) {
    this.name = clip(name, 60).trim();
    this.changed();
  }

  // Hang up like a closed terminal window; force it if the shell ignores the hangup.
  kill() {
    if (this.exit) return;
    try {
      this.pty.kill('SIGHUP');
    } catch {
      // already gone
    }
    clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      if (!this.exit) {
        try {
          process.kill(this.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }, 3000);
    this.killTimer.unref?.();
  }

  foreground() {
    if (this.exit) return null;
    try {
      return this.pty.process || null;
    } catch {
      return null;
    }
  }

  // The last line with text above the prompt when the shell is idle, else the last line with text.
  preview() {
    const buffer = this.term.buffer.active;
    const promptLine = buffer.type === 'normal' && !this.command ? this.promptMarker?.line : undefined;
    let y = Number.isInteger(promptLine) && promptLine >= 0 ? promptLine - 1 : buffer.baseY + buffer.cursorY;
    for (let seen = 0; y >= 0 && seen < 200; y -= 1, seen += 1) {
      const text = buffer.getLine(y)?.translateToString(true).trim();
      if (text) return text.slice(0, 200);
    }
    return '';
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      title: this.title,
      cwd: this.cwd,
      process: this.foreground(),
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      lastOutputAt: this.lastOutputAt,
      lastInputAt: this.lastInputAt,
      command: this.command,
      lastCommand: this.lastCommand,
      exit: this.exit,
      preview: this.preview(),
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of [...this.subscriptions]) subscription.close();
    clearTimeout(this.changeTimer);
    clearTimeout(this.activityTimer);
    clearTimeout(this.killTimer);
    this.promptMarker?.dispose();
    this.term.dispose();
  }
}

// ---- all sessions ------------------------------------------------------------------------

export class SessionManager extends EventEmitter {
  constructor({
    shell = userInfo().shell || '/bin/zsh',
    env = process.env,
    integrationDir = join(tmpdir(), 'remote-term', 'zsh'),
    maxSessions = LIMITS.sessions,
    scrollback = LIMITS.scrollback,
    spawn = pty.spawn,
    log = () => {},
  } = {}) {
    super();
    this.shell = shell;
    this.baseEnv = env;
    this.home = env.HOME || homedir();
    this.integrationDir = integrationDir; // null turns the integration off
    this.log = log;
    this.integrationProblem = null;
    this.maxSessions = maxSessions;
    this.scrollback = scrollback;
    this.spawn = spawn;
    this.sessions = new Map();
    this.changeTimer = null;
  }

  envFor() {
    const env = {};
    for (const [key, value] of Object.entries(this.baseEnv)) {
      if (/^(REMOTE_TERM_|npm_|RT_)/.test(key) || ['NODE_OPTIONS', 'INIT_CWD', 'ZDOTDIR'].includes(key)) continue;
      env[key] = value;
    }
    const user = userInfo().username;
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'remote-term',
      TERM_PROGRAM_VERSION: VERSION,
      LANG: this.baseEnv.LANG || 'en_US.UTF-8',
      SHELL: this.shell,
      HOME: this.home,
      USER: this.baseEnv.USER || user,
      LOGNAME: this.baseEnv.LOGNAME || user,
    });
    const userZdotdir = this.baseEnv.ZDOTDIR || this.home;
    // Without the integration the shell is plain zsh: nothing breaks, but there are no command
    // marks, so no "command finished" notifications and no previews. Say so once.
    let problem = null;
    if (!this.integrationDir || basename(this.shell) !== 'zsh') problem = null;
    else if (!isAscii(userZdotdir)) problem = `ZDOTDIR or HOME is not an ASCII path: ${userZdotdir}`;
    else {
      try {
        env.ZDOTDIR = installIntegration(this.integrationDir);
        env.RT_USER_ZDOTDIR = userZdotdir;
      } catch (error) {
        delete env.ZDOTDIR;
        problem = error.message;
      }
    }
    if (problem && problem !== this.integrationProblem) this.log('integration-disabled', { reason: problem });
    this.integrationProblem = problem;
    if (!env.ZDOTDIR && this.baseEnv.ZDOTDIR) env.ZDOTDIR = this.baseEnv.ZDOTDIR;
    return env;
  }

  create({ cols = 80, rows = 24, cwd } = {}) {
    if (this.sessions.size >= this.maxSessions) throw new SessionError('too-many-sessions');
    const requested = typeof cwd === 'string' && isAbsolute(cwd) && isDirectory(cwd) ? cwd : null;
    let id;
    do id = randomBytes(6).toString('base64url'); while (this.sessions.has(id));
    const session = new Session({
      id,
      shell: this.shell,
      args: ['-l'],
      cwd: requested ?? this.home,
      env: this.envFor(),
      cols: clamp(cols, LIMITS.cols, 80),
      rows: clamp(rows, LIMITS.rows, 24),
      scrollback: this.scrollback,
      spawn: this.spawn,
    });
    this.sessions.set(id, session);
    session.on('changed', () => this.changed());
    for (const event of ['bell', 'notify', 'command-start', 'command-end', 'exit', 'resize']) {
      session.on(event, (details) => this.emit(event, session, details));
    }
    this.changed();
    return session;
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  list() {
    return [...this.sessions.values()].map((session) => session.summary());
  }

  remove(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    if (session.exit) session.dispose();
    else {
      session.once('exit', () => session.dispose());
      session.kill();
    }
    this.emit('removed', session);
    this.changed();
    return true;
  }

  changed() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit('list', this.list());
    }, 200);
    this.changeTimer.unref?.();
  }

  dispose() {
    clearTimeout(this.changeTimer);
    for (const session of this.sessions.values()) {
      session.kill();
      session.dispose();
    }
    this.sessions.clear();
  }
}
