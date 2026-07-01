// ============================================================================
// Swisshost — SINGLE SOURCE OF CONFIG
// Site name, color tokens, room-code expiry, and the ICE server list all live
// here. Rename the product, re-theme it, or add a TURN server by editing only
// this file.
// ============================================================================

export const CONFIG = {
  // --- Identity -------------------------------------------------------------
  siteName: 'Swisshost',
  domain: 'swisshost.cc',
  tagline: 'Peer-to-peer. End-to-end encrypted. No middleman.',

  // --- Color tokens ---------------------------------------------------------
  // These are injected into CSS custom properties at runtime (see main.jsx /
  // applyThemeTokens) so this object is the single source of truth for color.
  colors: {
    cream: '#F5F1E8', // base background
    paper: '#FBF8F1', // raised surfaces
    ink: '#141210', // near-black text / borders
    red: '#c22525', // primary accent, buttons, focus rings, active state
    redDark: '#8f1a1a', // pressed / hover-darken
    muted: '#6b655c', // secondary text
    line: '#141210', // grid / border lines
    ok: '#1f7a4d', // success (connected / transfer complete)
    warn: '#b8860b', // soft warnings
  },

  // --- Room codes -----------------------------------------------------------
  roomCode: {
    length: 6,
    // Unambiguous alphabet — no 0/O/1/I/L to ease on-screen-keyboard entry on TV.
    alphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
    expiryMs: 10 * 60 * 1000, // 10 minutes OR first use, whichever comes first
  },

  // --- Timeouts -------------------------------------------------------------
  connectionTimeoutMs: 15_000, // ~15s → show the "try a home network" fallback

  // --- File transfer --------------------------------------------------------
  file: {
    chunkSize: 16 * 1024, // 16 KB per chunk (safe across TV DataChannel impls)
    bufferedHighWater: 8 * 1024 * 1024, // pause sending above 8 MB buffered
    bufferedLowWater: 1 * 1024 * 1024, // resume below 1 MB buffered
    softWarnBytes: 500 * 1024 * 1024, // soft warning above ~500 MB (not a block)
  },

  // --- Signaling backend ----------------------------------------------------
  // The Cloudflare Worker/Durable Object WebSocket endpoint. Override per env
  // with VITE_SIGNALING_URL (see README). Falls back to same-origin /connect.
  signalingUrl:
    import.meta.env?.VITE_SIGNALING_URL ||
    (typeof location !== 'undefined'
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
      : ''),

  // --- ICE servers ----------------------------------------------------------
  // v1 ships STUN-only (Google public STUN). To enable the "Relayed" fallback
  // path, append TURN entries here with credentials — NO other code changes
  // are required; the UI already distinguishes Direct vs Relayed.
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Example TURN (add later):
    // {
    //   urls: 'turn:turn.swisshost.cc:3478',
    //   username: 'YOUR_TURN_USER',
    //   credential: 'YOUR_TURN_SECRET',
    // },
  ],
};

// Convenience: the WebRTC config object consumed by RTCPeerConnection.
export const RTC_CONFIG = {
  iceServers: CONFIG.iceServers,
  iceCandidatePoolSize: 2,
};
