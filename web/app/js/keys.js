// What the special keys send. Arrows follow the program's cursor-key mode (vim and less switch
// it), and modified keys use xterm's encoding: ESC [ 1 ; <1 + alt·2 + ctrl·4> <final>.
export function withModifiers(data, { ctrl = false, alt = false } = {}) {
  let out = data;
  if (ctrl && [...out].length === 1) {
    const code = out.toUpperCase().charCodeAt(0);
    if (code >= 0x40 && code <= 0x5f) out = String.fromCharCode(code - 0x40); // @ A-Z [ \ ] ^ _
    else if (out === ' ' || out === '2') out = '\x00';
    else if (out === '/' || out === '7') out = '\x1f';
    else if (out === '?' || out === '8') out = '\x7f';
  }
  if (alt && out.length > 0) out = `\x1b${out}`;
  return out;
}

export function cursorKey(final, { ctrl = false, alt = false, applicationCursor = false } = {}) {
  const modifier = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  if (modifier > 1) return `\x1b[1;${modifier}${final}`;
  return applicationCursor ? `\x1bO${final}` : `\x1b[${final}`;
}

// The key bar, left to right. `repeat` keys auto-repeat while held.
export const KEYS = [
  { id: 'esc', label: 'esc', send: '\x1b' },
  { id: 'tab', label: 'tab', send: '\t' },
  { id: 'ctrl', label: 'ctrl', modifier: 'ctrl' },
  { id: 'alt', label: '⌥', modifier: 'alt' },
  { id: 'left', label: '←', cursor: 'D', repeat: true },
  { id: 'up', label: '↑', cursor: 'A', repeat: true },
  { id: 'down', label: '↓', cursor: 'B', repeat: true },
  { id: 'right', label: '→', cursor: 'C', repeat: true },
  { id: 'shift-tab', label: '⇧tab', send: '\x1b[Z' },
  { id: 'ctrl-c', label: '^C', send: '\x03' },
  { id: 'pipe', label: '|', send: '|' },
  { id: 'slash', label: '/', send: '/' },
  { id: 'dash', label: '-', send: '-' },
  { id: 'tilde', label: '~', send: '~' },
  { id: 'backtick', label: '`', send: '`' },
  { id: 'home', label: 'home', cursor: 'H' },
  { id: 'end', label: 'end', cursor: 'F' },
  { id: 'page-up', label: 'pgup', send: '\x1b[5~', repeat: true },
  { id: 'page-down', label: 'pgdn', send: '\x1b[6~', repeat: true },
  { id: 'paste', label: '粘贴', action: 'paste' },
];
