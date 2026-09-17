// Local development: the relay and the agent both on this Mac, state in .dev/ (not committed).
// Shells run with your real environment. Open http://localhost:3040 (passkeys allow http only
// on localhost).
//   node scripts/dev.js           run
//   node scripts/dev.js --pair    run and open a pairing window (the link is printed)
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../relay/server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV = `${ROOT}.dev/`;
const PORT = Number(process.env.PORT || 3040);
const origin = `http://localhost:${PORT}`;

await mkdir(`${DEV}agent`, { recursive: true, mode: 0o700 });
let agentConfig;
try {
  agentConfig = JSON.parse(await readFile(`${DEV}agent/agent.json`, 'utf8'));
} catch {
  agentConfig = { relayUrl: `ws://127.0.0.1:${PORT}/agent`, deviceToken: randomBytes(32).toString('base64url'), origin };
  await writeFile(`${DEV}agent/agent.json`, `${JSON.stringify(agentConfig, null, 2)}\n`, { mode: 0o600 });
}

const relay = await createRelay({
  port: PORT,
  host: '127.0.0.1',
  publicOrigin: origin,
  rpId: 'localhost',
  agentTokenSha256: createHash('sha256').update(agentConfig.deviceToken).digest('hex'),
  dataDir: `${DEV}relay`,
});
await relay.listen();
console.log(`relay: ${origin}`);

const agent = spawn(process.execPath, ['agent/index.js', ...(process.argv.includes('--pair') ? ['--pair'] : [])], {
  cwd: ROOT,
  env: { ...process.env, REMOTE_TERM_HOME: `${DEV}agent` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
agent.stdout.setEncoding('utf8');
agent.stdout.on('data', (chunk) => {
  for (const line of chunk.split('\n').filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event.event === 'pairing') console.log(`pairing link (10 min, one use): ${event.url}`);
      else console.log(`agent: ${line}`);
    } catch {
      console.log(`agent: ${line}`);
    }
  }
});
agent.on('exit', (code) => {
  console.log(`agent exited (${code})`);
  relay.close().finally(() => process.exit(code ?? 0));
});

const stop = () => {
  agent.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
