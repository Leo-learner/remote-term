// Byte helpers shared by the browser and Node. Both have btoa/atob, TextEncoder and WebCrypto,
// so every module in shared/ runs unchanged on the phone, the relay and the Mac.
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function bytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') return encoder.encode(input);
  if (Array.isArray(input)) return Uint8Array.from(input);
  throw new TypeError('expected bytes');
}

export function concat(...parts) {
  const list = parts.map(bytes);
  const out = new Uint8Array(list.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of list) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toB64u(input) {
  const data = bytes(input);
  let binary = '';
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Throws on anything that is not base64url, and on a length mismatch when one is expected.
export function fromB64u(text, expectedLength) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new TypeError('invalid base64url');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new TypeError(`expected ${expectedLength} bytes, got ${out.length}`);
  }
  return out;
}

export function randomBytes(length) {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
