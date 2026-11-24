import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { unzipSync } from "fflate";
import { parseGtfsTimeToSeconds } from "../packages/transit-core/src/index";
import { createTursoD1Adapter } from "../packages/database/src/index";

const KV_NAMESPACE_ID = "dafb7b7092f94a2097793fdfb21b8e0f";
const D1_DB_NAME = "swisshost-db";

interface AgencySeedSpec {
  id: string;
  feedId: string;
  url: string;
  fallbackUrl?: string;
}

const AGENCIES: AgencySeedSpec[] = [
  {
    id: "guelph",
    feedId: "guelph-static",
    url: "https://gismaps.guelph.ca/Pages/GTFS/google_transit.zip",
    fallbackUrl: "https://drive.usercontent.google.com/download?id=1SsCgQ0agO_EONavJoOuBPMlbcu2VcUs4&export=download",
  },
  {
    id: "go",
    feedId: "go-static",
    url: "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip",
  },
  {
    id: "ttc",
    feedId: "ttc-static",
    url: "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/TTC%20Routes%20and%20Schedules%20Data.zip",
    fallbackUrl: "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/bd4809dd-e289-4de8-bbde-c5c00dafbf4f/resource/28514055-d011-4ed7-8bb0-97961dfe2b66/download/SurfaceGTFS.ZIP",
  },
  {
    id: "thunderbay",
    feedId: "thunderbay-static",
    url: "http://api.nextlift.ca/gtfs.zip",
  },
  {
    id: "miway",
    feedId: "miway-static",
    url: "https://www.miapp.ca/GTFS/google_transit.zip",
  },
  {
    id: "milton",
    feedId: "milton-static",
    url: "https://metrolinx.tmix.se/gtfs/gtfs-milton.zip",
  },
  {
    id: "ontarionorthland",
    feedId: "ontarionorthland-static",
    url: "https://ontarionorthland.tmix.se/gtfs/gtfs.zip",
  },
  {
    id: "grt",
    feedId: "grt-static",
    url: "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/0",
    fallbackUrl: "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1",
  },
  {
    id: "brampton",
    feedId: "brampton-static",
    url: "https://www.arcgis.com/sharing/rest/content/items/a355aabd5a8c490186bdce559c9c75fb/data",
  },
  {
    id: "yrt",
    feedId: "yrt-static",
    url: "https://www.yrt.ca/google/google_transit.zip",
  },
  {
    id: "oakville",
    feedId: "oakville-static",
    url: "https://www.arcgis.com/sharing/rest/content/items/d78a1c1ad6a940009de8b68839a8f606/data",
  },
  {
    id: "hsr",
    feedId: "hsr-static",
    url: "https://opendata.hamilton.ca/GTFS-Static/google_transit.zip",
  },
  {
    id: "drt",
    feedId: "drt-static",
    url: "https://maps.durham.ca/OpenDataGTFS/GTFS_Durham_TXT.zip",
  },
];

function sqlEsc(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
  return `'${val.replace(/'/g, "''")}'`;
}

/**
 * Streaming line-by-line CSV parser so 200MB+ stop_times.txt files parse cleanly without blowing RAM.
 */
function forEachCsvRow(text: string, onRow: (row: Record<string, string>) => void): void {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let i = 0;
  const len = clean.length;

  const readLine = (): string[] | null => {
    if (i >= len) return null;
    const fields: string[] = [];
    let field = "";
    let inQuotes = false;

    while (i < len) {
      const ch = clean[i++]!;
      if (inQuotes) {
        if (ch === '"') {
          if (clean[i] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(field.trim());
        field = "";
      } else if (ch === "\n") {
        fields.push(field.trim());
        return fields;
      } else if (ch !== "\r") {
        field += ch;
      }
    }
    fields.push(field.trim());
    return fields;
  };

  const header = readLine();
  if (!header || header.length === 0) return;

  let vals: string[] | null;
  while ((vals = readLine()) !== null) {
    if (vals.length === 1 && vals[0] === "") continue;
    const rec: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      rec[header[c]!] = vals[c] ?? "";
    }
    onRow(rec);
  }
}

async function fetchZip(spec: AgencySeedSpec): Promise<Uint8Array> {
  const urls = [spec.url, ...(spec.fallbackUrl ? [spec.fallbackUrl] : [])];
  let lastErr = "fetch failed";
  for (const u of urls) {
    try {
      console.log(`[${spec.id}] Downloading ${u} ...`);
      const resp = await fetch(u, {
        headers: { "User-Agent": "Swisshost-StaticSync/1.0 (+https://swisshost.cc)" },
        redirect: "follow",
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      console.log(`[${spec.id}] Downloaded ${(buf.byteLength / 1024 / 1024).toFixed(2)} MB`);
      return buf;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      console.warn(`[${spec.id}] Failed ${u}: ${lastErr}`);
    }
  }
  throw new Error(lastErr);
}

function runWrangler(args: string[]): void {
  const wranglerBin = path.resolve(process.cwd(), "node_modules/.bin/wrangler");
  execFileSync(wranglerBin, args, { stdio: "inherit" });
}

async function seedAgency(spec: AgencySeedSpec, remote: boolean, force: boolean, kvOnly = false): Promise<void> {
  const tursoUrl = process.env.TURSO_DATABASE_URL?.trim();
  const tursoToken = process.env.TURSO_AUTH_TOKEN?.trim();
  const tursoDb = !kvOnly && tursoUrl && tursoToken ? createTursoD1Adapter(tursoUrl, tursoToken) : null;

  const zipBytes = await fetchZip(spec);
  const contentHash = crypto.createHash("sha256").update(zipBytes).digest("hex").slice(0, 16);
  const versionId = `${spec.id}-${contentHash}`;
  const now = new Date().toISOString();

  // Skip re-importing if Turso already has this exact ZIP content hash active (0 wasted row writes!)
  if (tursoDb && !force) {
    const active = await tursoDb
      .prepare("SELECT content_hash FROM feed_versions WHERE agency_id = ? AND status = 'active' LIMIT 1")
      .bind(spec.id)
      .first<{ content_hash: string }>()
      .catch(() => null);
    if (active?.content_hash === contentHash) {
      console.log(`[${spec.id}] Static GTFS unchanged (${contentHash}) — skipping import.`);
      return;
    }
  }

  console.log(`[${spec.id}] Unzipping core GTFS files...`);
  const files = unzipSync(zipBytes, {
    filter(file) {
      const name = file.name.split("/").pop() ?? "";
      return [
        "routes.txt",
        "stops.txt",
        "trips.txt",
        "stop_times.txt",
        "shapes.txt",
        "calendar.txt",
        "calendar_dates.txt",
        "feed_info.txt",
      ].includes(name);
    },
  });

  const dec = new TextDecoder("utf-8");
  const getText = (name: string): string | null => {
    const key = Object.keys(files).find((k) => k === name || k.endsWith(`/${name}`));
    return key ? dec.decode(files[key]!) : null;
  };

  // 1. Routes
  const routes: Array<{
    routeId: string;
    shortName: string;
    longName: string;
    description: string | null;
    routeType: number;
    color: string | null;
    textColor: string | null;
    sortOrder: number | null;
  }> = [];
  const routesTxt = getText("routes.txt");
  if (routesTxt) {
    forEachCsvRow(routesTxt, (r) => {
      if (!r.route_id) return;
      routes.push({
        routeId: r.route_id,
        shortName: r.route_short_name || r.route_id,
        longName: r.route_long_name || r.route_short_name || r.route_id,
        description: r.route_desc || null,
        routeType: Number.isFinite(Number(r.route_type)) ? Number(r.route_type) : 3,
        color: r.route_color ? (r.route_color.startsWith("#") ? r.route_color : `#${r.route_color}`) : null,
        textColor: r.route_text_color
          ? r.route_text_color.startsWith("#")
            ? r.route_text_color
            : `#${r.route_text_color}`
          : null,
        sortOrder: r.route_sort_order ? Number(r.route_sort_order) : null,
      });
    });
  }

  // 2. Stops
  const stopsMap = new Map<
    string,
    {
      stopId: string;
      stopCode: string | null;
      name: string;
      description: string | null;
      lat: number;
      lon: number;
      locationType: number;
      parentStation: string | null;
      platformCode: string | null;
      wheelchairBoarding: number;
      routes: Set<string>;
    }
  >();
  const stopsTxt = getText("stops.txt");
  if (stopsTxt) {
    forEachCsvRow(stopsTxt, (s) => {
      const lat = Number(s.stop_lat);
      const lon = Number(s.stop_lon);
      if (!s.stop_id || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
      stopsMap.set(s.stop_id, {
        stopId: s.stop_id,
        stopCode: s.stop_code || null,
        name: s.stop_name || s.stop_id,
        description: s.stop_desc || null,
        lat,
        lon,
        locationType: Number(s.location_type || "0") || 0,
        parentStation: s.parent_station || null,
        platformCode: s.platform_code || null,
        wheelchairBoarding: Number(s.wheelchair_boarding || "0") || 0,
        routes: new Set<string>(),
      });
    });
  }

  // 3. Trips — collect ALL trips for compact KV lookup + select 1 canonical pattern trip per (routeId, directionId, headsign)
  const tripMeta = new Map<
    string,
    {
      tripId: string;
      routeId: string;
      serviceId: string;
      directionId: number;
      headsign: string;
      shortName: string | null;
      blockId: string | null;
      shapeId: string | null;
      patternKey: string;
    }
  >();
  const canonicalTripByPattern = new Map<string, string>();
  const routeShapesById = new Map<string, string>(); // routeId -> shapeId
  const routeDirs = new Map<string, Map<number, string>>();

  const tripsTxt = getText("trips.txt");
  if (tripsTxt) {
    forEachCsvRow(tripsTxt, (t) => {
      if (!t.trip_id || !t.route_id) return;
      const dir = t.direction_id !== undefined && t.direction_id !== "" ? Number(t.direction_id) : 0;
      const headsign = t.trip_headsign || "";
      const patternKey = `${t.route_id}|${dir}|${headsign}`;
      tripMeta.set(t.trip_id, {
        tripId: t.trip_id,
        routeId: t.route_id,
        serviceId: t.service_id || "default",
        directionId: dir,
        headsign,
        shortName: t.trip_short_name || null,
        blockId: t.block_id || null,
        shapeId: t.shape_id || null,
        patternKey,
      });
      if (!canonicalTripByPattern.has(patternKey)) {
        canonicalTripByPattern.set(patternKey, t.trip_id);
      }
      if (t.shape_id && !routeShapesById.has(t.route_id)) {
        routeShapesById.set(t.route_id, t.shape_id);
      }
      const dm = routeDirs.get(t.route_id) ?? new Map<number, string>();
      if (!dm.has(dir) && headsign) dm.set(dir, headsign);
      routeDirs.set(t.route_id, dm);
    });
  }

  const canonicalTripSet = new Set(canonicalTripByPattern.values());
  console.log(
    `[${spec.id}] Parsed ${routes.length} routes, ${stopsMap.size} stops, ${tripMeta.size} total trips (${canonicalTripSet.size} canonical patterns)`
  );

  // 4. Stop times — extract ordered stops for canonical pattern trips AND populate stop.routes across all trips
  const canonicalStopTimes: Array<{
    tripId: string;
    stopSequence: number;
    stopId: string;
    arrivalSec: number | null;
    departureSec: number | null;
  }> = [];
  const stopTimesTxt = getText("stop_times.txt");
  if (stopTimesTxt) {
    forEachCsvRow(stopTimesTxt, (st) => {
      const trip = tripMeta.get(st.trip_id ?? "");
      if (!trip || !st.stop_id) return;
      const stop = stopsMap.get(st.stop_id);
      if (stop) stop.routes.add(trip.routeId);
      if (canonicalTripSet.has(trip.tripId)) {
        canonicalStopTimes.push({
          tripId: trip.tripId,
          stopSequence: Number(st.stop_sequence || "0"),
          stopId: st.stop_id,
          arrivalSec: parseGtfsTimeToSeconds(st.arrival_time),
          departureSec: parseGtfsTimeToSeconds(st.departure_time),
        });
      }
    });
  }
  console.log(`[${spec.id}] Extracted ${canonicalStopTimes.length} canonical stop_times`);

  // 5. Shapes — only parse shape_ids actually needed by routes!
  const neededShapeIds = new Set(routeShapesById.values());
  const shapesRaw = new Map<string, Array<{ seq: number; lon: number; lat: number }>>();
  const shapesTxt = getText("shapes.txt");
  if (shapesTxt && neededShapeIds.size > 0) {
    forEachCsvRow(shapesTxt, (sh) => {
      if (!sh.shape_id || !neededShapeIds.has(sh.shape_id)) return;
      const lat = Number(sh.shape_pt_lat);
      const lon = Number(sh.shape_pt_lon);
      const seq = Number(sh.shape_pt_sequence);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      let arr = shapesRaw.get(sh.shape_id);
      if (!arr) {
        arr = [];
        shapesRaw.set(sh.shape_id, arr);
      }
      arr.push({ seq, lon, lat });
    });
  }

  const shapeCoordsById = new Map<string, Array<[number, number]>>();
  for (const [id, pts] of shapesRaw) {
    pts.sort((a, b) => a.seq - b.seq);
    const step = pts.length > 180 ? Math.ceil(pts.length / 180) : 1;
    const simp: Array<[number, number]> = [];
    for (let i = 0; i < pts.length; i += step) {
      simp.push([Number(pts[i]!.lon.toFixed(5)), Number(pts[i]!.lat.toFixed(5))]);
    }
    const last = pts[pts.length - 1]!;
    simp.push([Number(last.lon.toFixed(5)), Number(last.lat.toFixed(5))]);
    shapeCoordsById.set(id, simp);
  }

  // 6. Build ultra-compact KV lookup payloads:
  //    a) stop_lookup:{agency} -> { [stopId]: stopName }
  //    b) trip_lookup:{agency} -> { h: string[], p: string[], m: { [tripId]: [headsignIdx, dirId, patternTripIdx] } }
  //    c) routes:{agency} -> route shortName, longName, color
  const stopLookup: Record<string, string> = {};
  for (const s of stopsMap.values()) {
    stopLookup[s.stopId] = s.name;
  }

  const headsignTable: string[] = [];
  const headsignIdx = new Map<string, number>();
  const patternTable: string[] = [];
  const patternIdx = new Map<string, number>();
  const tripIndexMap: Record<string, [number, number, number]> = {};

  for (const t of tripMeta.values()) {
    let hi = headsignIdx.get(t.headsign);
    if (hi === undefined) {
      hi = headsignTable.length;
      headsignTable.push(t.headsign);
      headsignIdx.set(t.headsign, hi);
    }
    const canonTripId = canonicalTripByPattern.get(t.patternKey) ?? t.tripId;
    let pi = patternIdx.get(canonTripId);
    if (pi === undefined) {
      pi = patternTable.length;
      patternTable.push(canonTripId);
      patternIdx.set(canonTripId, pi);
    }
    tripIndexMap[t.tripId] = [hi, t.directionId, pi];
  }

  const routeLookupList = routes.map((r) => ({
    route_id: r.routeId,
    short_name: r.shortName,
    long_name: r.longName,
    color: r.color,
    route_type: r.routeType,
  }));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `swisshost-${spec.id}-`));
  const stopKvFile = path.join(tmpDir, "stop_lookup.json");
  const tripKvFile = path.join(tmpDir, "trip_lookup.json");
  const routeKvFile = path.join(tmpDir, "route_lookup.json");
  fs.writeFileSync(stopKvFile, JSON.stringify(stopLookup));
  fs.writeFileSync(tripKvFile, JSON.stringify({ h: headsignTable, p: patternTable, m: tripIndexMap }));
  fs.writeFileSync(routeKvFile, JSON.stringify(routeLookupList));

  console.log(
    `[${spec.id}] KV blobs: stops=${(fs.statSync(stopKvFile).size / 1024).toFixed(0)}KB, trips=${(
      fs.statSync(tripKvFile).size / 1024
    ).toFixed(0)}KB`
  );

  // 7. Build chunked SQL files (max ~1.2 MB per SQL file for fast D1 remote execution)
  const sqlStatements: string[] = [];

  sqlStatements.push(
    `INSERT OR REPLACE INTO feed_versions (id, feed_id, agency_id, content_hash, status, route_count, stop_count, trip_count, diagnostics_json, activated_at, created_at) VALUES (${sqlEsc(
      versionId
    )}, ${sqlEsc(spec.feedId)}, ${sqlEsc(spec.id)}, ${sqlEsc(contentHash)}, 'staged', ${routes.length}, ${
      stopsMap.size
    }, ${canonicalTripSet.size}, '{}', NULL, ${sqlEsc(now)});`
  );

  // Clean old version rows for this same versionId if re-running
  sqlStatements.push(`DELETE FROM routes WHERE agency_id = ${sqlEsc(spec.id)} AND version_id = ${sqlEsc(versionId)};`);
  sqlStatements.push(`DELETE FROM stops WHERE agency_id = ${sqlEsc(spec.id)} AND version_id = ${sqlEsc(versionId)};`);
  sqlStatements.push(`DELETE FROM trips WHERE agency_id = ${sqlEsc(spec.id)} AND version_id = ${sqlEsc(versionId)};`);
  sqlStatements.push(`DELETE FROM stop_times WHERE agency_id = ${sqlEsc(spec.id)} AND version_id = ${sqlEsc(versionId)};`);

  // Routes (batches of 20)
  for (let i = 0; i < routes.length; i += 20) {
    const slice = routes.slice(i, i + 20);
    const vals = slice.map((r) => {
      const shId = routeShapesById.get(r.routeId);
      const coords = shId ? shapeCoordsById.get(shId) : undefined;
      const shapeJson = coords ? JSON.stringify({ type: "LineString", coordinates: coords }) : null;
      const dirs = Array.from(routeDirs.get(r.routeId)?.entries() ?? []).map(([directionId, headsign]) => ({
        directionId,
        headsign,
      }));
      return `(${sqlEsc(spec.id)}, ${sqlEsc(r.routeId)}, ${sqlEsc(versionId)}, ${sqlEsc(r.shortName)}, ${sqlEsc(
        r.longName
      )}, ${sqlEsc(r.description)}, ${r.routeType}, ${sqlEsc(r.color)}, ${sqlEsc(r.textColor)}, ${sqlEsc(
        r.sortOrder
      )}, ${sqlEsc(JSON.stringify(dirs))}, ${sqlEsc(shapeJson)})`;
    });
    sqlStatements.push(
      `INSERT OR REPLACE INTO routes (agency_id, route_id, version_id, short_name, long_name, description, route_type, color, text_color, sort_order, directions_json, shape_geojson) VALUES ${vals.join(
        ","
      )};`
    );
  }

  // Stops (batches of 60)
  const stopsArr = Array.from(stopsMap.values());
  for (let i = 0; i < stopsArr.length; i += 60) {
    const slice = stopsArr.slice(i, i + 60);
    const vals = slice.map(
      (s) =>
        `(${sqlEsc(spec.id)}, ${sqlEsc(s.stopId)}, ${sqlEsc(versionId)}, ${sqlEsc(s.stopCode)}, ${sqlEsc(s.name)}, ${sqlEsc(
          s.description
        )}, ${s.lat}, ${s.lon}, ${s.locationType}, ${sqlEsc(s.parentStation)}, ${sqlEsc(s.platformCode)}, ${
          s.wheelchairBoarding
        }, ${sqlEsc(JSON.stringify(Array.from(s.routes)))})`
    );
    sqlStatements.push(
      `INSERT OR REPLACE INTO stops (agency_id, stop_id, version_id, stop_code, name, description, lat, lon, location_type, parent_station, platform_code, wheelchair_boarding, routes_json) VALUES ${vals.join(
        ","
      )};`
    );
  }

  // Canonical pattern trips (batches of 60)
  const canonTripsArr = Array.from(canonicalTripSet)
    .map((id) => tripMeta.get(id)!)
    .filter(Boolean);
  for (let i = 0; i < canonTripsArr.length; i += 60) {
    const slice = canonTripsArr.slice(i, i + 60);
    const vals = slice.map(
      (t) =>
        `(${sqlEsc(spec.id)}, ${sqlEsc(t.tripId)}, ${sqlEsc(versionId)}, ${sqlEsc(t.routeId)}, ${sqlEsc(
          t.serviceId
        )}, ${t.directionId}, ${sqlEsc(t.headsign)}, ${sqlEsc(t.shortName)}, ${sqlEsc(t.blockId)}, ${sqlEsc(t.shapeId)})`
    );
    sqlStatements.push(
      `INSERT OR REPLACE INTO trips (agency_id, trip_id, version_id, route_id, service_id, direction_id, headsign, short_name, block_id, shape_id) VALUES ${vals.join(
        ","
      )};`
    );
  }

  // Canonical stop_times (batches of 100)
  for (let i = 0; i < canonicalStopTimes.length; i += 100) {
    const slice = canonicalStopTimes.slice(i, i + 100);
    const vals = slice.map(
      (st) =>
        `(${sqlEsc(spec.id)}, ${sqlEsc(versionId)}, ${sqlEsc(st.tripId)}, ${st.stopSequence}, ${sqlEsc(
          st.stopId
        )}, ${sqlEsc(st.arrivalSec)}, ${sqlEsc(st.departureSec)})`
    );
    sqlStatements.push(
      `INSERT OR REPLACE INTO stop_times (agency_id, version_id, trip_id, stop_sequence, stop_id, arrival_sec, departure_sec) VALUES ${vals.join(
        ","
      )};`
    );
  }

  // Activate version atomically & prune older superseded static rows to save D1 storage
  sqlStatements.push(
    `UPDATE feed_versions SET status = 'archived' WHERE agency_id = ${sqlEsc(spec.id)} AND status = 'active' AND id != ${sqlEsc(
      versionId
    )};`
  );
  sqlStatements.push(
    `UPDATE feed_versions SET status = 'active', activated_at = ${sqlEsc(now)} WHERE id = ${sqlEsc(versionId)};`
  );
  sqlStatements.push(
    `UPDATE feeds SET status = 'fresh', last_fetch_at = ${sqlEsc(now)}, last_success_at = ${sqlEsc(
      now
    )}, last_error = NULL, last_entity_count = ${routes.length + stopsMap.size}, updated_at = ${sqlEsc(
      now
    )} WHERE id = ${sqlEsc(spec.feedId)};`
  );
  // Keep D1 compact by purging old version data rows after activating new version
  sqlStatements.push(`DELETE FROM stop_times WHERE agency_id = ${sqlEsc(spec.id)} AND version_id != ${sqlEsc(versionId)};`);
  sqlStatements.push(`DELETE FROM trips WHERE agency_id = ${sqlEsc(spec.id)} AND version_id != ${sqlEsc(versionId)};`);
  sqlStatements.push(`DELETE FROM stops WHERE agency_id = ${sqlEsc(spec.id)} AND version_id != ${sqlEsc(versionId)};`);
  sqlStatements.push(`DELETE FROM routes WHERE agency_id = ${sqlEsc(spec.id)} AND version_id != ${sqlEsc(versionId)};`);

  if (kvOnly) {
    console.log(`[${spec.id}] KV-only mode: skipping SQL writes.`);
  } else if (tursoDb) {
    // Execute SQL statements directly against Turso over Hrana HTTP pipeline in batches of 20
    console.log(`[${spec.id}] Writing ${sqlStatements.length} SQL statements directly to Turso...`);
    for (let i = 0; i < sqlStatements.length; i += 20) {
      const slice = sqlStatements.slice(i, i + 20);
      await tursoDb.batch(slice.map((sql) => tursoDb.prepare(sql)));
    }
    console.log(`[${spec.id}] Turso static GTFS write complete.`);
  } else {
    // Write into <= 800KB SQL chunk files and execute via Wrangler D1
    let chunkIdx = 0;
    let buf = "";
    const flushChunk = () => {
      if (!buf) return;
      const f = path.join(tmpDir, `chunk-${chunkIdx++}.sql`);
      fs.writeFileSync(f, buf);
      console.log(`[${spec.id}] Executing D1 SQL chunk ${chunkIdx} (${(buf.length / 1024).toFixed(0)} KB)...`);
      runWrangler(["d1", "execute", D1_DB_NAME, remote ? "--remote" : "--local", "--file", f, "-y"]);
      buf = "";
    };

    for (const stmt of sqlStatements) {
      if (buf.length + stmt.length > 750_000) {
        flushChunk();
      }
      buf += stmt + "\n";
    }
    flushChunk();
  }

  // Upload KV lookup blobs (3 total KV writes per agency!)
  if (remote) {
    const canUploadKv = !process.env.CI || Boolean(process.env.CLOUDFLARE_API_TOKEN?.trim());
    if (canUploadKv) {
      console.log(`[${spec.id}] Uploading stop/trip/route lookup blobs to KV...`);
      runWrangler(["kv", "key", "put", "--namespace-id", KV_NAMESPACE_ID, "--remote", `stop_lookup:${spec.id}`, "--path", stopKvFile]);
      runWrangler(["kv", "key", "put", "--namespace-id", KV_NAMESPACE_ID, "--remote", `trip_lookup:${spec.id}`, "--path", tripKvFile]);
      runWrangler(["kv", "key", "put", "--namespace-id", KV_NAMESPACE_ID, "--remote", `routes:${spec.id}`, "--path", routeKvFile]);
    } else {
      console.log(`[${spec.id}] Skipping KV upload in CI (CLOUDFLARE_API_TOKEN not set); Turso static tables updated.`);
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[${spec.id}] Static GTFS sync complete! Version: ${versionId}`);
}

async function main() {
  const args = process.argv.slice(2);
  const remote = !args.includes("--local");
  const force = args.includes("--force");
  const kvOnly = args.includes("--kv-only");
  const filterArg = args.find((a) => !a.startsWith("--"));
  const targets = filterArg ? AGENCIES.filter((a) => a.id === filterArg) : AGENCIES;

  if (targets.length === 0) {
    console.error(`Unknown agency "${filterArg}". Choose from: ${AGENCIES.map((a) => a.id).join(", ")}`);
    process.exit(1);
  }

  const failures: string[] = [];
  for (const spec of targets) {
    try {
      await seedAgency(spec, remote, force, kvOnly);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${spec.id}] FAILED: ${msg}`);
      failures.push(`${spec.id}: ${msg}`);
    }
  }
  if (failures.length > 0) {
    console.error(`Completed with ${failures.length} failure(s):\n${failures.join("\n")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
