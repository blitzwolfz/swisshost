# Swisshost Operations Runbooks

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the Turso-first storage model, multi-agency pipeline, and TTC subway kinematic math.

## 0. Verifying Turso Database Mode (No Cloudflare DO SQLite / D1 Writes)
1. Ensure both `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` Worker secrets are set (`npx wrangler secret list`).
2. Check `GET /api/v1/status`:
   - `database.provider` should be `"turso"`
   - `database.doSqliteStorage` should be `"disabled"`
3. If `TURSO_DATABASE_URL` or `TURSO_AUTH_TOKEN` is rotated, update both via `npx wrangler secret put` and redeploy. Both `AgencyLiveDO` and `FeedSchedulerDO` rehydrate directly from Turso on hibernation wake using `this.ctx.id.name`.

## 1. Adding the GO Transit (Metrolinx) API Key
1. Register for a free Metrolinx Open Data API key at https://api.openmetrolinx.com/OpenDataAPI/Help/Registration/en
2. Bind it as a Worker secret:
   ```bash
   npx wrangler secret put GO_TRANSIT_API_KEY
   ```
3. Within 5 minutes (or immediately via `/admin` -> **Run Watchdog Now**), `go-positions`, `go-trip-updates`, and `go-alerts` transition from `missing_key` to `fresh`.

## 2. Enabling Automated 12-Hour GitHub Archiving (`swisshost-data`)
1. Create a fine-grained GitHub PAT scoped strictly to `blitzwolfz/swisshost-data` with `Contents: Read and write`.
2. Bind it as a Worker secret:
   ```bash
   npx wrangler secret put GITHUB_ARCHIVE_TOKEN
   ```
3. Cloudflare Cron (`0 0,12 * * *`) seals completed 12-hour UTC windows into gzipped CSVs + SHA-256 manifests and commits without force-pushing. You can also trigger or verify a run from `/admin`.

## 3. Restoring from `swisshost-data`
1. Clone `git@github.com:blitzwolfz/swisshost-data.git`.
2. Verify each `manifests/<agency>/YYYY/MM/DD/<window>.json` SHA-256 against the corresponding `positions.csv.gz` file (`shasum -a 256`).
3. Apply D1 migrations (`pnpm db:migrate:remote`) and replay archived windows if needed.

## 4. Static GTFS Rollback
If a newly imported static GTFS schedule causes unexpected route/stop mismatches:
- Open `/admin`, locate the agency's `gtfs_static` feed, and click **Rollback** (or `POST /admin/agencies/:id/rollback-static`). Previous versions remain intact in `feed_versions`.

## 5. Free-Tier Quota Guardrails ($0/month)
- **70% (`warn_70`)**: Public exports paused; warning surfaced on `/status`.
- **85% (`throttle_85`)**: `FeedSchedulerDO` automatically doubles live polling intervals.
- **95% (`paused_95`)**: Collection pauses before provider quota exhaustion, preserving state persistence and recovery headroom.
