// Small DOM helpers: element builder, bottom sheets, toast, confirm dialog, labels.
export const $ = (selector, root = document) => root.querySelector(selector);

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') element.className = value;
    else if (name === 'dataset') Object.assign(element.dataset, value);
    else if (name.startsWith('on') && typeof value === 'function') element.addEventListener(name.slice(2), value);
    else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, String(value));
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

let openedSheet = null;

export function openSheet(sheet) {
  if (openedSheet === sheet) return;
  closeSheet();
  openedSheet = sheet;
  sheet.hidden = false;
  document.documentElement.dataset.sheet = sheet.id;
  requestAnimationFrame(() => sheet.classList.add('open'));
}

export function closeSheet() {
  if (!openedSheet) return;
  const sheet = openedSheet;
  openedSheet = null;
  sheet.classList.remove('open');
  delete document.documentElement.dataset.sheet;
  setTimeout(() => {
    if (openedSheet !== sheet) sheet.hidden = true;
  }, 220);
}

export const sheetIsOpen = (sheet) => openedSheet === sheet;

let toastTimer = null;
export function toast(text, ms = 2200) {
  const element = $('#toast');
  element.textContent = text;
  element.hidden = false;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.classList.remove('show');
    setTimeout(() => {
      element.hidden = true;
    }, 200);
  }, ms);
}

export function confirmDialog({ title, message, confirm = '确定', cancel = '取消', destructive = false }) {
  const dialog = $('#confirm');
  $('.dialog-title', dialog).textContent = title;
  $('.dialog-message', dialog).textContent = message;
  const ok = $('[data-choice="ok"]', dialog);
  const no = $('[data-choice="cancel"]', dialog);
  ok.textContent = confirm;
  ok.classList.toggle('destructive', destructive);
  no.textContent = cancel;
  dialog.hidden = false;
  return new Promise((resolve) => {
    const done = (answer) => {
      dialog.hidden = true;
      ok.onclick = null;
      no.onclick = null;
      resolve(answer);
    };
    ok.onclick = () => done(true);
    no.onclick = () => done(false);
  });
}

export function basename(path) {
  if (!path) return '';
  const parts = String(path).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '/';
}

export function shortPath(path, user) {
  if (!path) return '';
  const home = user ? `/Users/${user}` : null;
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

const SHELLS = /^-?(zsh|bash|fish|sh|login)$/;

// "claude · mac-remote", "vim · notes", or the folder when the shell is idle.
export function sessionLabel(session) {
  if (!session) return '';
  if (session.name) return session.name;
  const folder = basename(session.cwd) || '~';
  const program = session.process && !SHELLS.test(session.process) ? session.process : null;
  return program ? `${program} · ${folder}` : folder;
}

export function relativeTime(ts, now = Date.now()) {
  const seconds = Math.round((now - ts) / 1000);
  if (seconds < 45) return '刚刚';
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} 小时前`;
  const date = new Date(ts);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}
