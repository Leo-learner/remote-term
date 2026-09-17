// WebAuthn with JSON in and JSON out, in the shapes SimpleWebAuthn expects on the other side.
// Conversions are done by hand rather than with the newer browser JSON helpers, so every Safari
// version produces exactly the same fields.
import { fromB64u, toB64u } from '/shared/bytes.js';

export function passkeysSupported() {
  return typeof window.PublicKeyCredential === 'function' && typeof navigator.credentials?.get === 'function';
}

const credentialList = (list) => (list ?? []).map((item) => ({ ...item, id: fromB64u(item.id) }));

export async function createPasskey(options) {
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromB64u(options.challenge),
      user: { ...options.user, id: fromB64u(options.user.id) },
      excludeCredentials: credentialList(options.excludeCredentials),
    },
  });
  const { response } = credential;
  return {
    id: credential.id,
    rawId: toB64u(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toB64u(response.clientDataJSON),
      attestationObject: toB64u(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

export async function getPasskey(options) {
  const credential = await navigator.credentials.get({
    publicKey: { ...options, challenge: fromB64u(options.challenge), allowCredentials: credentialList(options.allowCredentials) },
  });
  const { response } = credential;
  return {
    id: credential.id,
    rawId: toB64u(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toB64u(response.clientDataJSON),
      authenticatorData: toB64u(response.authenticatorData),
      signature: toB64u(response.signature),
      userHandle: response.userHandle ? toB64u(response.userHandle) : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}
