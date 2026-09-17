// Relay-side sessions and login throttling. The relay is only the outer door: a cookie lets a
// browser load the app and open a WebSocket, but a shell needs a ticket that only the Mac issues.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DAY = 24 * 3600_000;
const PERSIST_SEEN_EVERY_MS = 10 * 60_000;

// Keyed by SHA-256 of the cookie value and persisted, so a relay restart (every deploy) does not
// log the phone out, and the file on disk holds no usable cookie.
export class SessionStore {
  constructor({ file, idleMs = 30 * DAY, absoluteMs = 90 * DAY, now = Date.now, maxSessions = 50 }) {
    this.file = file;
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
    this.now = now;
    this.maxSessions = maxSessions;
    this.entries = new Map();
    this.tail = Promise.resolve();
  }

  static keyOf(id) {
    return createHash('sha256').update(String(id)).digest('hex');
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      for (const [key, session] of Object.entries(saved.sessions ?? {})) this.entries.set(key, session);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.sweep();
    return this;
  }

  save() {
    const snapshot = JSON.stringify({ sessions: Object.fromEntries(this.entries) });
    this.tail = this.tail.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, this.file);
    }).catch(() => {});
    return this.tail;
  }

  expired(session, at) {
    return at - session.seenAt > this.idleMs || at - session.createdAt > this.absoluteMs;
  }

  create(info = {}) {
    const id = randomBytes(32).toString('base64url');
    const at = this.now();
    this.entries.set(SessionStore.keyOf(id), { ip: info.ip ?? '', ua: String(info.ua ?? '').slice(0, 160), createdAt: at, seenAt: at, savedSeenAt: at });
    while (this.entries.size > this.maxSessions) this.entries.delete(this.entries.keys().next().value);
    this.save();
    return id;
  }

  // { key, session } for a live session (its idle timer refreshed), or null.
  touch(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
    const key = SessionStore.keyOf(id);
    const session = this.entries.get(key);
    if (!session) return null;
    const at = this.now();
    if (this.expired(session, at)) {
      this.entries.delete(key);
      this.save();
      return null;
    }
    session.seenAt = at;
    if (at - (session.savedSeenAt ?? 0) > PERSIST_SEEN_EVERY_MS) {
      session.savedSeenAt = at;
      this.save();
    }
    return { key, session };
  }

  destroy(id) {
    const key = SessionStore.keyOf(id);
    if (this.entries.delete(key)) this.save();
    return key;
  }

  sweep() {
    const at = this.now();
    let changed = false;
    for (const [key, session] of this.entries) {
      if (this.expired(session, at)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

// Back-off after failed attempts from one IP: three free, then 30 s doubling up to an hour, plus
// a global ceiling so a spread-out attack cannot make unlimited guesses either.
export function failureDelayMs(failures) {
  if (failures < 3) return 0;
  return Math.min(30_000 * 2 ** (failures - 3), 3_600_000);
}

export class Throttle {
  constructor({ now = Date.now, globalLimit = 30, globalWindowMs = 15 * 60_000 } = {}) {
    this.now = now;
    this.globalLimit = globalLimit;
    this.globalWindowMs = globalWindowMs;
    this.byIp = new Map();
    this.recentFailures = [];
  }

  check(ip) {
    const at = this.now();
    this.recentFailures = this.recentFailures.filter((ts) => at - ts < this.globalWindowMs);
    if (this.recentFailures.length >= this.globalLimit) {
      return { allowed: false, retryAfterMs: this.globalWindowMs - (at - this.recentFailures[0]) };
    }
    const entry = this.byIp.get(ip);
    if (entry && entry.until > at) return { allowed: false, retryAfterMs: entry.until - at };
    return { allowed: true, retryAfterMs: 0 };
  }

  fail(ip) {
    const at = this.now();
    this.recentFailures.push(at);
    const entry = this.byIp.get(ip) ?? { count: 0, until: 0 };
    entry.count += 1;
    entry.until = at + failureDelayMs(entry.count);
    this.byIp.set(ip, entry);
    if (this.byIp.size > 10_000) this.byIp.delete(this.byIp.keys().next().value);
  }

  succeed(ip) {
    this.byIp.delete(ip);
  }
}

// Requests that create work (a challenge, an ECDH key on the Mac) are limited per IP even when
// they succeed: a token bucket of `burst` refilled at `perMinute`.
export class RateLimit {
  constructor({ burst = 10, perMinute = 10, now = Date.now } = {}) {
    this.burst = burst;
    this.perMs = perMinute / 60_000;
    this.now = now;
    this.buckets = new Map();
  }

  take(key) {
    const at = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at };
    bucket.tokens = Math.min(this.burst, bucket.tokens + (at - bucket.at) * this.perMs);
    bucket.at = at;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 10_000) this.buckets.delete(this.buckets.keys().next().value);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}
