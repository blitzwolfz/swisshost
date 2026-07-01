# Swisshost

**Peer-to-peer, end-to-end-encrypted file sharing and chat.** No accounts, no logs,
nothing stored. Built with React + Vite (frontend) and a Cloudflare Worker + Durable
Object (signaling only). Designed for desktop, mobile, and smart-TV browsers.

- Chat and files travel over a **direct WebRTC DataChannel** between the two browsers.
- Content is **AES-GCM encrypted** with a key derived from an in-browser **ECDH** exchange —
  end-to-end encrypted on top of WebRTC's own DTLS transport encryption.
- The server only ever relays the SDP/ICE **handshake**. It cannot see your messages or files.

> Rename the whole product, re-theme it, change the code expiry, or add a TURN server by
> editing **one file**: [`src/config.js`](src/config.js).

---

## Repository layout

```
src/                 React + Vite frontend
  config.js          ← single source of config (name, colors, expiry, ICE servers)
  lib/               crypto, signaling, webrtc, chunked files, useSession hook
  components/        UI (Home, Session, Chat, FileTransfer, trust/notice, status)
worker/              Cloudflare Worker + Durable Object signaling backend
  src/index.js       Worker + `Room` Durable Object
  wrangler.toml
PROJECT.md           full spec + architecture notes + backlog
```

---

## Local development

Prerequisites: **Node 18+** and npm.

```bash
npm install

# Terminal 1 — signaling backend (Worker + Durable Object) on :8787
npm run worker:dev

# Terminal 2 — frontend on :5173
cp .env.example .env         # VITE_SIGNALING_URL=ws://localhost:8787
npm run dev
```

Open the printed URL in **two** browser tabs/devices on the **same home network**: start a
session in one, copy the code, join from the other. (Two tabs on one machine also works for
a smoke test.)

---

## Cloudflare deployment guide

This deploys three things:

1. the **signaling Worker + Durable Object** (`wrangler`),
2. the **static frontend** (Cloudflare Pages), and
3. the **custom domain** `swisshost.cc` (DNS + SSL) for both.

You'll end up with:

- `https://swisshost.cc` → the frontend (Pages)
- `wss://signal.swisshost.cc` → the signaling Worker

### Step 0 — Create a Cloudflare account

1. Go to <https://dash.cloudflare.com/sign-up>, create an account, verify your email
   (check your inbox for a Cloudflare verification link — you can't do anything until
   this is confirmed).
2. Log in with the CLI. `wrangler` is already a local devDependency (installed by
   `npm install` earlier), so run it via `npx` from inside the project folder — **don't**
   `npm install -g wrangler`; global npm installs on macOS commonly fail with `EACCES`
   permission errors unless npm's global prefix has been reconfigured, and it isn't
   needed here anyway:
   ```bash
   cd ~/Desktop/swisshost
   npx wrangler login            # opens a browser to authorize
   ```
   This opens your default browser to a Cloudflare "Authorize Wrangler" page. Click
   **Allow**, then return to the terminal — it should print `Successfully logged in`.
   If you have multiple Cloudflare accounts, `wrangler` will ask you to pick one the
   first time you run `npx wrangler deploy` (Step 2); pick the account you just created.
   Every other `wrangler` command in this guide (and the `npm run worker:*` scripts)
   already uses the local copy — you'll never need a global install.
3. Find your **Account ID** (you may need it later): dashboard → any domain or
   **Workers & Pages** → right sidebar shows "Account ID" as a copyable string. Not
   required for the commands below since `wrangler login` handles auth, but useful if
   you ever need to set it explicitly via `account_id` in `wrangler.toml`.

### Step 1 — Add the domain `swisshost.cc` to Cloudflare

1. In the dashboard: **Add a site** → enter `swisshost.cc` → pick a plan (Free is fine).
2. Cloudflare shows you **two nameservers** (e.g. `xxx.ns.cloudflare.com`).
3. At your **domain registrar** (where you bought swisshost.cc), replace the existing
   nameservers with Cloudflare's two. Save.
4. Wait for Cloudflare to report the domain as **Active** (minutes to a few hours). SSL
   certificates are provisioned automatically once active.
5. Recommended: **SSL/TLS → Overview → Full (strict)**.

> Durable Objects run fine on the **Workers Free** plan as long as they use
> SQLite-backed storage — `worker/wrangler.toml` already declares this
> (`new_sqlite_classes`), so no paid plan is required. If you ever see the deploy error
> `In order to use Durable Objects with a free plan, you must create a namespace using a
> 'new_sqlite_classes' migration`, it means the migration in `wrangler.toml` reverted to
> the older `new_classes` form — switch it back to `new_sqlite_classes`.

### Step 2 — Deploy the signaling Worker + Durable Object

From the repo root:

```bash
npm run worker:deploy          # = wrangler deploy --config worker/wrangler.toml
```

`worker/wrangler.toml` already declares the Durable Object and its migration:

```toml
name = "swisshost-signaling"
main = "src/index.js"
compatibility_date = "2024-11-01"

[[durable_objects.bindings]]
name = "ROOM"
class_name = "Room"

[[migrations]]
tag = "v1"
new_classes = ["Room"]
```

After deploy you'll get a `https://swisshost-signaling.<your-subdomain>.workers.dev` URL.
Test it:

```bash
curl https://swisshost-signaling.<your-subdomain>.workers.dev/health
# {"ok":true,"service":"swisshost-signaling"}
```

**No secrets are required** for v1 (STUN-only, no TURN). If you later add a TURN provider
whose credentials you'd rather not hard-code, store them as secrets:

```bash
wrangler secret put TURN_USERNAME --config worker/wrangler.toml
wrangler secret put TURN_CREDENTIAL --config worker/wrangler.toml
```

…and read them in the Worker, or (simpler for v1) just append the TURN entry directly to
`iceServers` in `src/config.js`.

### Step 3 — Map the Worker to `signal.swisshost.cc`

1. Open `worker/wrangler.toml` and **uncomment** the route block:
   ```toml
   [[routes]]
   pattern = "signal.swisshost.cc"
   custom_domain = true
   ```
2. Redeploy:
   ```bash
   npm run worker:deploy
   ```
   `custom_domain = true` makes wrangler **auto-create the DNS record** for
   `signal.swisshost.cc` and provision its SSL certificate. No manual DNS entry needed.
3. Verify: `curl https://signal.swisshost.cc/health` → `{"ok":true,...}`.

### Step 4 — Build & deploy the frontend to Cloudflare Pages

**Option A — Git-connected (recommended):**

1. Push this repo to GitHub/GitLab.
2. Dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick the repo.
3. Build settings:
   - **Framework preset:** Vite
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
4. **Environment variables** (Settings → Variables) — add:
   - `VITE_SIGNALING_URL = wss://signal.swisshost.cc`
5. **Save and Deploy.** Every push to the production branch redeploys automatically.

**Option B — Direct upload via CLI:**

```bash
VITE_SIGNALING_URL=wss://signal.swisshost.cc npm run build
npx wrangler pages deploy dist --project-name swisshost
```

### Step 5 — Point `swisshost.cc` at the Pages site

1. In the Pages project → **Custom domains → Set up a custom domain**.
2. Add `swisshost.cc` (and optionally `www.swisshost.cc`).
3. Because the domain is already on Cloudflare, the required DNS `CNAME`/`A` records and
   SSL certificate are created for you automatically. Wait until it shows **Active**.

### Step 6 — Final verification

- Visit `https://swisshost.cc` on two devices on **home Wi-Fi**.
- Start a session on one, join with the code on the other.
- Status bar should read **Connected · Direct (P2P)**.
- Send a chat message and a file both directions.
- Open DevTools → Network on the signaling socket: you'll see only SDP/ICE JSON, never
  message or file content.

---

## Configuration reference (`src/config.js`)

| Field | Purpose |
|---|---|
| `siteName`, `domain`, `tagline` | Product identity (rename here). |
| `colors.*` | Theme tokens; injected into CSS custom properties at runtime. |
| `roomCode.length` / `alphabet` / `expiryMs` | Code shape and lifetime (10 min default). |
| `connectionTimeoutMs` | When to show the "try a home network" fallback (~15s). |
| `file.chunkSize` / `bufferedHighWater` / `bufferedLowWater` | Transfer tuning. |
| `file.softWarnBytes` | Soft large-file warning threshold (~500 MB). |
| `signalingUrl` | Worker ws(s):// origin (via `VITE_SIGNALING_URL`). |
| `iceServers` | **Add TURN here** to enable the Relayed fallback — no other change needed. |

## Adding a TURN server later (enables "Relayed")

v1 ships STUN-only, so connections fail on networks that block P2P (the app already warns
about this). STUN just helps two peers discover their public IP/port — it never carries
your traffic. **TURN is a relay server that actually forwards packets** when a direct
connection isn't possible, so it always needs an account/server you control, with real
credentials. There's no way around signing up somewhere. Two concrete paths below —
pick one.

There's an important distinction between the two kinds of TURN credentials you'll run into:

- **Static credentials** — one fixed username/password you paste straight into
  `iceServers` and forget about. Simple, but if leaked (anyone can view your site's JS
  source, since this ends up in the browser bundle) they don't expire.
- **Ephemeral/time-limited credentials** — minted on demand, valid for e.g. 24 hours, tied
  to a secret that stays server-side. Safer, but requires a tiny endpoint on your Worker to
  generate them (a few lines — shown below).

### Option A — Metered.ca (fastest to set up, static credentials, good for v1)

1. Go to <https://www.metered.ca/tools/openrelay/> or sign up at
   <https://www.metered.ca> → **TURN Server** product → free tier gives ~ a few GB/month.
2. After signup, open the dashboard → **Application** (or **API Key**) section. You'll see
   a screen listing:
   - a **Turn Server URL** (e.g. `relay.metered.ca:80` and `:443`)
   - a **Username** (a long generated string, not something you choose)
   - a **Credential / Password** (also generated)

   This is exactly the "where do I find TURN username" answer — it's on that dashboard
   page, not something you invent yourself.
3. Copy those three values into `src/config.js`:
   ```js
   iceServers: [
     { urls: 'stun:stun.l.google.com:19302' },
     {
       urls: 'turn:relay.metered.ca:80',
       username: 'PASTE_USERNAME_FROM_DASHBOARD',
       credential: 'PASTE_CREDENTIAL_FROM_DASHBOARD',
     },
   ],
   ```
4. Rebuild and redeploy the frontend (`npm run build`, then re-deploy to Pages as in
   Step 4 above). No Worker changes needed — this is a static value baked into the JS
   bundle at build time.

This is fine to start with. The downside: the credential sits in your public JS bundle
forever (anyone can view-source it and use your TURN quota). Fine for a side project;
not ideal at scale — see Option B if that matters to you.

### Option B — Cloudflare Calls TURN (ephemeral credentials, stays in the Cloudflare ecosystem)

Since you're already deploying to Cloudflare, this avoids adding a third-party vendor.

1. Dashboard → **Calls** (left sidebar, may be under "Developer Platform" depending on
   your account) → **Create a TURN app** (sometimes labeled "Create Application").
2. This gives you a **Turn Token ID** and a **Turn Token API Key/Secret**. These are NOT
   what you put in `iceServers` directly — they're used server-side to *mint* short-lived
   credentials by calling Cloudflare's API.
3. Store them as Worker secrets (never commit these to the repo):
   ```bash
   wrangler secret put TURN_TOKEN_ID --config worker/wrangler.toml
   wrangler secret put TURN_API_TOKEN --config worker/wrangler.toml
   ```
4. Add a small route to `worker/src/index.js` that calls Cloudflare's Calls API to mint a
   credential good for ~24h, and returns it to the frontend:
   ```js
   // inside the fetch() router, alongside /api/room:
   if (url.pathname === '/api/turn-credentials' && request.method === 'GET') {
     const res = await fetch(
       `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_TOKEN_ID}/credentials/generate-ice-servers`,
       {
         method: 'POST',
         headers: {
           Authorization: `Bearer ${env.TURN_API_TOKEN}`,
           'Content-Type': 'application/json',
         },
         body: JSON.stringify({ ttl: 86400 }),
       }
     );
     const data = await res.json();
     return json(data); // { iceServers: [...] }
   }
   ```
5. On the frontend, fetch this once at startup and merge it into `CONFIG.iceServers`
   instead of hardcoding TURN entries in `config.js` (e.g. in `main.jsx`, before render,
   `fetch('/api/turn-credentials').then(...)`).

This is more setup, but the credential never appears in your shipped JS and auto-rotates.

### Either way

The UI already distinguishes **Direct (P2P)** vs **Relayed** from the selected ICE
candidate pair — no other code changes are required once `iceServers` includes a working
TURN entry. Test it by forcing a relay: temporarily set `iceTransportPolicy: 'relay'` in
`RTC_CONFIG` (`src/config.js`) — the status pill should read **Relayed**, then remove that
line once confirmed.

---

## Privacy properties

- **Signaling server** sees: room codes, SDP, ICE candidates (network addresses). It does
  **not** see message/file content and holds no ability to decrypt it.
- **Room codes**: single-use, expire in 10 minutes, deleted by a Durable Object alarm.
- **No persistence**: nothing is stored server-side; the frontend keeps state only in memory
  for the active session.
