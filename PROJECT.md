# Swisshost — Build Tracking Document

> P2P end-to-end-encrypted file-sharing + chat web app. Deployed at **swisshost.cc**.
> This file captures the original spec, architecture decisions, current build status, and
> next steps — so work can resume cleanly if a session is interrupted.

---

## 1. Original spec (verbatim requirements)

**Product:** "Swisshost" — a peer-to-peer file-sharing and chat web app. Name stored in a single
config constant so it's trivially renameable. Built with React + Vite. Works well on desktops,
mobile browsers, and smart-TV browsers.

### Connection flow
- User A clicks **Start Session** → generates a short, single-use room code (6 alphanumeric chars,
  expires after 10 minutes or first use).
- User B enters the code to join.
- A **Cloudflare Worker + Durable Object** acts as the signaling relay per room code — it only ever
  sees SDP/ICE handshake metadata, never message or file content.
- Once the WebRTC DataChannel is established, both peers do an **ECDH key exchange** (Web Crypto API)
  to derive a shared **AES-GCM** key.
- All chat messages and file chunks are encrypted with this session key before being sent —
  end-to-end encrypted on top of WebRTC's native DTLS-SRTP transport encryption.
- **ICE server config (STUN/TURN)** centralized in one config object so a TURN server can be added
  later by appending credentials — no architectural change. Ship v1 with STUN only (Google public STUN).
- Connection-state UI shows **"Direct (P2P)"** vs. future **"Relayed"** using the selected candidate
  pair type from `RTCPeerConnection`.

### Network limitations warning
- Clear, dismissible notice before/during setup: *"This works best on home Wi-Fi. Mobile data
  networks and corporate/office Wi-Fi often block the direct connections this app needs, and the
  transfer may fail to connect."*
- If connection fails after ~15s timeout, show a specific fallback message suggesting a home network,
  not a generic error.

### Chat
- Real-time text over its own dedicated DataChannel (separate from file transfer).
- No persistence — nothing stored server-side or client-side beyond the active session.
- Confirm before the user closes/navigates away mid-session.

### File sharing
- Drag-and-drop or file picker, chunked transfer with per-file progress bar, on its own DataChannel.
- Support multiple queued files.
- Soft warning above ~500MB, not a hard block.

### TV / remote-control support
- All interactive elements reachable + clearly focus-visible via D-pad/remote nav — large hit
  targets, visible focus rings (#c22525 red), no hover-only affordances.
- Single large room-code text field (not multi-box) for easier on-screen-keyboard entry.
- Account for older Tizen/WebOS/Android-TV engines and TV safe-zone margins (~5% edge padding).
- Larger "10-foot UI" font sizes/spacing at TV breakpoints.

### Trust / transparency UI
- Persistent copy: *"This connection is peer-to-peer and end-to-end encrypted. We cannot see your
  files or messages."* Expandable "How this works" section mentioning a relay may be used as a
  future fallback in poor network conditions.

### Design
- Brutalist: raw structural layout, visible borders/grid lines, monospace or heavy sans type,
  minimal ornamentation, sharp corners.
- Cream (#F5F1E8) base, #c22525 red primary accent (buttons, borders, active/focus).
- Fully responsive across mobile, desktop, TV.

### Config
- Site name, color tokens, room-code expiry duration, ICE server list — all in a single config file.

### Deliverables
- Full source (React/Vite frontend + Cloudflare Worker/Durable Object signaling backend).
- Step-by-step Cloudflare setup guide (account, Pages deploy, Worker/DO via wrangler, custom domain
  swisshost.cc DNS + SSL, env vars/secrets). → see `README.md`.

---

## 2. Architecture decisions

| Concern | Decision |
|---|---|
| Single config source | `src/config.js` — site name, colors, expiry, ICE servers, chunk size, timeouts. Colors are injected into CSS custom properties at runtime (`applyThemeTokens`) so JS is the single source of truth. |
| Room code generation | Generated **server-side** by the Durable Object on `create`, guaranteeing uniqueness + single-use tracking. 6 chars from an unambiguous alphabet (no 0/O/1/I). |
| Signaling | One Durable Object instance per room code (`idFromName(code)`). Holds ≤2 WebSockets (host+guest), relays opaque SDP/ICE JSON, enforces expiry + single-use, emits `peer-joined`/`peer-left` control events. Never sees decrypted content. |
| Initiator | **Host** is the WebRTC initiator: creates both DataChannels and the SDP offer once the DO signals `peer-joined`. Guest answers. Trickle ICE both directions. |
| Data channels | `chat` (ordered) and `file` (ordered) — separate so big transfers don't head-of-line-block chat. |
| E2E crypto | Per-peer ECDH (P-256) keypair via Web Crypto. Public keys swapped over the `chat` channel on open; derive shared **AES-GCM-256** key. Every app payload sealed: frame = `[type:1][iv:12][ciphertext]`. |
| File protocol (per file) | `meta` frame (name/size/type/id) → N `chunk` frames → `end` frame, all AES-GCM sealed. Backpressure via `bufferedAmount` + `bufferedamountlow`. |
| Connection type UI | Reads `RTCIceCandidatePair` via `getStats()`; maps selected local candidate `type` → `host/srflx/prc = Direct`, `relay = Relayed`. |

### Frame format (both channels)
```
[ type : 1 byte ][ iv : 12 bytes ][ AES-GCM ciphertext ]
type 0 = key exchange (plaintext pubkey, not sealed)   ← only on chat channel, pre-key
type 1 = chat text (sealed JSON {text, ts})
type 2 = file meta (sealed JSON {id, name, size, mime})
type 3 = file chunk (sealed raw bytes)
type 4 = file end  (sealed JSON {id})
```

---

## 3. File map

```
swisshost/
  README.md                  ← Cloudflare setup guide (deliverable)
  PROJECT.md                 ← this file
  package.json / vite.config.js / index.html
  src/
    config.js                ← SINGLE config source
    main.jsx                 ← boot + theme token injection
    App.jsx                  ← top-level view state machine
    styles.css               ← brutalist theme, TV/mobile breakpoints, focus rings
    lib/
      crypto.js              ← ECDH + AES-GCM seal/open, frame codec
      signaling.js           ← WebSocket client to the Worker/DO
      webrtc.js              ← RTCPeerConnection + channels + stats
      useSession.js          ← React hook orchestrating the whole session
      files.js               ← chunked send/receive over the file channel
    components/
      TrustBanner.jsx  HowItWorks.jsx  NetworkNotice.jsx
      Home.jsx  Session.jsx  ConnectionStatus.jsx  Chat.jsx  FileTransfer.jsx
  worker/
    wrangler.toml
    src/index.js             ← Worker + Room Durable Object
```

---

## 4. Build status

- [x] Project scaffold + config
- [x] Cloudflare Worker + Durable Object signaling
- [x] Crypto layer (ECDH/AES-GCM, frame codec)
- [x] Signaling client + WebRTC layer + useSession hook
- [x] Chunked file transfer
- [x] React UI (Home, Session, Chat, FileTransfer, status, trust/notice)
- [x] Brutalist styles + TV/mobile responsive + focus rings
- [x] README setup guide

## 5. Next steps / backlog (post-v1)
- Add a **TURN** server: append credentials to `CONFIG.iceServers` in `src/config.js` — no code
  changes elsewhere. TURN enables the "Relayed" path already surfaced in the UI.
- Local dev: run `wrangler dev` for the Worker and point `VITE_SIGNALING_URL` at it.
- Optional: multi-file parallelism (currently queued sequentially per file channel).
- Optional: resumable transfers, transfer cancel button wiring to sender pause.
- Optional: PWA manifest + offline shell.
- Test matrix: real Tizen / webOS / Android-TV devices for focus order + on-screen keyboard.

## 6. Improvement ideas (proposed, not yet built)

**Reliability**
1. **Add a TURN server** — the single biggest real-world reliability gap. STUN-only fails on
   most mobile/corporate networks (already warned about in the UI). A cheap TURN provider
   (Cloudflare Calls TURN, Twilio, Metered) would rescue a large share of failed connections;
   config/UI already support it — just append credentials to `iceServers`.
2. **Reconnect on transient ICE drop** — `disconnected` is currently treated the same as
   `failed`. ICE can self-recover from a brief Wi-Fi hiccup; add a short grace period before
   declaring failure.
3. **Resumable/retryable file transfers** — a transfer that dies mid-file leaves the receiver
   with an unusable partial blob. Track chunk offsets so a dropped connection can resume if the
   peer reconnects.

**UX polish**
4. **QR code for the room code** — one party is often on a phone; a scannable QR code next to
   the text code beats typing 6 characters, especially cross-device.
5. **Parallel multi-file sends** on the file channel (currently sequential) to improve
   throughput for queued transfers.
6. **Sound / vibration cue** on TV and mobile when a peer joins or a transfer completes —
   useful since a TV may not be watched attentively mid-transfer.
7. **Cancel button** for an in-flight outgoing transfer — `sendFile` already accepts a
   `shouldCancel` hook (see `src/lib/files.js`), just needs UI wiring.

**Trust/security surface**
8. **Fingerprint verification (optional)** — derive a short emoji/word fingerprint from both
   peers' ECDH public keys and display it on each side, so users can verbally confirm they
   aren't being MITM'd via a compromised signaling server. Closes the last trust gap (the app
   currently trusts the Durable Object to introduce the correct peer).
9. **Rate-limit room creation** per IP on the Worker to prevent signaling-backend abuse/spam.

**Ops**
10. **Content-free health metrics** — a `/api/stats` endpoint on the Worker surfacing DO
    alarm-triggered cleanup counts and connection success/fail counts (no user content logged).
    Useful for deciding whether STUN-only failure rates justify paying for TURN.
