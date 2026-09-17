// Connect this Mac to a relay: node agent/setup.js <relay-url> [--origin <url>] [--force]
//   node agent/setup.js wss://term.dkz12345.com/agent
//   node agent/setup.js ws://127.0.0.1:3040/agent --origin http://localhost:3040   (local development)
// Writes agent.json with a fresh device token and prints only its SHA-256 for the relay's .env,
// so the token itself never leaves this Mac.
import { createHash, randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { checkConfig, paths } from './config.js';
import { writeJson } from './store.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { origin: { type: 'string' }, force: { type: 'boolean', default: false } },
});
const [relayUrl] = positionals;
if (!relayUrl) {
  console.error('usage: node agent/setup.js <wss://host/agent> [--origin https://host] [--force]');
  process.exit(1);
}
if (!values.force && (await access(paths.config).then(() => true, () => false))) {
  console.error(`${paths.config} already exists (pass --force to replace it; the relay then needs the new hash)`);
  process.exit(1);
}

const deviceToken = randomBytes(32).toString('base64url');
const config = { relayUrl, deviceToken, ...(values.origin ? { origin: values.origin } : {}) };
try {
  checkConfig(config);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
await writeJson(paths.config, config);
console.log(`wrote ${paths.config}`);
console.log('put this line into the relay .env:');
console.log(`AGENT_TOKEN_SHA256=${createHash('sha256').update(deviceToken).digest('hex')}`);
