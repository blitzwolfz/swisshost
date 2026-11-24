# Swisshost - Ontario Public Transit Tracking & Intelligence Platform

A map-first public transit tracker, fleet reference, historical replay tool, and trip planner (`https://swisshost.cc`), running on **Cloudflare Workers** + **Turso (libSQL)** with a 12-hour GitHub (`swisshost-data`) historical archive and toggleable Environment Canada weather & radar.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full Turso-first persistence design, multi-agency live pipeline, and TTC subway kinematic timing model, and [docs/RUNBOOKS.md](./docs/RUNBOOKS.md) for operations.

## Configured Agencies
- **TTC (Toronto Transit Commission):** Live GTFS-RT GPS for surface buses & streetcars (`bustime.ttc.ca/gtfsrt/*`), plus kinematic timetable estimation for Subway Lines 1, 2, and 4
- **Guelph Transit:** Open GTFS Static + live GTFS-RT (VehiclePositions, TripUpdates, ServiceAlerts)
- **Thunder Bay Transit:** Open GTFS Static + live GTFS-RT (`nextlift.ca`)
- **GO Transit & UP Express (Metrolinx):** GTFS Static + rail corridor overlay & timetable estimation (live GPS trains & buses activate automatically once `GO_TRANSIT_API_KEY` is bound)

## Weather Data
- Official, keyless **Environment and Climate Change Canada (ECCC)** MSC GeoMet feeds (`api.weather.gc.ca` and `geo.weather.gc.ca`), edge-cached by Ontario city hub (`on-143` Toronto, `on-5` Guelph, `on-100` Thunder Bay) with user toggles for conditions, alerts, trip forecasts, and 1 km rain/snow radar.

## Commands
```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm deploy
```

## Worker Secrets (`wrangler secret put <NAME>`)
- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`: Primary Turso (libSQL) database credentials (replaces Cloudflare D1 across Workers, Cron jobs, and Durable Objects)
- `ADMIN_API_TOKEN`: Bearer token for `/admin/*`
- `GITHUB_ARCHIVE_TOKEN`: Fine-grained GitHub PAT with `Contents: Read and write` on `blitzwolfz/swisshost-data` for automated 12-hour archive commits (`0 0,12 * * *` UTC)
- `GO_TRANSIT_API_KEY`: Free Metrolinx Open Data API key to activate live GO Transit trains and buses
