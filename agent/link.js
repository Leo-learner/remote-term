// One phone connection as this Mac sees it. The relay hands over the phone's binary frames and
// carries our answers back; it can neither read nor forge them. Until the resume handshake
// succeeds, the only thing a link accepts is a hello that proves the phone holds a valid ticket.
import { ChannelError, answerResume } from '../shared/channel.js';
import { OP, OUTER, controlFrame, dataFrame, handshakeFrame, outer, parseInner, parseOuter } from '../shared/frames.js';

const MAX_CHANNELS = 8;
const RECHECK_TICKET_MS = 5 * 60_000;

const isChannel = (value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
const isSize = (value) => Number.isInteger(value) && value > 0 && value < 10_000;

export class Link {
  // send(bytes) delivers a frame to the phone; drop(reason) asks the relay to close the phone's socket.
  constructor({ id, send, drop, tickets, sessions, authority, notifier, info, log = () => {} }) {
    this.id = id;
    this.sendRaw = send;
    this.drop = drop;
    this.tickets = tickets;
    this.sessions = sessions;
    this.authority = authority;
    this.notifier = notifier;
    this.info = info;
    this.log = log;
    this.state = 'handshake'; // handshake → open → closing → closed
    this.handshaking = false;
    this.channel = null;
    this.ticket = null;
    this.subs = new Map(); // channel number -> { sessionId, subscription }
    this.focus = { id: null, visible: false };
    this.recheck = null;
  }

  // ---- incoming ------------------------------------------------------------------------------

  async receive(frame) {
    if (this.state === 'closing' || this.state === 'closed') return;
    const parsed = parseOuter(frame);
    if (!parsed) return this.fail('bad-frame');
    if (this.state === 'handshake') return this.handshake(parsed);
    if (parsed.type !== OUTER.SEALED) return this.fail('expected-sealed');
    try {
      await this.channel.receive(parsed.payload, (plain) => this.handle(plain));
    } catch (error) {
      this.fail(error instanceof ChannelError ? error.code : 'internal', error);
    }
  }

  async handshake(parsed) {
    if (parsed.type !== OUTER.HANDSHAKE) return this.fail('expected-hello');
    if (this.handshaking) return;
    this.handshaking = true;
    try {
      let ticket = null;
      const { welcome, channel } = await answerResume(parsed.message, async (tid) => {
        ticket = this.tickets.use(tid);
        return ticket;
      });
      if (this.state !== 'handshake') return;
      this.channel = channel;
      this.ticket = ticket;
      this.state = 'open';
      this.sendRaw(handshakeFrame(welcome));
      this.control({ t: 'ready', agent: this.info(), sessions: this.sessions.list(), device: ticket.credentialId });
      this.recheck = setInterval(() => this.recheckTicket(), RECHECK_TICKET_MS);
      this.recheck.unref?.();
      this.log('link-open', { link: this.id, device: ticket.device });
    } catch (error) {
      // Plain text on purpose: the phone needs the reason before it has a channel. "unknown-ticket"
      // means expired or revoked, so the phone asks for Face ID.
      const reason = error instanceof ChannelError ? error.code : 'internal';
      this.sendRaw(handshakeFrame({ t: 'reject', reason }));
      this.fail(reason, error instanceof ChannelError ? undefined : error);
    }
  }

  // A connection that stays open for days still answers to the ticket policy.
  recheckTicket() {
    if (this.state !== 'open') return;
    if (!this.tickets.use(this.ticket.tid)) {
      this.control({ t: 'locked', reason: 'ticket-expired' });
      this.fail('ticket-expired');
    }
  }

  handle(plain) {
    if (this.state !== 'open') return;
    const frame = parseInner(plain);
    if (!frame) return this.fail('bad-inner-frame');
    if (frame.op === OP.INPUT) return this.input(frame.channel, frame.data);
    if (frame.op === OP.CONTROL) return this.onControl(frame.message);
    return this.fail('unexpected-op');
  }

  input(ch, data) {
    const entry = this.subs.get(ch);
    const session = entry && this.sessions.get(entry.sessionId);
    if (session) session.write(Buffer.from(data));
  }

  onControl(message) {
    const reply = (error) => this.error(message, error.code ?? 'internal', error.code ? error.message : undefined);
    const handler = Object.hasOwn(this.handlers, message.t) ? this.handlers[message.t] : null;
    if (!handler) return this.error(message, 'unknown-message');
    try {
      const result = handler(message);
      if (result instanceof Promise) result.catch(reply);
    } catch (error) {
      reply(error);
    }
  }

  get handlers() {
    this.handlerTable ??= {
      ping: ({ ts }) => this.control({ t: 'pong', ts, at: Date.now() }),
      list: () => this.control({ t: 'sessions', items: this.sessions.list() }),
      create: (message) => {
        const session = this.sessions.create({ cols: message.cols, rows: message.rows, cwd: message.cwd });
        this.control({ t: 'created', ref: message.ref, id: session.id });
      },
      attach: (message) => this.attach(message),
      detach: ({ ch }) => this.detach(ch),
      resize: ({ ch, cols, rows }) => {
        const entry = this.subs.get(ch);
        if (entry && isSize(cols) && isSize(rows)) this.sessions.get(entry.sessionId)?.resize(cols, rows);
      },
      ack: ({ ch, n }) => this.subs.get(ch)?.subscription.ack(n),
      close: (message) => {
        this.sessions.remove(message.id);
        this.control({ t: 'closed', ref: message.ref, id: message.id });
      },
      rename: ({ id, name }) => this.sessions.get(id)?.rename(name),
      focus: ({ id, visible }) => {
        this.focus = { id: typeof id === 'string' ? id : null, visible: visible === true };
      },
      devices: () => this.sendDevices(),
      'device-remove': (message) => {
        this.authority.removeCredential(message.id);
        this.notifier.removeCredential(message.id);
        this.sendDevices();
        if (message.id === this.ticket.credentialId) this.fail('device-removed');
      },
      'pair-open': async (message) => {
        const pairing = await this.authority.openPairing();
        this.control({ t: 'pairing', ref: message.ref, url: pairing.url, expiresAt: pairing.expiresAt });
      },
      'push-key': (message) => this.control({ t: 'push-key', ref: message.ref, key: this.notifier.publicKey }),
      'push-subscribe': (message) => {
        this.notifier.subscribe(this.ticket.credentialId, message.subscription, message.prefs);
        this.control({ t: 'push-prefs', ref: message.ref, prefs: this.notifier.prefs, subscribed: true });
      },
      'push-unsubscribe': (message) => {
        this.notifier.unsubscribe(String(message.endpoint ?? ''));
        this.control({ t: 'push-prefs', ref: message.ref, prefs: this.notifier.prefs, subscribed: false });
      },
      'push-prefs': (message) => {
        const prefs = message.prefs ? this.notifier.setPrefs(message.prefs) : this.notifier.prefs;
        this.control({ t: 'push-prefs', ref: message.ref, prefs });
      },
      'push-test': async (message) => {
        const sent = await this.notifier.test(this.ticket.credentialId);
        this.control({ t: 'push-tested', ref: message.ref, sent });
      },
      lock: () => {
        this.tickets.revoke(this.ticket.tid);
        this.control({ t: 'locked', reason: 'locked' });
        this.fail('locked');
      },
    };
    return this.handlerTable;
  }

  attach({ ch, id, cols, rows, lines, ref }) {
    if (!isChannel(ch)) return this.error({ ref }, 'bad-channel');
    const session = this.sessions.get(id);
    if (!session) return this.error({ ref }, 'no-session');
    this.detach(ch);
    if (this.subs.size >= MAX_CHANNELS) return this.error({ ref }, 'too-many-channels');
    // The device that attaches decides the size, as the one being looked at.
    if (isSize(cols) && isSize(rows)) session.resize(cols, rows);
    const subscription = session.attach({
      snapshot: (bytes, size) => {
        this.control({ t: 'screen', ch, id, cols: size.cols, rows: size.rows });
        this.sealed(dataFrame(OP.SNAPSHOT, ch, bytes));
      },
      output: (bytes) => this.sealed(dataFrame(OP.OUTPUT, ch, bytes)),
    }, { lines });
    this.subs.set(ch, { sessionId: id, subscription });
    this.control({ t: 'attached', ref, ch, id });
  }

  detach(ch) {
    const entry = this.subs.get(ch);
    if (!entry) return;
    entry.subscription.close();
    this.subs.delete(ch);
  }

  // A session went away: stop the subscriptions that pointed at it.
  sessionRemoved(sessionId) {
    for (const [ch, entry] of this.subs) {
      if (entry.sessionId === sessionId) {
        entry.subscription.close();
        this.subs.delete(ch);
      }
    }
  }

  sendDevices() {
    const items = this.authority.publicCredentials().map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt }));
    this.control({ t: 'devices', items, current: this.ticket.credentialId });
  }

  isFocused(sessionId) {
    return this.state === 'open' && this.focus.visible && this.focus.id === sessionId;
  }

  // ---- outgoing ------------------------------------------------------------------------------

  // New messages only while open; messages already queued still go out while closing, so a
  // "locked" notice reaches the phone before the relay drops it.
  sealed(plain) {
    if (this.state !== 'open') return;
    this.channel.send(plain, (ciphertext) => {
      if (this.state !== 'closed') this.sendRaw(outer(OUTER.SEALED, ciphertext));
    }).catch((error) => this.fail('internal', error));
  }

  control(message) {
    this.sealed(controlFrame(message));
  }

  error(request, code, message) {
    this.control({ t: 'error', ref: request?.ref, for: request?.t, code, message });
  }

  // ---- teardown ------------------------------------------------------------------------------

  // The phone is already gone (the relay said so): nothing left to flush.
  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.teardown();
  }

  // This side ends the link: flush what is queued, then ask the relay to drop the phone.
  fail(reason, error) {
    if (this.state === 'closing' || this.state === 'closed') return;
    this.log('link-closed', { link: this.id, reason, ...(error ? { message: error.message } : {}) });
    const flushed = this.channel ? this.channel.sendTail.catch(() => {}) : Promise.resolve();
    this.state = 'closing';
    this.teardown();
    flushed.then(() => {
      if (this.state !== 'closing') return;
      this.state = 'closed';
      this.drop(reason);
    });
  }

  teardown() {
    clearInterval(this.recheck);
    for (const entry of this.subs.values()) entry.subscription.close();
    this.subs.clear();
  }
}
