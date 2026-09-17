// The phone side of the protocol: one WebSocket to the relay, an end-to-end channel to the Mac on
// top of it, and the reconnect behaviour that makes a dropped connection feel like nothing.
import { startResume } from '/shared/channel.js';
import { OP, OUTER, controlFrame, dataFrame, handshakeFrame, outer, parseInner, parseOuter } from '/shared/frames.js';
import { clearTicket, loadTicket } from '/lib/tickets.js';

const PING_EVERY_MS = 10_000;
const PONG_TIMEOUT_MS = 6_000;
const QUICK_PONG_TIMEOUT_MS = 2_500;
const STALE_AFTER_HIDDEN_MS = 15_000; // iOS freezes background pages; after this long, do not trust the socket
const RETRY_STEPS_MS = [300, 1000, 2000, 4000, 8000];
const REQUEST_TIMEOUT_MS = 15_000;

// States: connecting → waiting (relay reached, Mac offline) → handshaking → ready;
// retrying (between attempts); locked (needs Face ID; detail.reason says why).
export class Connection extends EventTarget {
  constructor({ url = `${location.origin.replace(/^http/, 'ws')}/ws` } = {}) {
    super();
    this.url = url;
    this.state = 'idle';
    this.ws = null;
    this.channel = null;
    this.resume = null;
    this.ticket = null;
    this.attempt = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.hiddenAt = 0;
    this.refs = 0;
    this.pending = new Map(); // ref -> { resolve, reject, timer }
    this.inbox = Promise.resolve();
    this.rtt = null;
    this.agent = null;
    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('online', () => this.reconnectNow());
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setState(state, detail = {}) {
    this.state = state;
    this.emit('state', { state, ...detail });
  }

  // ---- connecting ----------------------------------------------------------------------------

  async start() {
    clearTimeout(this.retryTimer);
    if (this.ws) return;
    this.ticket = await loadTicket();
    if (!this.ticket) return this.setState('locked', { reason: 'no-ticket' });
    if (this.ws) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'retrying');
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (event) => {
      this.inbox = this.inbox.then(() => this.receive(ws, event.data)).catch(() => this.abort(ws));
    };
    ws.onclose = (event) => this.closed(ws, event);
  }

  reconnectNow() {
    if (this.state === 'locked' || this.ws) return;
    this.attempt = 0;
    this.start();
  }

  // Unlock (after Face ID) or a manual retry: forget the old socket and start over.
  restart() {
    if (this.ws) this.abort(this.ws, { silent: true });
    this.attempt = 0;
    this.start();
  }

  abort(ws, { silent = false } = {}) {
    if (this.ws !== ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      // already closing
    }
    this.closed(ws, { code: 1006, reason: '' }, { silent });
  }

  async closed(ws, event, { silent = false } = {}) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.channel = null;
    this.resume = null;
    this.stopPing();
    this.failPending('disconnected');
    if (event.code === 4401) {
      if (event.reason !== 'logged-out') await clearTicket();
      return this.setState('locked', { reason: event.reason || 'ticket' });
    }
    if (silent || this.state === 'locked') return;
    // A refused upgrade (expired cookie) looks like any network error from here: ask the relay.
    if (this.attempt > 0) {
      try {
        const status = await fetch('/api/status', { cache: 'no-store' });
        if (status.status === 401) return this.setState('locked', { reason: 'signed-out' });
      } catch {
        // offline; keep retrying
      }
    }
    this.scheduleRetry();
  }

  scheduleRetry() {
    const delay = RETRY_STEPS_MS[Math.min(this.attempt, RETRY_STEPS_MS.length - 1)];
    this.attempt += 1;
    this.setState('retrying', { delay });
    clearTimeout(this.retryTimer);
    // A hidden page retries when it becomes visible instead (see onVisibility).
    if (document.visibilityState === 'visible') this.retryTimer = setTimeout(() => this.start(), delay * (0.8 + Math.random() * 0.4));
  }

  onVisibility() {
    const visible = document.visibilityState === 'visible';
    if (!visible) {
      this.hiddenAt = Date.now();
      this.emit('visibility', { visible });
      return;
    }
    const hiddenFor = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
    this.emit('visibility', { visible, hiddenFor });
    if (!this.ws) return this.reconnectNow();
    if (hiddenFor > STALE_AFTER_HIDDEN_MS) return this.restart();
    if (this.state === 'ready') this.ping(QUICK_PONG_TIMEOUT_MS);
  }

  // ---- receiving -----------------------------------------------------------------------------

  async receive(ws, data) {
    if (this.ws !== ws) return;
    if (typeof data === 'string') {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.type !== 'agent') return;
      if (message.online) return this.hello(ws);
      this.channel = null;
      this.stopPing();
      this.failPending('agent-offline');
      return this.setState('waiting');
    }
    const frame = parseOuter(new Uint8Array(data));
    if (!frame) throw new Error('bad frame');
    if (frame.type === OUTER.HANDSHAKE) {
      if (frame.message.t === 'welcome' && this.resume) {
        this.channel = await this.resume.finish(frame.message);
        this.resume = null;
      }
      return; // a reject is followed by close code 4401
    }
    if (this.channel) await this.channel.receive(frame.payload, (plain) => this.deliver(plain));
  }

  async hello(ws) {
    this.channel = null;
    this.setState('handshaking');
    this.resume = await startResume(this.ticket);
    if (this.ws === ws && ws.readyState === WebSocket.OPEN) ws.send(handshakeFrame(this.resume.hello));
  }

  deliver(plain) {
    const frame = parseInner(plain);
    if (!frame) return;
    if (frame.op !== OP.CONTROL) return this.emit('data', frame);
    const message = frame.message;
    if (message.t === 'ready') {
      this.attempt = 0;
      this.agent = message.agent;
      this.setState('ready', { message });
      this.startPing();
    } else if (message.t === 'pong') {
      clearTimeout(this.pongTimer);
      if (typeof message.ts === 'number') {
        this.rtt = Math.round(performance.now() - message.ts);
        this.emit('rtt', { rtt: this.rtt });
      }
    }
    if (message.ref && this.pending.has(message.ref)) {
      const { resolve, reject, timer } = this.pending.get(message.ref);
      this.pending.delete(message.ref);
      clearTimeout(timer);
      if (message.t === 'error') reject(Object.assign(new Error(message.code), { code: message.code }));
      else resolve(message);
    }
    this.emit('control', message);
  }

  // ---- sending -------------------------------------------------------------------------------

  sealed(plain) {
    const { ws, channel } = this;
    if (!channel || ws?.readyState !== WebSocket.OPEN) return false;
    channel.send(plain, (ciphertext) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(outer(OUTER.SEALED, ciphertext));
    }).catch(() => this.abort(ws));
    return true;
  }

  send(message) {
    return this.sealed(controlFrame(message));
  }

  input(channel, bytes) {
    for (let offset = 0; offset < bytes.length; offset += 16_384) {
      if (!this.sealed(dataFrame(OP.INPUT, channel, bytes.subarray(offset, offset + 16_384)))) return false;
    }
    return true;
  }

  request(message, timeout = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      this.refs += 1;
      const ref = `r${this.refs}`;
      if (!this.send({ ...message, ref })) return reject(Object.assign(new Error('offline'), { code: 'offline' }));
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
      }, timeout);
      this.pending.set(ref, { resolve, reject, timer });
    });
  }

  failPending(code) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(Object.assign(new Error(code), { code }));
    }
    this.pending.clear();
  }

  // ---- liveness ------------------------------------------------------------------------------

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
    this.ping();
  }

  stopPing() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
  }

  // A socket that died without a close (tunnel, lift, sleep) is only found by a missing pong.
  ping(timeout = PONG_TIMEOUT_MS) {
    if (document.visibilityState !== 'visible' || this.state !== 'ready') return;
    const { ws } = this;
    if (!this.send({ t: 'ping', ts: performance.now() })) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => this.abort(ws), timeout);
  }
}
