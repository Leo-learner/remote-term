// Agent configuration and state, in ~/Library/Application Support/RemoteTerm (mode 700).
// REMOTE_TERM_HOME points somewhere else for tests and local development.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './store.js';

export const HOME = process.env.REMOTE_TERM_HOME || join(homedir(), 'Library', 'Application Support', 'RemoteTerm');

export const paths = {
  config: join(HOME, 'agent.json'),
  credentials: join(HOME, 'credentials.json'),
  tickets: join(HOME, 'tickets.json'),
  push: join(HOME, 'push.json'),
  zsh: join(HOME, 'shell', 'zsh'),
};

const LOCAL = /^(ws|http):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

export function originFromRelayUrl(relayUrl) {
  const url = new URL(relayUrl);
  return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
}

export function checkConfig(raw) {
  const { relayUrl, deviceToken } = raw ?? {};
  if (typeof relayUrl !== 'string' || !(relayUrl.startsWith('wss://') || LOCAL.test(relayUrl))) {
    throw new Error('relayUrl must be wss://… (plain ws:// only for localhost)');
  }
  if (typeof deviceToken !== 'string' || deviceToken.length < 32) throw new Error('deviceToken is missing or too short');
  const origin = (raw.origin ?? originFromRelayUrl(relayUrl)).replace(/\/$/, '');
  const { hostname, protocol } = new URL(origin);
  // Passkeys need https, except on localhost; and an IP address can never be a passkey's site.
  if (protocol !== 'https:' && hostname !== 'localhost') throw new Error('origin must be https:// (http:// only for localhost)');
  return { relayUrl, deviceToken, origin, rpId: hostname, pushProxy: raw.pushProxy || undefined };
}

export async function loadConfig(file = paths.config) {
  const raw = await readJson(file, null);
  if (!raw) throw new Error(`${file} is missing: run "node agent/setup.js <relay-url>" first`);
  return checkConfig(raw);
}
