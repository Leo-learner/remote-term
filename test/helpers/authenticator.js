// A software passkey for tests: produces registration and assertion responses in the exact JSON
// shape browsers hand to SimpleWebAuthn, signed with a real P-256 key.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => createHash('sha256').update(data).digest();

// ---- minimal CBOR encoder (ints, byte strings, text, maps) ----------------------------------

function head(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  if (value < 65536) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(value, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(value, 1);
  return out;
}

export function cbor(value) {
  if (Number.isInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [key, item] of value) parts.push(cbor(key), cbor(item));
    return Buffer.concat(parts);
  }
  throw new TypeError(`cbor: unsupported ${typeof value}`);
}

// ---- authenticator ------------------------------------------------------------------------

const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };

export class SoftPasskey {
  constructor({ rpId, origin }) {
    this.rpId = rpId;
    this.origin = origin;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.jwk = publicKey.export({ format: 'jwk' });
    this.credentialId = randomBytes(20);
    this.userHandle = null;
    this.flags = FLAG.UP | FLAG.UV | FLAG.BE | FLAG.BS;
  }

  get id() {
    return b64u(this.credentialId);
  }

  coseKey() {
    return cbor(new Map([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(this.jwk.x, 'base64url')],
      [-3, Buffer.from(this.jwk.y, 'base64url')],
    ]));
  }

  authData({ attested, flags = this.flags, rpId = this.rpId }) {
    const counter = Buffer.alloc(4); // passkeys synced by iCloud Keychain always report 0
    const parts = [sha256(rpId), Buffer.from([attested ? flags | FLAG.AT : flags]), counter];
    if (attested) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), idLength, this.credentialId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  clientData(type, challengeB64u, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge: challengeB64u, origin, crossOrigin: false }));
  }

  // options: PublicKeyCredentialCreationOptionsJSON (challenge and user.id are base64url)
  create(options, { origin, flags } = {}) {
    this.userHandle = options.user?.id ?? null;
    const clientDataJSON = this.clientData('webauthn.create', options.challenge, origin);
    const attestationObject = cbor(new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', this.authData({ attested: true, flags, rpId: options.rp?.id ?? this.rpId })],
    ]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  // options: PublicKeyCredentialRequestOptionsJSON
  get(options, { origin, flags, signWith } = {}) {
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, origin);
    const authenticatorData = this.authData({ attested: false, flags, rpId: options.rpId ?? this.rpId });
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), signWith ?? this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(signature),
        userHandle: this.userHandle ?? undefined,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
