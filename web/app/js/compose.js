// The compose bar: a native text field for writing a whole line. Chinese input, dictation and
// moving the cursor are all local and instant; the line crosses the network once, on send.
const HISTORY_KEY = 'harbor.history';
const HISTORY_MAX = 50;
const SECRET_LIKE = /(pass(word)?|passwd|secret|token|api[_-]?key|authorization)\s*[=:]/i;

export class Compose extends EventTarget {
  constructor({ form, input }) {
    super();
    this.form = form;
    this.input = input;
    input.addEventListener('keydown', (event) => {
      // The Return that picks a Chinese candidate belongs to the input method, not to us.
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      if (event.shiftKey || event.altKey) return; // a new line
      event.preventDefault();
      this.submit();
    });
    input.addEventListener('input', () => this.autosize());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get active() {
    return !this.form.hidden;
  }

  open() {
    this.form.hidden = false;
    this.input.focus();
    this.emit('toggle', { active: true });
  }

  close() {
    this.form.hidden = true;
    this.emit('toggle', { active: false });
  }

  submit() {
    this.emit('send', { text: this.input.value });
  }

  // Called once the line was really sent.
  sent(text) {
    this.input.value = '';
    this.autosize();
    this.remember(text);
  }

  insert(text) {
    const { selectionStart, selectionEnd, value } = this.input;
    this.input.value = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
    this.input.selectionStart = this.input.selectionEnd = selectionStart + text.length;
    this.autosize();
  }

  history() {
    try {
      const list = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
      return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  // Lines that look like they carry a secret are not written to the phone's storage.
  remember(text) {
    if (!text.trim() || SECRET_LIKE.test(text)) return;
    const list = [text, ...this.history().filter((item) => item !== text)].slice(0, HISTORY_MAX);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch {
      // storage full or unavailable
    }
  }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 132)}px`;
  }
}
