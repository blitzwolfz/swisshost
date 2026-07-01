// ============================================================================
// Swisshost signaling backend — Cloudflare Worker + Durable Object
//
// One Durable Object instance per room code. Its ONLY job is to relay opaque
// WebRTC signaling (SDP offer/answer + ICE candidates) between exactly two
// peers, and to enforce room-code lifetime + single use. It never sees — and
// has no way to decrypt — chat messages or file content; those travel over the
// peers' direct WebRTC DataChannel and are additionally AES-GCM encrypted.
//
// Routes (all under the Worker):
//   POST /api/room                      -> { code }   (host creates a room)
//   GET  /api/room/:code/ws?role=host   -> WebSocket   (host joins)
//   GET  /api/room/:code/ws?role=guest  -> WebSocket   (guest joins, consumes code)
// ============================================================================

// Room-code generation must match the client's expectations. Kept here so the
// server is authoritative for uniqueness + single-use.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const ROOM_TTL_MS = 10 * 60 * 1000; // 10 minutes

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function randomCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'swisshost-signaling' });
    }

    // Create a room: generate a code, initialize its Durable Object.
    if (url.pathname === '/api/room' && request.method === 'POST') {
      const code = randomCode();
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      const res = await stub.fetch('https://do/init', {
        method: 'POST',
        body: JSON.stringify({ code, ttlMs: ROOM_TTL_MS }),
      });
      if (!res.ok) return json({ error: 'could not create room' }, 500);
      return json({ code, expiresInMs: ROOM_TTL_MS });
    }

    // WebSocket join: /api/room/:code/ws
    const wsMatch = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]+)\/ws$/);
    if (wsMatch) {
      const code = wsMatch[1].toUpperCase();
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      // Forward the upgrade to the DO, preserving the role query param.
      return stub.fetch(`https://do/ws${url.search}`, request);
    }

    return json({ error: 'not found' }, 404);
  },
};

// ---------------------------------------------------------------------------
// Durable Object: one per room code.
// ---------------------------------------------------------------------------
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // In-memory live sockets for this room (DO is single-threaded & sticky).
    this.host = null;
    this.guest = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init') {
      const { code, ttlMs } = await request.json();
      const now = Date.now();
      await this.state.storage.put('meta', {
        code,
        createdAt: now,
        expiresAt: now + ttlMs,
        consumed: false, // set true once a guest joins (single-use)
      });
      // Self-clean when the code expires.
      await this.state.storage.setAlarm(now + ttlMs);
      return new Response('ok');
    }

    if (url.pathname === '/ws') {
      return this.handleWs(request, url);
    }

    return new Response('not found', { status: 404 });
  }

  async handleWs(request, url) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const role = url.searchParams.get('role') === 'host' ? 'host' : 'guest';
    const meta = await this.state.storage.get('meta');

    // Validate room lifetime + single use.
    if (!meta) {
      return this.rejectWs('room-not-found');
    }
    if (Date.now() > meta.expiresAt) {
      return this.rejectWs('room-expired');
    }
    if (role === 'guest' && meta.consumed) {
      return this.rejectWs('room-already-used');
    }
    if (role === 'host' && this.host) {
      return this.rejectWs('host-already-present');
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (role === 'host') {
      this.host = server;
    } else {
      this.guest = server;
      // First guest consumes the single-use code.
      meta.consumed = true;
      await this.state.storage.put('meta', meta);
    }

    server.addEventListener('message', (evt) => {
      // Pure relay: forward opaque signaling to the *other* peer only.
      const other = role === 'host' ? this.guest : this.host;
      if (other && other.readyState === 1) {
        other.send(evt.data);
      }
    });

    const cleanup = () => {
      if (role === 'host') this.host = null;
      else this.guest = null;
      const other = role === 'host' ? this.guest : this.host;
      if (other && other.readyState === 1) {
        other.send(JSON.stringify({ type: 'peer-left' }));
      }
    };
    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    // Notify presence so the host knows when to create its SDP offer.
    // (These control frames are generated by the DO, not relayed peer content.)
    if (role === 'guest' && this.host && this.host.readyState === 1) {
      this.host.send(JSON.stringify({ type: 'peer-joined' }));
    }
    if (role === 'host' && this.guest && this.guest.readyState === 1) {
      // Rare re-join ordering: host arrived after guest.
      this.host = server;
      server.send(JSON.stringify({ type: 'peer-joined' }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  rejectWs(reason) {
    // Accept then immediately close with a reason so the client can show a
    // specific message instead of a generic failure.
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.send(JSON.stringify({ type: 'error', reason }));
    server.close(4000, reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Fires at expiry: drop everything so nothing lingers server-side.
  async alarm() {
    if (this.host && this.host.readyState === 1) {
      this.host.send(JSON.stringify({ type: 'room-expired' }));
      this.host.close(4001, 'room-expired');
    }
    if (this.guest && this.guest.readyState === 1) {
      this.guest.close(4001, 'room-expired');
    }
    await this.state.storage.deleteAll();
  }
}
