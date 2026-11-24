# Swisshost - Ontario Public Transit Tracking & Intelligence Platform

A map-first public transit tracker, fleet reference, historical replay tool, and trip planner (`https://swisshost.cc`), running on **Cloudflare Workers** + **Turso (libSQL)** with a 12-hour GitHub (`swisshost-data`) historical archive and toggleable Environment Canada weather & radar.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full Turso-first persistence design, multi-agency live pipeline, and TTC subway kinematic timing model, and [docs/RUNBOOKS.md](./docs/RUNBOOKS.md) for operations.

## Configured Agencies (13 Ontario Transit Networks)
- **GO Transit & UP Express (Metrolinx):** GTFS Static + rail corridor overlay & timetable estimation (live GPS trains & buses activate automatically once `GO_TRANSIT_API_KEY` is bound)
- **TTC (Toronto Transit Commission):** Live GTFS-RT GPS for surface buses & streetcars (`bustime.ttc.ca/gtfsrt/*`), plus kinematic timetable estimation for Subway Lines 1, 2, and 4
- **MiWay (Mississauga Transit):** Open GTFS Static + live GTFS-RT (`miapp.ca`)
- **Brampton Transit (Züm):** Open GTFS Static + live GTFS-RT (`gtfs-rt-merge.prod.bt-cadavl.com`)
- **York Region Transit (YRT / Viva):** Open GTFS Static + live GTFS-RT (`rtu.york.ca`)
- **Durham Region Transit (DRT):** Open GTFS Static + live GTFS-RT (`drtonline.durhamregiontransit.com`)
- **Oakville Transit:** Open GTFS Static schedule & route planning (`arcgis.com`)
- **Milton Transit:** Open GTFS Static + live GTFS-RT (`metrolinx.tmix.se`)
- **Hamilton Street Railway (HSR):** Open GTFS Static + live GTFS-RT (`opendata.hamilton.ca`)
- **Guelph Transit:** Open GTFS Static + live GTFS-RT (VehiclePositions, TripUpdates, ServiceAlerts)
- **Grand River Transit (GRT / ION LRT):** Open GTFS Static + live GTFS-RT (`webapps.regionofwaterloo.ca`)
- **Ontario Northland (ONTC):** Open GTFS Static + live GTFS-RT (`ontarionorthland.tmix.se`)
- **Thunder Bay Transit:** Open GTFS Static + live GTFS-RT (`nextlift.ca`)

## Weather Data
- Official, keyless **Environment and Climate Change Canada (ECCC)** MSC GeoMet feeds (`api.weather.gc.ca` and `geo.weather.gc.ca`), edge-cached by Ontario city hub (`on-143` Toronto, `on-24` Mississauga, `on-4` Brampton, `on-59` Richmond Hill/York, `on-117` Oshawa/Durham, `on-79` Oakville/Halton, `on-77` Hamilton, `on-5` Guelph, `on-82` Kitchener-Waterloo, `on-139` North Bay, `on-40` Sudbury, `on-100` Thunder Bay) with user toggles for conditions, alerts, trip forecasts, and 1 km rain/snow radar.

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
