import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fromB64u, randomBytes, toB64u } from '../shared/bytes.js';
import {
  answerResume, ephemeralKey, loginChallenge, openBox, pairChallenge, pairProof, startResume,
} from '../shared/channel.js';
import { PasskeyAuthority } from '../agent/passkeys.js';
import { TicketStore } from '../agent/tickets.js';
import { SoftPasskey } from './helpers/authenticator.js';

const RP_ID = 'term.example.test';
const ORIGIN = `https://${RP_ID}`;
const decoder = new TextDecoder();

async function setup({ now = Date.now, policy } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rt-passkeys-'));
  const tickets = await new TicketStore({ file: join(dir, 'tickets.json'), now, ...(policy ? { policy } : {}) }).load();
  const changes = [];
  const authority = await new PasskeyAuthority({
    file: join(dir, 'credentials.json'), rpId: RP_ID, origin: ORIGIN, tickets, now, onChange: () => changes.push(1),
  }).load();
  return { dir, tickets, authority, changes };
}

// Everything the phone does during pairing, with hooks to misbehave.
async function pair(authority, passkey, { tamper = {} } = {}) {
  const { url, pid } = await authority.openPairing();
  const secret = fromB64u(new URL(url).hash.slice(1));
  const phone = await ephemeralKey();
  const start = await authority.pairStart({ pid, e: toB64u(phone.pub) });
  const expected = await pairChallenge({ pid, phonePub: phone.pub, agentPub: fromB64u(start.e), agentNonce: fromB64u(start.n) });
  assert.equal(start.options.challenge, toB64u(expected), 'the phone can recompute what it is about to sign');
  const response = passkey.create(start.options, tamper.create);
  const proof = await pairProof(tamper.secret ?? secret, fromB64u(response.response.clientDataJSON), fromB64u(response.response.attestationObject));
  const result = await authority.pairFinish({ pid, hid: start.hid, response, proof: toB64u(proof), name: 'iPhone\x07 17 Pro' });
  const opened = await openBox(
    { privateKey: phone.privateKey, peerPub: fromB64u(start.e), salt: secret, context: expected },
    fromB64u(result.sealed),
  );
  return { result, ticket: JSON.parse(decoder.decode(opened)), start, pid, secret };
}

async function login(authority, passkey, { relayNonce = randomBytes(32), tamper = {} } = {}) {
  const phone = await ephemeralKey();
  const agent = await authority.loginStart({ e: toB64u(phone.pub) });
  const challenge = await loginChallenge({
    relayNonce, phonePub: phone.pub, agent: { hid: agent.hid, pub: fromB64u(agent.e), nonce: fromB64u(agent.n) },
  });
  const response = passkey.get({ challenge: toB64u(challenge), rpId: RP_ID }, tamper.get);
  const result = await authority.loginFinish({
    hid: agent.hid,
    relayNonce: toB64u(tamper.relayNonce ?? relayNonce),
    e: toB64u(tamper.phonePub ?? phone.pub),
    response,
  });
  const opened = await openBox({ privateKey: phone.privateKey, peerPub: fromB64u(agent.e), context: challenge }, fromB64u(result.sealed));
  return { result, ticket: JSON.parse(decoder.decode(opened)) };
}

async function resumeWorks(tickets, ticket) {
  const phone = await startResume({ tid: ticket.tid, key: fromB64u(ticket.k) });
  const agent = await answerResume(phone.hello, async (tid) => tickets.use(tid));
  await phone.finish(agent.welcome);
}

test('pairing stores the passkey and hands the phone a working ticket', async () => {
  const { authority, tickets, changes, dir } = await setup();
  const passkey = new SoftPasskey({ rpId: RP_ID, origin: ORIGIN });
  const { result, ticket } = await pair(authority, passkey);

  assert.equal(result.credentialId, passkey.id);
  assert.equal(ticket.cid, passkey.id);
  const [stored] = authority.publicCredentials();
  assert.equal(stored.id, passkey.id);
  assert.equal(stored.name, 'iPhone 17 Pro', 'control characters are stripped from the device name');
  assert.ok(changes.length >= 2, 'opening the pairing and adding a credential both notify');
  await resumeWorks(tickets, ticket);

  await authority.flush();
  await tickets.flush();
  assert.equal((await stat(join(dir, 'credentials.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'tickets.json'))).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(join(dir, 'credentials.json'), 'utf8'));
  assert.equal(saved.credentials.length, 1);
});

test('a pairing QR code works once', async () => {
  const { authority } = await setup();
  const { pid } = await pair(authority, new SoftPasskey({ rpId: RP_ID, origin: ORIGIN }));
  const phone = await ephemeralKey();
  await assert.rejects(authority.pairStart({ pid, e: toB64u(phone.pub) }), { code: 'pairing-closed' });
});

test('pairing without the QR secret is refused, and three bad proofs close the window', async () => {
  const { authority } = await setup();
  const { pid } = await authority.openPairing();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const phone = await ephemeralKey();
    const start = await authority.pairStart({ pid, e: toB64u(phone.pub) });
    const passkey = new SoftPasskey({ rpId: RP_ID, origin: ORIGIN });
    const response = passkey.create(start.options);
    const proof = await pairProof(randomBytes(32), fromB64u(response.response.clientDataJSON), fromB64u(response.response.attestationObject));
    await assert.rejects(authority.pairFinish({ pid, hid: start.hid, response, proof: toB64u(proof) }), { code: 'bad-proof' });
  }
  const phone = await ephemeralKey();
  await assert.rejects(authority.pairStart({ pid, e: toB64u(phone.pub) }), { code: 'pairing-closed' });
  assert.equal(authority.credentials.length, 0);
});

test('pairing expires after ten minutes', async () => {
  let clock = 1_000_000;
  const { authority } = await setup({ now: () => clock });
  const { pid } = await authority.openPairing();
  clock += 10 * 60_000 + 1;
  const phone = await ephemeralKey();
  await assert.rejects(authority.pairStart({ pid, e: toB64u(phone.pub) }), { code: 'pairing-closed' });
  assert.equal(authority.pairingState(), null);
});

test('a passkey created for another site or without Face ID is refused at pairing', async () => {
  const { authority } = await setup();
  const passkey = new SoftPasskey({ rpId: RP_ID, origin: ORIGIN });
  await assert.rejects(pair(authority, passkey, { tamper: { create: { origin: 'https://evil.example' } } }), { code: 'bad-registration' });
  await assert.rejects(pair(authority, passkey, { tamper: { create: { flags: 0x01 } } }), { code: 'bad-registration' });
  assert.equal(authority.credentials.length, 0);
});

test('login verifies the assertion on this Mac and returns a fresh ticket', async () => {
  const { authority, tickets } = await setup();
  const passkey = new SoftPasskey({ rpId: RP_ID, origin: ORIGIN });
  await pair(authority, passkey);
  const { result, ticket } = await login(authority, passkey);
  assert.equal(result.credentialId, passkey.id);
  await resumeWorks(tickets, ticket);
});

test('login refuses a relay that swapped its nonce or the phone key', async () => {
  const { authority } = await setup();
  const passkey = new SoftPasskey({ rpId: RP_ID, origin: ORIGIN });
  await pair(authority, passkey);
  await assert.rejects(login(authority, passkey, { tamper: { relayNonce: randomBytes(32) } }), { code: 'bad-assertion' });
  const relayKey = await ephemeralKey();
  await assert.rejects(login(authority, passkey, { tamper: { phonePub: relayKey.pub } }), { code: 'bad-handshake' });
});

test('login refuses unknown passkeys, forged signatures, missing Face ID and other origins', async () => {
  const { authority } = await setup();
  const passkey = new SoftPasskey({ rpId: RP_ID, origin: ORIGIN });
  await pair(authority, passkey);
  const stranger = new SoftPasskey({ rpId: RP_ID, origin: ORIGIN });
  await assert.rejects(login(authority, stranger), { code: 'unknown-credential' });
  await assert.rejects(login(authority, passkey, { tamper: { get: { signWith: stranger.privateKey } } }), { code: 'bad-assertion' });
  await assert.rejects(login(authority, passkey, { tamper: { get: { flags: 0x01 } } }), { code: 'bad-assertion' });
  await assert.rejects(login(authority, passkey, { tamper: { get: { origin: 'https://evil.example' } } }), { code: 'bad-assertion' });
});

test('a login handshake id works once', async () => {
  const { authority } = await setup();
  const passkey = new SoftPasskey({ rpId: RP_ID, origin: ORIGIN });
  await pair(authority, passkey);
  const phone = await ephemeralKey();
  const agent = await authority.loginStart({ e: toB64u(phone.pub) });
  const relayNonce = randomBytes(32);
  const challenge = await loginChallenge({ relayNonce, phonePub: phone.pub, agent: { hid: agent.hid, pub: fromB64u(agent.e), nonce: fromB64u(agent.n) } });
  const response = passkey.get({ challenge: toB64u(challenge), rpId: RP_ID });
  const request = { hid: agent.hid, relayNonce: toB64u(relayNonce), e: toB64u(phone.pub), response };
  await authority.loginFinish(request);
  await assert.rejects(authority.loginFinish(request), { code: 'handshake-expired' });
});

test('login before any pairing says so', async () => {
  const { authority } = await setup();
  const phone = await ephemeralKey();
  await assert.rejects(authority.loginStart({ e: toB64u(phone.pub) }), { code: 'not-paired' });
});

test('removing a passkey revokes its tickets', async () => {
  const { authority, tickets } = await setup();
  const passkey = new SoftPasskey({ rpId: RP_ID, origin: ORIGIN });
  const { ticket } = await pair(authority, passkey);
  assert.equal(authority.removeCredential(passkey.id), true);
  assert.equal(tickets.use(ticket.tid), null);
  assert.equal(authority.credentials.length, 0);
});

test('the ticket policy decides, and a rejected ticket is deleted for good', async () => {
  let clock = 5_000_000;
  let allow = true;
  const { authority, tickets } = await setup({ now: () => clock, policy: () => allow });
  const passkey = new SoftPasskey({ rpId: RP_ID, origin: ORIGIN });
  const { ticket } = await pair(authority, passkey);
  clock += 1000;
  assert.ok(tickets.use(ticket.tid));
  assert.equal(tickets.tickets[0].lastUsedAt, clock, 'using a ticket refreshes lastUsedAt');
  allow = false;
  assert.equal(tickets.use(ticket.tid), null);
  allow = true;
  assert.equal(tickets.use(ticket.tid), null, 'loosening the policy later does not revive it');
  const throwing = await setup({ policy: () => { throw new Error('bug'); } });
  const minted = throwing.tickets.mint({ credentialId: 'x' });
  assert.equal(throwing.tickets.use(minted.tid), null, 'a policy that throws counts as "no"');
});
