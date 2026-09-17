import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IDLE_LIMIT_MS, TicketStore, ticketStillValid } from '../agent/tickets.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("the owner's rule: Face ID again after 12 hours without use, however old the ticket is", () => {
  const now = Date.UTC(2026, 8, 17, 12);
  const ticket = ({ idle, age }) => ({ createdAt: now - age, lastUsedAt: now - idle });
  assert.equal(IDLE_LIMIT_MS, 12 * HOUR);
  assert.equal(ticketStillValid(ticket({ idle: 0, age: 0 }), now), true);
  assert.equal(ticketStillValid(ticket({ idle: 12 * HOUR - 1, age: 0 }), now), true);
  assert.equal(ticketStillValid(ticket({ idle: 12 * HOUR, age: 0 }), now), false);
  assert.equal(ticketStillValid(ticket({ idle: 5 * 60_000, age: 90 * DAY }), now), true, 'no absolute lifetime');
});

test('using a ticket moves the 12-hour window along; one idle stretch past it ends the ticket', async () => {
  let clock = Date.UTC(2026, 8, 17, 8);
  const store = await new TicketStore({ file: join(await mkdtemp(join(tmpdir(), 'rt-tickets-')), 'tickets.json'), now: () => clock }).load();
  const { tid } = store.mint({ credentialId: 'phone' });
  for (let day = 0; day < 10; day += 1) {
    clock += 11 * HOUR; // back before the window closes, ten times over
    assert.ok(store.use(tid), `still valid on use ${day + 1}`);
  }
  clock += 12 * HOUR + 1;
  assert.equal(store.use(tid), null);
  clock += 1;
  assert.equal(store.use(tid), null, 'and it stays gone');
});
