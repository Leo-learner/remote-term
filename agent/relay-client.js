// Outbound WebSocket to the relay. The Mac listens on no port; this link is the only way in.
//   text, agent → relay   {type:'hello', version, credentials, pairing}, {type:'credentials', list, pairing},
//                         {type:'rpc-result', rid, ok, result | error}, {type:'drop', link, reason}
//   text, relay → agent   {type:'link-open', link}, {type:'link-close', link}, {type:'rpc', rid, method, params}
//   binary, both ways     u32 link id + a phone's frame, which only the phone and this Mac can read
import WebSocket from 'ws';
import { linkFrame, parseLinkFrame } from '../shared/frames.js';

const PING_EVERY_MS = 20_000;
const MAX_RETRY_MS = 30_000;

export function startRelayClient({ url, token, hello, onMessage, onFrame, onStatus }) {
  let socket = null;
  let pingTimer = null;
  let retryTimer = null;
  let retryMs = 1000;
  let stopped = false;

  const open = () => socket?.readyState === WebSocket.OPEN;

  function connect() {
    if (stopped) return;
    onStatus('connecting');
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 10_000,
      maxPayload: 1 << 20,
      perMessageDeflate: false, // most bytes are ciphertext, which does not compress
    });
    socket = ws;
    let awaitingPong = false;

    ws.on('open', () => {
      retryMs = 1000;
      ws._socket?.setNoDelay?.(true);
      ws.send(JSON.stringify(hello()));
      onStatus('connected');
      // A link that died silently (sleep, network change) is only noticed by a missing pong.
      pingTimer = setInterval(() => {
        if (awaitingPong) return ws.terminate();
        awaitingPong = true;
        ws.ping();
      }, PING_EVERY_MS);
    });
    ws.on('pong', () => {
      awaitingPong = false;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = parseLinkFrame(data);
        if (frame) onFrame(frame.linkId, frame.payload);
        return;
      }
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      onMessage(message);
    });
    ws.on('error', (error) => onStatus('error', { message: error.message }));
    ws.on('close', (code) => {
      clearInterval(pingTimer);
      if (socket === ws) socket = null;
      onStatus('disconnected', { code });
      if (!stopped) {
        const delay = retryMs * (0.8 + Math.random() * 0.4);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        retryTimer = setTimeout(connect, delay);
      }
    });
  }

  connect();
  return {
    sendJson(message) {
      if (open()) socket.send(JSON.stringify(message));
    },
    sendFrame(linkId, payload) {
      if (open()) socket.send(linkFrame(linkId, payload), { binary: true });
    },
    bufferedAmount: () => socket?.bufferedAmount ?? 0,
    stop() {
      stopped = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      socket?.close(1000, 'agent stopping');
    },
  };
}
