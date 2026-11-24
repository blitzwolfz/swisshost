import { Hono } from "hono";
import {
  ExportRequestSchema,
  FavoriteInputSchema,
  OpenApiDocument,
  SubscriptionInputSchema,
  createProblemDetails,
} from "@swisshost/contracts";
import { ensureAgenciesSeeded, getQuotaStatus } from "@swisshost/database";
import {
  ANALYTICS_ALGORITHM_VERSION,
  backtestPredictions,
  computeHeadwayMetrics,
  computeScheduleAdherence,
  predictStopArrival,
} from "@swisshost/analytics";
import { formatSecondsToClock, getLocalServiceContext, haversineMeters } from "@swisshost/transit-core";
import { createAdminApp } from "../../admin/src/index";
import { FeedSchedulerDO } from "../../collector/src/feed-scheduler-do";
import { AgencyLiveDO } from "../../live/src/agency-live-do";
import { runTwelveHourArchive, runWatchdog } from "../../jobs/src/index";
import type { Env } from "./env";
import { BUILTIN_AGENCIES, getBudgets, hashPassword, sha256Hex, verifyPassword } from "./env";

export { FeedSchedulerDO, AgencyLiveDO };

type AppVars = {
  requestId: string;
  user: { id: string; handle: string; displayName: string; role: string } | null;
};

const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

// ---------------------------------------------------------------------------
// Global security headers, request ID, and error formatting
// ---------------------------------------------------------------------------
app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID().slice(0, 12);
  c.set("requestId", requestId);
  c.set("user", null);

  await next();

  c.header("X-Request-Id", requestId);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
});

// Lazy seed once per isolate + bootstrap scheduler alarms if feeds have never polled
let seeded = false;
async function ensureSeeded(
  env: Env,
  execCtx?: { waitUntil(promise: Promise<unknown>): void }
): Promise<void> {
  if (seeded) return;
  await ensureAgenciesSeeded(env.DB, BUILTIN_AGENCIES);
  seeded = true;
  if (execCtx) {
    const unpolled = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM feeds WHERE enabled = 1 AND kind != 'gtfs_static' AND last_fetch_at IS NULL"
    ).first<{ c: number }>();
    if ((unpolled?.c ?? 0) > 0) {
      execCtx.waitUntil(runWatchdog(env).catch(() => undefined));
    }
  }
}

app.use("/api/*", async (c, next) => {
  await ensureSeeded(c.env, c.executionCtx);

  // Optional session resolution
  const token =
    c.req.header("X-Session-Token") ??
    c.req.header("Cookie")?.match(/swisshost_session=([^;]+)/)?.[1];
  if (token) {
    const hash = await sha256Hex(token);
    const row = await c.env.DB.prepare(
      `SELECT u.id, u.handle, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    )
      .bind(hash, new Date().toISOString())
      .first<{ id: string; handle: string; display_name: string; role: string }>();
    if (row) {
      c.set("user", {
        id: row.id,
        handle: row.handle,
        displayName: row.display_name,
        role: row.role,
      });
    }
  }

  return next();
});

app.onError((err, c) => {
  const requestId = c.get("requestId");
  console.error(JSON.stringify({ level: "error", requestId, message: err.message }));
  return c.json(
    createProblemDetails(500, "Internal Server Error", err.message, requestId, c.req.path),
    500
  );
});

// Mount admin routes
app.route("/admin", createAdminApp());

// OpenAPI spec
app.get("/openapi.json", (c) => {
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(OpenApiDocument);
});

// ---------------------------------------------------------------------------
// Public Health, Status & Agency Directory (F01)
// ---------------------------------------------------------------------------
app.get("/api/v1/health", (c) => {
  return c.json({ ok: true, service: "swisshost", time: new Date().toISOString() });
});

app.get("/api/v1/status", async (c) => {
  const [agencies, feeds, archives, quota] = await Promise.all([
    c.env.DB.prepare("SELECT id, name, short_name, timezone, enabled FROM agencies ORDER BY name ASC").all(),
    c.env.DB.prepare(
      `SELECT id, agency_id, kind, status, refresh_seconds, stale_after_seconds,
              last_fetch_at, last_success_at, last_source_ts, last_error, last_entity_count, duplicate_ratio, enabled
       FROM feeds ORDER BY agency_id, kind`
    ).all(),
    c.env.DB.prepare(
      `SELECT agency_id, window_key, status, row_count, commit_sha, verified_at, created_at
       FROM archive_manifests ORDER BY created_at DESC LIMIT 12`
    ).all(),
    getQuotaStatus(c.env.DB, getBudgets(c.env)),
  ]);

  c.header("Cache-Control", "public, max-age=15");
  return c.json({
    platformStatus: quota.tier === "paused_95" ? "degraded_quota" : "operational",
    serverTime: new Date().toISOString(),
    quota: {
      tier: quota.tier,
      maxRatio: Number(quota.maxRatio.toFixed(3)),
      d1Writes: quota.d1Writes,
      d1WriteBudget: quota.d1WriteBudget,
      doRequests: quota.doRequests,
      doRequestBudget: quota.doRequestBudget,
    },
    agencies: agencies.results,
    feeds: feeds.results,
    archives: archives.results,
  });
});

app.get("/api/v1/agencies", async (c) => {
  const agencies = await c.env.DB.prepare(
    `SELECT * FROM agencies WHERE enabled = 1 ORDER BY name ASC`
  ).all<Record<string, unknown>>();
  const feeds = await c.env.DB.prepare(
    `SELECT id, agency_id, kind, status, last_success_at, last_source_ts, last_entity_count, last_error, stale_after_seconds, enabled
     FROM feeds`
  ).all<Record<string, unknown>>();

  const statsList = await Promise.all(
    agencies.results.map(async (a) => {
      const id = String(a.id);
      const stats = await c.env.AGENCY_LIVE.getByName(id).getStats().catch(() => null);
      return [id, stats] as const;
    })
  );
  const statsMap = new Map(statsList);

  const data = agencies.results.map((a) => {
    const id = String(a.id);
    const aFeeds = feeds.results.filter((f) => f.agency_id === id);
    const posFeed = aFeeds.find((f) => f.kind === "vehicle_positions");
    const liveStats = statsMap.get(id);
    return {
      id,
      name: a.name,
      shortName: a.short_name,
      region: a.region,
      timezone: a.timezone,
      modes: JSON.parse(String(a.modes_json || "[]")),
      center: [Number(a.center_lon), Number(a.center_lat)],
      defaultZoom: Number(a.default_zoom),
      attribution: a.attribution,
      licenseUrl: a.license_url,
      archivePolicy: a.archive_policy,
      capabilities: JSON.parse(String(a.capabilities_json || "{}")),
      liveStatus: posFeed?.status === "missing_key" ? "missing_key" : (liveStats?.feedStatus ?? posFeed?.status ?? "unknown"),
      lastSuccessAt: liveStats?.lastSuccessAt ?? posFeed?.last_success_at ?? null,
      lastError: posFeed?.last_error ?? null,
      activeVehicleCount: liveStats?.activeCount ?? 0,
      feeds: aFeeds,
    };
  });

  c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  return c.json({ agencies: data, serverTime: new Date().toISOString() });
});

app.get("/api/v1/agencies/:id/status", async (c) => {
  const agencyId = c.req.param("id");
  const agency = await c.env.DB.prepare("SELECT * FROM agencies WHERE id = ?").bind(agencyId).first();
  if (!agency) {
    return c.json(createProblemDetails(404, "Agency not found", `Unknown agency: ${agencyId}`, c.get("requestId")), 404);
  }
  const [feeds, activeVersion, liveSnap] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM feeds WHERE agency_id = ?").bind(agencyId).all(),
    c.env.DB.prepare("SELECT * FROM feed_versions WHERE agency_id = ? AND status = 'active' LIMIT 1")
      .bind(agencyId)
      .first(),
    c.env.AGENCY_LIVE.getByName(agencyId).getSnapshot({ agencyId }),
  ]);

  return c.json({
    agencyId,
    serverTime: new Date().toISOString(),
    liveCursor: liveSnap.cursor,
    liveStatus: liveSnap.feedStatus,
    liveVehicleCount: liveSnap.vehicles.length,
    connectedClients: liveSnap.connectedClients,
    activeStaticVersion: activeVersion ?? null,
    feeds: feeds.results,
  });
});

// ---------------------------------------------------------------------------
// Live Vehicles & WebSocket (F02, F05, F15)
// ---------------------------------------------------------------------------
app.get("/api/v1/live", async (c) => {
  const agencyId = c.req.query("agency") || "guelph";
  const stub = c.env.AGENCY_LIVE.getByName(agencyId);
  return stub.fetch(c.req.raw);
});

app.get("/api/v1/agencies/:id/vehicles", async (c) => {
  const agencyId = c.req.param("id");
  const routeId = c.req.query("route") || undefined;
  const format = c.req.query("format") || "json";
  const q = c.req.query("q")?.trim().toLowerCase() || "";
  const assigned = c.req.query("assigned");
  const freshnessFilter = c.req.query("freshness");
  const bboxParam = c.req.query("bbox");

  let bbox: [number, number, number, number] | undefined;
  if (bboxParam) {
    const parts = bboxParam.split(",").map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      bbox = [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
    }
  }

  const snap = await c.env.AGENCY_LIVE.getByName(agencyId).getSnapshot({ agencyId, routeId, bbox });

  // Fall back to D1 vehicle_latest if DO cold-started with 0 rows
  let vehicles = snap.vehicles;
  if (vehicles.length === 0) {
    const rows = await c.env.DB.prepare(
      `SELECT * FROM vehicle_latest WHERE agency_id = ? ORDER BY updated_at DESC LIMIT 1500`
    )
      .bind(agencyId)
      .all<Record<string, unknown>>();
    const nowMs = Date.now();
    vehicles = rows.results.map((r) => {
      const refMs = Date.parse(String(r.observed_at ?? r.received_at));
      const ageSeconds = Math.max(0, Math.round((nowMs - refMs) / 1000));
      return {
        agencyId: String(r.agency_id),
        sourceVehicleId: String(r.source_vehicle_id),
        vehicleId: String(r.vehicle_id),
        fleetNumber: String(r.fleet_number),
        label: (r.fleet_number as string | null) ?? null,
        routeId: (r.route_id as string | null) ?? null,
        tripId: (r.trip_id as string | null) ?? null,
        blockId: (r.block_id as string | null) ?? null,
        directionId: r.direction_id !== null ? Number(r.direction_id) : null,
        lat: Number(r.lat),
        lon: Number(r.lon),
        bearingDeg: r.bearing_deg !== null ? Number(r.bearing_deg) : null,
        speedMps: r.speed_mps !== null ? Number(r.speed_mps) : null,
        scheduleDeviationSec: r.schedule_deviation_sec !== null ? Number(r.schedule_deviation_sec) : null,
        currentStatus: (r.current_status as string | null) ?? null,
        stopId: (r.stop_id as string | null) ?? null,
        stopSequence: r.stop_sequence !== null ? Number(r.stop_sequence) : null,
        occupancyStatus: (r.occupancy_status as string | null) ?? null,
        observedAt: (r.observed_at as string | null) ?? null,
        receivedAt: String(r.received_at),
        timestampBasis: (r.timestamp_basis as "vehicle" | "feed" | "receipt") ?? "receipt",
        ageSeconds,
        freshness: ageSeconds > 120 ? "stale" : ageSeconds > 75 ? "delayed" : "fresh",
        qualityFlags: JSON.parse(String(r.quality_flags_json || "[]")),
        matchMethod: String(r.match_method || "unmatched"),
        matchConfidence: Number(r.match_confidence || 0),
      };
    });
  }

  // Enrich with active route short names & colors from KV/D1
  const routeMeta = await getRouteLookup(c.env, agencyId);
  vehicles = vehicles.map((v) => {
    const rm = v.routeId ? routeMeta.get(v.routeId) : undefined;
    return {
      ...v,
      routeShortName: rm?.shortName ?? v.routeId,
      routeColor: rm?.color ?? null,
    };
  });

  if (routeId) vehicles = vehicles.filter((v) => v.routeId === routeId);
  if (q) {
    vehicles = vehicles.filter(
      (v) =>
        v.fleetNumber.toLowerCase().includes(q) ||
        v.vehicleId.toLowerCase().includes(q) ||
        (v.routeId?.toLowerCase().includes(q) ?? false) ||
        (v.tripId?.toLowerCase().includes(q) ?? false)
    );
  }
  if (assigned === "true") vehicles = vehicles.filter((v) => Boolean(v.routeId || v.tripId));
  if (assigned === "false") vehicles = vehicles.filter((v) => !v.routeId && !v.tripId);
  if (freshnessFilter) vehicles = vehicles.filter((v) => v.freshness === freshnessFilter);

  if (format === "geojson") {
    c.header("Cache-Control", "public, max-age=5");
    return c.json({
      type: "FeatureCollection",
      metadata: {
        agencyId,
        cursor: snap.cursor,
        feedStatus: snap.feedStatus,
        serverTime: snap.serverTime,
        count: vehicles.length,
      },
      features: vehicles.map((v) => ({
        type: "Feature",
        id: `${v.agencyId}:${v.vehicleId}`,
        geometry: { type: "Point", coordinates: [v.lon, v.lat] },
        properties: v,
      })),
    });
  }

  c.header("Cache-Control", "public, max-age=5");
  return c.json({
    agencyId,
    cursor: snap.cursor,
    feedStatus: snap.feedStatus,
    lastSuccessAt: snap.lastSuccessAt,
    serverTime: snap.serverTime,
    count: vehicles.length,
    vehicles,
  });
});

// Fleet directory + vehicle detail (F05, F07)
app.get("/api/v1/agencies/:id/fleet", async (c) => {
  const agencyId = c.req.param("id");
  const q = c.req.query("q")?.trim().toLowerCase() || "";
  const limit = Math.min(200, Math.max(10, Number(c.req.query("limit") || "100")));
  const offset = Math.max(0, Number(c.req.query("offset") || "0"));

  const [dbRows, liveSnap] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM vehicles WHERE agency_id = ? ORDER BY last_seen_at DESC LIMIT 600`
    )
      .bind(agencyId)
      .all<Record<string, unknown>>(),
    c.env.AGENCY_LIVE.getByName(agencyId).getSnapshot({ agencyId }),
  ]);

  const liveById = new Map(liveSnap.vehicles.map((v) => [v.vehicleId, v]));
  const merged = new Map<string, Record<string, unknown>>();

  for (const r of dbRows.results) {
    const vid = String(r.vehicle_id);
    const live = liveById.get(vid);
    merged.set(vid, {
      ...r,
      route_id: live?.routeId ?? null,
      trip_id: live?.tripId ?? null,
      lat: live?.lat ?? null,
      lon: live?.lon ?? null,
      speed_mps: live?.speedMps ?? null,
      bearing_deg: live?.bearingDeg ?? null,
      schedule_deviation_sec: live?.scheduleDeviationSec ?? null,
      last_seen_at: live?.observedAt ?? live?.receivedAt ?? r.last_seen_at,
    });
  }
  for (const live of liveSnap.vehicles) {
    if (!merged.has(live.vehicleId)) {
      merged.set(live.vehicleId, {
        agency_id: agencyId,
        vehicle_id: live.vehicleId,
        fleet_number: live.fleetNumber,
        vehicle_type: "unknown",
        manufacturer: null,
        model: null,
        year: null,
        route_id: live.routeId,
        trip_id: live.tripId,
        speed_mps: live.speedMps,
        schedule_deviation_sec: live.scheduleDeviationSec,
        last_seen_at: live.observedAt ?? live.receivedAt,
        metadata_source: "observed",
      });
    }
  }

  let list = Array.from(merged.values());
  if (q) {
    list = list.filter(
      (v) =>
        String(v.fleet_number ?? "").toLowerCase().includes(q) ||
        String(v.vehicle_id ?? "").toLowerCase().includes(q) ||
        String(v.model ?? "").toLowerCase().includes(q) ||
        String(v.route_id ?? "").toLowerCase().includes(q)
    );
  }
  list.sort((a, b) => Date.parse(String(b.last_seen_at ?? 0)) - Date.parse(String(a.last_seen_at ?? 0)));

  return c.json({
    agencyId,
    total: list.length,
    limit,
    offset,
    vehicles: list.slice(offset, offset + limit),
  });
});

app.get("/api/v1/agencies/:id/vehicles/:vehicle", async (c) => {
  const agencyId = c.req.param("id");
  const vehicleId = decodeURIComponent(c.req.param("vehicle"));

  const [vehicle, liveVeh, aliases, assignments] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM vehicles WHERE agency_id = ? AND (vehicle_id = ? OR fleet_number = ?) LIMIT 1")
      .bind(agencyId, vehicleId, vehicleId)
      .first<Record<string, unknown>>(),
    c.env.AGENCY_LIVE.getByName(agencyId).getVehicle(vehicleId),
    c.env.DB.prepare("SELECT * FROM vehicle_aliases WHERE agency_id = ? AND vehicle_id = ? ORDER BY valid_from DESC")
      .bind(agencyId, vehicleId)
      .all(),
    c.env.DB.prepare(
      `SELECT * FROM vehicle_assignments WHERE agency_id = ? AND vehicle_id = ?
       ORDER BY started_at DESC LIMIT 30`
    )
      .bind(agencyId, vehicleId)
      .all(),
  ]);

  const latest = liveVeh
    ? {
        agency_id: liveVeh.agencyId,
        source_vehicle_id: liveVeh.sourceVehicleId,
        vehicle_id: liveVeh.vehicleId,
        fleet_number: liveVeh.fleetNumber,
        route_id: liveVeh.routeId,
        trip_id: liveVeh.tripId,
        block_id: liveVeh.blockId,
        direction_id: liveVeh.directionId,
        lat: liveVeh.lat,
        lon: liveVeh.lon,
        bearing_deg: liveVeh.bearingDeg,
        speed_mps: liveVeh.speedMps,
        schedule_deviation_sec: liveVeh.scheduleDeviationSec,
        current_status: liveVeh.currentStatus,
        stop_id: liveVeh.stopId,
        stop_sequence: liveVeh.stopSequence,
        occupancy_status: liveVeh.occupancyStatus,
        observed_at: liveVeh.observedAt,
        received_at: liveVeh.receivedAt,
        timestamp_basis: liveVeh.timestampBasis,
        match_method: liveVeh.matchMethod,
        match_confidence: liveVeh.matchConfidence,
      }
    : null;

  if (!vehicle && !latest) {
    return c.json(
      createProblemDetails(404, "Vehicle not found", `No observed record for vehicle ${vehicleId} in ${agencyId}`),
      404
    );
  }

  return c.json({
    agencyId,
    vehicle: vehicle ?? {
      agency_id: agencyId,
      vehicle_id: latest?.vehicle_id,
      fleet_number: latest?.fleet_number,
      metadata_source: "observed",
    },
    latest,
    aliases: aliases.results,
    recentAssignments: assignments.results,
  });
});

// Historical tracking & replay (F08)
app.get("/api/v1/agencies/:id/vehicles/:vehicle/history", async (c) => {
  const agencyId = c.req.param("id");
  const vehicleId = decodeURIComponent(c.req.param("vehicle"));
  const dateParam = c.req.query("date");
  const fromParam = c.req.query("from");
  const toParam = c.req.query("to");

  const agency = await c.env.DB.prepare("SELECT timezone FROM agencies WHERE id = ?")
    .bind(agencyId)
    .first<{ timezone: string }>();
  const tz = agency?.timezone ?? "America/Toronto";

  const targetDate = dateParam || getLocalServiceContext(new Date(), tz).serviceDate;
  const fromIso = fromParam || `${targetDate}T00:00:00.000Z`;
  const toIso = toParam || `${targetDate}T23:59:59.999Z`;

  const [chunks, assignments, earliest, archives] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, window_start, window_end, data_json
       FROM observation_chunks
       WHERE agency_id = ? AND window_end >= ? AND window_start <= ?
       ORDER BY window_start ASC LIMIT 240`
    )
      .bind(agencyId, fromIso, toIso)
      .all<{ id: string; window_start: string; window_end: string; data_json: string }>(),
    c.env.DB.prepare(
      `SELECT * FROM vehicle_assignments
       WHERE agency_id = ? AND vehicle_id = ? AND service_date = ?
       ORDER BY started_at ASC`
    )
      .bind(agencyId, vehicleId, targetDate)
      .all(),
    c.env.DB.prepare(
      `SELECT MIN(window_start) as earliest FROM observation_chunks WHERE agency_id = ?`
    )
      .bind(agencyId)
      .first<{ earliest: string | null }>(),
    c.env.DB.prepare(
      `SELECT window_key, status, commit_sha, row_count, verified_at
       FROM archive_manifests WHERE agency_id = ? ORDER BY window_key DESC LIMIT 10`
    )
      .bind(agencyId)
      .all(),
  ]);

  const points: Array<{
    observedAt: string;
    receivedAt: string;
    lat: number;
    lon: number;
    bearingDeg: number | null;
    speedMps: number | null;
    routeId: string | null;
    tripId: string | null;
    delaySec: number | null;
    timestampBasis: string;
    gapFromPrevSec: number | null;
  }> = [];

  for (const ch of chunks.results) {
    const rows = JSON.parse(ch.data_json) as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (r.v !== vehicleId && r.f !== vehicleId) continue;
      const ts = String(r.ts ?? r.rx);
      if (ts < fromIso || ts > toIso) continue;
      points.push({
        observedAt: ts,
        receivedAt: String(r.rx ?? ts),
        lat: Number(r.la),
        lon: Number(r.lo),
        bearingDeg: r.hd !== null && r.hd !== undefined ? Number(r.hd) : null,
        speedMps: r.sp !== null && r.sp !== undefined ? Number(r.sp) : null,
        routeId: (r.r as string | null) ?? null,
        tripId: (r.t as string | null) ?? null,
        delaySec: r.sd !== null && r.sd !== undefined ? Number(r.sd) : null,
        timestampBasis: String(r.tb ?? "receipt"),
        gapFromPrevSec: null,
      });
    }
  }

  points.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const gaps: Array<{ from: string; to: string; durationSec: number }> = [];
  for (let i = 1; i < points.length; i++) {
    const dt = Math.round(
      (Date.parse(points[i]!.observedAt) - Date.parse(points[i - 1]!.observedAt)) / 1000
    );
    points[i]!.gapFromPrevSec = dt;
    if (dt >= 300) {
      gaps.push({ from: points[i - 1]!.observedAt, to: points[i]!.observedAt, durationSec: dt });
    }
  }

  return c.json({
    agencyId,
    vehicleId,
    timezone: tz,
    serviceDate: targetDate,
    from: fromIso,
    to: toIso,
    earliestAvailableAt: earliest?.earliest ?? null,
    pointCount: points.length,
    points: points.slice(0, 3000),
    gaps,
    assignments: assignments.results,
    archiveCoverage: archives.results,
  });
});

// Route-level history query (for History page when querying by route/date)
app.get("/api/v1/agencies/:id/history", async (c) => {
  const agencyId = c.req.param("id");
  const routeId = c.req.query("route") || undefined;
  const vehicleId = c.req.query("vehicle") || undefined;
  const dateParam = c.req.query("date");

  const agency = await c.env.DB.prepare("SELECT timezone FROM agencies WHERE id = ?")
    .bind(agencyId)
    .first<{ timezone: string }>();
  const tz = agency?.timezone ?? "America/Toronto";
  const targetDate = dateParam || getLocalServiceContext(new Date(), tz).serviceDate;
  const fromIso = `${targetDate}T00:00:00.000Z`;
  const toIso = `${targetDate}T23:59:59.999Z`;

  const [chunks, assignments, earliest] = await Promise.all([
    c.env.DB.prepare(
      `SELECT window_start, window_end, data_json FROM observation_chunks
       WHERE agency_id = ? AND window_end >= ? AND window_start <= ?
       ORDER BY window_start ASC LIMIT 240`
    )
      .bind(agencyId, fromIso, toIso)
      .all<{ window_start: string; window_end: string; data_json: string }>(),
    routeId
      ? c.env.DB.prepare(
          `SELECT * FROM vehicle_assignments WHERE agency_id = ? AND route_id = ? AND service_date = ? ORDER BY started_at DESC LIMIT 200`
        )
          .bind(agencyId, routeId, targetDate)
          .all()
      : c.env.DB.prepare(
          `SELECT * FROM vehicle_assignments WHERE agency_id = ? AND service_date = ? ORDER BY started_at DESC LIMIT 200`
        )
          .bind(agencyId, targetDate)
          .all(),
    c.env.DB.prepare("SELECT MIN(window_start) as earliest FROM observation_chunks WHERE agency_id = ?")
      .bind(agencyId)
      .first<{ earliest: string | null }>(),
  ]);

  const points: Array<{
    observedAt: string;
    vehicleId: string;
    fleetNumber: string;
    routeId: string | null;
    tripId: string | null;
    lat: number;
    lon: number;
    speedMps: number | null;
    delaySec: number | null;
  }> = [];

  for (const ch of chunks.results) {
    const rows = JSON.parse(ch.data_json) as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (routeId && r.r !== routeId) continue;
      if (vehicleId && r.v !== vehicleId && r.f !== vehicleId) continue;
      const ts = String(r.ts ?? r.rx);
      if (ts < fromIso || ts > toIso) continue;
      points.push({
        observedAt: ts,
        vehicleId: String(r.v),
        fleetNumber: String(r.f ?? r.v),
        routeId: (r.r as string | null) ?? null,
        tripId: (r.t as string | null) ?? null,
        lat: Number(r.la),
        lon: Number(r.lo),
        speedMps: r.sp !== null && r.sp !== undefined ? Number(r.sp) : null,
        delaySec: r.sd !== null && r.sd !== undefined ? Number(r.sd) : null,
      });
    }
  }

  points.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));

  return c.json({
    agencyId,
    timezone: tz,
    serviceDate: targetDate,
    routeId: routeId ?? null,
    vehicleId: vehicleId ?? null,
    earliestAvailableAt: earliest?.earliest ?? null,
    pointCount: points.length,
    points: points.slice(0, 4000),
    assignments: assignments.results,
  });
});

// ---------------------------------------------------------------------------
// Routes Explorer (F03)
// ---------------------------------------------------------------------------
async function getActiveVersionId(db: D1Database, agencyId: string): Promise<string | null> {
  const v = await db
    .prepare("SELECT id FROM feed_versions WHERE agency_id = ? AND status = 'active' ORDER BY activated_at DESC LIMIT 1")
    .bind(agencyId)
    .first<{ id: string }>();
  return v?.id ?? null;
}

async function getRouteLookup(
  env: Env,
  agencyId: string
): Promise<Map<string, { shortName: string; longName: string; color: string | null }>> {
  const cacheKey = `routes:${agencyId}`;
  const cached = await env.CACHE.get(cacheKey, "json").catch(() => null);
  if (Array.isArray(cached)) {
    return new Map(
      (cached as Array<{ route_id: string; short_name: string; long_name: string; color: string | null }>).map((r) => [
        r.route_id,
        { shortName: r.short_name, longName: r.long_name, color: r.color },
      ])
    );
  }
  const versionId = await getActiveVersionId(env.DB, agencyId);
  if (!versionId) return new Map();
  const rows = await env.DB.prepare(
    "SELECT route_id, short_name, long_name, color FROM routes WHERE agency_id = ? AND version_id = ?"
  )
    .bind(agencyId, versionId)
    .all<{ route_id: string; short_name: string; long_name: string; color: string | null }>();
  await env.CACHE.put(cacheKey, JSON.stringify(rows.results), { expirationTtl: 600 }).catch(() => undefined);
  return new Map(
    rows.results.map((r) => [r.route_id, { shortName: r.short_name, longName: r.long_name, color: r.color }])
  );
}

app.get("/api/v1/agencies/:id/routes", async (c) => {
  const agencyId = c.req.param("id");
  const versionId = await getActiveVersionId(c.env.DB, agencyId);

  const [staticRoutes, liveStats, alertCounts] = await Promise.all([
    versionId
      ? c.env.DB.prepare(
          `SELECT route_id, short_name, long_name, description, route_type, color, text_color, sort_order, directions_json
           FROM routes WHERE agency_id = ? AND version_id = ? ORDER BY COALESCE(sort_order, 9999), short_name`
        )
          .bind(agencyId, versionId)
          .all<Record<string, unknown>>()
      : Promise.resolve({ results: [] as Array<Record<string, unknown>> }),
    c.env.AGENCY_LIVE.getByName(agencyId).getStats(),
    c.env.DB.prepare(
      `SELECT informed_entities_json FROM service_alerts WHERE agency_id = ? AND active = 1`
    )
      .bind(agencyId)
      .all<{ informed_entities_json: string }>(),
  ]);

  const activeMap = new Map(Object.entries(liveStats.routeCounts));
  const alertMap = new Map<string, number>();
  for (const al of alertCounts.results) {
    const ents = JSON.parse(al.informed_entities_json || "[]") as Array<{ routeId?: string }>;
    for (const e of ents) {
      if (e.routeId) alertMap.set(e.routeId, (alertMap.get(e.routeId) ?? 0) + 1);
    }
  }

  // Merge static routes with any live-observed route IDs if static feed hasn't been imported yet
  const routeMap = new Map<string, Record<string, unknown>>();
  for (const r of staticRoutes.results) {
    const id = String(r.route_id);
    routeMap.set(id, {
      routeId: id,
      shortName: r.short_name,
      longName: r.long_name,
      description: r.description,
      routeType: r.route_type,
      color: r.color,
      textColor: r.text_color,
      directions: JSON.parse(String(r.directions_json || "[]")),
      activeVehicles: activeMap.get(id) ?? 0,
      activeAlerts: alertMap.get(id) ?? 0,
      source: "scheduled",
    });
  }
  for (const [id, count] of activeMap) {
    if (!routeMap.has(id)) {
      routeMap.set(id, {
        routeId: id,
        shortName: id,
        longName: `Route ${id} (observed live)`,
        description: null,
        routeType: 3,
        color: null,
        textColor: null,
        directions: [],
        activeVehicles: count,
        activeAlerts: alertMap.get(id) ?? 0,
        source: "observed_live",
      });
    }
  }

  c.header("Cache-Control", "public, max-age=30");
  return c.json({
    agencyId,
    staticVersionId: versionId,
    routes: Array.from(routeMap.values()),
  });
});

app.get("/api/v1/agencies/:id/routes/:route", async (c) => {
  const agencyId = c.req.param("id");
  const routeId = decodeURIComponent(c.req.param("route"));
  const versionId = await getActiveVersionId(c.env.DB, agencyId);

  const [routeRow, trips, liveSnap, alerts, analyticsRows] = await Promise.all([
    versionId
      ? c.env.DB.prepare(
          `SELECT * FROM routes WHERE agency_id = ? AND version_id = ? AND route_id = ?`
        )
          .bind(agencyId, versionId, routeId)
          .first<Record<string, unknown>>()
      : Promise.resolve(null),
    versionId
      ? c.env.DB.prepare(
          `SELECT trip_id, service_id, direction_id, headsign, block_id, first_departure_sec, last_arrival_sec
           FROM trips WHERE agency_id = ? AND version_id = ? AND route_id = ? LIMIT 80`
        )
          .bind(agencyId, versionId, routeId)
          .all()
      : Promise.resolve({ results: [] }),
    c.env.AGENCY_LIVE.getByName(agencyId).getSnapshot({ agencyId, routeId }),
    c.env.DB.prepare("SELECT * FROM service_alerts WHERE agency_id = ? AND active = 1")
      .bind(agencyId)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT * FROM analytics_buckets WHERE agency_id = ? AND route_id = ? ORDER BY bucket_start DESC LIMIT 24`
    )
      .bind(agencyId, routeId)
      .all(),
  ]);

  // Fetch ordered stops for the first representative trip if static data exists
  let stops: Array<Record<string, unknown>> = [];
  const firstTrip = (trips.results[0] as { trip_id?: string } | undefined)?.trip_id;
  if (versionId && firstTrip) {
    const stopRes = await c.env.DB.prepare(
      `SELECT st.stop_sequence, st.arrival_sec, st.departure_sec, s.stop_id, s.stop_code, s.name, s.lat, s.lon, s.wheelchair_boarding
       FROM stop_times st
       JOIN stops s ON s.agency_id = st.agency_id AND s.version_id = st.version_id AND s.stop_id = st.stop_id
       WHERE st.agency_id = ? AND st.version_id = ? AND st.trip_id = ?
       ORDER BY st.stop_sequence ASC`
    )
      .bind(agencyId, versionId, firstTrip)
      .all();
    stops = stopRes.results;
  }

  const routeAlerts = alerts.results.filter((a) => {
    const ents = JSON.parse(String(a.informed_entities_json || "[]")) as Array<{ routeId?: string }>;
    return ents.some((e) => e.routeId === routeId);
  });

  const liveDelays = liveSnap.vehicles
    .map((v) => v.scheduleDeviationSec)
    .filter((d): d is number => d !== null);

  return c.json({
    agencyId,
    route: routeRow
      ? {
          routeId: routeRow.route_id,
          shortName: routeRow.short_name,
          longName: routeRow.long_name,
          description: routeRow.description,
          routeType: routeRow.route_type,
          color: routeRow.color,
          textColor: routeRow.text_color,
          directions: JSON.parse(String(routeRow.directions_json || "[]")),
          shapeGeoJson: routeRow.shape_geojson ? JSON.parse(String(routeRow.shape_geojson)) : null,
          geometrySource: routeRow.shape_geojson ? "static_gtfs" : "unavailable",
        }
      : {
          routeId,
          shortName: routeId,
          longName: `Route ${routeId}`,
          directions: [],
          shapeGeoJson: null,
          geometrySource: "unavailable",
        },
    activeVehicles: liveSnap.vehicles,
    stops,
    trips: trips.results,
    alerts: routeAlerts,
    performance: {
      liveAdherence: computeScheduleAdherence(liveDelays),
      historicalBuckets: analyticsRows.results,
    },
  });
});

// ---------------------------------------------------------------------------
// Stops Explorer & Arrivals Prediction (F04, F10)
// ---------------------------------------------------------------------------
app.get("/api/v1/agencies/:id/stops", async (c) => {
  const agencyId = c.req.param("id");
  const q = c.req.query("q")?.trim() || "";
  const limit = Math.min(200, Math.max(10, Number(c.req.query("limit") || "100")));
  const versionId = await getActiveVersionId(c.env.DB, agencyId);

  if (!versionId) {
    return c.json({ agencyId, staticVersionId: null, stops: [] });
  }

  const like = `%${q}%`;
  const rows = q
    ? await c.env.DB.prepare(
        `SELECT stop_id, stop_code, name, lat, lon, platform_code, parent_station, wheelchair_boarding
         FROM stops WHERE agency_id = ? AND version_id = ? AND (name LIKE ? OR stop_code LIKE ? OR stop_id LIKE ?)
         ORDER BY name ASC LIMIT ?`
      )
        .bind(agencyId, versionId, like, like, like, limit)
        .all()
    : await c.env.DB.prepare(
        `SELECT stop_id, stop_code, name, lat, lon, platform_code, parent_station, wheelchair_boarding
         FROM stops WHERE agency_id = ? AND version_id = ?
         ORDER BY name ASC LIMIT ?`
      )
        .bind(agencyId, versionId, limit)
        .all();

  c.header("Cache-Control", "public, max-age=60");
  return c.json({ agencyId, staticVersionId: versionId, stops: rows.results });
});

app.get("/api/v1/agencies/:id/stops/:stop/arrivals", async (c) => {
  const agencyId = c.req.param("id");
  const stopId = decodeURIComponent(c.req.param("stop"));
  const versionId = await getActiveVersionId(c.env.DB, agencyId);
  const agency = await c.env.DB.prepare("SELECT timezone FROM agencies WHERE id = ?")
    .bind(agencyId)
    .first<{ timezone: string }>();
  const tz = agency?.timezone ?? "America/Toronto";
  const now = new Date();
  const nowMs = now.getTime();
  const ctx = getLocalServiceContext(now, tz);

  const stop = versionId
    ? await c.env.DB.prepare(
        "SELECT * FROM stops WHERE agency_id = ? AND version_id = ? AND (stop_id = ? OR stop_code = ?) LIMIT 1"
      )
        .bind(agencyId, versionId, stopId, stopId)
        .first<Record<string, unknown>>()
    : null;

  const resolvedStopId = stop ? String(stop.stop_id) : stopId;

  const liveStub = c.env.AGENCY_LIVE.getByName(agencyId);
  const [scheduledRows, liveTripUpdates, liveSnap, alerts] = await Promise.all([
    versionId
      ? c.env.DB.prepare(
          `SELECT st.trip_id, st.stop_sequence, st.arrival_sec, st.departure_sec,
                  t.route_id, t.headsign, t.direction_id, t.block_id
           FROM stop_times st
           JOIN trips t ON t.agency_id = st.agency_id AND t.version_id = st.version_id AND t.trip_id = st.trip_id
           WHERE st.agency_id = ? AND st.version_id = ? AND st.stop_id = ?
             AND st.departure_sec >= ? AND st.departure_sec <= ?
           ORDER BY st.departure_sec ASC LIMIT 30`
        )
          .bind(agencyId, versionId, resolvedStopId, ctx.serviceSeconds - 300, ctx.serviceSeconds + 7200)
          .all<Record<string, unknown>>()
      : Promise.resolve({ results: [] as Array<Record<string, unknown>> }),
    liveStub.getTripUpdates({ serviceDate: ctx.serviceDate }),
    liveStub.getSnapshot({ agencyId }),
    c.env.DB.prepare("SELECT * FROM service_alerts WHERE agency_id = ? AND active = 1")
      .bind(agencyId)
      .all<Record<string, unknown>>(),
  ]);

  const tuByTrip = new Map(liveTripUpdates.map((r) => [r.tripId, r]));
  const vehByTrip = new Map(liveSnap.vehicles.filter((v) => v.tripId).map((v) => [v.tripId!, v]));

  const departures: Array<Record<string, unknown>> = [];

  for (const row of scheduledRows.results) {
    const tripId = String(row.trip_id);
    const tu = tuByTrip.get(tripId);
    const veh = vehByTrip.get(tripId);
    const schedSec = Number(row.departure_sec ?? row.arrival_sec ?? 0);
    const deltaFromNowSec = schedSec - ctx.serviceSeconds;
    const schedEpochMs = nowMs + deltaFromNowSec * 1000;

    let agencyPredMs: number | null = null;
    let stopRel = tu?.scheduleRelationship ?? "SCHEDULED";
    if (tu?.stopUpdates) {
      const matchStop = tu.stopUpdates.find((u) => u.stopId === resolvedStopId);
      if (matchStop) {
        if (matchStop.scheduleRelationship) stopRel = matchStop.scheduleRelationship;
        const iso = matchStop.departureTime ?? matchStop.arrivalTime;
        if (iso) agencyPredMs = Date.parse(iso);
      }
    }

    const distMeters =
      stop && veh
        ? haversineMeters(veh.lat, veh.lon, Number(stop.lat), Number(stop.lon))
        : null;

    const prediction = predictStopArrival({
      nowEpochMs: nowMs,
      scheduledEpochMs: schedEpochMs,
      agencyPredictedEpochMs: agencyPredMs,
      currentDelaySec: tu?.delaySec ?? null,
      distanceRemainingMeters: distMeters,
    });

    departures.push({
      tripId,
      routeId: row.route_id,
      headsign: row.headsign,
      directionId: row.direction_id,
      blockId: row.block_id,
      vehicleId: veh?.vehicleId ?? tu?.vehicleId ?? null,
      fleetNumber: veh?.fleetNumber ?? null,
      scheduleRelationship: stopRel,
      scheduledTime: formatSecondsToClock(schedSec),
      scheduledSec: schedSec,
      predictedTime: new Date(prediction.predictedEpochMs).toISOString(),
      etaSeconds: prediction.etaSeconds,
      uncertaintySec: prediction.uncertaintySec,
      predictionSource: prediction.source,
      confidence: prediction.confidence,
      basis: prediction.basis,
      modelVersion: prediction.modelVersion,
      distanceMeters: distMeters !== null ? Math.round(distMeters) : null,
    });
  }

  // Also include live TripUpdates referencing this stop if static schedule isn't loaded
  if (departures.length === 0) {
    for (const tu of liveTripUpdates) {
      const matchStop = tu.stopUpdates.find((u) => u.stopId === resolvedStopId);
      if (!matchStop) continue;
      const iso = matchStop.departureTime ?? matchStop.arrivalTime;
      const predMs = iso ? Date.parse(iso) : nowMs + Math.max(60, tu.delaySec ?? 300) * 1000;
      const prediction = predictStopArrival({
        nowEpochMs: nowMs,
        scheduledEpochMs: null,
        agencyPredictedEpochMs: predMs,
      });
      departures.push({
        tripId: tu.tripId,
        routeId: tu.routeId,
        headsign: null,
        vehicleId: tu.vehicleId,
        scheduleRelationship: matchStop.scheduleRelationship ?? tu.scheduleRelationship,
        scheduledTime: "—",
        predictedTime: new Date(prediction.predictedEpochMs).toISOString(),
        etaSeconds: prediction.etaSeconds,
        uncertaintySec: prediction.uncertaintySec,
        predictionSource: prediction.source,
        confidence: prediction.confidence,
        basis: prediction.basis,
        modelVersion: prediction.modelVersion,
      });
    }
  }

  departures.sort((a, b) => Number(a.etaSeconds) - Number(b.etaSeconds));

  const stopAlerts = alerts.results.filter((a) => {
    const ents = JSON.parse(String(a.informed_entities_json || "[]")) as Array<{ stopId?: string }>;
    return ents.some((e) => e.stopId === resolvedStopId);
  });

  // Approaching vehicles within 2.5km if stop coordinates known
  const approachingVehicles = stop
    ? liveSnap.vehicles
        .map((v) => ({
          ...v,
          distanceMeters: Math.round(haversineMeters(v.lat, v.lon, Number(stop.lat), Number(stop.lon))),
        }))
        .filter((v) => v.distanceMeters <= 2500)
        .sort((a, b) => a.distanceMeters - b.distanceMeters)
        .slice(0, 12)
    : [];

  return c.json({
    agencyId,
    timezone: tz,
    serviceDate: ctx.serviceDate,
    serverTime: now.toISOString(),
    stop: stop ?? { stop_id: resolvedStopId, name: `Stop ${resolvedStopId}` },
    departures,
    approachingVehicles,
    alerts: stopAlerts,
  });
});

app.get("/api/v1/agencies/:id/stops/:stop/history", async (c) => {
  const agencyId = c.req.param("id");
  const stopId = decodeURIComponent(c.req.param("stop"));
  const rows = await c.env.DB.prepare(
    `SELECT * FROM stop_events WHERE agency_id = ? AND stop_id = ? ORDER BY created_at DESC LIMIT 100`
  )
    .bind(agencyId, stopId)
    .all();
  return c.json({ agencyId, stopId, events: rows.results });
});

// ---------------------------------------------------------------------------
// Trip & Block Explorer (F06)
// ---------------------------------------------------------------------------
app.get("/api/v1/agencies/:id/trips/:instance", async (c) => {
  const agencyId = c.req.param("id");
  const tripId = decodeURIComponent(c.req.param("instance"));
  const versionId = await getActiveVersionId(c.env.DB, agencyId);
  const agency = await c.env.DB.prepare("SELECT timezone FROM agencies WHERE id = ?")
    .bind(agencyId)
    .first<{ timezone: string }>();
  const serviceDate = c.req.query("date") || getLocalServiceContext(new Date(), agency?.timezone ?? "America/Toronto").serviceDate;

  const liveStub = c.env.AGENCY_LIVE.getByName(agencyId);
  const [tripRow, stopTimes, liveTripUpdates, assignments, liveVeh] = await Promise.all([
    versionId
      ? c.env.DB.prepare("SELECT * FROM trips WHERE agency_id = ? AND version_id = ? AND trip_id = ?")
          .bind(agencyId, versionId, tripId)
          .first<Record<string, unknown>>()
      : Promise.resolve(null),
    versionId
      ? c.env.DB.prepare(
          `SELECT st.*, s.name as stop_name, s.stop_code, s.lat, s.lon
           FROM stop_times st
           JOIN stops s ON s.agency_id = st.agency_id AND s.version_id = st.version_id AND s.stop_id = st.stop_id
           WHERE st.agency_id = ? AND st.version_id = ? AND st.trip_id = ?
           ORDER BY st.stop_sequence ASC`
        )
          .bind(agencyId, versionId, tripId)
          .all()
      : Promise.resolve({ results: [] }),
    liveStub.getTripUpdates({ tripId }),
    c.env.DB.prepare(
      "SELECT * FROM vehicle_assignments WHERE agency_id = ? AND trip_id = ? AND service_date = ? ORDER BY started_at ASC"
    )
      .bind(agencyId, tripId, serviceDate)
      .all(),
    liveStub.getVehicleByTrip(tripId),
  ]);

  const tu = liveTripUpdates[0] ?? null;
  const liveVehicle = liveVeh
    ? {
        vehicle_id: liveVeh.vehicleId,
        fleet_number: liveVeh.fleetNumber,
        observed_at: liveVeh.observedAt,
        received_at: liveVeh.receivedAt,
      }
    : null;

  return c.json({
    agencyId,
    serviceDate,
    tripId,
    staticVersionId: versionId,
    trip: tripRow,
    stopTimes: stopTimes.results,
    tripUpdate: tu
      ? {
          schedule_relationship: tu.scheduleRelationship,
          delay_sec: tu.delaySec,
          stopUpdates: tu.stopUpdates,
        }
      : null,
    assignments: assignments.results,
    liveVehicle,
    note: !liveVehicle
      ? "No live vehicle currently matched to this trip; absence of GPS does not imply cancellation."
      : null,
  });
});

app.get("/api/v1/agencies/:id/blocks/:block", async (c) => {
  const agencyId = c.req.param("id");
  const blockId = decodeURIComponent(c.req.param("block"));
  const versionId = await getActiveVersionId(c.env.DB, agencyId);
  const serviceDate = c.req.query("date") || getLocalServiceContext(new Date(), "America/Toronto").serviceDate;

  const [trips, assignments] = await Promise.all([
    versionId
      ? c.env.DB.prepare(
          `SELECT * FROM trips WHERE agency_id = ? AND version_id = ? AND block_id = ? ORDER BY first_departure_sec ASC`
        )
          .bind(agencyId, versionId, blockId)
          .all()
      : Promise.resolve({ results: [] }),
    c.env.DB.prepare(
      `SELECT * FROM vehicle_assignments WHERE agency_id = ? AND block_id = ? AND service_date = ? ORDER BY started_at ASC`
    )
      .bind(agencyId, blockId, serviceDate)
      .all(),
  ]);

  return c.json({
    agencyId,
    serviceDate,
    blockId,
    trips: trips.results,
    assignments: assignments.results,
    note: "Block IDs reflect schedule groupings and do not guarantee a single physical vehicle remained assigned all day.",
  });
});

// ---------------------------------------------------------------------------
// Service Alerts (F11)
// ---------------------------------------------------------------------------
app.get("/api/v1/agencies/:id/alerts", async (c) => {
  const agencyId = c.req.param("id");
  const includeInactive = c.req.query("historical") === "true";

  const rows = includeInactive
    ? await c.env.DB.prepare(
        "SELECT * FROM service_alerts WHERE agency_id = ? ORDER BY last_seen_at DESC LIMIT 100"
      )
        .bind(agencyId)
        .all<Record<string, unknown>>()
    : await c.env.DB.prepare(
        "SELECT * FROM service_alerts WHERE agency_id = ? AND active = 1 ORDER BY last_seen_at DESC LIMIT 100"
      )
        .bind(agencyId)
        .all<Record<string, unknown>>();

  return c.json({
    agencyId,
    alerts: rows.results.map((a) => ({
      id: a.id,
      sourceAlertId: a.source_alert_id,
      cause: a.cause,
      effect: a.effect,
      headerText: a.header_text,
      descriptionText: a.description_text,
      url: a.url,
      active: Number(a.active) === 1,
      activePeriods: JSON.parse(String(a.active_periods_json || "[]")),
      informedEntities: JSON.parse(String(a.informed_entities_json || "[]")),
      firstSeenAt: a.first_seen_at,
      lastSeenAt: a.last_seen_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// Analytics & Prediction Backtest (F09)
// ---------------------------------------------------------------------------
app.get("/api/v1/agencies/:id/analytics/:metric", async (c) => {
  const agencyId = c.req.param("id");
  const metric = c.req.param("metric");
  const routeId = c.req.query("route") || undefined;

  const agency = await c.env.DB.prepare("SELECT timezone FROM agencies WHERE id = ?")
    .bind(agencyId)
    .first<{ timezone: string }>();

  const buckets = routeId
    ? await c.env.DB.prepare(
        `SELECT * FROM analytics_buckets WHERE agency_id = ? AND metric_type = ? AND route_id = ?
         ORDER BY bucket_start DESC LIMIT 48`
      )
        .bind(agencyId, metric, routeId)
        .all<Record<string, unknown>>()
    : await c.env.DB.prepare(
        `SELECT * FROM analytics_buckets WHERE agency_id = ? AND metric_type = ?
         ORDER BY bucket_start DESC LIMIT 48`
      )
        .bind(agencyId, metric)
        .all<Record<string, unknown>>();

  // Live fallback computation from AgencyLiveDO when buckets are still accumulating
  const liveSnap = await c.env.AGENCY_LIVE.getByName(agencyId).getSnapshot({ agencyId, routeId });
  const delays = liveSnap.vehicles
    .map((v) => v.scheduleDeviationSec)
    .filter((d): d is number => d !== null);

  let summary: unknown;
  if (metric === "adherence") {
    summary = computeScheduleAdherence(delays);
  } else if (metric === "headway") {
    const events = await c.env.DB.prepare(
      routeId
        ? "SELECT observed_arrival_at FROM stop_events WHERE agency_id = ? AND route_id = ? ORDER BY observed_arrival_at DESC LIMIT 100"
        : "SELECT observed_arrival_at FROM stop_events WHERE agency_id = ? ORDER BY observed_arrival_at DESC LIMIT 100"
    )
      .bind(...(routeId ? [agencyId, routeId] : [agencyId]))
      .all<{ observed_arrival_at: string | null }>();
    const epochs = events.results
      .map((e) => (e.observed_arrival_at ? Date.parse(e.observed_arrival_at) : NaN))
      .filter((t) => Number.isFinite(t));
    summary = computeHeadwayMetrics(epochs);
  } else if (metric === "backtest") {
    summary = backtestPredictions([]);
  } else {
    summary = {
      observedVehicles: liveSnap.vehicles.length,
      matchedWithDelay: delays.length,
      algorithmVersion: ANALYTICS_ALGORITHM_VERSION,
      note:
        liveSnap.vehicles.length < 5
          ? "Insufficient historical sample size; metrics populate automatically as observations accumulate."
          : undefined,
    };
  }

  return c.json({
    agencyId,
    metric,
    routeId: routeId ?? null,
    timezone: agency?.timezone ?? "America/Toronto",
    algorithmVersion: ANALYTICS_ALGORITHM_VERSION,
    summary,
    buckets: buckets.results.map((b) => ({
      ...b,
      value: JSON.parse(String(b.value_json || "{}")),
    })),
  });
});

// ---------------------------------------------------------------------------
// Cross-agency Global Search (F01-F06)
// ---------------------------------------------------------------------------
app.get("/api/v1/search", async (c) => {
  const q = c.req.query("q")?.trim() || "";
  const agencyFilter = c.req.query("agency") || undefined;
  if (q.length < 1) {
    return c.json({ query: q, results: { routes: [], stops: [], vehicles: [], trips: [] } });
  }
  const like = `%${q}%`;

  const [vehicles, routes, stops, trips] = await Promise.all([
    agencyFilter
      ? c.env.DB.prepare(
          `SELECT agency_id, vehicle_id, fleet_number, model, last_seen_at FROM vehicles
           WHERE agency_id = ? AND (fleet_number LIKE ? OR vehicle_id LIKE ?) LIMIT 15`
        )
          .bind(agencyFilter, like, like)
          .all()
      : c.env.DB.prepare(
          `SELECT agency_id, vehicle_id, fleet_number, model, last_seen_at FROM vehicles
           WHERE fleet_number LIKE ? OR vehicle_id LIKE ? LIMIT 15`
        )
          .bind(like, like)
          .all(),
    agencyFilter
      ? c.env.DB.prepare(
          `SELECT DISTINCT r.agency_id, r.route_id, r.short_name, r.long_name, r.color
           FROM routes r JOIN feed_versions fv ON fv.id = r.version_id AND fv.status = 'active'
           WHERE r.agency_id = ? AND (r.short_name LIKE ? OR r.long_name LIKE ? OR r.route_id LIKE ?) LIMIT 15`
        )
          .bind(agencyFilter, like, like, like)
          .all()
      : c.env.DB.prepare(
          `SELECT DISTINCT r.agency_id, r.route_id, r.short_name, r.long_name, r.color
           FROM routes r JOIN feed_versions fv ON fv.id = r.version_id AND fv.status = 'active'
           WHERE r.short_name LIKE ? OR r.long_name LIKE ? OR r.route_id LIKE ? LIMIT 15`
        )
          .bind(like, like, like)
          .all(),
    agencyFilter
      ? c.env.DB.prepare(
          `SELECT s.agency_id, s.stop_id, s.stop_code, s.name, s.lat, s.lon
           FROM stops s JOIN feed_versions fv ON fv.id = s.version_id AND fv.status = 'active'
           WHERE s.agency_id = ? AND (s.name LIKE ? OR s.stop_code LIKE ? OR s.stop_id LIKE ?) LIMIT 15`
        )
          .bind(agencyFilter, like, like, like)
          .all()
      : c.env.DB.prepare(
          `SELECT s.agency_id, s.stop_id, s.stop_code, s.name, s.lat, s.lon
           FROM stops s JOIN feed_versions fv ON fv.id = s.version_id AND fv.status = 'active'
           WHERE s.name LIKE ? OR s.stop_code LIKE ? OR s.stop_id LIKE ? LIMIT 15`
        )
          .bind(like, like, like)
          .all(),
    agencyFilter
      ? c.env.DB.prepare(
          `SELECT DISTINCT agency_id, trip_id, route_id, block_id, headsign
           FROM trips WHERE agency_id = ? AND (trip_id LIKE ? OR block_id LIKE ?) LIMIT 10`
        )
          .bind(agencyFilter, like, like)
          .all()
      : c.env.DB.prepare(
          `SELECT DISTINCT agency_id, trip_id, route_id, block_id, headsign
           FROM trips WHERE trip_id LIKE ? OR block_id LIKE ? LIMIT 10`
        )
          .bind(like, like)
          .all(),
  ]);

  return c.json({
    query: q,
    results: {
      routes: routes.results,
      stops: stops.results,
      vehicles: vehicles.results,
      trips: trips.results,
    },
  });
});

// ---------------------------------------------------------------------------
// Data Exports (F13)
// ---------------------------------------------------------------------------
app.post("/api/v1/exports", async (c) => {
  const quota = await getQuotaStatus(c.env.DB, getBudgets(c.env));
  if (quota.tier === "warn_70" || quota.tier === "throttle_85" || quota.tier === "paused_95") {
    return c.json(
      createProblemDetails(
        503,
        "Exports temporarily restricted",
        `Daily free-tier quota is in ${quota.tier} state; try again after UTC midnight.`
      ),
      503
    );
  }

  const parsed = ExportRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      createProblemDetails(400, "Invalid export request", parsed.error.issues.map((i) => i.message).join("; ")),
      400
    );
  }
  const req = parsed.data;
  const rangeMs = Date.parse(req.to) - Date.parse(req.from);
  if (rangeMs <= 0 || rangeMs > 7 * 86400 * 1000) {
    return c.json(
      createProblemDetails(400, "Export range bounded", "Export date range must be positive and at most 7 days."),
      400
    );
  }

  const jobId = crypto.randomUUID();
  const downloadToken = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

  const chunks = await c.env.DB.prepare(
    `SELECT data_json FROM observation_chunks
     WHERE agency_id = ? AND window_end >= ? AND window_start <= ?
     ORDER BY window_start ASC LIMIT 200`
  )
    .bind(req.agencyId, req.from, req.to)
    .all<{ data_json: string }>();

  const rows: Array<Record<string, unknown>> = [];
  for (const ch of chunks.results) {
    for (const r of JSON.parse(ch.data_json) as Array<Record<string, unknown>>) {
      if (req.routeId && r.r !== req.routeId) continue;
      if (req.vehicleId && r.v !== req.vehicleId && r.f !== req.vehicleId) continue;
      rows.push(r);
      if (rows.length >= 10_000) break;
    }
    if (rows.length >= 10_000) break;
  }

  let outputText = "";
  if (req.format === "geojson") {
    outputText = JSON.stringify({
      type: "FeatureCollection",
      features: rows.map((r) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.lo, r.la] },
        properties: r,
      })),
    });
  } else if (req.format === "json") {
    outputText = JSON.stringify({ agencyId: req.agencyId, count: rows.length, rows });
  } else {
    const header = "observed_at,received_at,vehicle_id,fleet_number,route_id,trip_id,lat,lon,bearing_deg,speed_mps,delay_sec,timestamp_basis";
    const lines = rows.map((r) =>
      [r.ts, r.rx, r.v, r.f, r.r, r.t, r.la, r.lo, r.hd, r.sp, r.sd, r.tb]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",")
    );
    outputText = [header, ...lines].join("\n") + "\n";
  }

  await c.env.DB.prepare(
    `INSERT INTO export_jobs (
      id, agency_id, query_json, format, status, row_count,
      download_token, result_text, expires_at, created_at, completed_at
    ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`
  )
    .bind(jobId, req.agencyId, JSON.stringify(req), req.format, rows.length, downloadToken, outputText, expiresAt, now, now)
    .run();

  return c.json(
    {
      id: jobId,
      status: "completed",
      format: req.format,
      rowCount: rows.length,
      expiresAt,
      downloadUrl: `/api/v1/exports/${jobId}?token=${downloadToken}&download=1`,
    },
    201
  );
});

app.get("/api/v1/exports/:id", async (c) => {
  const id = c.req.param("id");
  const token = c.req.query("token");
  const download = c.req.query("download") === "1";

  const job = await c.env.DB.prepare("SELECT * FROM export_jobs WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!job) {
    return c.json(createProblemDetails(404, "Export not found", `No export job ${id}`), 404);
  }
  if (Date.parse(String(job.expires_at)) < Date.now()) {
    return c.json(createProblemDetails(410, "Export expired", "This export link has expired."), 410);
  }
  if (download) {
    if (!token || token !== job.download_token) {
      return c.json(createProblemDetails(403, "Invalid download token", "Missing or invalid export token."), 403);
    }
    const fmt = String(job.format);
    const contentType =
      fmt === "csv" ? "text/csv; charset=utf-8" : fmt === "geojson" ? "application/geo+json" : "application/json";
    return new Response(String(job.result_text || ""), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="swisshost-${job.agency_id}-${id.slice(0, 8)}.${fmt}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return c.json({
    id: job.id,
    agencyId: job.agency_id,
    format: job.format,
    status: job.status,
    rowCount: job.row_count,
    expiresAt: job.expires_at,
    createdAt: job.created_at,
  });
});

// ---------------------------------------------------------------------------
// Optional Password Accounts, Favorites & Subscriptions (F12)
// ---------------------------------------------------------------------------
app.post("/api/v1/auth/register", async (c) => {
  const body = (await c.req.json()) as { handle?: string; password?: string; displayName?: string };
  const handle = body.handle?.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "") || "";
  if (handle.length < 2 || !body.password || body.password.length < 8) {
    return c.json(
      createProblemDetails(400, "Invalid registration", "Handle (2+ chars) and password (8+ chars) are required."),
      400
    );
  }

  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  const pwHash = await hashPassword(body.password);
  const sessionToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const sessionHash = await sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO users (id, handle, display_name, role, password_hash, created_at, last_login_at)
         VALUES (?, ?, ?, 'user', ?, ?, ?)`
      ).bind(userId, handle, body.displayName?.trim() || handle, pwHash, now, now),
      c.env.DB.prepare(
        `INSERT INTO sessions (token_hash, user_id, role, expires_at, created_at) VALUES (?, ?, 'user', ?, ?)`
      ).bind(sessionHash, userId, expiresAt, now),
    ]);
  } catch {
    return c.json(createProblemDetails(409, "Handle already taken", "Choose another handle or sign in."), 409);
  }

  c.header(
    "Set-Cookie",
    `swisshost_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${30 * 86400}`
  );
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true, user: { id: userId, handle, displayName: body.displayName || handle, role: "user" } }, 201);
});

app.post("/api/v1/auth/login", async (c) => {
  const body = (await c.req.json()) as { handle?: string; password?: string };
  const handle = body.handle?.trim().toLowerCase() || "";
  if (!handle || !body.password) {
    return c.json(createProblemDetails(400, "Missing credentials", "Enter handle and password."), 400);
  }

  const user = await c.env.DB.prepare(
    `SELECT id, handle, display_name, role, password_hash FROM users WHERE handle = ?`
  )
    .bind(handle)
    .first<{ id: string; handle: string; display_name: string; role: string; password_hash: string | null }>();

  if (!user || !(await verifyPassword(body.password, user.password_hash))) {
    return c.json(createProblemDetails(401, "Invalid credentials", "Incorrect handle or password."), 401);
  }

  const now = new Date().toISOString();
  const sessionToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const sessionHash = await sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now, user.id),
    c.env.DB.prepare(
      "INSERT INTO sessions (token_hash, user_id, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(sessionHash, user.id, user.role, expiresAt, now),
  ]);

  c.header(
    "Set-Cookie",
    `swisshost_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${30 * 86400}`
  );
  c.header("Cache-Control", "no-store");
  return c.json({
    ok: true,
    user: { id: user.id, handle: user.handle, displayName: user.display_name, role: user.role },
  });
});

app.post("/api/v1/auth/logout", async (c) => {
  const token = c.req.header("Cookie")?.match(/swisshost_session=([^;]+)/)?.[1];
  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
  c.header("Set-Cookie", "swisshost_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0");
  return c.json({ ok: true });
});

app.get("/api/v1/me", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ user: c.get("user") });
});

app.delete("/api/v1/me", async (c) => {
  const user = c.get("user");
  if (!user) return c.json(createProblemDetails(401, "Sign in required", "Not authenticated."), 401);
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
  c.header("Set-Cookie", "swisshost_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0");
  return c.json({ ok: true, deleted: true });
});

app.get("/api/v1/me/favorites", async (c) => {
  const user = c.get("user");
  if (!user) return c.json(createProblemDetails(401, "Sign in required", "Not authenticated."), 401);
  const rows = await c.env.DB.prepare("SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC")
    .bind(user.id)
    .all();
  c.header("Cache-Control", "no-store");
  return c.json({ favorites: rows.results });
});

app.put("/api/v1/me/favorites", async (c) => {
  const user = c.get("user");
  if (!user) return c.json(createProblemDetails(401, "Sign in required", "Not authenticated."), 401);
  const parsed = FavoriteInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(createProblemDetails(400, "Invalid favorite", parsed.error.message), 400);
  }
  const f = parsed.data;
  await c.env.DB.prepare(
    `INSERT INTO favorites (id, user_id, agency_id, entity_type, entity_id, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, agency_id, entity_type, entity_id) DO UPDATE SET label = excluded.label`
  )
    .bind(crypto.randomUUID(), user.id, f.agencyId, f.entityType, f.entityId, f.label, new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

app.delete("/api/v1/me/favorites/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json(createProblemDetails(401, "Sign in required", "Not authenticated."), 401);
  await c.env.DB.prepare("DELETE FROM favorites WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), user.id)
    .run();
  return c.json({ ok: true });
});

app.get("/api/v1/me/subscriptions", async (c) => {
  const user = c.get("user");
  if (!user) return c.json(createProblemDetails(401, "Sign in required", "Not authenticated."), 401);
  const [subs, inbox] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC").bind(user.id).all(),
    c.env.DB.prepare("SELECT * FROM notifications_inbox WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
      .bind(user.id)
      .all(),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json({ subscriptions: subs.results, notifications: inbox.results });
});

app.post("/api/v1/me/subscriptions", async (c) => {
  const user = c.get("user");
  if (!user) return c.json(createProblemDetails(401, "Sign in required", "Not authenticated."), 401);
  const parsed = SubscriptionInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(createProblemDetails(400, "Invalid subscription", parsed.error.message), 400);
  }
  const s = parsed.data;
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO subscriptions (
      id, user_id, agency_id, target_type, target_id, rule_json,
      channel, push_subscription_json, quiet_hours_json, cooldown_sec, enabled, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  )
    .bind(
      id,
      user.id,
      s.agencyId,
      s.targetType,
      s.targetId,
      JSON.stringify(s.rule),
      s.channel,
      s.pushSubscription ? JSON.stringify(s.pushSubscription) : null,
      s.quietHours ? JSON.stringify(s.quietHours) : null,
      s.cooldownSec,
      new Date().toISOString()
    )
    .run();
  return c.json({ ok: true, id }, 201);
});

app.delete("/api/v1/me/subscriptions/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json(createProblemDetails(401, "Sign in required", "Not authenticated."), 401);
  await c.env.DB.prepare("DELETE FROM subscriptions WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), user.id)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API 404 (never return SPA HTML on unknown /api/* routes — PRD §5.1)
// ---------------------------------------------------------------------------
app.all("/api/*", (c) => {
  return c.json(
    createProblemDetails(404, "Endpoint not found", `Unknown API path: ${c.req.path}`, c.get("requestId"), c.req.path),
    404
  );
});

// Fallback to Workers Static Assets for PWA UI routes
app.all("*", async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text("Swisshost API Worker running (static assets not attached).", 200);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === "0 0,12 * * *") {
      ctx.waitUntil(runTwelveHourArchive(env));
    } else {
      ctx.waitUntil(runWatchdog(env));
    }
  },
} satisfies ExportedHandler<Env>;
