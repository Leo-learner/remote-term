// The session list sheet.
import { h, relativeTime, sessionLabel, shortPath } from './ui.js';

function status(session) {
  if (session.exit) return { text: session.exit.signal ? `已结束 · ${session.exit.signal}` : `已结束 · 退出码 ${session.exit.code}`, kind: 'exited' };
  if (session.command) return { text: `运行中 · ${session.command.text || '命令'}`, kind: 'running' };
  return { text: '空闲', kind: 'idle' };
}

export function renderSessions(list, { sessions, currentId, user, onOpen, onClose, onRename }) {
  const sorted = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  list.replaceChildren(...sorted.map((session) => {
    const { text, kind } = status(session);
    let pressTimer = null;
    let longPressed = false; // a long press renames; the click that follows it must not switch
    return h('li', { class: `session${session.id === currentId ? ' current' : ''}`, dataset: { status: kind } },
      h('button', {
        class: 'session-main',
        type: 'button',
        onclick: () => {
          if (longPressed) {
            longPressed = false;
            return;
          }
          onOpen(session.id);
        },
        onpointerdown: () => {
          longPressed = false;
          pressTimer = setTimeout(() => {
            longPressed = true;
            onRename(session);
          }, 600);
        },
        onpointerup: () => clearTimeout(pressTimer),
        onpointercancel: () => clearTimeout(pressTimer),
        oncontextmenu: (event) => event.preventDefault(),
      },
      h('span', { class: 'session-top' },
        h('span', { class: 'session-name' }, sessionLabel(session)),
        h('span', { class: 'session-time' }, relativeTime(session.lastOutputAt))),
      h('span', { class: 'session-cwd' }, shortPath(session.cwd, user)),
      h('code', { class: 'session-preview' }, session.preview || ' '),
      h('span', { class: 'session-status' }, text)),
      h('button', { class: 'session-close', type: 'button', 'aria-label': '关闭会话', onclick: () => onClose(session) }, '×'));
  }));
}
