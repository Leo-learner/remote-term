// Resume tickets let a phone reconnect without Face ID. A passkey ceremony mints one; the phone
// keeps the key as a non-extractable CryptoKey, this Mac keeps it here. Every new connection
// asks use(tid), and ticketStillValid() decides whether the answer is "go ahead" or "Face ID".
import { randomBytes } from 'node:crypto';
import { JsonFile } from './store.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Decides whether a stored ticket may still open the terminal without a new Face ID.
//   ticket.createdAt   when the passkey ceremony minted it (ms)
//   ticket.lastUsedAt  when a connection last used it (ms; refreshed while a connection stays open)
//   now                current time (ms)
// Return true to reconnect silently, false to show the lock screen and ask for Face ID.
//
// TODO(Leo): this placeholder keeps things working until you choose your own policy.
export function ticketStillValid(ticket, now) {
  return now - ticket.lastUsedAt < 12 * HOUR && now - ticket.createdAt < 7 * DAY;
}

export class TicketStore {
  constructor({ file, now = Date.now, policy = ticketStillValid, maxTickets = 20 }) {
    this.store = new JsonFile(file, { tickets: [] });
    this.now = now;
    this.policy = policy;
    this.maxTickets = maxTickets;
  }

  async load() {
    const value = await this.store.load();
    if (!Array.isArray(value.tickets)) value.tickets = [];
    return this;
  }

  get tickets() {
    return this.store.value.tickets;
  }

  mint({ credentialId, device = '' }) {
    const at = this.now();
    const ticket = {
      tid: randomBytes(16).toString('base64url'),
      key: randomBytes(32).toString('base64url'),
      credentialId,
      device: String(device).slice(0, 40),
      createdAt: at,
      lastUsedAt: at,
    };
    this.tickets.push(ticket);
    // Oldest first out: a phone that re-logs in often must not grow this file forever.
    while (this.tickets.length > this.maxTickets) this.tickets.shift();
    this.store.save();
    return { tid: ticket.tid, key: Buffer.from(ticket.key, 'base64url'), credentialId };
  }

  // The ticket if it may be used now (its lastUsedAt is refreshed), or null. A ticket the policy
  // rejects is deleted, so an expired ticket never comes back if the policy is loosened later.
  use(tid) {
    const index = this.tickets.findIndex((ticket) => ticket.tid === tid);
    if (index === -1) return null;
    const ticket = this.tickets[index];
    const at = this.now();
    let valid = false;
    try {
      valid = this.policy({ ...ticket }, at) === true;
    } catch {
      valid = false;
    }
    if (!valid) {
      this.tickets.splice(index, 1);
      this.store.save();
      return null;
    }
    ticket.lastUsedAt = at;
    this.store.save();
    return { tid: ticket.tid, key: Buffer.from(ticket.key, 'base64url'), credentialId: ticket.credentialId, device: ticket.device };
  }

  // Called while a connection stays open, so "idle" means idle, not "connected long ago".
  touch(tid) {
    const ticket = this.tickets.find((item) => item.tid === tid);
    if (!ticket) return false;
    ticket.lastUsedAt = this.now();
    this.store.save();
    return true;
  }

  revoke(tid) {
    const before = this.tickets.length;
    this.store.value.tickets = this.tickets.filter((ticket) => ticket.tid !== tid);
    if (this.tickets.length !== before) this.store.save();
  }

  revokeCredential(credentialId) {
    const before = this.tickets.length;
    this.store.value.tickets = this.tickets.filter((ticket) => ticket.credentialId !== credentialId);
    if (this.tickets.length !== before) this.store.save();
  }

  flush() {
    return this.store.tail;
  }
}
