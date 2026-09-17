// The row of keys above the phone keyboard. Buttons never take the focus, so the keyboard stays up.
// ctrl and ⌥ are sticky: tap once for the next key, double tap to lock, tap again to release.
import { KEYS, cursorKey, withModifiers } from './keys.js';

const REPEAT_DELAY_MS = 380;
const REPEAT_EVERY_MS = 50;
const DOUBLE_TAP_MS = 350;

export class KeyBar extends EventTarget {
  constructor(element, { modes }) {
    super();
    this.element = element;
    this.modes = modes; // () => the terminal's current modes
    this.mods = { ctrl: 'off', alt: 'off' };
    this.lastTap = { ctrl: 0, alt: 0 };
    element.replaceChildren(...KEYS.map((key) => this.button(key)));
    this.sync();
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  button(key) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'key';
    button.dataset.key = key.id;
    button.textContent = key.label;
    let delay = null;
    let interval = null;
    let repeated = false;
    const release = () => {
      clearTimeout(delay);
      clearInterval(interval);
      delay = null;
      interval = null;
      button.classList.remove('pressed');
    };
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault(); // keep the focus, and with it the keyboard
      button.classList.add('pressed');
      repeated = false;
      if (key.repeat) {
        delay = setTimeout(() => {
          repeated = true;
          this.press(key);
          interval = setInterval(() => this.press(key), REPEAT_EVERY_MS);
        }, REPEAT_DELAY_MS);
      }
    });
    button.addEventListener('pointerup', () => {
      const alreadySent = repeated;
      release();
      if (!alreadySent) this.press(key);
    });
    // Scrolling the bar sideways cancels the press instead of sending the key.
    button.addEventListener('pointercancel', release);
    button.addEventListener('contextmenu', (event) => event.preventDefault());
    return button;
  }

  press(key) {
    navigator.vibrate?.(5);
    if (key.modifier) return this.toggle(key.modifier);
    if (key.action) return this.emit('action', { action: key.action });
    const mods = this.consume();
    const data = key.cursor
      ? cursorKey(key.cursor, { ...mods, applicationCursor: this.modes()?.applicationCursorKeysMode === true })
      : withModifiers(key.send, mods);
    this.emit('key', { data, id: key.id });
  }

  toggle(name) {
    const now = performance.now();
    const quick = now - this.lastTap[name] < DOUBLE_TAP_MS;
    const state = this.mods[name];
    this.mods[name] = state === 'locked' ? 'off' : quick ? 'locked' : state === 'off' ? 'once' : 'off';
    this.lastTap[name] = now;
    this.sync();
  }

  // Modifiers for the key being sent now; one-shot modifiers switch off afterwards.
  consume() {
    const active = { ctrl: this.mods.ctrl !== 'off', alt: this.mods.alt !== 'off' };
    let changed = false;
    for (const name of ['ctrl', 'alt']) {
      if (this.mods[name] === 'once') {
        this.mods[name] = 'off';
        changed = true;
      }
    }
    if (changed) this.sync();
    return active;
  }

  sync() {
    for (const name of ['ctrl', 'alt']) this.element.querySelector(`[data-key="${name}"]`)?.setAttribute('data-state', this.mods[name]);
  }
}
