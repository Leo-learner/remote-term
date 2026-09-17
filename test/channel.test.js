import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromB64u, randomBytes, toB64u } from '../shared/bytes.js';
import {
  Channel, ChannelError, answerResume, ephemeralKey, loginChallenge, openBox, pairChallenge, pairProof,
  pairingId, sealBox, startResume, verifyPairProof,
} from '../shared/channel.js';
import { OP, OUTER, controlFrame, dataFrame, handshakeFrame, parseInner, parseOuter } from '../shared/frames.js';

const decoder = new TextDecoder();

function makeTicket() {
  return { tid: toB64u(randomBytes(16)), key: randomBytes(32) };
}

async function handshake(ticket, lookup = async (tid) => (tid === ticket.tid ? { key: ticket.key } : null)) {
  const phone = await startResume(ticket);
  const agent = await answerResume(phone.hello, lookup);
  const phoneChannel = await phone.finish(agent.welcome);
  return { phone, agent, phoneChannel, agentChannel: agent.channel };
}

function collect(channel) {
  const out = [];
  return { out, deliver: (ciphertext) => out.push(ciphertext) };
}

test('resume handshake gives both sides matching keys in both directions', async () => {
  const { phoneChannel, agentChannel } = await handshake(makeTicket());
  const toAgent = collect();
  for (const text of ['ls\r', 'echo 中文\r', 'x'.repeat(10_000)]) await phoneChannel.send(new TextEncoder().encode(text), toAgent.deliver);
  const received = [];
  for (const frame of toAgent.out) await agentChannel.receive(frame, (plain) => received.push(decoder.decode(plain)));
  assert.deepEqual(received, ['ls\r', 'echo 中文\r', 'x'.repeat(10_000)]);

  const toPhone = collect();
  await agentChannel.send(new TextEncoder().encode('output'), toPhone.deliver);
  let echoed = '';
  await phoneChannel.receive(toPhone.out[0], (plain) => { echoed = decoder.decode(plain); });
  assert.equal(echoed, 'output');
});

test('the phone key also works when stored as a non-extractable CryptoKey', async () => {
  const ticket = makeTicket();
  const key = await crypto.subtle.importKey('raw', ticket.key, 'HKDF', false, ['deriveBits']);
  assert.equal(key.extractable, false);
  const phone = await startResume({ tid: ticket.tid, key });
  const agent = await answerResume(phone.hello, async () => ({ key: ticket.key }));
  await phone.finish(agent.welcome);
});

test('sends are delivered in call order even when encryption finishes out of order', async () => {
  const { phoneChannel, agentChannel } = await handshake(makeTicket());
  const toAgent = collect();
  const sizes = [200_000, 1, 50_000, 3, 100_000];
  await Promise.all(sizes.map((size, i) => phoneChannel.send(new Uint8Array(size).fill(i), toAgent.deliver)));
  const seen = [];
  await Promise.all(toAgent.out.map((frame) => agentChannel.receive(frame, (plain) => seen.push([plain.length, plain[0]]))));
  assert.deepEqual(seen, sizes.map((size, i) => [size, i]));
});

test('an unknown ticket or a hello made with the wrong key is refused', async () => {
  const ticket = makeTicket();
  const phone = await startResume(ticket);
  await assert.rejects(answerResume(phone.hello, async () => null), { code: 'unknown-ticket' });
  await assert.rejects(answerResume(phone.hello, async () => ({ key: randomBytes(32) })), { code: 'bad-ticket-proof' });
});

test('a tampered hello is refused', async () => {
  const ticket = makeTicket();
  const lookup = async () => ({ key: ticket.key });
  const phone = await startResume(ticket);
  const other = await ephemeralKey();
  await assert.rejects(answerResume({ ...phone.hello, e: toB64u(other.pub) }, lookup), { code: 'bad-ticket-proof' });
  await assert.rejects(answerResume({ ...phone.hello, n: toB64u(randomBytes(32)) }, lookup), { code: 'bad-ticket-proof' });
  await assert.rejects(answerResume({ ...phone.hello, e: 'short' }, lookup), { code: 'bad-message' });
  await assert.rejects(answerResume({ ...phone.hello, v: 2 }, lookup), { code: 'bad-message' });
});

test('the phone rejects a welcome that was not made with the ticket key (relay in the middle)', async () => {
  const ticket = makeTicket();
  const phone = await startResume(ticket);
  // The relay answers the hello itself, pretending to be the Mac, with a key it guessed.
  const impostor = await answerResume(phone.hello, async () => ({ key: ticket.key }));
  const forged = await ephemeralKey();
  await assert.rejects(phone.finish({ ...impostor.welcome, e: toB64u(forged.pub) }), { code: 'bad-agent-proof' });
  const wrongKey = await startResume({ tid: ticket.tid, key: randomBytes(32) });
  const agent = await answerResume(phone.hello, async () => ({ key: ticket.key }));
  await assert.rejects(wrongKey.finish(agent.welcome), { code: 'bad-agent-proof' });
});

test('a replayed hello yields a different channel the replayer cannot use', async () => {
  const ticket = makeTicket();
  const lookup = async () => ({ key: ticket.key });
  const phone = await startResume(ticket);
  const first = await answerResume(phone.hello, lookup);
  const phoneChannel = await phone.finish(first.welcome);
  const replay = await answerResume(phone.hello, lookup);
  assert.notEqual(replay.welcome.e, first.welcome.e);
  // Frames from the real session do not open on the replayed channel.
  const frames = collect();
  await phoneChannel.send(new TextEncoder().encode('rm -rf ~'), frames.deliver);
  await assert.rejects(replay.channel.receive(frames.out[0], () => {}), { code: 'bad-frame' });
});

test('dropped, reordered, replayed or modified frames fail to decrypt', async () => {
  const { phoneChannel, agentChannel } = await handshake(makeTicket());
  const frames = collect();
  for (const text of ['a', 'b', 'c']) await phoneChannel.send(new TextEncoder().encode(text), frames.deliver);

  const { agentChannel: fresh1 } = await handshake(makeTicket());
  await assert.rejects(fresh1.receive(frames.out[0], () => {}), { code: 'bad-frame' }); // other session's key

  // Skip frame 0 (dropped by the relay): frame 1 is decrypted with sequence 0 and fails.
  await assert.rejects(agentChannel.receive(frames.out[1], () => {}), { code: 'bad-frame' });

  const second = await handshake(makeTicket());
  const more = collect();
  for (const text of ['a', 'b']) await second.phoneChannel.send(new TextEncoder().encode(text), more.deliver);
  await second.agentChannel.receive(more.out[0], () => {});
  await assert.rejects(second.agentChannel.receive(more.out[0], () => {}), { code: 'bad-frame' }); // replay

  const third = await handshake(makeTicket());
  const flipped = collect();
  await third.phoneChannel.send(new TextEncoder().encode('echo hi'), flipped.deliver);
  flipped.out[0][3] ^= 1;
  await assert.rejects(third.agentChannel.receive(flipped.out[0], () => {}), { code: 'bad-frame' });
});

test('the channel direction keys differ, so a frame cannot be reflected back', async () => {
  const { phoneChannel } = await handshake(makeTicket());
  const frames = collect();
  await phoneChannel.send(new TextEncoder().encode('hello'), frames.deliver);
  await assert.rejects(phoneChannel.receive(frames.out[0], () => {}), { code: 'bad-frame' });
});

test('IVs encode direction and sequence', () => {
  const iv = Channel.iv(2, 258n);
  assert.deepEqual([...iv], [0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1, 2]);
});

test('sealed boxes open only with the matching key, salt and context', async () => {
  const agent = await ephemeralKey();
  const phone = await ephemeralKey();
  const salt = randomBytes(32);
  const context = randomBytes(32);
  const sealed = await sealBox({ privateKey: agent.privateKey, peerPub: phone.pub, salt, context }, 'ticket');
  const opened = await openBox({ privateKey: phone.privateKey, peerPub: agent.pub, salt, context }, sealed);
  assert.equal(decoder.decode(opened), 'ticket');
  await assert.rejects(openBox({ privateKey: phone.privateKey, peerPub: agent.pub, salt: randomBytes(32), context }, sealed), { code: 'bad-box' });
  await assert.rejects(openBox({ privateKey: phone.privateKey, peerPub: agent.pub, salt, context: randomBytes(32) }, sealed), { code: 'bad-box' });
  const relay = await ephemeralKey();
  await assert.rejects(openBox({ privateKey: relay.privateKey, peerPub: agent.pub, salt, context }, sealed), { code: 'bad-box' });
});

test('ceremony challenges bind every part', async () => {
  const phone = await ephemeralKey();
  const agent = await ephemeralKey();
  const relayNonce = randomBytes(32);
  const agentPart = { hid: toB64u(randomBytes(16)), pub: agent.pub, nonce: randomBytes(32) };
  const base = toB64u(await loginChallenge({ relayNonce, phonePub: phone.pub, agent: agentPart }));
  assert.equal(toB64u(await loginChallenge({ relayNonce, phonePub: phone.pub, agent: agentPart })), base);
  const other = await ephemeralKey();
  const variants = [
    { relayNonce: randomBytes(32), phonePub: phone.pub, agent: agentPart },
    { relayNonce, phonePub: other.pub, agent: agentPart },
    { relayNonce, phonePub: phone.pub, agent: { ...agentPart, pub: other.pub } },
    { relayNonce, phonePub: phone.pub, agent: { ...agentPart, nonce: randomBytes(32) } },
    { relayNonce, phonePub: phone.pub, agent: { ...agentPart, hid: toB64u(randomBytes(16)) } },
    { relayNonce, phonePub: phone.pub, agent: null },
  ];
  for (const variant of variants) assert.notEqual(toB64u(await loginChallenge(variant)), base);

  const pid = await pairingId(randomBytes(32));
  assert.equal(fromB64u(pid).length, 16);
  const pair = toB64u(await pairChallenge({ pid, phonePub: phone.pub, agentPub: agent.pub, agentNonce: agentPart.nonce }));
  assert.notEqual(toB64u(await pairChallenge({ pid, phonePub: other.pub, agentPub: agent.pub, agentNonce: agentPart.nonce })), pair);
});

test('pairing proof needs the secret and covers both the client data and the attestation', async () => {
  const secret = randomBytes(32);
  const clientData = new TextEncoder().encode('{"type":"webauthn.create"}');
  const attestation = randomBytes(300);
  const proof = await pairProof(secret, clientData, attestation);
  assert.equal(await verifyPairProof(secret, proof, clientData, attestation), true);
  assert.equal(await verifyPairProof(randomBytes(32), proof, clientData, attestation), false);
  assert.equal(await verifyPairProof(secret, proof, clientData, randomBytes(300)), false);
  assert.equal(await verifyPairProof(secret, proof, new TextEncoder().encode('{}'), attestation), false);
});

test('frames round-trip and garbage is rejected', () => {
  const hs = parseOuter(handshakeFrame({ t: 'hello', v: 1 }));
  assert.equal(hs.type, OUTER.HANDSHAKE);
  assert.deepEqual(hs.message, { t: 'hello', v: 1 });
  assert.equal(parseOuter(new Uint8Array([9, 1, 2])), null);
  assert.equal(parseOuter(new Uint8Array([0, 123])), null);

  assert.deepEqual(parseInner(controlFrame({ t: 'list' })), { op: OP.CONTROL, message: { t: 'list' } });
  const out = parseInner(dataFrame(OP.OUTPUT, 7, 'héllo'));
  assert.equal(out.op, OP.OUTPUT);
  assert.equal(out.channel, 7);
  assert.equal(decoder.decode(out.data), 'héllo');
  assert.equal(parseInner(new Uint8Array([OP.INPUT, 0, 0])), null);
  assert.equal(parseInner(new Uint8Array([OP.CONTROL, 0x5b, 0x5d])), null); // [] has no t
  assert.equal(parseInner(new Uint8Array([99])), null);
  assert.ok(ChannelError);
});
