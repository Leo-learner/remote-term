// The Face ID ceremonies. One passkey assertion logs this browser in at the relay and, when the
// Mac is online, brings back a ticket sealed by the Mac. Pairing works the same way with the
// secret from the QR code.
import { decoder, fromB64u, toB64u } from '/shared/bytes.js';
import { ephemeralKey, loginChallenge, openBox, pairChallenge, pairProof, pairingId } from '/shared/channel.js';
import { createPasskey, getPasskey } from './passkey.js';
import { saveTicket } from './tickets.js';

export class AuthError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

async function post(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new AuthError('network');
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new AuthError(json.error ?? `http-${response.status}`, json);
  return json;
}

function passkeyError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') return new AuthError('cancelled');
  if (error?.name === 'InvalidStateError') return new AuthError('already-registered');
  return new AuthError('passkey-failed', { name: error?.name, message: error?.message });
}

export async function login() {
  const phone = await ephemeralKey();
  const start = await post('/api/login/options', { e: toB64u(phone.pub) });
  const agentPub = start.agent ? fromB64u(start.agent.e, 65) : null;
  const challenge = await loginChallenge({
    relayNonce: fromB64u(start.n, 32),
    phonePub: phone.pub,
    agent: start.agent && { hid: start.agent.hid, pub: agentPub, nonce: fromB64u(start.agent.n, 32) },
  });
  if (toB64u(challenge) !== start.options.challenge) throw new AuthError('bad-challenge');
  let response;
  try {
    response = await getPasskey(start.options);
  } catch (error) {
    throw passkeyError(error);
  }
  const finish = await post('/api/login/verify', { lid: start.lid, response });
  if (!finish.sealed) return { ticket: false, agentError: finish.agentError };
  const opened = await openBox({ privateKey: phone.privateKey, peerPub: agentPub, context: challenge }, fromB64u(finish.sealed));
  await saveTicket(JSON.parse(decoder.decode(opened)));
  return { ticket: true };
}

export async function pair(secret, deviceName) {
  const pid = await pairingId(secret);
  const phone = await ephemeralKey();
  const start = await post('/api/pair/options', { pid, e: toB64u(phone.pub) });
  const agentPub = fromB64u(start.e, 65);
  const challenge = await pairChallenge({ pid, phonePub: phone.pub, agentPub, agentNonce: fromB64u(start.n, 32) });
  if (toB64u(challenge) !== start.options.challenge) throw new AuthError('bad-challenge');
  let response;
  try {
    response = await createPasskey(start.options);
  } catch (error) {
    throw passkeyError(error);
  }
  const proof = await pairProof(secret, fromB64u(response.response.clientDataJSON), fromB64u(response.response.attestationObject));
  const finish = await post('/api/pair/verify', { pid, hid: start.hid, response, proof: toB64u(proof), name: deviceName });
  const opened = await openBox({ privateKey: phone.privateKey, peerPub: agentPub, salt: secret, context: challenge }, fromB64u(finish.sealed));
  await saveTicket(JSON.parse(decoder.decode(opened)));
}

// Chinese messages for the codes above; neutral wording, the login page is public.
export function describeError(error) {
  const code = error?.code ?? 'internal';
  const retry = error?.details?.retryAfterSec;
  return {
    cancelled: '已取消',
    network: '网络连接失败，请重试',
    'invalid-credentials': '验证没有通过，请重试',
    expired: '操作超时，请重试',
    'too-many-attempts': `尝试次数过多，请 ${retry ?? 60} 秒后再试`,
    'slow-down': '操作太频繁，请稍后再试',
    'not-paired': '还没有配对任何设备',
    'pairing-closed': '二维码已过期或已使用，请重新生成',
    'agent-offline': '设备离线，请稍后再试',
    'agent-timeout': '设备没有响应，请重试',
    'already-registered': '这台设备已经配对过了',
    'bad-proof': '二维码不完整，请重新扫描',
  }[code] ?? '出了点问题，请重试';
}
