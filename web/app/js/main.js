// Wires the app together: connection ⇄ terminal view, key bar, compose bar, sheets and overlays.
import { encoder } from '/shared/bytes.js';
import { OP } from '/shared/frames.js';
import { describeError, login } from '/lib/auth.js';
import { clearTicket } from '/lib/tickets.js';
import { Compose } from './compose.js';
import { Connection } from './connection.js';
import { dangerReason } from './danger.js';
import { KeyBar } from './keybar.js';
import { cursorKey, withModifiers } from './keys.js';
import { currentSubscription, enablePush, pushState, registerWorker } from './push.js';
import { renderSettings } from './settings.js';
import { renderSessions } from './switcher.js';
import { TerminalView } from './terminal-view.js';
import { $, closeSheet, confirmDialog, openSheet, sessionLabel, sheetIsOpen, toast } from './ui.js';

const PREFS_KEY = 'harbor.prefs';
const LAST_SESSION_KEY = 'harbor.session';
const ACK_EVERY_BYTES = 32 * 1024;
const ACK_DELAY_MS = 100;

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

const prefs = { fontSize: 13, compose: false, ...readPrefs() };
const savePrefs = () => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // private mode
  }
};

const app = $('#app');
const connection = new Connection();
const renderer = new URLSearchParams(location.search).get('renderer') === 'webgl' ? 'webgl' : 'dom';
const view = new TerminalView($('#term-host'), { fontSize: prefs.fontSize, renderer });
const keybar = new KeyBar($('#key-bar'), { modes: () => view.modes });
const compose = new Compose({ form: $('#compose'), input: $('#compose-input') });

const state = {
  sessions: [],
  current: null, // { id, ch, parsed, acked, ackTimer }
  nextChannel: 1,
  lastSize: null,
  creating: false,
  pasting: false,
  wanted: sessionFromHash(),
};

function sessionFromHash() {
  const match = /[#&]s=([\w-]+)/.exec(location.hash);
  if (match) history.replaceState(null, '', location.pathname);
  return match?.[1] ?? null;
}

const currentSession = () => state.sessions.find((session) => session.id === state.current?.id) ?? null;

// ---- layout ----------------------------------------------------------------------------------

// iOS keeps the layout viewport when the keyboard opens; only the visual viewport shrinks. The app
// is sized and moved to the visual viewport, so the key bar sits right on top of the keyboard.
//
// The terminal itself keeps its keyboard-down size and slides up to keep the cursor in view.
// Resizing it instead would send the shell a SIGWINCH on every keyboard toggle: zsh redraws its
// two-line prompt, and full-screen programs like Claude Code repaint everything.
const stage = $('#stage');
const host = $('#term-host');
let fullStageHeight = 0;

function layout() {
  const viewport = window.visualViewport;
  const height = viewport ? viewport.height : window.innerHeight;
  const keyboardUp = window.innerHeight - height > 120;
  app.style.height = `${Math.round(height)}px`;
  app.style.transform = viewport && viewport.offsetTop ? `translateY(${Math.round(viewport.offsetTop)}px)` : '';
  document.documentElement.dataset.keyboard = keyboardUp ? 'up' : 'down';
  requestAnimationFrame(() => {
    if (!keyboardUp || !fullStageHeight) fullStageHeight = stage.clientHeight;
    host.style.height = `${Math.max(stage.clientHeight, fullStageHeight) - 4}px`;
    scheduleFit();
    panToCursor();
  });
}

let panFrame = 0;
function panToCursor() {
  cancelAnimationFrame(panFrame);
  panFrame = requestAnimationFrame(() => {
    const visible = stage.clientHeight - 4;
    const hidden = host.clientHeight - visible;
    let offset = 0;
    if (hidden > 0 && view.atBottom) {
      const cursorBottom = (view.cursorRow + 1) * view.cellHeight + 8;
      offset = Math.min(hidden, Math.max(0, cursorBottom - visible));
    }
    host.style.transform = offset ? `translateY(${-Math.round(offset)}px)` : '';
  });
}

view.addEventListener('cursor', panToCursor);

let fitFrame = 0;
let resizeTimer = 0;
function scheduleFit() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    const size = view.fit();
    if (!size || !state.current) return;
    if (size.cols === state.lastSize?.cols && size.rows === state.lastSize?.rows) return;
    // Wait for the keyboard animation to settle before telling the Mac (every resize redraws there).
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      state.lastSize = size;
      connection.send({ t: 'resize', ch: state.current.ch, cols: size.cols, rows: size.rows });
    }, 120);
  });
}

window.visualViewport?.addEventListener('resize', layout);
window.visualViewport?.addEventListener('scroll', layout);
window.addEventListener('resize', layout);
new ResizeObserver(scheduleFit).observe($('#term-host'));

// ---- sessions --------------------------------------------------------------------------------

function attach(id) {
  const previous = state.current;
  if (previous) {
    clearTimeout(previous.ackTimer);
    if (previous.id !== id) view.reset();
    connection.send({ t: 'detach', ch: previous.ch });
  }
  const size = view.fit() ?? view.size;
  state.lastSize = size;
  state.current = { id, ch: state.nextChannel, parsed: 0, acked: 0, ackTimer: null };
  state.nextChannel += 1;
  try {
    localStorage.setItem(LAST_SESSION_KEY, id);
  } catch {
    // private mode
  }
  connection.send({ t: 'attach', ch: state.current.ch, id, cols: size.cols, rows: size.rows, lines: 2000 });
  syncFocus();
  render();
}

async function createSession(cwd) {
  if (state.creating || connection.state !== 'ready') return;
  state.creating = true;
  render();
  try {
    const size = view.fit() ?? view.size;
    const { id } = await connection.request({ t: 'create', cols: size.cols, rows: size.rows, cwd });
    attach(id);
  } catch (error) {
    toast(error.code === 'too-many-sessions' ? '会话太多了，先关掉几个' : '没能新建会话');
  } finally {
    state.creating = false;
    render();
  }
}

async function closeSession(session) {
  if (session.command && !session.exit) {
    const ok = await confirmDialog({
      title: '关闭这个会话？',
      message: `「${session.command.text || '一个命令'}」还在运行，关闭会结束它。`,
      confirm: '关闭',
      destructive: true,
    });
    if (!ok) return;
  }
  connection.send({ t: 'close', id: session.id });
}

function newest(sessions) {
  return [...sessions].sort((a, b) => Math.max(b.lastInputAt, b.lastOutputAt) - Math.max(a.lastInputAt, a.lastOutputAt))[0] ?? null;
}

function updateSessions(items) {
  state.sessions = Array.isArray(items) ? items : [];
  if (state.current && !currentSession() && connection.state === 'ready') {
    const next = newest(state.sessions);
    if (next) attach(next.id);
    else {
      clearTimeout(state.current.ackTimer);
      state.current = null;
      view.reset();
    }
  }
  render();
}

// ---- rendering -------------------------------------------------------------------------------

function render() {
  const session = currentSession();
  $('#title-text').textContent = session ? sessionLabel(session) : connection.state === 'ready' ? '会话' : '连接中…';
  const exited = $('#exited');
  exited.hidden = !session?.exit;
  if (session?.exit) {
    exited.querySelector('.exited-text').textContent = session.exit.signal
      ? `会话已结束（${session.exit.signal}）`
      : `会话已结束（退出码 ${session.exit.code}）`;
  }
  $('#empty').hidden = !(connection.state === 'ready' && state.sessions.length === 0 && !state.creating);
  if (sheetIsOpen($('#switcher'))) renderSwitcher();
}

function renderSwitcher() {
  renderSessions($('#session-list'), {
    sessions: state.sessions,
    currentId: state.current?.id,
    user: connection.agent?.user,
    onOpen: (id) => {
      closeSheet();
      if (id !== state.current?.id) attach(id);
    },
    onClose: closeSession,
    onRename: (session) => {
      const name = prompt('会话名称（留空恢复默认）', session.name ?? '');
      if (name !== null) connection.send({ t: 'rename', id: session.id, name });
    },
  });
}

function banner(text) {
  const element = $('#banner');
  element.hidden = !text;
  element.textContent = text ?? '';
}

function overlay(id) {
  for (const name of ['lock', 'offline']) $(`#${name}`).hidden = name !== id;
}

// ---- connection --------------------------------------------------------------------------------

connection.addEventListener('state', ({ detail }) => {
  const { state: now } = detail;
  app.dataset.state = now;
  $('#conn').dataset.state = now;
  if (now === 'ready') {
    overlay(null);
    banner(null);
    onReady(detail.message);
  } else if (now === 'waiting') {
    banner(null);
    overlay('offline');
  } else if (now === 'locked') {
    banner(null);
    if (detail.reason === 'logged-out') return location.replace('/');
    $('#lock-message').textContent = detail.reason === 'signed-out' ? '登录已过期' : '';
    overlay('lock');
  } else if (['connecting', 'retrying', 'handshaking'].includes(now)) {
    banner(state.current ? '正在重新连接…' : '正在连接…');
  }
  render();
});

function onReady(message) {
  state.sessions = message.sessions ?? [];
  const wanted = state.wanted ?? state.current?.id ?? localStorage.getItem(LAST_SESSION_KEY);
  state.wanted = null;
  const target = state.sessions.find((session) => session.id === wanted) ?? newest(state.sessions);
  state.current = null; // channels belonged to the previous connection
  if (target) attach(target.id);
  else createSession();
  resubscribePush();
}

connection.addEventListener('control', ({ detail: message }) => {
  if (message.t === 'sessions') updateSessions(message.items);
  else if (message.t === 'screen' && message.ch === state.current?.ch) {
    // Another device resized the session since we asked; take it back for this screen.
    const size = view.size;
    if (message.cols !== size.cols || message.rows !== size.rows) {
      state.lastSize = null;
      scheduleFit();
    }
  } else if (message.t === 'error' && !message.ref) {
    toast(`电脑报错：${message.code}`);
  }
});

connection.addEventListener('data', ({ detail }) => {
  const current = state.current;
  if (!current || detail.channel !== current.ch) return;
  const { length } = detail.data;
  const parsed = () => {
    current.parsed += length;
    scheduleAck(current);
  };
  if (detail.op === OP.SNAPSHOT) view.writeSnapshot(detail.data, parsed);
  else if (detail.op === OP.OUTPUT) view.writeOutput(detail.data, parsed);
});

function scheduleAck(current) {
  if (state.current !== current) return;
  if (current.parsed - current.acked >= ACK_EVERY_BYTES) return sendAck(current);
  clearTimeout(current.ackTimer);
  current.ackTimer = setTimeout(() => sendAck(current), ACK_DELAY_MS);
}

function sendAck(current) {
  clearTimeout(current.ackTimer);
  if (state.current !== current || current.parsed === current.acked) return;
  current.acked = current.parsed;
  connection.send({ t: 'ack', ch: current.ch, n: current.parsed });
}

connection.addEventListener('rtt', ({ detail }) => {
  $('#rtt').textContent = `${detail.rtt}ms`;
});

connection.addEventListener('visibility', ({ detail }) => syncFocus(detail.visible));

// Tells the Mac which session is on screen, so it does not push a notification about it.
function syncFocus(visible = document.visibilityState === 'visible') {
  if (connection.state === 'ready') connection.send({ t: 'focus', id: state.current?.id ?? null, visible });
}

// ---- input -------------------------------------------------------------------------------------

function sendText(text) {
  const current = state.current;
  if (!current || connection.state !== 'ready' || currentSession()?.exit) return false;
  if (!connection.input(current.ch, encoder.encode(text))) return false;
  if (!view.atBottom) view.scrollToBottom();
  return true;
}

view.addEventListener('input', ({ detail }) => {
  sendText(state.pasting ? detail : withModifiers(detail, keybar.consume()));
});

keybar.addEventListener('key', ({ detail }) => sendText(detail.data));
keybar.addEventListener('action', ({ detail }) => {
  if (detail.action === 'paste') paste();
});

async function paste() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return toast('没能读取剪贴板');
  }
  if (!text) return;
  if (compose.active) return compose.insert(text);
  state.pasting = true;
  view.paste(text);
  state.pasting = false;
}

view.addEventListener('alt-scroll', ({ detail }) => {
  const key = cursorKey(detail.lines > 0 ? 'A' : 'B', { applicationCursor: view.modes.applicationCursorKeysMode });
  sendText(key.repeat(Math.min(Math.abs(detail.lines), 6)));
});

view.addEventListener('bell', () => {
  app.classList.remove('bell');
  void app.offsetWidth; // restart the animation
  app.classList.add('bell');
});

view.addEventListener('scroll', ({ detail }) => {
  $('#to-bottom').hidden = detail.atBottom;
});
$('#to-bottom').addEventListener('click', () => view.scrollToBottom());

let hudTimer = 0;
view.attachGestures({
  onTap: () => {
    if (compose.active) compose.input.focus();
    else view.focus();
  },
  onLongPress: openSelectSheet,
  onZoom: (size) => {
    if (size !== view.fontSize) {
      view.fontSize = size;
      scheduleFit();
    }
    const hud = $('#hud');
    hud.hidden = false;
    requestAnimationFrame(() => {
      hud.textContent = `${view.fontSize} pt · ${view.size.cols}×${view.size.rows}`;
    });
  },
  onZoomEnd: () => {
    prefs.fontSize = view.fontSize;
    savePrefs();
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      $('#hud').hidden = true;
    }, 600);
  },
});

// ---- compose bar -------------------------------------------------------------------------------

function setComposeMode(active) {
  const keyboardWasUp = document.documentElement.dataset.keyboard === 'up';
  if (active) compose.open();
  else {
    compose.close();
    if (keyboardWasUp) view.focus();
  }
  $('#mode-button').dataset.mode = active ? 'compose' : 'direct';
  $('#mode-button').textContent = active ? '撰写' : '直接';
  prefs.compose = active;
  savePrefs();
}

$('#mode-button').addEventListener('pointerdown', (event) => event.preventDefault());
$('#mode-button').addEventListener('click', () => setComposeMode(!compose.active));

compose.addEventListener('send', async ({ detail: { text } }) => {
  if (!state.current) return;
  if (text && /\S/.test(text)) {
    const reason = dangerReason(text);
    if (reason && !(await confirmDialog({ title: '确认发送？', message: reason, confirm: '仍然发送', destructive: true }))) return;
  }
  // Several lines go in as one paste when the program supports it, so they are not run one by one.
  const lines = text.replace(/\r?\n/g, '\r');
  const body = text.includes('\n') && view.modes.bracketedPasteMode ? `\x1b[200~${lines}\x1b[201~` : lines;
  if (sendText(`${body}\r`)) compose.sent(text);
  else toast('还没连上，稍后再发');
});

$('#keyboard-button').addEventListener('pointerdown', (event) => event.preventDefault());
$('#keyboard-button').addEventListener('click', () => {
  if (document.documentElement.dataset.keyboard === 'up') {
    compose.input.blur();
    view.blur();
  } else if (compose.active) compose.input.focus();
  else view.focus();
});

// ---- sheets, menu, overlays -----------------------------------------------------------------------

$('#title-button').addEventListener('click', () => {
  renderSwitcher();
  openSheet($('#switcher'));
});
$('#menu-button').addEventListener('click', () => openSheet($('#menu')));
$('#backdrop').addEventListener('click', closeSheet);

function openSelectSheet() {
  view.blur();
  compose.input.blur();
  const pre = $('#select-text');
  pre.textContent = view.text();
  openSheet($('#select-sheet'));
  requestAnimationFrame(() => {
    pre.scrollTop = pre.scrollHeight;
  });
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('复制失败');
  }
}

async function openSettings() {
  openSheet($('#settings'));
  const rerender = () => renderSettings($('#settings-body'), context);
  const context = {
    connection,
    view,
    prefs,
    savePrefs,
    refit: scheduleFit,
    confirm: confirmDialog,
    rerender,
    onLock: lockNow,
    onLogout: logout,
  };
  await rerender();
}

function lockNow() {
  closeSheet();
  if (!connection.send({ t: 'lock' })) {
    clearTicket().then(() => connection.restart());
  }
}

async function logout() {
  closeSheet();
  if (!(await confirmDialog({ title: '退出登录？', message: '下次打开需要重新用面容 ID 登录。会话会留在电脑上。', confirm: '退出', destructive: true }))) return;
  await clearTicket();
  try {
    await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  } finally {
    location.replace('/');
  }
}

const actions = {
  'new-session': () => {
    closeSheet();
    createSession(currentSession()?.cwd);
  },
  'select-text': () => openSelectSheet(),
  settings: () => openSettings(),
  lock: () => lockNow(),
  'close-sheet': () => closeSheet(),
  'copy-all': () => copy(view.text()),
  'copy-last': () => {
    const text = view.lastOutputText();
    if (text === null) toast('没找到上一条命令的输出');
    else copy(text);
  },
  restart: async () => {
    const session = currentSession();
    if (!session) return;
    await createSession(session.cwd);
    connection.send({ t: 'close', id: session.id });
  },
  'close-current': () => {
    const session = currentSession();
    if (session) connection.send({ t: 'close', id: session.id });
  },
  retry: () => connection.restart(),
};

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (target && Object.hasOwn(actions, target.dataset.action)) actions[target.dataset.action]();
});

$('#unlock-button').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  $('#lock-message').textContent = '';
  try {
    const result = await login();
    if (!result.ticket) $('#lock-message').textContent = result.agentError === 'agent-offline' ? '电脑离线，恢复后再试' : '电脑没有签发凭据，请重试';
    else connection.restart();
  } catch (error) {
    $('#lock-message').textContent = describeError(error);
  } finally {
    button.disabled = false;
  }
});

// ---- notifications ------------------------------------------------------------------------------

// A subscription the Mac forgot (e.g. its push state was reset) is sent again after each connect.
async function resubscribePush() {
  const push = pushState();
  if (!push.supported || push.permission !== 'granted') return;
  const subscription = await currentSubscription().catch(() => null);
  if (subscription) enablePush(connection).catch(() => {});
}

navigator.serviceWorker?.addEventListener('message', (event) => {
  const id = event.data?.type === 'open-session' ? event.data.sessionId : null;
  if (!id) return;
  if (state.sessions.some((session) => session.id === id)) attach(id);
  else state.wanted = id;
});

window.addEventListener('hashchange', () => {
  const id = sessionFromHash();
  if (id && state.sessions.some((session) => session.id === id)) attach(id);
});

// ---- start ---------------------------------------------------------------------------------------

if (location.hostname === 'localhost') window.harbor = { connection, view, keybar, compose, state }; // for debugging

layout();
if (prefs.compose) setComposeMode(true);
registerWorker();
connection.start();
