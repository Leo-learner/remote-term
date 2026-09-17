// Passkeys, verified on this Mac. The relay checks the same assertions for its own login page,
// but only a check made here can open a shell: the relay is a shared box this Mac does not trust.
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { fromB64u, toB64u } from '../shared/bytes.js';
import { SIZES, ephemeralKey, loginChallenge, pairChallenge, pairingId, sealBox, verifyPairProof } from '../shared/channel.js';
import { JsonFile } from './store.js';

const PAIRING_TTL_MS = 10 * 60_000;
const HANDSHAKE_TTL_MS = 3 * 60_000;
const MAX_PENDING = 16;
const MAX_BAD_PROOFS = 3;

export class AuthError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

const cleanName = (name) => String(name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40);

function decodeField(value, size, field) {
  try {
    return fromB64u(value, size);
  } catch {
    throw new AuthError('bad-request', `bad ${field}`);
  }
}

export class PasskeyAuthority {
  constructor({ file, rpId, origin, tickets, now = Date.now, onChange = () => {} }) {
    this.store = new JsonFile(file, { userId: null, credentials: [] });
    this.rpId = rpId;
    this.origin = origin;
    this.tickets = tickets;
    this.now = now;
    this.onChange = onChange;
    this.pairing = null; // { secret, pid, expiresAt, badProofs }
    this.pending = new Map(); // hid -> handshake state
  }

  async load() {
    const value = await this.store.load();
    if (!Array.isArray(value.credentials)) value.credentials = [];
    if (!value.userId) {
      value.userId = randomBytes(16).toString('base64url');
      await this.store.save();
    }
    return this;
  }

  get credentials() {
    return this.store.value.credentials;
  }

  // What the relay needs to verify logins, and what the phone shows under "devices".
  publicCredentials() {
    return this.credentials.map(({ id, publicKey, counter, transports, name, createdAt, lastUsedAt }) => (
      { id, publicKey, counter, transports, name, createdAt, lastUsedAt }));
  }

  removeCredential(id) {
    const before = this.credentials.length;
    this.store.value.credentials = this.credentials.filter((credential) => credential.id !== id);
    if (this.credentials.length === before) return false;
    this.tickets.revokeCredential(id);
    this.store.save();
    this.onChange();
    return true;
  }

  // ---- pending handshakes ------------------------------------------------------------------

  remember(state) {
    const at = this.now();
    for (const [hid, item] of this.pending) if (at - item.at > HANDSHAKE_TTL_MS) this.pending.delete(hid);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value);
    const hid = randomBytes(SIZES.hid).toString('base64url');
    this.pending.set(hid, { ...state, at });
    return hid;
  }

  // Single use: a handshake id is gone after the first finish attempt, successful or not.
  take(hid, kind) {
    const state = typeof hid === 'string' ? this.pending.get(hid) : undefined;
    if (!state) return null;
    this.pending.delete(hid);
    if (state.kind !== kind || this.now() - state.at > HANDSHAKE_TTL_MS) return null;
    return state;
  }

  // ---- pairing -----------------------------------------------------------------------------

  // Opens a ten-minute window for one new passkey. The secret goes into the QR code's URL
  // fragment; the relay is only told the pairing id.
  async openPairing(publicOrigin = this.origin) {
    const secret = randomBytes(32);
    const pid = await pairingId(secret);
    this.pairing = { secret, pid, expiresAt: this.now() + PAIRING_TTL_MS, badProofs: 0 };
    this.onChange();
    return { pid, expiresAt: this.pairing.expiresAt, url: `${publicOrigin}/pair#${toB64u(secret)}` };
  }

  pairingState() {
    if (this.pairing && this.pairing.expiresAt <= this.now()) this.pairing = null;
    return this.pairing ? { pid: this.pairing.pid, expiresAt: this.pairing.expiresAt } : null;
  }

  closePairing() {
    if (!this.pairing) return;
    this.pairing = null;
    this.onChange();
  }

  openPairingFor(pid) {
    const state = this.pairingState();
    if (!state || state.pid !== pid) throw new AuthError('pairing-closed');
    return this.pairing;
  }

  async pairStart({ pid, e }) {
    this.openPairingFor(pid);
    const phonePub = decodeField(e, SIZES.pub, 'e');
    const eph = await ephemeralKey();
    const nonce = randomBytes(SIZES.nonce);
    const challenge = await pairChallenge({ pid, phonePub, agentPub: eph.pub, agentNonce: nonce });
    const hid = this.remember({ kind: 'pair', pid, phonePub, eph, challenge });
    const user = userInfo().username;
    return {
      hid,
      e: toB64u(eph.pub),
      n: toB64u(nonce),
      options: {
        challenge: toB64u(challenge),
        rp: { id: this.rpId, name: this.rpId },
        user: { id: this.store.value.userId, name: user, displayName: user },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        timeout: 120_000,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        excludeCredentials: this.credentials.map(({ id, transports }) => ({ id, type: 'public-key', transports })),
        hints: ['client-device'],
      },
    };
  }

  async pairFinish({ pid, hid, response, proof, name }) {
    const state = this.take(hid, 'pair');
    if (!state || state.pid !== pid) throw new AuthError('handshake-expired');
    const pairing = this.openPairingFor(pid);

    const clientDataJSON = decodeField(response?.response?.clientDataJSON, undefined, 'clientDataJSON');
    const attestationObject = decodeField(response?.response?.attestationObject, undefined, 'attestationObject');
    const proofBytes = decodeField(proof, SIZES.mac, 'proof');
    if (!(await verifyPairProof(pairing.secret, proofBytes, clientDataJSON, attestationObject))) {
      pairing.badProofs += 1;
      if (pairing.badProofs >= MAX_BAD_PROOFS) this.closePairing();
      throw new AuthError('bad-proof');
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: toB64u(state.challenge),
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
      });
    } catch (error) {
      throw new AuthError('bad-registration', error.message);
    }
    if (!verification.verified) throw new AuthError('bad-registration');
    const { credential, credentialBackedUp } = verification.registrationInfo;
    if (this.credentials.some((item) => item.id === credential.id)) throw new AuthError('already-registered');

    const at = this.now();
    const deviceName = cleanName(name) || 'iPhone';
    this.credentials.push({
      id: credential.id,
      publicKey: toB64u(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      backedUp: credentialBackedUp,
      name: deviceName,
      createdAt: at,
      lastUsedAt: at,
    });
    this.pairing = null; // one QR code, one passkey
    await this.store.save();
    this.onChange();

    const ticket = this.tickets.mint({ credentialId: credential.id, device: deviceName });
    const sealed = await sealBox(
      { privateKey: state.eph.privateKey, peerPub: state.phonePub, salt: pairing.secret, context: state.challenge },
      JSON.stringify({ tid: ticket.tid, k: toB64u(ticket.key), cid: credential.id }),
    );
    return { credentialId: credential.id, sealed: toB64u(sealed) };
  }

  // ---- login -------------------------------------------------------------------------------

  async loginStart({ e }) {
    if (this.credentials.length === 0) throw new AuthError('not-paired');
    const phonePub = decodeField(e, SIZES.pub, 'e');
    const eph = await ephemeralKey();
    const nonce = randomBytes(SIZES.nonce);
    const hid = this.remember({ kind: 'login', phonePub, eph, nonce });
    return { hid, e: toB64u(eph.pub), n: toB64u(nonce) };
  }

  // The relay passes along its own nonce and the phone's key; if it altered either, the
  // challenge computed here differs from the one the passkey signed and verification fails.
  async loginFinish({ hid, relayNonce, e, response }) {
    const state = this.take(hid, 'login');
    if (!state) throw new AuthError('handshake-expired');
    const phonePub = decodeField(e, SIZES.pub, 'e');
    if (toB64u(phonePub) !== toB64u(state.phonePub)) throw new AuthError('bad-handshake');
    const challenge = await loginChallenge({
      relayNonce: decodeField(relayNonce, SIZES.nonce, 'relayNonce'),
      phonePub,
      agent: { hid, pub: state.eph.pub, nonce: state.nonce },
    });

    const stored = this.credentials.find((item) => item.id === response?.id);
    if (!stored) throw new AuthError('unknown-credential');
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: toB64u(challenge),
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        credential: {
          id: stored.id,
          publicKey: fromB64u(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports,
        },
        requireUserVerification: true,
      });
    } catch (error) {
      throw new AuthError('bad-assertion', error.message);
    }
    if (!verification.verified) throw new AuthError('bad-assertion');

    stored.counter = verification.authenticationInfo.newCounter;
    stored.lastUsedAt = this.now();
    this.store.save();

    const ticket = this.tickets.mint({ credentialId: stored.id, device: stored.name });
    const sealed = await sealBox(
      { privateKey: state.eph.privateKey, peerPub: phonePub, context: challenge },
      JSON.stringify({ tid: ticket.tid, k: toB64u(ticket.key), cid: stored.id }),
    );
    return { credentialId: stored.id, sealed: toB64u(sealed) };
  }

  flush() {
    return this.store.tail;
  }
}
