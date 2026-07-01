// ============================================================================
// Signaling client — talks to the Cloudflare Worker/Durable Object.
//
// Two responsibilities:
//   1. createRoom()  -> POST /api/room, returns a server-generated room code.
//   2. connect()     -> open a WebSocket to the room's DO to exchange opaque
//                       SDP/ICE. All content payloads travel over WebRTC, never
//                       this socket.
// ============================================================================

import { CONFIG } from '../config.js';

function httpBase() {
  // Signaling URL is a ws(s):// origin; derive the matching http(s):// origin.
  return CONFIG.signalingUrl.replace(/^ws/, 'http');
}

export async function createRoom() {
  const res = await fetch(`${httpBase()}/api/room`, { method: 'POST' });
  if (!res.ok) throw new Error('Could not reach the signaling server.');
  return res.json(); // { code, expiresInMs }
}

// Opens the signaling WebSocket for a room. `handlers` is a map of
// { onOpen, onMessage(obj), onClose(reason), onError }.
export function connect(code, role, handlers) {
  const url = `${CONFIG.signalingUrl}/api/room/${encodeURIComponent(
    code
  )}/ws?role=${role}`;
  const ws = new WebSocket(url);

  ws.addEventListener('open', () => handlers.onOpen?.());
  ws.addEventListener('message', (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    handlers.onMessage?.(msg);
  });
  ws.addEventListener('close', (evt) =>
    handlers.onClose?.(evt.reason || 'closed', evt.code)
  );
  ws.addEventListener('error', () => handlers.onError?.());

  return {
    send(obj) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    close() {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    },
    get raw() {
      return ws;
    },
  };
}
