// Smoke test against a deployed relay with a software passkey. It pairs, runs one command over the
// end-to-end channel, checks the wire carries no plaintext, then removes its passkey again.
//   node agent/index.js --pair > agent.out &     (the agent prints the pairing link)
//   node scripts/smoke-production.js https://term.example.com "<pairing link>"
import { SoftPasskey } from '../test/helpers/authenticator.js';
import { FakePhone, waitFor } from '../test/helpers/phone.js';

const [origin, pairingUrl] = process.argv.slice(2);
if (!origin || !pairingUrl) {
  console.error('usage: node scripts/smoke-production.js <origin> <pairing link>');
  process.exit(1);
}

const step = (name, started) => console.log(`ok  ${name}${started ? ` (${Date.now() - started} ms)` : ''}`);
const phone = new FakePhone({ base: origin, origin });
const passkey = new SoftPasskey({ rpId: new URL(origin).hostname, origin });
let connection;

try {
  let t = Date.now();
  const ticket = await phone.pair(pairingUrl, passkey, 'smoke test');
  step('pair through the relay; the Mac verified the passkey and sealed a ticket', t);

  t = Date.now();
  connection = phone.connect(ticket);
  await connection.opened;
  const ready = await connection.ready();
  step(`end-to-end channel ready, agent ${ready.agent.version} on ${ready.agent.host}`, t);

  const pings = [];
  for (let i = 0; i < 5; i += 1) {
    const sent = Date.now();
    await connection.send({ t: 'ping', ts: sent, n: i });
    await connection.reply((message) => message.t === 'pong' && message.ts === sent, 'pong');
    pings.push(Date.now() - sent);
  }
  step(`round trips phone → Mac → phone: ${pings.join(', ')} ms`);

  t = Date.now();
  await connection.send({ t: 'create', ref: 'c', cols: 60, rows: 20 });
  const { id } = await connection.reply((message) => message.t === 'created' && message.ref === 'c', 'created');
  await connection.send({ t: 'attach', ref: 'a', ch: 1, id, cols: 60, rows: 20 });
  await connection.reply((message) => message.t === 'screen' && message.ch === 1, 'screen');
  step('session created and attached', t);

  t = Date.now();
  await waitFor(() => connection.controls.some((message) => message.t === 'sessions' && message.items.some((item) => item.id === id && item.cwd)), { what: 'shell prompt', timeout: 20_000 });
  await connection.input(1, 'echo smoke-$((6*7))\r');
  await waitFor(() => /smoke-42\r\n/.test(connection.screens.get(1) ?? ''), { what: 'command output', timeout: 20_000 });
  step('command ran in a login shell on the Mac', t);

  const wire = Buffer.concat(connection.raw.map((frame) => Buffer.from(frame)));
  if (wire.includes(Buffer.from('smoke-42')) || wire.includes(Buffer.from('echo smoke'))) throw new Error('plaintext on the wire');
  step(`${connection.raw.length} frames from the relay, no plaintext among them`);

  await connection.send({ t: 'close', ref: 'x', id });
  await connection.reply((message) => message.t === 'closed' && message.ref === 'x', 'closed');
  await connection.send({ t: 'device-remove', id: passkey.id });
  await waitFor(() => connection.closed, { what: 'link dropped after removing the passkey' });
  step(`test passkey removed, link closed with ${connection.closed.code}`);

  const retry = await phone.login(passkey).then(() => 'logged in', (error) => `refused (${error.reply?.status})`);
  if (retry === 'logged in') throw new Error('the removed passkey can still log in');
  step(`the removed passkey is refused at login: ${retry}`);
} finally {
  connection?.close();
  await phone.post('/api/logout', {}).catch(() => {});
}
