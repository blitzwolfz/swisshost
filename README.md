# Swisshost — Public Transit Tracking & Intelligence Platform

A map-first, Cloudflare-native public transit tracking, fleet reference, historical replay, and schedule intelligence platform (`https://swisshost.cc`), built on a strict `$0/month` Cloudflare Free plan + 12-hour GitHub (`swisshost-data`) historical archive architecture.

## Configured Agencies
- **Guelph Transit** — Open GTFS Static + GTFS-RT (VehiclePositions, TripUpdates, ServiceAlerts)
- **TTC (Toronto Transit Commission)** — Open GTFS Static (Surface) + GTFS-RT (`bustime.ttc.ca/gtfsrt/*`) + Umo XML adapter
- **GO Transit (Metrolinx)** — GTFS Static + Metrolinx Open Data GTFS-RT (activates automatically once `GO_TRANSIT_API_KEY` Worker secret is configured)

## Commands
```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm db:migrate:remote
pnpm deploy
```

## Required Optional Secrets (set via `wrangler secret put <NAME>`)
- `ADMIN_API_TOKEN` — Bearer token for `/admin/*` (or protect `/admin*` via Cloudflare Access Zero Trust Free)
- `GITHUB_ARCHIVE_TOKEN` — Fine-grained GitHub PAT with `Contents: Read and write` on `blitzwolfz/swisshost-data` for automated 12-hour archive commits (`0 0,12 * * *` UTC)
- `GO_TRANSIT_API_KEY` — Free Metrolinx Open Data API key to activate live GO Transit trains and buses
