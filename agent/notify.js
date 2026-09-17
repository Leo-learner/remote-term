// Push notifications, sent from this Mac straight to the phone's push service (Apple's, for an
// iPhone home screen app). Web Push encrypts the payload to keys the phone generated, so neither
// the relay nor Apple can read it. shouldNotify() decides which terminal events deserve a buzz.
import { basename } from 'node:path';
import webpush from 'web-push';
import { JsonFile } from './store.js';

// Only real push services: the endpoint comes from the phone, and this Mac should not be made to
// POST to arbitrary addresses.
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const DEFAULT_PREFS = { commands: true, minSeconds: 30, bells: true, programs: true };
const BELL_GAP_MS = 30_000;
const MAX_SUBSCRIPTIONS = 10;

class PushError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// event.kind: 'command' (a command finished), 'bell', 'program' (OSC 9/777 from a program)
export function shouldNotify(event, { prefs, focused }) {
  if (focused) return false; // the phone is showing that session right now
  switch (event.kind) {
    case 'command':
      return prefs.commands && event.durationMs >= prefs.minSeconds * 1000;
    case 'bell':
      return prefs.bells;
    case 'program':
      return prefs.programs;
    default:
      return false;
  }
}

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

const cut = (text, length) => {
  const value = String(text ?? '').trim();
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
};

export function sessionLabel(session) {
  const process = session.foreground?.() ?? null;
  const shell = process && /^-?(zsh|bash|fish|sh|login)$/.test(process);
  return session.name || (process && !shell ? process : '') || (session.cwd ? basename(session.cwd) : '') || 'shell';
}

export function describe(event) {
  if (event.kind === 'command') {
    const took = `用时 ${formatDuration(event.durationMs)}`;
    return event.exitCode === 0
      ? { title: `完成 · ${cut(event.command, 40)}`, body: `${took} · ${event.label}` }
      : { title: `失败 · ${cut(event.command, 40)}`, body: `退出码 ${event.exitCode ?? '?'} · ${took} · ${event.label}` };
  }
  if (event.kind === 'bell') return { title: `${event.label} 响铃了`, body: '' };
  if (event.kind === 'program') {
    const fromClaude = /claude/i.test(event.process ?? '') || /claude/i.test(event.title ?? '');
    return { title: cut(event.title || (fromClaude ? 'Claude Code' : event.label), 60), body: cut(event.body, 180) };
  }
  return { title: cut(event.title, 60), body: cut(event.body, 180) };
}

export class Notifier {
  constructor({ file, subject, send = webpush.sendNotification, now = Date.now, log = () => {}, isFocused = () => false, proxy }) {
    this.store = new JsonFile(file, { vapid: null, subscriptions: [], prefs: {} });
    this.subject = /^https:\/\//.test(subject ?? '') && !/^https:\/\/localhost\b/.test(subject) ? subject : 'mailto:owner@remote-term.invalid';
    this.send = send;
    this.now = now;
    this.log = log;
    this.isFocused = isFocused;
    this.proxy = proxy;
    this.lastBell = new Map();
  }

  async load() {
    const value = await this.store.load();
    if (!value.vapid?.publicKey || !value.vapid?.privateKey) {
      value.vapid = webpush.generateVAPIDKeys();
      await this.store.save();
    }
    if (!Array.isArray(value.subscriptions)) value.subscriptions = [];
    if (!value.prefs || typeof value.prefs !== 'object') value.prefs = {};
    return this;
  }

  get publicKey() {
    return this.store.value.vapid.publicKey;
  }

  get prefs() {
    return { ...DEFAULT_PREFS, ...this.store.value.prefs };
  }

  get subscriptions() {
    return this.store.value.subscriptions;
  }

  setPrefs(prefs) {
    const next = {};
    for (const key of ['commands', 'bells', 'programs']) if (typeof prefs?.[key] === 'boolean') next[key] = prefs[key];
    const minSeconds = Number(prefs?.minSeconds);
    if (Number.isInteger(minSeconds) && minSeconds >= 0 && minSeconds <= 86_400) next.minSeconds = minSeconds;
    this.store.value.prefs = { ...this.store.value.prefs, ...next };
    this.store.save();
    return this.prefs;
  }

  subscribe(credentialId, subscription, prefs) {
    let url;
    try {
      url = new URL(String(subscription?.endpoint ?? ''));
    } catch {
      throw new PushError('bad-subscription');
    }
    if (url.protocol !== 'https:' || !PUSH_HOSTS.some((host) => host.test(url.hostname))) throw new PushError('bad-subscription');
    const { p256dh, auth } = subscription.keys ?? {};
    if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) {
      throw new PushError('bad-subscription');
    }
    const list = this.subscriptions.filter((item) => item.endpoint !== url.href);
    list.push({ credentialId, endpoint: url.href, keys: { p256dh, auth }, createdAt: this.now() });
    while (list.length > MAX_SUBSCRIPTIONS) list.shift();
    this.store.value.subscriptions = list;
    this.store.save();
    if (prefs) this.setPrefs(prefs);
  }

  unsubscribe(endpoint) {
    this.store.value.subscriptions = this.subscriptions.filter((item) => item.endpoint !== endpoint);
    this.store.save();
  }

  removeCredential(credentialId) {
    this.store.value.subscriptions = this.subscriptions.filter((item) => item.credentialId !== credentialId);
    this.store.save();
  }

  async notify(event) {
    if (this.subscriptions.length === 0) return 0;
    const focused = event.sessionId ? this.isFocused(event.sessionId) : false;
    if (!shouldNotify(event, { prefs: this.prefs, focused })) return 0;
    if (event.kind === 'bell') {
      const at = this.now();
      if (at - (this.lastBell.get(event.sessionId) ?? -Infinity) < BELL_GAP_MS) return 0;
      this.lastBell.set(event.sessionId, at);
    }
    const payload = { ...describe(event), kind: event.kind, sessionId: event.sessionId ?? null, at: this.now() };
    return this.deliver(this.subscriptions, payload, event.sessionId);
  }

  test(credentialId) {
    const mine = this.subscriptions.filter((item) => item.credentialId === credentialId);
    return this.deliver(mine, { title: '通知已开启', body: '这是一条测试通知', kind: 'test', sessionId: null, at: this.now() });
  }

  async deliver(subscriptions, payload, topic) {
    const { publicKey, privateKey } = this.store.value.vapid;
    const results = await Promise.all(subscriptions.map(async (item) => {
      try {
        await this.send({ endpoint: item.endpoint, keys: item.keys }, JSON.stringify(payload), {
          vapidDetails: { subject: this.subject, publicKey, privateKey },
          TTL: 3600,
          urgency: 'high',
          timeout: 15_000,
          ...(topic ? { topic } : {}), // a newer push for the same session replaces an undelivered one
          ...(this.proxy ? { proxy: this.proxy } : {}),
        });
        return 1;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) this.unsubscribe(item.endpoint); // the phone dropped it
        this.log('push-failed', { status: error.statusCode ?? null, message: error.message });
        return 0;
      }
    }));
    return results.reduce((total, sent) => total + sent, 0);
  }

  flush() {
    return this.store.tail;
  }
}
