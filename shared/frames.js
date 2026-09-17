// Wire framing.
//
// Phone <-> relay WebSocket: text frames are relay status ({type:'agent', online}); binary frames
// are end-to-end and opaque to the relay: one outer byte, then
//   0x00 HANDSHAKE  JSON (hello / welcome / reject), before the channel exists
//   0x01 SEALED     AES-GCM ciphertext of an inner frame
//
// Inner frame (plaintext inside SEALED): one opcode byte, then
//   0x01 CONTROL    JSON message
//   0x02 OUTPUT     u32 channel + terminal bytes (Mac -> phone)
//   0x03 INPUT      u32 channel + terminal bytes (phone -> Mac)
//   0x04 SNAPSHOT   u32 channel + serialized screen; the phone resets the terminal first
//
// Relay <-> agent WebSocket: text frames are JSON control; binary frames are u32 link id + the
// phone's binary frame, unchanged.
import { bytes, concat, decoder, encoder } from './bytes.js';

export const OUTER = { HANDSHAKE: 0, SEALED: 1 };
export const OP = { CONTROL: 1, OUTPUT: 2, INPUT: 3, SNAPSHOT: 4 };

export const LIMITS = {
  phoneFrame: 256 * 1024, // one binary frame from the phone (a large paste is split)
  inputChunk: 32 * 1024,
  controlJson: 64 * 1024,
};

export function outer(type, payload) {
  return concat([type], payload);
}

export function handshakeFrame(message) {
  return outer(OUTER.HANDSHAKE, encoder.encode(JSON.stringify(message)));
}

export function parseOuter(frame) {
  const data = bytes(frame);
  if (data.length < 1) return null;
  if (data[0] === OUTER.HANDSHAKE) {
    try {
      return { type: OUTER.HANDSHAKE, message: JSON.parse(decoder.decode(data.subarray(1))) };
    } catch {
      return null;
    }
  }
  if (data[0] === OUTER.SEALED) return { type: OUTER.SEALED, payload: data.subarray(1) };
  return null;
}

export function controlFrame(message) {
  return concat([OP.CONTROL], encoder.encode(JSON.stringify(message)));
}

export function dataFrame(op, channel, payload) {
  const header = new Uint8Array(5);
  header[0] = op;
  new DataView(header.buffer).setUint32(1, channel >>> 0);
  return concat(header, typeof payload === 'string' ? encoder.encode(payload) : payload);
}

// Returns { op, message } for CONTROL, { op, channel, data } for the data opcodes, or null.
export function parseInner(frame) {
  const data = bytes(frame);
  if (data.length < 1) return null;
  const op = data[0];
  if (op === OP.CONTROL) {
    if (data.length - 1 > LIMITS.controlJson) return null;
    try {
      const message = JSON.parse(decoder.decode(data.subarray(1)));
      return message && typeof message === 'object' && typeof message.t === 'string' ? { op, message } : null;
    } catch {
      return null;
    }
  }
  if (op === OP.OUTPUT || op === OP.INPUT || op === OP.SNAPSHOT) {
    if (data.length < 5) return null;
    const channel = new DataView(data.buffer, data.byteOffset + 1, 4).getUint32(0);
    return { op, channel, data: data.subarray(5) };
  }
  return null;
}

export function linkFrame(linkId, payload) {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, linkId >>> 0);
  return concat(header, payload);
}

export function parseLinkFrame(frame) {
  const data = bytes(frame);
  if (data.length < 5) return null;
  return { linkId: new DataView(data.buffer, data.byteOffset, 4).getUint32(0), payload: data.subarray(4) };
}
