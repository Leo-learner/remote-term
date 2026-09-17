// The terminal on screen: xterm.js with the owner's Ghostty look (Catppuccin Mocha, Menlo), sized
// to its box, and touch handling of our own: drag to scroll with momentum, pinch for font size,
// tap for the keyboard, long press to select text.
import { Unicode11Addon } from '../vendor/addon-unicode11.mjs';
import { WebglAddon } from '../vendor/addon-webgl.mjs';
import { Terminal } from '../vendor/xterm.mjs';

export const MOCHA = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#585b70',
  selectionForeground: '#cdd6f4',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#a6adc8',
  brightBlack: '#585b70',
  brightRed: '#f37799',
  brightGreen: '#89d88b',
  brightYellow: '#ebd391',
  brightBlue: '#74a8fc',
  brightMagenta: '#f2aede',
  brightCyan: '#6bd7ca',
  brightWhite: '#bac2de',
};

export const FONT_SIZES = { min: 9, max: 24 };
const RIS = new Uint8Array([0x1b, 0x63]); // full reset, so a snapshot replaces the screen in one parse
const LONG_PRESS_MS = 550;
const TAP_SLOP_PX = 8;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const spread = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

export class TerminalView extends EventTarget {
  // The DOM renderer is the default: crisp at any pixel ratio, system fonts for Chinese and emoji.
  // WebGL is faster for floods of output; try it with ?renderer=webgl.
  constructor(host, { fontSize = 13, renderer = 'dom' } = {}) {
    super();
    this.host = host;
    this.term = new Terminal({
      fontFamily: 'Menlo, "SF Mono", ui-monospace, "PingFang SC", monospace',
      fontSize: clamp(fontSize, FONT_SIZES.min, FONT_SIZES.max),
      lineHeight: 1.1,
      theme: MOCHA,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      smoothScrollDuration: 0,
      rescaleOverlappingGlyphs: true,
    });
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11'; // same as the Mac's parser, so wide characters line up
    this.term.open(host);
    if (renderer === 'webgl') this.enableWebgl();
    this.watchCommands();
    this.term.onData((data) => this.emit('input', data));
    this.term.onBinary((data) => this.emit('input', data));
    this.term.onBell(() => this.emit('bell'));
    this.term.onScroll(() => this.emit('scroll', { atBottom: this.atBottom }));
    this.term.onCursorMove(() => this.emit('cursor'));
    this.term.onWriteParsed(() => {
      if (!this.atBottom) this.emit('scroll', { atBottom: false, output: true });
    });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  enableWebgl() {
    try {
      const webgl = new WebglAddon();
      // iOS drops GPU contexts of backgrounded pages; rebuild instead of going blank.
      webgl.onContextLoss(() => {
        webgl.dispose();
        setTimeout(() => this.enableWebgl(), 300);
      });
      this.term.loadAddon(webgl);
    } catch {
      // the DOM renderer stays in charge
    }
  }

  // Marks from the Mac's shell integration: where the last command's output starts and ends.
  watchCommands() {
    this.term.parser.registerOscHandler(133, (data) => {
      if (data.startsWith('C')) {
        this.outputStart?.dispose();
        this.outputStart = this.term.registerMarker(0);
      } else if (data.startsWith('D') && this.outputStart) {
        this.lastOutput?.start.dispose();
        this.lastOutput?.end.dispose();
        this.lastOutput = { start: this.outputStart, end: this.term.registerMarker(0) };
        this.outputStart = null;
      }
      return false;
    });
  }

  // ---- size ----------------------------------------------------------------------------------

  // FitAddon keeps 14px for a scrollbar we hide; on a phone that is two columns, so fit by hand.
  fit() {
    const cell = this.term._core?._renderService?.dimensions?.css?.cell;
    if (!cell?.width || !cell?.height) return null;
    const cols = Math.max(20, Math.floor(this.host.clientWidth / cell.width));
    const rows = Math.max(5, Math.floor(this.host.clientHeight / cell.height));
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
    return { cols, rows };
  }

  get size() {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  get fontSize() {
    return this.term.options.fontSize;
  }

  set fontSize(size) {
    this.term.options.fontSize = clamp(Math.round(size), FONT_SIZES.min, FONT_SIZES.max);
  }

  // The cursor's row on screen, counted from the top of the visible rows.
  get cursorRow() {
    const buffer = this.term.buffer.active;
    return buffer.baseY + buffer.cursorY - buffer.viewportY;
  }

  get cellHeight() {
    return this.term._core?._renderService?.dimensions?.css?.cell?.height || 16;
  }

  // ---- content -------------------------------------------------------------------------------

  // `done` runs once xterm has parsed the bytes: acknowledging only then makes a phone that
  // renders slowly look as slow as it is, so the Mac stops pushing and sends a fresh screen later.
  writeSnapshot(bytes, done) {
    const data = new Uint8Array(RIS.length + bytes.length);
    data.set(RIS);
    data.set(bytes, RIS.length);
    this.lastOutput = null;
    this.term.write(data, done);
  }

  writeOutput(bytes, done) {
    this.term.write(bytes, done);
  }

  reset() {
    this.term.reset();
  }

  paste(text) {
    this.term.paste(text); // xterm adds bracketed-paste markers when the program asked for them
  }

  get modes() {
    return this.term.modes;
  }

  get atBottom() {
    const buffer = this.term.buffer.active;
    return buffer.viewportY >= buffer.baseY;
  }

  scrollToBottom() {
    this.term.scrollToBottom();
  }

  focus() {
    this.term.focus();
  }

  blur() {
    this.term.blur();
  }

  get focused() {
    return document.activeElement === this.term.textarea;
  }

  lines(from, to) {
    const buffer = this.term.buffer.active;
    const out = [];
    for (let y = Math.max(0, from); y < Math.min(to, buffer.length); y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
      else out.push(text);
    }
    return out.join('\n').replace(/\s+$/, '');
  }

  text(maxLines = 3000) {
    const { length } = this.term.buffer.active;
    return this.lines(length - maxLines, length);
  }

  lastOutputText() {
    const { start, end } = this.lastOutput ?? {};
    if (!start || !end || start.line < 0 || end.line < 0) return null;
    return this.lines(start.line, end.line);
  }

  // ---- touch ---------------------------------------------------------------------------------

  // Handlers run in the capture phase and stop there, so xterm's own touch code (which scrolls
  // and selects in ways that fight a phone keyboard) never sees these touches.
  attachGestures({ onTap, onLongPress, onZoom, onZoomEnd }) {
    const el = this.host;
    let touch = null;
    let pinch = null;
    let momentum = 0;

    const stop = (event) => {
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    };

    el.addEventListener('touchstart', (event) => {
      stop(event);
      cancelAnimationFrame(momentum);
      if (event.touches.length === 2) {
        clearTimeout(touch?.longTimer);
        touch = null;
        pinch = { spread: spread(event.touches), size: this.fontSize };
        return;
      }
      if (event.touches.length !== 1 || pinch) return;
      const point = event.touches[0];
      const now = performance.now();
      touch = { x: point.clientX, y: point.clientY, lastY: point.clientY, moved: false, long: false, acc: 0, samples: [{ y: point.clientY, t: now }] };
      touch.longTimer = setTimeout(() => {
        if (touch && !touch.moved) {
          touch.long = true;
          onLongPress?.();
        }
      }, LONG_PRESS_MS);
    }, { passive: false, capture: true });

    el.addEventListener('touchmove', (event) => {
      stop(event);
      if (pinch && event.touches.length === 2) {
        onZoom?.(clamp(Math.round(pinch.size * (spread(event.touches) / pinch.spread)), FONT_SIZES.min, FONT_SIZES.max));
        return;
      }
      if (!touch || event.touches.length !== 1) return;
      const point = event.touches[0];
      if (!touch.moved && Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > TAP_SLOP_PX) {
        touch.moved = true;
        clearTimeout(touch.longTimer);
      }
      if (!touch.moved) return;
      const dy = point.clientY - touch.lastY;
      touch.lastY = point.clientY;
      touch.samples.push({ y: point.clientY, t: performance.now() });
      if (touch.samples.length > 5) touch.samples.shift();
      this.scrollByPixels(dy, touch);
    }, { passive: false, capture: true });

    el.addEventListener('touchend', (event) => {
      stop(event);
      if (pinch) {
        if (event.touches.length < 2) {
          pinch = null;
          onZoomEnd?.();
        }
        return;
      }
      if (!touch) return;
      clearTimeout(touch.longTimer);
      const ended = touch;
      touch = null;
      if (ended.long) return;
      if (!ended.moved) return onTap?.();
      // Keep gliding in the scrollback, the way a native list does.
      if (this.term.buffer.active.type !== 'normal') return;
      const first = ended.samples[0];
      const last = ended.samples[ended.samples.length - 1];
      let velocity = (last.y - first.y) / Math.max(1, last.t - first.t);
      if (Math.abs(velocity) < 0.25) return;
      let previous = performance.now();
      const glide = (now) => {
        const dt = now - previous;
        previous = now;
        velocity *= 0.995 ** dt;
        this.scrollByPixels(velocity * dt, ended);
        if (Math.abs(velocity) > 0.03 && !(velocity < 0 && this.atBottom)) momentum = requestAnimationFrame(glide);
      };
      momentum = requestAnimationFrame(glide);
    }, { passive: false, capture: true });

    el.addEventListener('touchcancel', (event) => {
      event.stopPropagation();
      clearTimeout(touch?.longTimer);
      touch = null;
      if (pinch) {
        pinch = null;
        onZoomEnd?.();
      }
    }, { capture: true });
  }

  // Finger down shows earlier lines. Full-screen programs (less, vim, htop) have no scrollback of
  // ours to move through, so they get arrow keys instead.
  scrollByPixels(dy, state) {
    state.acc += dy;
    const cell = this.cellHeight;
    const lines = Math.trunc(state.acc / cell);
    if (lines === 0) return;
    state.acc -= lines * cell;
    if (this.term.buffer.active.type === 'normal') this.term.scrollLines(-lines);
    else this.emit('alt-scroll', { lines });
  }
}
