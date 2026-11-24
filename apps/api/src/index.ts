import { Hono } from "hono";
import {
  ExportRequestSchema,
  FavoriteInputSchema,
  SubscriptionInputSchema,
  createProblemDetails,
} from "@swisshost/contracts";
import {
  ensureAgenciesSeeded,
  getQuotaStatus,
  loadLatestLiveVehiclesFromTurso,
  parseObservationChunkRows,
} from "@swisshost/database";
import {
  ANALYTICS_ALGORITHM_VERSION,
  backtestPredictions,
  computeHeadwayMetrics,
  computeScheduleAdherence,
  predictStopArrival,
} from "@swisshost/analytics";
import {
  RAIL_CORRIDORS,
  computeOnBoardRouteProgress,
  computeRailLegSchedule,
  computeUpcomingBusesForLeg,
  estimateOntarioTripFare,
  evaluateTransferRisk,
  findCrossAgencyTransferPairs,
  findRailPlanCandidates,
  findRailToRailTransfers,
  formatSecondsToClock,
  generateScheduledRailVehicles,
  getLocalServiceContext,
  getRailCorridor,
  getRailCorridorsForAgency,
  getScheduledRailRideTimeline,
  haversineMeters,
  inferVehicleMode,
  isRailMode,
  parseEcccCityPageWeather,
  resolveEcccSiteId,
  type PlanRoutePattern,
  type PlanScheduledDepartureInput,
  type PlannedUpcomingBus,
  type TransferRiskAssessment,
  type TripFareEstimate,
  type WeatherSnapshot,
} from "@swisshost/transit-core";
import { createAdminApp } from "../../admin/src/index";
import { FeedSchedulerDO } from "../../collector/src/feed-scheduler-do";
import { AgencyLiveDO } from "../../live/src/agency-live-do";
import { runTwelveHourArchive, runWatchdog } from "../../jobs/src/index";
import type { Env } from "./env";
import { BUILTIN_AGENCIES, getBudgets, hashPassword, sha256Hex, verifyPassword, withActiveDb } from "./env";

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

function isAllowedAppOrigin(value: string | undefined, publicOrigin?: string): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    const origin = u.origin.toLowerCase();
    if (publicOrigin && origin === publicOrigin.toLowerCase().replace(/\/+$/, "")) return true;
    return (
      origin === "https://swisshost.cc" ||
      origin === "https://www.swisshost.cc" ||
      origin === "https://swisshost.saminm-qureshi.workers.dev" ||
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1"
    );
  } catch {
    return false;
  }
}

// Restrict /api/v1/* to first-party Swisshost app requests only (no public third-party API access)
app.use("/api/v1/*", async (c, next) => {
  // Keep lightweight liveness check and signed export file downloads accessible
  if (c.req.path === "/api/v1/health") return next();
  if (/^\/api\/v1\/exports\/[^/]+$/.test(c.req.path) && c.req.query("token")) return next();

  const pubOrigin = c.env.PUBLIC_ORIGIN;
  const origin = c.req.header("Origin");
  const referer = c.req.header("Referer");
  const secFetchSite = c.req.header("Sec-Fetch-Site")?.toLowerCase();
  const appHeader = c.req.header("X-Swisshost-App");
  const isWsUpgrade = c.req.header("Upgrade")?.toLowerCase() === "websocket";

  // Reject any cross-site request or foreign Origin/Referer
  if (secFetchSite && secFetchSite !== "same-origin") {
    return c.json(createProblemDetails(403, "Forbidden", "Public API access is disabled.", c.get("requestId")), 403);
  }
  if (origin && !isAllowedAppOrigin(origin, pubOrigin)) {
    return c.json(createProblemDetails(403, "Forbidden", "Public API access is disabled.", c.get("requestId")), 403);
  }
  if (referer && !isAllowedAppOrigin(referer, pubOrigin)) {
    return c.json(createProblemDetails(403, "Forbidden", "Public API access is disabled.", c.get("requestId")), 403);
  }

  if (isWsUpgrade) {
    if (!isAllowedAppOrigin(origin, pubOrigin)) {
      return c.json(createProblemDetails(403, "Forbidden", "Public WebSocket access is disabled.", c.get("requestId")), 403);
    }
    return next();
  }

  const hasTrustedOriginSignal =
    secFetchSite === "same-origin" ||
    isAllowedAppOrigin(origin, pubOrigin) ||
    isAllowedAppOrigin(referer, pubOrigin);

  if (!hasTrustedOriginSignal || (!appHeader && secFetchSite !== "same-origin")) {
    return c.json(createProblemDetails(403, "Forbidden", "Public API access is disabled.", c.get("requestId")), 403);
  }

  return next();
});

// Edge-cache hot read-only endpoints via Cloudflare Cache API (zero extra D1/DO calls under traffic spikes)
const EDGE_CACHE_PATHS = new Set(["/api/v1/agencies", "/api/v1/status"]);
app.use("/api/v1/*", async (c, next) => {
  const isCacheable =
    c.req.method === "GET" &&
    (EDGE_CACHE_PATHS.has(c.req.path) || /^\/api\/v1\/agencies\/[^/]+\/routes$/.test(c.req.path));
  if (!isCacheable) return next();

  const cache = (caches as unknown as { default?: Cache }).default;
  if (!cache) return next();

  const cacheKey = new Request(c.req.url, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("X-Swisshost-Cache", "HIT");
    return res;
  }

  await next();

  if (c.res.status === 200) {
    const toStore = c.res.clone();
    toStore.headers.set("Cache-Control", "public, max-age=20, s-maxage=20");
    c.executionCtx.waitUntil(cache.put(cacheKey, toStore));
  }
});

// Mount admin routes
app.route("/admin", createAdminApp());

// OpenAPI spec disabled (internal app API only)
app.get("/openapi.json", (c) => {
  return c.json(createProblemDetails(404, "Not found", "Public API documentation is disabled.", c.get("requestId")), 404);
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

  const usingTurso = Boolean(c.env.TURSO_DATABASE_URL && c.env.TURSO_AUTH_TOKEN);

  c.header("Cache-Control", "public, max-age=15");
  return c.json({
    platformStatus: quota.tier === "paused_95" ? "degraded_quota" : "operational",
    serverTime: new Date().toISOString(),
    database: {
      provider: usingTurso ? "turso" : "cloudflare_d1",
      doSqliteStorage: "disabled",
    },
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
      const stats = await c.env.AGENCY_LIVE.getByName(id).getStats(id).catch(() => null);
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
// Rail Corridors Overlay (TTC Subway + GO Rail / UP Express)
// ---------------------------------------------------------------------------
app.get("/api/v1/rail-corridors", (c) => {
  const agency = c.req.query("agency") || "all";
  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    agencyId: agency,
    corridors: getRailCorridorsForAgency(agency),
  });
});

// ---------------------------------------------------------------------------
// Environment and Climate Change Canada (ECCC) Weather Proxy (Edge-Cached)
// Free, keyless official MSC GeoMet API; cached by hub to minimize worker/upstream cost
// ---------------------------------------------------------------------------
const weatherMemCache = new Map<string, { data: WeatherSnapshot; fetchedAt: number }>();
const WEATHER_MEM_TTL_MS = 5 * 60_000;

app.get("/api/v1/weather", async (c) => {
  const agency = c.req.query("agency") || undefined;
  const latRaw = c.req.query("lat");
  const lonRaw = c.req.query("lon");
  const lat = latRaw !== undefined ? Number(latRaw) : null;
  const lon = lonRaw !== undefined ? Number(lonRaw) : null;

  const hub = resolveEcccSiteId({
    agencyId: agency,
    lat: lat !== null && Number.isFinite(lat) ? lat : null,
    lon: lon !== null && Number.isFinite(lon) ? lon : null,
  });

  // 1. Cloudflare Edge Cache keyed strictly by ECCC siteId so TTC, GO, and nearby coords share 1 entry
  const cache = (caches as unknown as { default?: Cache }).default;
  const edgeCacheKey = new Request(`https://weather-cache.swisshost.internal/eccc/${hub.siteId}`, {
    method: "GET",
  });
  if (cache) {
    const hit = await cache.match(edgeCacheKey);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set("X-Swisshost-Cache", "HIT");
      return res;
    }
  }

  // 2. Isolate in-memory cache fallback (zero upstream calls within 5 min)
  const mem = weatherMemCache.get(hub.siteId);
  if (mem && Date.now() - mem.fetchedAt < WEATHER_MEM_TTL_MS) {
    c.header("Cache-Control", "public, max-age=300, s-maxage=600, stale-while-revalidate=600");
    c.header("X-Swisshost-Cache", "MEM");
    return c.json(mem.data);
  }

  const upstreamUrl = `https://api.weather.gc.ca/collections/citypageweather-realtime/items/${encodeURIComponent(hub.siteId)}?f=json`;
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Swisshost/1.0 (+https://swisshost.cc)",
      },
      signal: AbortSignal.timeout(7000),
    });

    if (!upstream.ok) {
      throw new Error(`ECCC returned HTTP ${upstream.status}`);
    }

    const raw = (await upstream.json()) as unknown;
    const parsed = parseEcccCityPageWeather(raw, hub);
    weatherMemCache.set(hub.siteId, { data: parsed, fetchedAt: Date.now() });

    const body = JSON.stringify(parsed);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=600",
      "X-Swisshost-Cache": "MISS",
    };

    if (cache) {
      c.executionCtx.waitUntil(
        cache.put(edgeCacheKey, new Response(body, { status: 200, headers })).catch(() => undefined)
      );
    }

    return new Response(body, { status: 200, headers });
  } catch (err) {
    // Graceful stale fallback if ECCC hiccups
    if (mem) {
      c.header("Cache-Control", "public, max-age=60");
      c.header("X-Swisshost-Cache", "STALE");
      return c.json({ ...mem.data, stale: true });
    }
    return c.json(
      createProblemDetails(
        502,
        "Weather feed unavailable",
        err instanceof Error ? err.message : "Could not reach Environment Canada weather service.",
        c.get("requestId"),
        c.req.path
      ),
      502
    );
  }
});

// ---------------------------------------------------------------------------
// Live Vehicles & WebSocket (F02, F05, F15)
// ---------------------------------------------------------------------------
app.get("/api/v1/live", async (c) => {
  const agencyId = c.req.query("agency") || "guelph";
  const stub = c.env.AGENCY_LIVE.getByName(agencyId);
  return stub.fetch(c.req.raw);
});

const coldStartPollGuard = new Map<string, number>();

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

  let snap = await c.env.AGENCY_LIVE.getByName(agencyId).getSnapshot({ agencyId, routeId, bbox });

  // Self-heal immediately after a deploy or DO eviction (or when stale > 120s), throttled per agency to once every 45s
  const lastTry = coldStartPollGuard.get(agencyId) ?? 0;
  const isStaleOrEmpty =
    snap.vehicles.length === 0 ||
    (snap.lastSuccessAt !== null && Date.now() - Date.parse(snap.lastSuccessAt) > 120_000);
  if (isStaleOrEmpty && Date.now() - lastTry > 45_000) {
    coldStartPollGuard.set(agencyId, Date.now());
    const posFeeds = await c.env.DB.prepare(
      `SELECT f.*, a.timezone, a.archive_policy
       FROM feeds f JOIN agencies a ON a.id = f.agency_id
       WHERE f.agency_id = ? AND f.kind = 'vehicle_positions' AND f.enabled = 1 AND f.status != 'missing_key'`
    )
      .bind(agencyId)
      .all<Record<string, unknown>>();
    if (posFeeds.results.length > 0) {
      await Promise.all(
        posFeeds.results.map(async (feed) => {
          const scheduler = c.env.FEED_SCHEDULER.getByName(String(feed.id));
          await scheduler
            .ensureScheduled({
              id: String(feed.id),
              agencyId: String(feed.agency_id),
              kind: "vehicle_positions",
              adapter: String(feed.adapter),
              url: String(feed.url),
              fallbackUrl: (feed.fallback_url as string | null) ?? null,
              authQueryParam: (feed.auth_query_param as string | null) ?? null,
              authSecretRef: (feed.auth_secret_ref as string | null) ?? null,
              refreshSeconds: Number(feed.refresh_seconds || 45),
              staleAfterSeconds: Number(feed.stale_after_seconds || 120),
              timezone: String(feed.timezone || "America/Toronto"),
              archivePermitted: String(feed.archive_policy || "permitted") === "permitted",
              enabled: true,
            })
            .catch(() => undefined);
          await scheduler.pollNow(false).catch(() => undefined);
        })
      );
      snap = await c.env.AGENCY_LIVE.getByName(agencyId).getSnapshot({ agencyId, routeId, bbox });
    }
  }

  // Fall back to Turso observation_chunks if DO cold-started with 0 rows (same pattern for all agencies)
  let vehicles = snap.vehicles;
  if (vehicles.length === 0) {
    const tursoFallback = await loadLatestLiveVehiclesFromTurso(c.env.DB, agencyId, 15).catch(() => null);
    if (tursoFallback && tursoFallback.vehicles.length > 0) {
      vehicles = tursoFallback.vehicles;
    }
  }

  // Enrich with active route names/colors/types, trip headsigns, mode, and resolved stop names from KV/D1
  const lookups = await getAgencyStaticLookups(c.env, agencyId);
  const modeFilter = c.req.query("mode")?.toLowerCase() || "";
  vehicles = vehicles.map((v) => enrichVehicleWithLookups(v, lookups, agencyId));

  // Merge timetable-estimated trains for TTC Subway and GO Rail corridors that don't have live GPS reporting
  const liveRailRouteIds = new Set<string>();
  for (const v of vehicles) {
    if (v.freshness !== "stale" && isRailMode(v.vehicleMode)) {
      if (v.routeId) liveRailRouteIds.add(v.routeId);
      if (v.routeShortName) liveRailRouteIds.add(v.routeShortName);
    }
  }
  const scheduledTrains = generateScheduledRailVehicles(agencyId, Date.now(), liveRailRouteIds);
  if (scheduledTrains.length > 0) {
    vehicles = [...vehicles, ...scheduledTrains];
  }

  if (routeId) {
    vehicles = vehicles.filter((v) => v.routeId === routeId || v.routeShortName === routeId);
  }
  if (modeFilter === "trains" || modeFilter === "rail") {
    vehicles = vehicles.filter((v) => isRailMode(v.vehicleMode));
  } else if (modeFilter === "subway" || modeFilter === "streetcar" || modeFilter === "bus") {
    vehicles = vehicles.filter((v) => v.vehicleMode === modeFilter);
  }
  if (q) {
    vehicles = vehicles.filter(
      (v) =>
        v.fleetNumber.toLowerCase().includes(q) ||
        v.vehicleId.toLowerCase().includes(q) ||
        (v.routeId?.toLowerCase().includes(q) ?? false) ||
        (v.routeShortName?.toLowerCase().includes(q) ?? false) ||
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

  // Timetable-estimated train detail (TTC Subway / GO Rail when no live GPS is present)
  if (vehicleId.startsWith("sched:")) {
    const sched = getScheduledRailRideTimeline(agencyId, vehicleId, Date.now());
    if (sched) {
      const lv = sched.vehicle;
      return c.json({
        agencyId,
        vehicle: {
          agency_id: agencyId,
          vehicle_id: lv.vehicleId,
          fleet_number: lv.fleetNumber,
          vehicle_type: lv.vehicleMode ?? "rail",
          metadata_source: "scheduled_timetable",
        },
        latest: {
          agency_id: lv.agencyId,
          source_vehicle_id: lv.sourceVehicleId,
          vehicle_id: lv.vehicleId,
          fleet_number: lv.fleetNumber,
          route_id: lv.routeId,
          route_short_name: lv.routeShortName ?? lv.routeId,
          route_long_name: lv.routeLongName ?? null,
          route_type: lv.routeType ?? null,
          vehicle_mode: lv.vehicleMode ?? "rail",
          position_source: "scheduled",
          headsign: lv.headsign ?? null,
          trip_id: lv.tripId,
          block_id: null,
          direction_id: lv.directionId,
          lat: lv.lat,
          lon: lv.lon,
          bearing_deg: lv.bearingDeg,
          speed_mps: lv.speedMps,
          schedule_deviation_sec: 0,
          current_status: lv.currentStatus,
          stop_id: lv.stopId,
          stop_name: lv.stopName ?? null,
          stop_sequence: lv.stopSequence,
          occupancy_status: null,
          observed_at: lv.observedAt,
          received_at: lv.receivedAt,
          timestamp_basis: "receipt",
          match_method: "scheduled_timetable",
          match_confidence: 0.65,
        },
        aliases: [],
        recentAssignments: [],
      });
    }
  }

  const [vehicle, rawLiveVeh, lookups, aliases, assignments] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM vehicles WHERE agency_id = ? AND (vehicle_id = ? OR fleet_number = ?) LIMIT 1")
      .bind(agencyId, vehicleId, vehicleId)
      .first<Record<string, unknown>>(),
    c.env.AGENCY_LIVE.getByName(agencyId).getVehicle(vehicleId),
    getAgencyStaticLookups(c.env, agencyId),
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

  const liveVeh = rawLiveVeh ? enrichVehicleWithLookups(rawLiveVeh, lookups, agencyId) : null;

  const latest = liveVeh
    ? {
        agency_id: liveVeh.agencyId,
        source_vehicle_id: liveVeh.sourceVehicleId,
        vehicle_id: liveVeh.vehicleId,
        fleet_number: liveVeh.fleetNumber,
        route_id: liveVeh.routeId,
        route_short_name: liveVeh.routeShortName ?? liveVeh.routeId,
        route_long_name: liveVeh.routeLongName ?? null,
        headsign: liveVeh.headsign ?? null,
        trip_id: liveVeh.tripId,
        pattern_trip_id: liveVeh.patternTripId ?? null,
        block_id: liveVeh.blockId,
        direction_id: liveVeh.directionId,
        lat: liveVeh.lat,
        lon: liveVeh.lon,
        bearing_deg: liveVeh.bearingDeg,
        speed_mps: liveVeh.speedMps,
        schedule_deviation_sec: liveVeh.scheduleDeviationSec,
        current_status: liveVeh.currentStatus,
        stop_id: liveVeh.stopId,
        stop_name: liveVeh.stopName ?? null,
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

// ---------------------------------------------------------------------------
// On-Board Live Ride Timeline (upcoming stops, ETAs, and route shape)
// ---------------------------------------------------------------------------
app.get("/api/v1/agencies/:id/vehicles/:vehicle/ride", async (c) => {
  const agencyId = c.req.param("id");
  const vehicleId = decodeURIComponent(c.req.param("vehicle"));

  if (vehicleId.startsWith("sched:")) {
    const sched = getScheduledRailRideTimeline(agencyId, vehicleId, Date.now());
    if (sched) {
      return c.json({
        agencyId,
        vehicle: sched.vehicle,
        routeShape: sched.routeShape,
        stops: sched.stops,
        serverTime: new Date().toISOString(),
      });
    }
  }

  const [rawVeh, lookups, versionId] = await Promise.all([
    c.env.AGENCY_LIVE.getByName(agencyId).getVehicle(vehicleId),
    getAgencyStaticLookups(c.env, agencyId),
    getActiveVersionId(c.env.DB, agencyId),
  ]);

  if (!rawVeh) {
    return c.json(createProblemDetails(404, "Vehicle not live", `Vehicle ${vehicleId} is not currently reporting live GPS.`), 404);
  }

  const veh = enrichVehicleWithLookups(rawVeh, lookups, agencyId);
  let patternTripId = veh.patternTripId ?? null;
  let routeShape: { type: "LineString"; coordinates: Array<[number, number]> } | null = null;

  if (versionId && veh.routeId) {
    const routeRow = await c.env.DB.prepare(
      "SELECT shape_geojson FROM routes WHERE agency_id = ? AND version_id = ? AND route_id = ?"
    )
      .bind(agencyId, versionId, veh.routeId)
      .first<{ shape_geojson: string | null }>();
    if (routeRow?.shape_geojson) {
      routeShape = JSON.parse(routeRow.shape_geojson) as { type: "LineString"; coordinates: Array<[number, number]> };
    }

    if (!patternTripId) {
      const fallbackTrip = await c.env.DB.prepare(
        `SELECT trip_id, headsign FROM trips WHERE agency_id = ? AND version_id = ? AND route_id = ?
         ORDER BY CASE WHEN direction_id = ? THEN 0 ELSE 1 END LIMIT 1`
      )
        .bind(agencyId, versionId, veh.routeId, veh.directionId ?? 0)
        .first<{ trip_id: string; headsign: string | null }>();
      if (fallbackTrip) {
        patternTripId = fallbackTrip.trip_id;
        if (!veh.headsign && fallbackTrip.headsign) veh.headsign = fallbackTrip.headsign;
      }
    }
  }

  let orderedStops: Array<{
    stopId: string;
    stopCode: string | null;
    name: string;
    lat: number;
    lon: number;
    stopSequence: number;
    status: "passed" | "current" | "next" | "upcoming";
    distanceMeters: number;
    etaMinutes: number | null;
  }> = [];

  if (versionId && patternTripId) {
    const stRows = await c.env.DB.prepare(
      `SELECT st.stop_sequence, st.stop_id, s.stop_code, s.name, s.lat, s.lon
       FROM stop_times st
       JOIN stops s ON s.agency_id = st.agency_id AND s.version_id = st.version_id AND s.stop_id = st.stop_id
       WHERE st.agency_id = ? AND st.version_id = ? AND st.trip_id = ?
       ORDER BY st.stop_sequence ASC`
    )
      .bind(agencyId, versionId, patternTripId)
      .all<{
        stop_sequence: number;
        stop_id: string;
        stop_code: string | null;
        name: string;
        lat: number;
        lon: number;
      }>();

    const list = stRows.results;
    if (list.length > 0) {
      // Locate vehicle along the ordered stop sequence (prefer explicit stopId match, else nearest stop)
      let currentIdx = -1;
      if (veh.stopId) {
        currentIdx = list.findIndex((s) => s.stop_id === veh.stopId);
      }
      if (currentIdx === -1) {
        let bestDist = Infinity;
        for (let i = 0; i < list.length; i++) {
          const d = haversineMeters(veh.lat, veh.lon, list[i]!.lat, list[i]!.lon);
          if (d < bestDist) {
            bestDist = d;
            currentIdx = i;
          }
        }
      }

      const speedMps = veh.speedMps && veh.speedMps > 2.5 ? Math.min(20, veh.speedMps) : 6.2; // ~22 km/h urban average
      let cumDist = 0;

      orderedStops = list.map((s, idx) => {
        const directDist = Math.round(haversineMeters(veh.lat, veh.lon, s.lat, s.lon));
        let status: "passed" | "current" | "next" | "upcoming";
        let etaMinutes: number | null = null;

        if (idx < currentIdx) {
          status = "passed";
        } else if (idx === currentIdx) {
          status = veh.currentStatus === "STOPPED_AT" || directDist < 65 ? "current" : "next";
          cumDist = directDist;
          etaMinutes = status === "current" ? 0 : Math.max(1, Math.round(directDist / speedMps / 60));
        } else {
          const prev = list[idx - 1]!;
          const segDist = haversineMeters(prev.lat, prev.lon, s.lat, s.lon);
          cumDist += Math.max(segDist, 80);
          status = idx === currentIdx + 1 && (veh.currentStatus === "STOPPED_AT" || directDist < 65) ? "next" : "upcoming";
          // Add ~18s average dwell per intermediate stop
          const stopsAhead = idx - currentIdx;
          etaMinutes = Math.max(1, Math.round((cumDist / speedMps + stopsAhead * 18) / 60));
        }

        return {
          stopId: s.stop_id,
          stopCode: s.stop_code,
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          stopSequence: s.stop_sequence,
          status,
          distanceMeters: idx >= currentIdx ? Math.round(cumDist) : directDist,
          etaMinutes,
        };
      });

      // Fill stopName if missing from feed
      const nextStop = orderedStops.find((s) => s.status === "current" || s.status === "next");
      if (nextStop && !veh.stopName) {
        veh.stopName = nextStop.name;
      }
    }
  }

  return c.json({
    agencyId,
    vehicle: veh,
    routeShape,
    stops: orderedStops,
    serverTime: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Nearby Stops & Vehicles (powers Simple Rider View + On-Board Auto-Detect)
// ---------------------------------------------------------------------------
app.get("/api/v1/nearby", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lon = Number(c.req.query("lon"));
  const radius = Math.min(3000, Math.max(150, Number(c.req.query("radius") || "900")));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return c.json(createProblemDetails(400, "Coordinates required", "Provide valid lat and lon query parameters."), 400);
  }

  const dLat = radius / 111_000;
  const dLon = radius / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));

  const [stopRows, agencies] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.agency_id, s.stop_id, s.stop_code, s.name, s.lat, s.lon, s.routes_json
       FROM stops s
       JOIN feed_versions fv ON fv.id = s.version_id AND fv.status = 'active'
       WHERE s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ?
       LIMIT 60`
    )
      .bind(lat - dLat, lat + dLat, lon - dLon, lon + dLon)
      .all<{
        agency_id: string;
        stop_id: string;
        stop_code: string | null;
        name: string;
        lat: number;
        lon: number;
        routes_json: string;
      }>(),
    c.env.DB.prepare("SELECT id FROM agencies WHERE enabled = 1").all<{ id: string }>(),
  ]);

  const nearbyStops = stopRows.results
    .map((s) => {
      const dist = Math.round(haversineMeters(lat, lon, s.lat, s.lon));
      return {
        agencyId: s.agency_id,
        stopId: s.stop_id,
        stopCode: s.stop_code,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        distanceMeters: dist,
        walkMinutes: Math.max(1, Math.round(dist / 78)),
        routes: JSON.parse(s.routes_json || "[]") as string[],
      };
    })
    .filter((s) => s.distanceMeters <= radius)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 12);

  // Gather nearby live vehicles across enabled agencies
  const vehicleRadius = Math.max(radius, 1200);
  const vLat = vehicleRadius / 111_000;
  const vLon = vehicleRadius / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const bbox: [number, number, number, number] = [lon - vLon, lat - vLat, lon + vLon, lat + vLat];

  const agencyVehicleBatches = await Promise.all(
    agencies.results.map(async ({ id }) => {
      const [snap, lookups] = await Promise.all([
        c.env.AGENCY_LIVE.getByName(id).getSnapshot({ agencyId: id, bbox }),
        getAgencyStaticLookups(c.env, id),
      ]);
      return snap.vehicles.map((v) => {
        const enriched = enrichVehicleWithLookups(v, lookups, id);
        return {
          ...enriched,
          distanceMeters: Math.round(haversineMeters(lat, lon, v.lat, v.lon)),
        };
      });
    })
  );

  const nearbyVehicles = agencyVehicleBatches
    .flat()
    .filter((v) => v.distanceMeters <= vehicleRadius)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 20);

  return c.json({
    lat,
    lon,
    nearbyStops,
    nearbyVehicles,
    serverTime: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// On-Board Mode: Location + Existing Route Data Candidates & Live Route Tracker
// ---------------------------------------------------------------------------
app.get("/api/v1/onboard/candidates", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lon = Number(c.req.query("lon"));
  const radius = Math.min(1800, Math.max(200, Number(c.req.query("radius") || "700")));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return c.json(createProblemDetails(400, "Coordinates required", "Provide valid lat and lon query parameters."), 400);
  }

  const dLat = radius / 111_000;
  const dLon = radius / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));

  const [stopRows, agencies] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.agency_id, s.stop_id, s.stop_code, s.name, s.lat, s.lon, s.routes_json
       FROM stops s
       JOIN feed_versions fv ON fv.id = s.version_id AND fv.status = 'active'
       WHERE s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ?
       LIMIT 100`
    )
      .bind(lat - dLat, lat + dLat, lon - dLon, lon + dLon)
      .all<{
        agency_id: string;
        stop_id: string;
        stop_code: string | null;
        name: string;
        lat: number;
        lon: number;
        routes_json: string;
      }>(),
    c.env.DB.prepare("SELECT id FROM agencies WHERE enabled = 1").all<{ id: string }>(),
  ]);

  type RouteCandidateBucket = {
    agencyId: string;
    routeId: string;
    routeShortName: string;
    routeLongName: string | null;
    routeColor: string | null;
    vehicleMode: string;
    nearestStopId: string | null;
    nearestStopName: string | null;
    nearestStopDistanceMeters: number;
    vehicles: Array<Record<string, unknown> & { distanceMeters: number }>;
  };

  const buckets = new Map<string, RouteCandidateBucket>();
  const involvedAgencies = new Set<string>();

  for (const s of stopRows.results) {
    const dist = Math.round(haversineMeters(lat, lon, s.lat, s.lon));
    if (dist > radius) continue;
    involvedAgencies.add(s.agency_id);
    const rList = JSON.parse(s.routes_json || "[]") as string[];
    for (const rId of rList) {
      const key = `${s.agency_id}:${rId}`;
      const existing = buckets.get(key);
      if (!existing || dist < existing.nearestStopDistanceMeters) {
        buckets.set(key, {
          agencyId: s.agency_id,
          routeId: rId,
          routeShortName: rId,
          routeLongName: null,
          routeColor: null,
          vehicleMode: inferVehicleMode(s.agency_id, rId),
          nearestStopId: s.stop_id,
          nearestStopName: s.name,
          nearestStopDistanceMeters: dist,
          vehicles: existing?.vehicles ?? [],
        });
      }
    }
  }

  // Also include nearby rail corridors (TTC Subway / GO Rail) within 900m
  for (const cor of RAIL_CORRIDORS) {
    let bestSt: { stopId: string; name: string; dist: number } | null = null;
    for (const st of cor.stations) {
      const d = Math.round(haversineMeters(lat, lon, st.lat, st.lon));
      if (d <= Math.max(radius, 900) && (!bestSt || d < bestSt.dist)) {
        bestSt = { stopId: st.stopId, name: st.name, dist: d };
      }
    }
    if (bestSt) {
      involvedAgencies.add(cor.agencyId);
      const key = `${cor.agencyId}:${cor.routeId}`;
      const existing = buckets.get(key);
      if (!existing || bestSt.dist < existing.nearestStopDistanceMeters) {
        buckets.set(key, {
          agencyId: cor.agencyId,
          routeId: cor.routeId,
          routeShortName: cor.shortName,
          routeLongName: cor.longName,
          routeColor: cor.color,
          vehicleMode: cor.mode,
          nearestStopId: bestSt.stopId,
          nearestStopName: bestSt.name,
          nearestStopDistanceMeters: bestSt.dist,
          vehicles: existing?.vehicles ?? [],
        });
      }
    }
  }

  // Pull live + scheduled vehicles within 1.8km across enabled agencies to populate vehicles on each route portion
  const portionRadius = 1800;
  const vLat = portionRadius / 111_000;
  const vLon = portionRadius / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const bbox: [number, number, number, number] = [lon - vLon, lat - vLat, lon + vLon, lat + vLat];
  const nowMs = Date.now();

  const agenciesToCheck = Array.from(new Set([...agencies.results.map((a) => a.id), ...involvedAgencies]));
  const lookupsByAgency = new Map<string, AgencyStaticLookups>();

  await Promise.all(
    agenciesToCheck.map(async (ag) => {
      const [snap, lookups] = await Promise.all([
        c.env.AGENCY_LIVE.getByName(ag).getSnapshot({ agencyId: ag, bbox }),
        getAgencyStaticLookups(c.env, ag),
      ]);
      lookupsByAgency.set(ag, lookups);

      const liveRailIds = new Set<string>();
      const enriched = snap.vehicles.map((v) => {
        const e = enrichVehicleWithLookups(v, lookups, ag);
        if (e.freshness !== "stale" && isRailMode(e.vehicleMode)) {
          if (e.routeId) liveRailIds.add(e.routeId);
          if (e.routeShortName) liveRailIds.add(e.routeShortName);
        }
        return e;
      });
      const schedTrains = generateScheduledRailVehicles(ag, nowMs, liveRailIds).filter(
        (t) => haversineMeters(lat, lon, t.lat, t.lon) <= portionRadius
      );

      for (const v of [...enriched, ...schedTrains]) {
        if (v.freshness === "stale") continue;
        const dist = Math.round(haversineMeters(lat, lon, v.lat, v.lon));
        if (dist > portionRadius) continue;
        if (!v.routeId) continue;
        const key = `${ag}:${v.routeId}`;
        let bucket = buckets.get(key);
        if (!bucket && dist <= 900) {
          bucket = {
            agencyId: ag,
            routeId: v.routeId,
            routeShortName: v.routeShortName ?? v.routeId,
            routeLongName: v.routeLongName ?? null,
            routeColor: v.routeColor ?? null,
            vehicleMode: v.vehicleMode ?? inferVehicleMode(ag, v.routeId, v.routeShortName, v.routeType),
            nearestStopId: v.stopId ?? null,
            nearestStopName: v.stopName ?? null,
            nearestStopDistanceMeters: dist,
            vehicles: [],
          };
          buckets.set(key, bucket);
        }
        if (bucket) {
          bucket.vehicles.push({ ...v, distanceMeters: dist });
        }
      }
    })
  );

  // Enrich bucket metadata from static lookups and sort vehicles + routes
  const candidates = Array.from(buckets.values()).map((b) => {
    const rm = lookupsByAgency.get(b.agencyId)?.routes.get(b.routeId);
    if (rm) {
      b.routeShortName = rm.shortName || b.routeShortName;
      b.routeLongName = b.routeLongName ?? rm.longName;
      b.routeColor = b.routeColor ?? rm.color;
      b.vehicleMode = inferVehicleMode(b.agencyId, b.routeId, rm.shortName, rm.routeType);
    }
    b.vehicles.sort((a, c2) => a.distanceMeters - c2.distanceMeters);
    return b;
  });

  candidates.sort((a, b) => {
    const aNearVeh = a.vehicles[0]?.distanceMeters ?? Infinity;
    const bNearVeh = b.vehicles[0]?.distanceMeters ?? Infinity;
    const aHasVeryClose = aNearVeh <= 180 ? 0 : 1;
    const bHasVeryClose = bNearVeh <= 180 ? 0 : 1;
    if (aHasVeryClose !== bHasVeryClose) return aHasVeryClose - bHasVeryClose;
    if (aHasVeryClose === 0 && aNearVeh !== bNearVeh) return aNearVeh - bNearVeh;
    if (a.nearestStopDistanceMeters !== b.nearestStopDistanceMeters) {
      return a.nearestStopDistanceMeters - b.nearestStopDistanceMeters;
    }
    return b.vehicles.length - a.vehicles.length;
  });

  return c.json({
    lat,
    lon,
    candidates: candidates.slice(0, 16),
    serverTime: new Date(nowMs).toISOString(),
  });
});

app.get("/api/v1/agencies/:id/routes/:route/onboard", async (c) => {
  const agencyId = c.req.param("id");
  const routeId = decodeURIComponent(c.req.param("route"));
  const latRaw = c.req.query("lat");
  const lonRaw = c.req.query("lon");
  const lat = latRaw !== undefined && latRaw !== "" ? Number(latRaw) : NaN;
  const lon = lonRaw !== undefined && lonRaw !== "" ? Number(lonRaw) : NaN;
  const hasUserGps = Number.isFinite(lat) && Number.isFinite(lon);
  const headingRaw = c.req.query("heading");
  const headingDeg = headingRaw !== undefined && headingRaw !== "" && Number.isFinite(Number(headingRaw)) ? Number(headingRaw) : null;
  const speedRaw = c.req.query("speed");
  const speedMps = speedRaw !== undefined && speedRaw !== "" && Number.isFinite(Number(speedRaw)) ? Number(speedRaw) : null;
  const directionParam = c.req.query("direction");
  const vehicleIdParam = c.req.query("vehicle") || null;
  const fromStopParam = c.req.query("fromStop") || null;
  const toStopParam = c.req.query("toStop") || null;

  const nowMs = Date.now();
  const [lookups, versionId, snap, alertRows] = await Promise.all([
    getAgencyStaticLookups(c.env, agencyId),
    getActiveVersionId(c.env.DB, agencyId),
    c.env.AGENCY_LIVE.getByName(agencyId).getSnapshot({ agencyId }),
    c.env.DB.prepare(
      "SELECT id, effect, cause, header_text, description_text, informed_entities_json FROM service_alerts WHERE agency_id = ? AND active = 1 LIMIT 40"
    )
      .bind(agencyId)
      .all<{
        id: string;
        effect: string | null;
        cause: string | null;
        header_text: string;
        description_text: string;
        informed_entities_json: string | null;
      }>()
      .catch(() => ({ results: [] })),
  ]);

  const liveRailIds = new Set<string>();
  const allVehicles = snap.vehicles.map((v) => {
    const e = enrichVehicleWithLookups(v, lookups, agencyId);
    if (e.freshness !== "stale" && isRailMode(e.vehicleMode)) {
      if (e.routeId) liveRailIds.add(e.routeId);
      if (e.routeShortName) liveRailIds.add(e.routeShortName);
    }
    return e;
  });
  const schedTrains = generateScheduledRailVehicles(agencyId, nowMs, liveRailIds);

  const routeVehiclesRaw = [...allVehicles, ...schedTrains].filter(
    (v) =>
      v.freshness !== "stale" &&
      (v.routeId === routeId || v.routeShortName?.toUpperCase() === routeId.toUpperCase())
  );

  // Check if this is a built-in rail corridor (TTC Subway or GO Rail)
  const railCorridor = getRailCorridor(agencyId, routeId);

  let routeShape: { type: "LineString"; coordinates: Array<[number, number]> } | null = null;
  let routeShortName = lookups.routes.get(routeId)?.shortName ?? railCorridor?.shortName ?? routeId;
  let routeLongName = lookups.routes.get(routeId)?.longName ?? railCorridor?.longName ?? null;
  let routeColorVal = lookups.routes.get(routeId)?.color ?? railCorridor?.color ?? null;
  let vehicleMode: string = railCorridor?.mode ?? inferVehicleMode(agencyId, routeId, routeShortName, lookups.routes.get(routeId)?.routeType);

  type DirPattern = {
    directionId: number;
    headsign: string;
    tripId: string;
    stops: Array<{ stopId: string; stopCode: string | null; name: string; lat: number; lon: number; stopSequence: number }>;
  };
  const dirPatterns: DirPattern[] = [];

  if (railCorridor) {
    routeShape = {
      type: "LineString",
      coordinates: railCorridor.stations.map((s) => [s.lon, s.lat]),
    };
    dirPatterns.push({
      directionId: 0,
      headsign: railCorridor.headsignFwd,
      tripId: `rail-${railCorridor.routeId}-0`,
      stops: railCorridor.stations.map((s, idx) => ({
        stopId: s.stopId,
        stopCode: null,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        stopSequence: idx + 1,
      })),
    });
    dirPatterns.push({
      directionId: 1,
      headsign: railCorridor.headsignRev,
      tripId: `rail-${railCorridor.routeId}-1`,
      stops: [...railCorridor.stations].reverse().map((s, idx) => ({
        stopId: s.stopId,
        stopCode: null,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        stopSequence: idx + 1,
      })),
    });
  } else if (versionId) {
    const routeRow = await c.env.DB.prepare(
      "SELECT short_name, long_name, color, route_type, shape_geojson FROM routes WHERE agency_id = ? AND version_id = ? AND route_id = ?"
    )
      .bind(agencyId, versionId, routeId)
      .first<{ short_name: string | null; long_name: string | null; color: string | null; route_type: number | null; shape_geojson: string | null }>();

    if (routeRow) {
      routeShortName = routeRow.short_name ?? routeShortName;
      routeLongName = routeRow.long_name ?? routeLongName;
      routeColorVal = routeRow.color ?? routeColorVal;
      vehicleMode = inferVehicleMode(agencyId, routeId, routeShortName, routeRow.route_type);
      if (routeRow.shape_geojson) {
        routeShape = JSON.parse(routeRow.shape_geojson) as { type: "LineString"; coordinates: Array<[number, number]> };
      }
    }

    const tripRows = await c.env.DB.prepare(
      `SELECT trip_id, direction_id, headsign
       FROM trips WHERE agency_id = ? AND version_id = ? AND route_id = ?
       LIMIT 16`
    )
      .bind(agencyId, versionId, routeId)
      .all<{ trip_id: string; direction_id: number | null; headsign: string | null }>();

    if (tripRows.results.length > 0) {
      const tripIds = tripRows.results.map((t) => t.trip_id);
      const placeholders = tripIds.map(() => "?").join(",");
      const stRows = await c.env.DB.prepare(
        `SELECT st.trip_id, st.stop_sequence, st.stop_id, s.stop_code, s.name, s.lat, s.lon, s.wheelchair_boarding
         FROM stop_times st
         JOIN stops s ON s.agency_id = st.agency_id AND s.version_id = st.version_id AND s.stop_id = st.stop_id
         WHERE st.agency_id = ? AND st.version_id = ? AND st.trip_id IN (${placeholders})
         ORDER BY st.trip_id, st.stop_sequence ASC`
      )
        .bind(agencyId, versionId, ...tripIds)
        .all<{
          trip_id: string;
          stop_sequence: number;
          stop_id: string;
          stop_code: string | null;
          name: string;
          lat: number;
          lon: number;
          wheelchair_boarding: number | null;
        }>();

      const byTrip = new Map<string, Array<DirPattern["stops"][number] & { wheelchairBoarding?: number }>>();
      for (const r of stRows.results) {
        let arr = byTrip.get(r.trip_id);
        if (!arr) {
          arr = [];
          byTrip.set(r.trip_id, arr);
        }
        arr.push({
          stopId: r.stop_id,
          stopCode: r.stop_code,
          name: r.name,
          lat: r.lat,
          lon: r.lon,
          stopSequence: r.stop_sequence,
          wheelchairBoarding: r.wheelchair_boarding ?? 0,
        });
      }

      // Keep the best (longest or matching fromStop->toStop) pattern per directionId
      const byDir = new Map<number, DirPattern>();
      for (const t of tripRows.results) {
        const stops = byTrip.get(t.trip_id) ?? [];
        if (stops.length === 0) continue;
        const dirId = t.direction_id ?? 0;
        const matchesTripStops =
          fromStopParam &&
          toStopParam &&
          stops.findIndex((s) => s.stopId === fromStopParam) !== -1 &&
          stops.findIndex((s) => s.stopId === toStopParam) > stops.findIndex((s) => s.stopId === fromStopParam);
        const existing = byDir.get(dirId);
        if (!existing || matchesTripStops || stops.length > existing.stops.length) {
          byDir.set(dirId, {
            directionId: dirId,
            headsign: t.headsign || `Direction ${dirId + 1}`,
            tripId: t.trip_id,
            stops,
          });
        }
      }
      for (const p of Array.from(byDir.values()).sort((a, b) => a.directionId - b.directionId)) {
        dirPatterns.push(p);
      }
    }
  }

  // Pick selected vehicle if provided
  const selectedVehicle = vehicleIdParam
    ? routeVehiclesRaw.find((v) => v.vehicleId === vehicleIdParam) ?? null
    : null;

  // Choose active direction pattern:
  // 1) Explicit direction query param
  // 2) Matches fromStop -> toStop order (for Planned Trip On-Board Window)
  // 3) Matches selectedVehicle.directionId
  // 4) Best heading match with user GPS if available, else first pattern
  let activePattern: DirPattern | null = dirPatterns[0] ?? null;
  if (directionParam !== undefined && directionParam !== "") {
    const dirNum = Number(directionParam);
    activePattern = dirPatterns.find((p) => p.directionId === dirNum) ?? activePattern;
  } else if (fromStopParam && toStopParam) {
    const forward = dirPatterns.find((p) => {
      const fi = p.stops.findIndex((s) => s.stopId === fromStopParam);
      const ti = p.stops.findIndex((s) => s.stopId === toStopParam);
      return fi !== -1 && ti !== -1 && fi < ti;
    });
    if (forward) activePattern = forward;
  } else if (selectedVehicle && selectedVehicle.directionId !== null) {
    activePattern = dirPatterns.find((p) => p.directionId === selectedVehicle.directionId) ?? activePattern;
  }

  // Fallback shape built from stop coordinates if GTFS shape_geojson is missing
  if (!routeShape && activePattern && activePattern.stops.length >= 2) {
    routeShape = {
      type: "LineString",
      coordinates: activePattern.stops.map((s) => [s.lon, s.lat]),
    };
  }

  // Determine tracking anchor coordinate: prefer user's live GPS location (as requested!), else selected vehicle, else first stop
  const trackLat = hasUserGps
    ? lat
    : selectedVehicle
      ? selectedVehicle.lat
      : activePattern?.stops[0]?.lat ?? 0;
  const trackLon = hasUserGps
    ? lon
    : selectedVehicle
      ? selectedVehicle.lon
      : activePattern?.stops[0]?.lon ?? 0;
  const trackingBasis: "user_gps" | "vehicle_gps" | "route_start" = hasUserGps
    ? "user_gps"
    : selectedVehicle
      ? "vehicle_gps"
      : "route_start";

  const progress = activePattern
    ? computeOnBoardRouteProgress({
        lat: trackLat,
        lon: trackLon,
        speedMps: hasUserGps ? speedMps : selectedVehicle?.speedMps ?? null,
        headingDeg: hasUserGps ? headingDeg : selectedVehicle?.bearingDeg ?? null,
        stops: activePattern.stops,
        defaultSpeedMps: isRailMode(vehicleMode as "rail" | "subway" | "bus") ? 14 : 6.5,
      })
    : { currentIndex: 0, distanceToRouteMeters: 0, stops: [] };

  // Rank vehicles on this route by distance to rider (or track anchor), flagging those "on this portion" (<= 1.8km)
  const vehiclesOnRoute = routeVehiclesRaw
    .map((v) => {
      const dist = Math.round(haversineMeters(trackLat, trackLon, v.lat, v.lon));
      return {
        ...v,
        distanceMeters: dist,
        onPortion: dist <= 1800,
      };
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  const routeAlerts = alertRows.results
    .filter((a) => {
      try {
        const ents = JSON.parse(a.informed_entities_json || "[]") as Array<{ routeId?: string }>;
        return ents.some(
          (e) =>
            e.routeId === routeId ||
            e.routeId === routeShortName ||
            (railCorridor && e.routeId === railCorridor.shortName)
        );
      } catch {
        return false;
      }
    })
    .slice(0, 4)
    .map((a) => ({
      id: a.id,
      effect: a.effect,
      cause: a.cause,
      headerText: a.header_text,
      descriptionText: a.description_text,
    }));

  const wheelchairByStop = new Map<string, number>();
  for (const s of (activePattern?.stops ?? []) as Array<{ stopId: string; wheelchairBoarding?: number }>) {
    if (s.wheelchairBoarding !== undefined) wheelchairByStop.set(s.stopId, s.wheelchairBoarding);
  }

  return c.json({
    agencyId,
    route: {
      routeId,
      shortName: routeShortName,
      longName: routeLongName,
      color: routeColorVal,
      vehicleMode,
    },
    trackingBasis,
    activeDirectionId: activePattern?.directionId ?? 0,
    activeHeadsign: activePattern?.headsign ?? selectedVehicle?.headsign ?? null,
    directions: dirPatterns.map((p) => ({
      directionId: p.directionId,
      headsign: p.headsign,
      stopCount: p.stops.length,
    })),
    routeShape,
    distanceToRouteMeters: progress.distanceToRouteMeters,
    stops: progress.stops.map((s) => ({
      ...s,
      wheelchairBoarding: railCorridor ? 1 : (wheelchairByStop.get(s.stopId) ?? 0),
    })),
    alerts: routeAlerts,
    selectedVehicle,
    vehiclesOnRoute,
    vehiclesOnPortionCount: vehiclesOnRoute.filter((v) => v.onPortion).length,
    serverTime: new Date(nowMs).toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Route Finder (Time-Aware Direct & 1-Transfer Transit Routing across Ontario)
// ---------------------------------------------------------------------------
app.get("/api/v1/plan", async (c) => {
  const fromLat = Number(c.req.query("fromLat"));
  const fromLon = Number(c.req.query("fromLon"));
  const toLat = Number(c.req.query("toLat"));
  const toLon = Number(c.req.query("toLon"));
  const agencyFilter = c.req.query("agency") || undefined;
  const departAtParam = c.req.query("departAt") || "";

  if (
    !Number.isFinite(fromLat) ||
    !Number.isFinite(fromLon) ||
    !Number.isFinite(toLat) ||
    !Number.isFinite(toLon)
  ) {
    return c.json(
      createProblemDetails(400, "Origin and destination required", "Provide fromLat, fromLon, toLat, toLon."),
      400
    );
  }

  const nowMs = Date.now();
  const parsedDepart = departAtParam ? Date.parse(departAtParam) : NaN;
  const departAtMs = Number.isFinite(parsedDepart) ? parsedDepart : nowMs;
  const departAtIso = new Date(departAtMs).toISOString();

  const directDist = haversineMeters(fromLat, fromLon, toLat, toLon);
  const walkSearchM = 1200;
  const queryStopsNear = async (lat: number, lon: number) => {
    const dLat = walkSearchM / 111_000;
    const dLon = walkSearchM / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    const sql = agencyFilter
      ? `SELECT s.agency_id, s.stop_id, s.stop_code, s.name, s.lat, s.lon, s.routes_json
         FROM stops s JOIN feed_versions fv ON fv.id = s.version_id AND fv.status = 'active'
         WHERE s.agency_id = ? AND s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ? LIMIT 80`
      : `SELECT s.agency_id, s.stop_id, s.stop_code, s.name, s.lat, s.lon, s.routes_json
         FROM stops s JOIN feed_versions fv ON fv.id = s.version_id AND fv.status = 'active'
         WHERE s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ? LIMIT 80`;
    const binds = agencyFilter
      ? [agencyFilter, lat - dLat, lat + dLat, lon - dLon, lon + dLon]
      : [lat - dLat, lat + dLat, lon - dLon, lon + dLon];
    const res = await c.env.DB.prepare(sql)
      .bind(...binds)
      .all<{
        agency_id: string;
        stop_id: string;
        stop_code: string | null;
        name: string;
        lat: number;
        lon: number;
        routes_json: string;
      }>();

    return res.results
      .map((s) => ({
        agencyId: s.agency_id,
        stopId: s.stop_id,
        stopCode: s.stop_code,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        distMeters: Math.round(haversineMeters(lat, lon, s.lat, s.lon)),
        routes: JSON.parse(s.routes_json || "[]") as string[],
      }))
      .filter((s) => s.distMeters <= walkSearchM && s.routes.length > 0)
      .sort((a, b) => a.distMeters - b.distMeters)
      .slice(0, 28);
  };

  const [originStops, destStops] = await Promise.all([
    queryStopsNear(fromLat, fromLon),
    queryStopsNear(toLat, toLon),
  ]);

  type PlanLeg = {
    mode: "walk" | "transit";
    agencyId?: string;
    routeId?: string;
    routeShortName?: string;
    routeLongName?: string | null;
    routeColor?: string | null;
    vehicleMode?: string;
    fromName: string;
    fromStopId?: string;
    fromLat?: number;
    fromLon?: number;
    toName: string;
    toStopId?: string;
    toLat?: number;
    toLon?: number;
    distanceMeters: number;
    minutes: number;
    waitMinutes?: number;
    departureTime?: string | null;
    arrivalTime?: string | null;
    stopsCount?: number | null;
    activeVehicles?: number;
    nearestVehicleId?: string | null;
    nearestFleetNumber?: string | null;
    nearestHeadsign?: string | null;
    upcomingBuses?: PlannedUpcomingBus[];
    alerts?: Array<{ id: string; effect: string | null; headerText: string; descriptionText: string }>;
  };

  type PlanOption = {
    id: string;
    kind: "direct" | "transfer";
    transfersCount?: number;
    agencyId: string;
    agencies: string[];
    isCrossAgency: boolean;
    serviceStatus: "live" | "scheduled" | "no_upcoming";
    leaveAt: string;
    arriveAt: string;
    nextDepartureAt: string | null;
    totalMinutes: number;
    walkMinutes: number;
    waitMinutes: number;
    rideMinutes: number;
    fareEstimate?: TripFareEstimate;
    transferRisks?: TransferRiskAssessment[];
    legs: PlanLeg[];
  };

  // Preload lookups, live vehicles, live TripUpdates, timezone & active static version per involved agency
  const involvedAgencies = Array.from(
    new Set([...originStops.map((s) => s.agencyId), ...destStops.map((s) => s.agencyId)])
  );

  type EnrichedPlanVehicle = Awaited<ReturnType<AgencyLiveDO["getSnapshot"]>>["vehicles"][number] & {
    routeShortName?: string | null;
    routeLongName?: string | null;
    routeColor?: string | null;
    headsign?: string | null;
    stopName?: string | null;
    patternTripId?: string | null;
  };

  type AgencyPlanData = {
    timezone: string;
    serviceDate: string;
    departServiceSeconds: number;
    versionId: string | null;
    lookups: AgencyStaticLookups;
    vehicles: EnrichedPlanVehicle[];
    tripUpdates: Awaited<ReturnType<AgencyLiveDO["getTripUpdates"]>>;
    patterns: PlanRoutePattern[];
  };

  const agencyInfo = new Map<string, AgencyPlanData>();
  await Promise.all(
    involvedAgencies.map(async (ag) => {
      const [agencyRow, versionId, lookups, snap] = await Promise.all([
        c.env.DB.prepare("SELECT timezone FROM agencies WHERE id = ?").bind(ag).first<{ timezone: string }>(),
        getActiveVersionId(c.env.DB, ag),
        getAgencyStaticLookups(c.env, ag),
        c.env.AGENCY_LIVE.getByName(ag).getSnapshot({ agencyId: ag }),
      ]);
      const tz = agencyRow?.timezone ?? "America/Toronto";
      const departCtx = getLocalServiceContext(new Date(departAtMs), tz);
      const liveCtx = getLocalServiceContext(new Date(nowMs), tz);
      const tripUpdates = await c.env.AGENCY_LIVE.getByName(ag)
        .getTripUpdates({ serviceDate: liveCtx.serviceDate })
        .catch(() => []);
      const enrichedVehicles = snap.vehicles.map((v) => enrichVehicleWithLookups(v, lookups, ag));
      agencyInfo.set(ag, {
        timezone: tz,
        serviceDate: departCtx.serviceDate,
        departServiceSeconds: departCtx.serviceSeconds,
        versionId,
        lookups,
        vehicles: enrichedVehicles,
        tripUpdates,
        patterns: [],
      });
    })
  );

  // Collect direct route candidates first (allow up to 2 stop-pairings per route so opposite-side stops can be direction-checked)
  type DirectCandidate = {
    agencyId: string;
    routeId: string;
    oStop: (typeof originStops)[number];
    dStop: (typeof destStops)[number];
  };
  const directCandidates: DirectCandidate[] = [];
  const directPairCounts = new Map<string, number>();

  for (const oStop of originStops) {
    for (const dStop of destStops) {
      if (oStop.agencyId !== dStop.agencyId || oStop.stopId === dStop.stopId) continue;
      const destRouteSet = new Set(dStop.routes);
      for (const routeId of oStop.routes) {
        if (!destRouteSet.has(routeId)) continue;
        const key = `${oStop.agencyId}:${routeId}`;
        const count = directPairCounts.get(key) ?? 0;
        if (count >= 4) continue;
        directPairCounts.set(key, count + 1);
        directCandidates.push({ agencyId: oStop.agencyId, routeId, oStop, dStop });
      }
    }
  }

  // Also collect 1-transfer candidates (both same-agency AND cross-agency Bus<->Bus and Bus<->Rail!)
  type TransferCandidate = {
    agency1: string;
    route1: string;
    oStop: (typeof originStops)[number];
    hub1: { stopId: string; name: string; lat: number; lon: number };
    agency2: string;
    route2: string;
    hub2: { stopId: string; name: string; lat: number; lon: number };
    dStop: (typeof destStops)[number];
    transferWalkMeters: number;
    isCrossAgency: boolean;
  };
  const transferCandidates: TransferCandidate[] = [];

  type BusToRailCandidate = {
    direction: "bus_to_rail" | "rail_to_bus";
    busAgencyId: string;
    busRouteId: string;
    busFromStop: { stopId: string; name: string; lat: number; lon: number; distMeters?: number };
    busToStop: { stopId: string; name: string; lat: number; lon: number; distMeters?: number };
    corridor: (typeof RAIL_CORRIDORS)[number];
    railFromIdx: number;
    railToIdx: number;
    transferWalkMeters: number;
    endWalkDistMeters: number;
  };
  const busRailCandidates: BusToRailCandidate[] = [];

  const originByRoute = new Map<string, (typeof originStops)[number]>();
  for (const os of originStops) {
    for (const r of os.routes) {
      const k = `${os.agencyId}:${r}`;
      if (!originByRoute.has(k)) originByRoute.set(k, os);
    }
  }
  const destByRoute = new Map<string, (typeof destStops)[number]>();
  for (const ds of destStops) {
    for (const r of ds.routes) {
      const k = `${ds.agencyId}:${r}`;
      if (!destByRoute.has(k)) destByRoute.set(k, ds);
    }
  }

  // Always check cross-agency & same-agency transfers when origin/dest span agencies OR fewer than 4 direct routes exist
  const originAgencySet = new Set(originStops.map((s) => s.agencyId));
  const destAgencySet = new Set(destStops.map((s) => s.agencyId));
  const hasDifferentAgencies =
    originStops.length > 0 &&
    destStops.length > 0 &&
    Array.from(originAgencySet).some((a) => !destAgencySet.has(a));

  if ((directPairCounts.size < 4 || hasDifferentAgencies) && originStops.length > 0 && destStops.length > 0) {
    const minLat = Math.min(fromLat, toLat) - 0.03;
    const maxLat = Math.max(fromLat, toLat) + 0.03;
    const minLon = Math.min(fromLon, toLon) - 0.04;
    const maxLon = Math.max(fromLon, toLon) + 0.04;

    const hubSql = agencyFilter
      ? `SELECT s.agency_id, s.stop_id, s.name, s.lat, s.lon, s.routes_json
         FROM stops s JOIN feed_versions fv ON fv.id = s.version_id AND fv.status = 'active'
         WHERE s.agency_id = ? AND s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ? AND LENGTH(s.routes_json) > 4
         LIMIT 380`
      : `SELECT s.agency_id, s.stop_id, s.name, s.lat, s.lon, s.routes_json
         FROM stops s JOIN feed_versions fv ON fv.id = s.version_id AND fv.status = 'active'
         WHERE s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ? AND LENGTH(s.routes_json) > 4
         LIMIT 380`;
    const hubBinds = agencyFilter
      ? [agencyFilter, minLat, maxLat, minLon, maxLon]
      : [minLat, maxLat, minLon, maxLon];

    const hubRows = await c.env.DB.prepare(hubSql)
      .bind(...hubBinds)
      .all<{
        agency_id: string;
        stop_id: string;
        name: string;
        lat: number;
        lon: number;
        routes_json: string;
      }>();

    const originRouteMeta = new Map<string, { agencyId: string; routeId: string; stopId: string }>();
    for (const [k, s] of originByRoute) originRouteMeta.set(k, { agencyId: s.agencyId, routeId: k.slice(k.indexOf(":") + 1), stopId: s.stopId });
    const destRouteMeta = new Map<string, { agencyId: string; routeId: string; stopId: string }>();
    for (const [k, s] of destByRoute) destRouteMeta.set(k, { agencyId: s.agencyId, routeId: k.slice(k.indexOf(":") + 1), stopId: s.stopId });

    const matches = findCrossAgencyTransferPairs({
      originRoutes: originRouteMeta,
      destRoutes: destRouteMeta,
      hubStops: hubRows.results.map((h) => ({
        agencyId: h.agency_id,
        stopId: h.stop_id,
        name: h.name,
        lat: h.lat,
        lon: h.lon,
        routes: JSON.parse(h.routes_json || "[]") as string[],
      })),
      maxTransferMeters: 450,
      maxResults: 10,
    });

    for (const m of matches) {
      const oStop = originByRoute.get(`${m.agency1}:${m.route1}`);
      const dStop = destByRoute.get(`${m.agency2}:${m.route2}`);
      if (!oStop || !dStop) continue;
      transferCandidates.push({
        agency1: m.agency1,
        route1: m.route1,
        oStop,
        hub1: m.hub1,
        agency2: m.agency2,
        route2: m.route2,
        hub2: m.hub2,
        dStop,
        transferWalkMeters: m.transferWalkMeters,
        isCrossAgency: m.isCrossAgency,
      });
    }
  }

  // Also check Bus <-> Rail Corridor transfers (e.g. Guelph/GRT/MiWay/Milton/TTC bus <-> GO Rail or TTC Subway)
  if (!agencyFilter || agencyFilter === "ttc" || agencyFilter === "go") {
    const eligibleCorridors = agencyFilter
      ? RAIL_CORRIDORS.filter((cor) => cor.agencyId === agencyFilter)
      : RAIL_CORRIDORS;

    // 1) Local Bus -> Rail: destination is near a rail station; find closest station on that rail corridor to origin
    if (originStops.length > 0) {
      const destRailTargets: Array<{
        corridor: (typeof RAIL_CORRIDORS)[number];
        destIdx: number;
        destDist: number;
        boardIdx: number;
        boardStation: (typeof RAIL_CORRIDORS)[number]["stations"][number];
      }> = [];

      for (const cor of eligibleCorridors) {
        let bestD: { idx: number; dist: number } | null = null;
        let bestB: { idx: number; dist: number } | null = null;
        for (let i = 0; i < cor.stations.length; i++) {
          const st = cor.stations[i]!;
          const dD = Math.round(haversineMeters(toLat, toLon, st.lat, st.lon));
          if (dD <= 2200 && (!bestD || dD < bestD.dist)) bestD = { idx: i, dist: dD };
          const dO = Math.round(haversineMeters(fromLat, fromLon, st.lat, st.lon));
          if (dO > 500 && dO <= 22_000 && (!bestB || dO < bestB.dist)) bestB = { idx: i, dist: dO };
        }
        if (bestD && bestB && bestD.idx !== bestB.idx) {
          destRailTargets.push({
            corridor: cor,
            destIdx: bestD.idx,
            destDist: bestD.dist,
            boardIdx: bestB.idx,
            boardStation: cor.stations[bestB.idx]!,
          });
        }
      }

      const uniqueBoardStations = Array.from(
        new Map(destRailTargets.map((t) => [t.boardStation.stopId, t.boardStation])).values()
      ).slice(0, 5);

      const stopsNearStation = new Map<string, Array<{ agencyId: string; stopId: string; name: string; lat: number; lon: number; routes: string[]; dist: number }>>();
      await Promise.all(
        uniqueBoardStations.map(async (st) => {
          const sLat = 500 / 111_000;
          const sLon = 500 / (111_000 * Math.max(0.2, Math.cos((st.lat * Math.PI) / 180)));
          const rows = await c.env.DB.prepare(
            `SELECT s.agency_id, s.stop_id, s.name, s.lat, s.lon, s.routes_json
             FROM stops s JOIN feed_versions fv ON fv.id = s.version_id AND fv.status = 'active'
             WHERE s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ? LIMIT 50`
          )
            .bind(st.lat - sLat, st.lat + sLat, st.lon - sLon, st.lon + sLon)
            .all<{ agency_id: string; stop_id: string; name: string; lat: number; lon: number; routes_json: string }>();

          stopsNearStation.set(
            st.stopId,
            rows.results
              .map((r) => ({
                agencyId: r.agency_id,
                stopId: r.stop_id,
                name: r.name,
                lat: r.lat,
                lon: r.lon,
                routes: JSON.parse(r.routes_json || "[]") as string[],
                dist: Math.round(haversineMeters(st.lat, st.lon, r.lat, r.lon)),
              }))
              .filter((r) => r.dist <= 500)
              .sort((a, b) => a.dist - b.dist)
          );
        })
      );

      const seenBR = new Set<string>();
      for (const target of destRailTargets) {
        const nearStops = stopsNearStation.get(target.boardStation.stopId) ?? [];
        for (const ns of nearStops) {
          for (const rId of ns.routes) {
            const oStop = originByRoute.get(`${ns.agencyId}:${rId}`);
            if (!oStop || oStop.stopId === ns.stopId) continue;
            const key = `b2r:${ns.agencyId}:${rId}>${target.corridor.agencyId}:${target.corridor.routeId}`;
            if (seenBR.has(key)) continue;
            seenBR.add(key);
            busRailCandidates.push({
              direction: "bus_to_rail",
              busAgencyId: ns.agencyId,
              busRouteId: rId,
              busFromStop: oStop,
              busToStop: ns,
              corridor: target.corridor,
              railFromIdx: target.boardIdx,
              railToIdx: target.destIdx,
              transferWalkMeters: ns.dist,
              endWalkDistMeters: target.destDist,
            });
            if (busRailCandidates.length >= 6) break;
          }
          if (busRailCandidates.length >= 6) break;
        }
      }
    }

    // 2) Rail -> Local Bus: origin is near a rail station; find closest station on that rail corridor to destination
    if (destStops.length > 0) {
      const origRailTargets: Array<{
        corridor: (typeof RAIL_CORRIDORS)[number];
        origIdx: number;
        origDist: number;
        exitIdx: number;
        exitStation: (typeof RAIL_CORRIDORS)[number]["stations"][number];
      }> = [];

      for (const cor of eligibleCorridors) {
        let bestO: { idx: number; dist: number } | null = null;
        let bestE: { idx: number; dist: number } | null = null;
        for (let i = 0; i < cor.stations.length; i++) {
          const st = cor.stations[i]!;
          const dO = Math.round(haversineMeters(fromLat, fromLon, st.lat, st.lon));
          if (dO <= 2200 && (!bestO || dO < bestO.dist)) bestO = { idx: i, dist: dO };
          const dD = Math.round(haversineMeters(toLat, toLon, st.lat, st.lon));
          if (dD > 500 && dD <= 22_000 && (!bestE || dD < bestE.dist)) bestE = { idx: i, dist: dD };
        }
        if (bestO && bestE && bestO.idx !== bestE.idx) {
          origRailTargets.push({
            corridor: cor,
            origIdx: bestO.idx,
            origDist: bestO.dist,
            exitIdx: bestE.idx,
            exitStation: cor.stations[bestE.idx]!,
          });
        }
      }

      const uniqueExitStations = Array.from(
        new Map(origRailTargets.map((t) => [t.exitStation.stopId, t.exitStation])).values()
      ).slice(0, 5);

      const stopsNearExit = new Map<string, Array<{ agencyId: string; stopId: string; name: string; lat: number; lon: number; routes: string[]; dist: number }>>();
      await Promise.all(
        uniqueExitStations.map(async (st) => {
          const sLat = 500 / 111_000;
          const sLon = 500 / (111_000 * Math.max(0.2, Math.cos((st.lat * Math.PI) / 180)));
          const rows = await c.env.DB.prepare(
            `SELECT s.agency_id, s.stop_id, s.name, s.lat, s.lon, s.routes_json
             FROM stops s JOIN feed_versions fv ON fv.id = s.version_id AND fv.status = 'active'
             WHERE s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ? LIMIT 50`
          )
            .bind(st.lat - sLat, st.lat + sLat, st.lon - sLon, st.lon + sLon)
            .all<{ agency_id: string; stop_id: string; name: string; lat: number; lon: number; routes_json: string }>();

          stopsNearExit.set(
            st.stopId,
            rows.results
              .map((r) => ({
                agencyId: r.agency_id,
                stopId: r.stop_id,
                name: r.name,
                lat: r.lat,
                lon: r.lon,
                routes: JSON.parse(r.routes_json || "[]") as string[],
                dist: Math.round(haversineMeters(st.lat, st.lon, r.lat, r.lon)),
              }))
              .filter((r) => r.dist <= 500)
              .sort((a, b) => a.dist - b.dist)
          );
        })
      );

      const seenRB = new Set<string>();
      for (const target of origRailTargets) {
        const nearStops = stopsNearExit.get(target.exitStation.stopId) ?? [];
        for (const ns of nearStops) {
          for (const rId of ns.routes) {
            const dStop = destByRoute.get(`${ns.agencyId}:${rId}`);
            if (!dStop || dStop.stopId === ns.stopId) continue;
            const key = `r2b:${target.corridor.agencyId}:${target.corridor.routeId}>${ns.agencyId}:${rId}`;
            if (seenRB.has(key)) continue;
            seenRB.add(key);
            busRailCandidates.push({
              direction: "rail_to_bus",
              busAgencyId: ns.agencyId,
              busRouteId: rId,
              busFromStop: ns,
              busToStop: dStop,
              corridor: target.corridor,
              railFromIdx: target.origIdx,
              railToIdx: target.exitIdx,
              transferWalkMeters: ns.dist,
              endWalkDistMeters: target.origDist,
            });
            if (busRailCandidates.length >= 12) break;
          }
          if (busRailCandidates.length >= 12) break;
        }
      }
    }
  }

  // Batch-load canonical route patterns (trips + stop_times) & scheduled departures for candidate routes/stops
  const candidateRoutesByAgency = new Map<string, Set<string>>();
  const candidateStopPairsByAgency = new Map<string, Map<string, { fromStopId: string; toStopId: string; routeId: string }>>();
  const addCandidate = (ag: string, routeId: string, fromStopId: string, toStopId: string) => {
    let rSet = candidateRoutesByAgency.get(ag);
    if (!rSet) {
      rSet = new Set();
      candidateRoutesByAgency.set(ag, rSet);
    }
    rSet.add(routeId);
    let pMap = candidateStopPairsByAgency.get(ag);
    if (!pMap) {
      pMap = new Map();
      candidateStopPairsByAgency.set(ag, pMap);
    }
    pMap.set(`${routeId}|${fromStopId}|${toStopId}`, { fromStopId, toStopId, routeId });
  };

  for (const dc of directCandidates) addCandidate(dc.agencyId, dc.routeId, dc.oStop.stopId, dc.dStop.stopId);
  for (const tc of transferCandidates) {
    addCandidate(tc.agency1, tc.route1, tc.oStop.stopId, tc.hub1.stopId);
    addCandidate(tc.agency2, tc.route2, tc.hub2.stopId, tc.dStop.stopId);
  }
  for (const brc of busRailCandidates) {
    addCandidate(brc.busAgencyId, brc.busRouteId, brc.busFromStop.stopId, brc.busToStop.stopId);
  }

  const scheduledByPairKey = new Map<string, PlanScheduledDepartureInput[]>();

  await Promise.all(
    Array.from(candidateRoutesByAgency.entries()).map(async ([ag, routeSet]) => {
      const info = agencyInfo.get(ag);
      if (!info?.versionId || routeSet.size === 0) return;
      const routeIds = Array.from(routeSet).slice(0, 16);
      const placeholders = routeIds.map(() => "?").join(",");

      // Fetch canonical pattern trips (up to 4 per route) + their ordered stops
      const tripRows = await c.env.DB.prepare(
        `SELECT trip_id, route_id, direction_id, headsign
         FROM trips
         WHERE agency_id = ? AND version_id = ? AND route_id IN (${placeholders})
         LIMIT 60`
      )
        .bind(ag, info.versionId, ...routeIds)
        .all<{ trip_id: string; route_id: string; direction_id: number | null; headsign: string | null }>();

      if (tripRows.results.length > 0) {
        const tripIds = tripRows.results.map((t) => t.trip_id);
        const tPlaceholders = tripIds.map(() => "?").join(",");
        const stRows = await c.env.DB.prepare(
          `SELECT st.trip_id, st.stop_sequence, st.stop_id, st.arrival_sec, st.departure_sec, s.lat, s.lon
           FROM stop_times st
           JOIN stops s ON s.agency_id = st.agency_id AND s.version_id = st.version_id AND s.stop_id = st.stop_id
           WHERE st.agency_id = ? AND st.version_id = ? AND st.trip_id IN (${tPlaceholders})
           ORDER BY st.trip_id, st.stop_sequence ASC`
        )
          .bind(ag, info.versionId, ...tripIds)
          .all<{
            trip_id: string;
            stop_sequence: number;
            stop_id: string;
            arrival_sec: number | null;
            departure_sec: number | null;
            lat: number;
            lon: number;
          }>();

        const stopsByTrip = new Map<string, PlanRoutePattern["stops"]>();
        for (const r of stRows.results) {
          let arr = stopsByTrip.get(r.trip_id);
          if (!arr) {
            arr = [];
            stopsByTrip.set(r.trip_id, arr);
          }
          arr.push({
            stopId: r.stop_id,
            stopSequence: r.stop_sequence,
            lat: r.lat,
            lon: r.lon,
            arrivalSec: r.arrival_sec,
            departureSec: r.departure_sec,
          });
        }

        info.patterns = tripRows.results
          .map((t) => ({
            tripId: t.trip_id,
            routeId: t.route_id,
            directionId: t.direction_id,
            headsign: t.headsign,
            stops: stopsByTrip.get(t.trip_id) ?? [],
          }))
          .filter((p) => p.stops.length > 0);
      }

      // Fetch scheduled departures within the next 3 hours from boarding stops
      const pairs = Array.from(candidateStopPairsByAgency.get(ag)?.values() ?? []);
      const boardingStopIds = Array.from(new Set(pairs.map((p) => p.fromStopId))).slice(0, 20);
      if (boardingStopIds.length > 0) {
        const sPlaceholders = boardingStopIds.map(() => "?").join(",");
        const minSec = info.departServiceSeconds - 120;
        const maxSec = info.departServiceSeconds + 10_800;
        const schedRows = await c.env.DB.prepare(
          `SELECT st1.trip_id, st1.stop_id as orig_stop, st1.stop_sequence as orig_seq,
                  st1.departure_sec as orig_dep, st2.stop_id as dest_stop,
                  st2.stop_sequence as dest_seq, st2.arrival_sec as dest_arr,
                  t.route_id, t.headsign
           FROM stop_times st1
           JOIN trips t ON t.agency_id = st1.agency_id AND t.version_id = st1.version_id AND t.trip_id = st1.trip_id
           JOIN stop_times st2 ON st2.agency_id = st1.agency_id AND st2.version_id = st1.version_id
                AND st2.trip_id = st1.trip_id AND st2.stop_sequence > st1.stop_sequence
           WHERE st1.agency_id = ? AND st1.version_id = ?
             AND st1.stop_id IN (${sPlaceholders})
             AND st1.departure_sec >= ? AND st1.departure_sec <= ?
           ORDER BY st1.departure_sec ASC
           LIMIT 240`
        )
          .bind(ag, info.versionId, ...boardingStopIds, minSec, maxSec)
          .all<{
            trip_id: string;
            orig_stop: string;
            orig_seq: number;
            orig_dep: number;
            dest_stop: string;
            dest_seq: number;
            dest_arr: number | null;
            route_id: string;
            headsign: string | null;
          }>();

        for (const r of schedRows.results) {
          const pk = `${ag}|${r.route_id}|${r.orig_stop}|${r.dest_stop}`;
          let arr = scheduledByPairKey.get(pk);
          if (!arr) {
            arr = [];
            scheduledByPairKey.set(pk, arr);
          }
          arr.push({
            tripId: r.trip_id,
            routeId: r.route_id,
            headsign: r.headsign,
            originDepartureSec: r.orig_dep,
            destArrivalSec: r.dest_arr,
            stopsCount: r.dest_seq - r.orig_seq,
          });
        }
      }
    })
  );

  const options: PlanOption[] = [];
  const bestDirectByRoute = new Map<string, PlanOption>();

  // 1. Evaluate direct candidates with real current-time upcoming buses
  for (const dc of directCandidates) {
    const { agencyId: ag, routeId, oStop, dStop } = dc;
    const info = agencyInfo.get(ag);
    if (!info) continue;
    const rm = info.lookups.routes.get(routeId);
    const speedMps = ag === "go" ? 16 : 6.2;
    const walkStartMin = Math.max(1, Math.round(oStop.distMeters / 78));
    const walkEndMin = Math.max(1, Math.round(dStop.distMeters / 78));
    const walkMinutes = walkStartMin + walkEndMin;
    const readyToBoardMs = departAtMs + walkStartMin * 60_000;

    const legCalc = computeUpcomingBusesForLeg({
      nowMs,
      departAtMs,
      readyToBoardMs,
      departServiceSeconds: info.departServiceSeconds,
      fromStop: { stopId: oStop.stopId, lat: oStop.lat, lon: oStop.lon },
      toStop: { stopId: dStop.stopId, lat: dStop.lat, lon: dStop.lon },
      routeId,
      defaultSpeedMps: speedMps,
      patterns: info.patterns,
      liveVehicles: info.vehicles,
      tripUpdates: info.tripUpdates,
      scheduledDepartures: scheduledByPairKey.get(`${ag}|${routeId}|${oStop.stopId}|${dStop.stopId}`) ?? [],
      maxResults: 4,
    });

    if (!legCalc.directionValid) continue;

    const routeVehicles = info.vehicles
      .filter((v) => v.routeId === routeId && v.freshness !== "stale")
      .map((v) => ({ v, dist: haversineMeters(v.lat, v.lon, oStop.lat, oStop.lon) }))
      .sort((a, b) => a.dist - b.dist);

    const nextBus = legCalc.upcomingBuses[0] ?? null;
    const rideMinutes = nextBus?.rideMinutes ?? legCalc.baselineRideMinutes;
    const waitMinutes = nextBus ? nextBus.waitMinutes : 0;
    const leaveAtIso = departAtIso;
    const arriveMs = nextBus
      ? Date.parse(nextBus.arrivalTime) + walkEndMin * 60_000
      : departAtMs + (walkMinutes + rideMinutes) * 60_000;
    const totalMinutes = Math.max(walkMinutes + rideMinutes, Math.round((arriveMs - departAtMs) / 60_000));
    const serviceStatus: PlanOption["serviceStatus"] = nextBus
      ? nextBus.isLive
        ? "live"
        : "scheduled"
      : "no_upcoming";

    const rideDist = Math.round(haversineMeters(oStop.lat, oStop.lon, dStop.lat, dStop.lon) * 1.25);

    const option: PlanOption = {
      id: `direct-${ag}-${routeId}-${oStop.stopId}`,
      kind: "direct",
      agencyId: ag,
      agencies: [ag],
      isCrossAgency: false,
      serviceStatus,
      leaveAt: leaveAtIso,
      arriveAt: new Date(arriveMs).toISOString(),
      nextDepartureAt: nextBus?.departureTime ?? null,
      totalMinutes,
      walkMinutes,
      waitMinutes,
      rideMinutes,
      legs: [
        {
          mode: "walk",
          fromName: "Origin",
          fromLat,
          fromLon,
          toName: oStop.name,
          toStopId: oStop.stopId,
          toLat: oStop.lat,
          toLon: oStop.lon,
          distanceMeters: oStop.distMeters,
          minutes: walkStartMin,
          departureTime: leaveAtIso,
          arrivalTime: new Date(readyToBoardMs).toISOString(),
        },
        {
          mode: "transit",
          agencyId: ag,
          routeId,
          routeShortName: rm?.shortName ?? routeId,
          routeLongName: rm?.longName ?? null,
          routeColor: rm?.color ?? null,
          vehicleMode: inferVehicleMode(ag, routeId, rm?.shortName, rm?.routeType),
          fromName: oStop.name,
          fromStopId: oStop.stopId,
          fromLat: oStop.lat,
          fromLon: oStop.lon,
          toName: dStop.name,
          toStopId: dStop.stopId,
          toLat: dStop.lat,
          toLon: dStop.lon,
          distanceMeters: rideDist,
          minutes: rideMinutes,
          waitMinutes,
          departureTime: nextBus?.departureTime ?? null,
          arrivalTime: nextBus?.arrivalTime ?? null,
          stopsCount: legCalc.stopsCount,
          activeVehicles: routeVehicles.length,
          nearestVehicleId: nextBus?.vehicleId ?? routeVehicles[0]?.v.vehicleId ?? null,
          nearestFleetNumber: nextBus?.fleetNumber ?? routeVehicles[0]?.v.fleetNumber ?? null,
          nearestHeadsign: nextBus?.headsign ?? legCalc.defaultHeadsign ?? routeVehicles[0]?.v.headsign ?? null,
          upcomingBuses: legCalc.upcomingBuses,
        },
        {
          mode: "walk",
          fromName: dStop.name,
          fromStopId: dStop.stopId,
          fromLat: dStop.lat,
          fromLon: dStop.lon,
          toName: "Destination",
          toLat,
          toLon,
          distanceMeters: dStop.distMeters,
          minutes: walkEndMin,
          departureTime: nextBus?.arrivalTime ?? null,
          arrivalTime: new Date(arriveMs).toISOString(),
        },
      ],
    };

    const routeKey = `${ag}:${routeId}`;
    const existing = bestDirectByRoute.get(routeKey);
    const score = (opt: PlanOption) =>
      (opt.serviceStatus === "live" ? 0 : opt.serviceStatus === "scheduled" ? 1 : 2) * 100_000 + opt.totalMinutes;
    if (!existing || score(option) < score(existing)) {
      bestDirectByRoute.set(routeKey, option);
    }
  }

  for (const opt of bestDirectByRoute.values()) {
    options.push(opt);
  }

  // 2. Evaluate 1-transfer candidates (both same-agency AND cross-agency Bus <-> Bus)
  for (const tc of transferCandidates) {
    const { agency1, route1, oStop, hub1, agency2, route2, hub2, dStop, transferWalkMeters, isCrossAgency } = tc;
    const info1 = agencyInfo.get(agency1);
    const info2 = agencyInfo.get(agency2);
    if (!info1 || !info2) continue;
    const rm1 = info1.lookups.routes.get(route1);
    const rm2 = info2.lookups.routes.get(route2);
    const speed1 = agency1 === "go" || agency1 === "ontarionorthland" ? 16 : 6.2;
    const speed2 = agency2 === "go" || agency2 === "ontarionorthland" ? 16 : 6.2;
    const walkStartMin = Math.max(1, Math.round(oStop.distMeters / 78));
    const walkTransferMin = transferWalkMeters >= 40 ? Math.max(1, Math.ceil(transferWalkMeters / 78)) : 0;
    const walkEndMin = Math.max(1, Math.round(dStop.distMeters / 78));
    const walkMinutes = walkStartMin + walkTransferMin + walkEndMin;
    const readyLeg1Ms = departAtMs + walkStartMin * 60_000;

    const leg1Calc = computeUpcomingBusesForLeg({
      nowMs,
      departAtMs,
      readyToBoardMs: readyLeg1Ms,
      departServiceSeconds: info1.departServiceSeconds,
      fromStop: { stopId: oStop.stopId, lat: oStop.lat, lon: oStop.lon },
      toStop: { stopId: hub1.stopId, lat: hub1.lat, lon: hub1.lon },
      routeId: route1,
      defaultSpeedMps: speed1,
      patterns: info1.patterns,
      liveVehicles: info1.vehicles,
      tripUpdates: info1.tripUpdates,
      scheduledDepartures: scheduledByPairKey.get(`${agency1}|${route1}|${oStop.stopId}|${hub1.stopId}`) ?? [],
      maxResults: 3,
    });
    if (!leg1Calc.directionValid) continue;

    const bus1 = leg1Calc.upcomingBuses[0] ?? null;
    const leg1Min = bus1?.rideMinutes ?? leg1Calc.baselineRideMinutes;
    const leg1ArriveMs = bus1
      ? Date.parse(bus1.arrivalTime)
      : readyLeg1Ms + leg1Min * 60_000;
    const transferBufferMin = Math.max(3, walkTransferMin + 2);
    const readyLeg2Ms = leg1ArriveMs + transferBufferMin * 60_000;

    const leg2Calc = computeUpcomingBusesForLeg({
      nowMs,
      departAtMs,
      readyToBoardMs: readyLeg2Ms,
      departServiceSeconds: info2.departServiceSeconds,
      fromStop: { stopId: hub2.stopId, lat: hub2.lat, lon: hub2.lon },
      toStop: { stopId: dStop.stopId, lat: dStop.lat, lon: dStop.lon },
      routeId: route2,
      defaultSpeedMps: speed2,
      patterns: info2.patterns,
      liveVehicles: info2.vehicles,
      tripUpdates: info2.tripUpdates,
      scheduledDepartures: scheduledByPairKey.get(`${agency2}|${route2}|${hub2.stopId}|${dStop.stopId}`) ?? [],
      maxResults: 3,
    });
    if (!leg2Calc.directionValid) continue;

    const bus2 = leg2Calc.upcomingBuses[0] ?? null;
    const leg2Min = bus2?.rideMinutes ?? leg2Calc.baselineRideMinutes;
    const wait1 = bus1 ? bus1.waitMinutes : 0;
    const wait2 = bus2 ? Math.max(0, Math.round((Date.parse(bus2.departureTime) - leg1ArriveMs - walkTransferMin * 60_000) / 60_000)) : 3;
    const totalWait = wait1 + wait2;
    const finalArriveMs = bus2
      ? Date.parse(bus2.arrivalTime) + walkEndMin * 60_000
      : readyLeg2Ms + (leg2Min + walkEndMin) * 60_000;
    const totalMinutes = Math.max(
      walkMinutes + leg1Min + leg2Min,
      Math.round((finalArriveMs - departAtMs) / 60_000)
    );

    const hasAnyUpcoming = Boolean(bus1 || bus2);
    const hasLive = Boolean(bus1?.isLive || bus2?.isLive);
    const serviceStatus: PlanOption["serviceStatus"] = hasLive
      ? "live"
      : hasAnyUpcoming
        ? "scheduled"
        : "no_upcoming";

    const leg1Dist = Math.round(haversineMeters(oStop.lat, oStop.lon, hub1.lat, hub1.lon) * 1.25);
    const leg2Dist = Math.round(haversineMeters(hub2.lat, hub2.lon, dStop.lat, dStop.lon) * 1.25);
    const active1 = info1.vehicles.filter((v) => v.routeId === route1 && v.freshness !== "stale").length;
    const active2 = info2.vehicles.filter((v) => v.routeId === route2 && v.freshness !== "stale").length;

    const legs: PlanLeg[] = [
      {
        mode: "walk",
        fromName: "Origin",
        fromLat,
        fromLon,
        toName: oStop.name,
        toStopId: oStop.stopId,
        toLat: oStop.lat,
        toLon: oStop.lon,
        distanceMeters: oStop.distMeters,
        minutes: walkStartMin,
        departureTime: departAtIso,
        arrivalTime: new Date(readyLeg1Ms).toISOString(),
      },
      {
        mode: "transit",
        agencyId: agency1,
        routeId: route1,
        routeShortName: rm1?.shortName ?? route1,
        routeLongName: rm1?.longName ?? null,
        routeColor: rm1?.color ?? null,
        vehicleMode: inferVehicleMode(agency1, route1, rm1?.shortName, rm1?.routeType),
        fromName: oStop.name,
        fromStopId: oStop.stopId,
        fromLat: oStop.lat,
        fromLon: oStop.lon,
        toName: hub1.name,
        toStopId: hub1.stopId,
        toLat: hub1.lat,
        toLon: hub1.lon,
        distanceMeters: leg1Dist,
        minutes: leg1Min,
        waitMinutes: wait1,
        departureTime: bus1?.departureTime ?? null,
        arrivalTime: bus1?.arrivalTime ?? null,
        stopsCount: leg1Calc.stopsCount,
        activeVehicles: active1,
        nearestVehicleId: bus1?.vehicleId ?? null,
        nearestFleetNumber: bus1?.fleetNumber ?? null,
        nearestHeadsign: bus1?.headsign ?? leg1Calc.defaultHeadsign ?? null,
        upcomingBuses: leg1Calc.upcomingBuses,
      },
    ];

    if (transferWalkMeters >= 40) {
      legs.push({
        mode: "walk",
        fromName: hub1.name,
        fromStopId: hub1.stopId,
        fromLat: hub1.lat,
        fromLon: hub1.lon,
        toName: hub2.name,
        toStopId: hub2.stopId,
        toLat: hub2.lat,
        toLon: hub2.lon,
        distanceMeters: transferWalkMeters,
        minutes: walkTransferMin,
        departureTime: bus1?.arrivalTime ?? null,
        arrivalTime: new Date(leg1ArriveMs + walkTransferMin * 60_000).toISOString(),
      });
    }

    legs.push(
      {
        mode: "transit",
        agencyId: agency2,
        routeId: route2,
        routeShortName: rm2?.shortName ?? route2,
        routeLongName: rm2?.longName ?? null,
        routeColor: rm2?.color ?? null,
        vehicleMode: inferVehicleMode(agency2, route2, rm2?.shortName, rm2?.routeType),
        fromName: hub2.name,
        fromStopId: hub2.stopId,
        fromLat: hub2.lat,
        fromLon: hub2.lon,
        toName: dStop.name,
        toStopId: dStop.stopId,
        toLat: dStop.lat,
        toLon: dStop.lon,
        distanceMeters: leg2Dist,
        minutes: leg2Min,
        waitMinutes: wait2,
        departureTime: bus2?.departureTime ?? null,
        arrivalTime: bus2?.arrivalTime ?? null,
        stopsCount: leg2Calc.stopsCount,
        activeVehicles: active2,
        nearestVehicleId: bus2?.vehicleId ?? null,
        nearestFleetNumber: bus2?.fleetNumber ?? null,
        nearestHeadsign: bus2?.headsign ?? leg2Calc.defaultHeadsign ?? null,
        upcomingBuses: leg2Calc.upcomingBuses,
      },
      {
        mode: "walk",
        fromName: dStop.name,
        fromStopId: dStop.stopId,
        fromLat: dStop.lat,
        fromLon: dStop.lon,
        toName: "Destination",
        toLat,
        toLon,
        distanceMeters: dStop.distMeters,
        minutes: walkEndMin,
        departureTime: bus2?.arrivalTime ?? null,
        arrivalTime: new Date(finalArriveMs).toISOString(),
      }
    );

    options.push({
      id: `transfer-${agency1}-${route1}-${agency2}-${route2}`,
      kind: "transfer",
      agencyId: agency1,
      agencies: isCrossAgency ? [agency1, agency2] : [agency1],
      isCrossAgency,
      serviceStatus,
      leaveAt: departAtIso,
      arriveAt: new Date(finalArriveMs).toISOString(),
      nextDepartureAt: bus1?.departureTime ?? null,
      totalMinutes,
      walkMinutes,
      waitMinutes: totalWait,
      rideMinutes: leg1Min + leg2Min,
      legs,
    });
  }

  // 2b. Evaluate Bus <-> Rail Corridor transfers (cross-agency & same-agency)
  for (const brc of busRailCandidates) {
    const busInfo = agencyInfo.get(brc.busAgencyId);
    if (!busInfo) continue;
    const rm = busInfo.lookups.routes.get(brc.busRouteId);
    const busSpeed = brc.busAgencyId === "go" || brc.busAgencyId === "ontarionorthland" ? 16 : 6.2;
    const isCrossAgency = brc.busAgencyId !== brc.corridor.agencyId;
    const walkTransferMin = brc.transferWalkMeters >= 40 ? Math.max(1, Math.ceil(brc.transferWalkMeters / 78)) : 0;
    const transferBufferMin = Math.max(3, walkTransferMin + 2);
    const activeRailTrains = generateScheduledRailVehicles(brc.corridor.agencyId, nowMs).filter(
      (v) => v.routeId === brc.corridor.routeId
    ).length;
    const activeBusVehicles = busInfo.vehicles.filter((v) => v.routeId === brc.busRouteId && v.freshness !== "stale").length;

    if (brc.direction === "bus_to_rail") {
      const walkStartMin = Math.max(1, Math.round((brc.busFromStop.distMeters ?? 150) / 78));
      const walkEndMin = Math.max(1, Math.round(brc.endWalkDistMeters / 78));
      const ready1Ms = departAtMs + walkStartMin * 60_000;

      const busCalc = computeUpcomingBusesForLeg({
        nowMs,
        departAtMs,
        readyToBoardMs: ready1Ms,
        departServiceSeconds: busInfo.departServiceSeconds,
        fromStop: { stopId: brc.busFromStop.stopId, lat: brc.busFromStop.lat, lon: brc.busFromStop.lon },
        toStop: { stopId: brc.busToStop.stopId, lat: brc.busToStop.lat, lon: brc.busToStop.lon },
        routeId: brc.busRouteId,
        defaultSpeedMps: busSpeed,
        patterns: busInfo.patterns,
        liveVehicles: busInfo.vehicles,
        tripUpdates: busInfo.tripUpdates,
        scheduledDepartures:
          scheduledByPairKey.get(`${brc.busAgencyId}|${brc.busRouteId}|${brc.busFromStop.stopId}|${brc.busToStop.stopId}`) ?? [],
        maxResults: 3,
      });
      if (!busCalc.directionValid) continue;

      const bus1 = busCalc.upcomingBuses[0] ?? null;
      const leg1Min = bus1?.rideMinutes ?? busCalc.baselineRideMinutes;
      const leg1ArrMs = bus1 ? Date.parse(bus1.arrivalTime) : ready1Ms + leg1Min * 60_000;
      const ready2Ms = leg1ArrMs + transferBufferMin * 60_000;

      const railLeg = computeRailLegSchedule({
        corridor: brc.corridor,
        originIdx: brc.railFromIdx,
        destIdx: brc.railToIdx,
        departAtMs,
        readyToBoardMs: ready2Ms,
        maxResults: 3,
      });
      if (!railLeg) continue;

      const railUpcoming: PlannedUpcomingBus[] = railLeg.upcomingDepartures.map((u) => ({
        ...u,
        isLive: false,
        source: "scheduled",
        vehicleId: null,
        fleetNumber: null,
        tripId: null,
        stopsAway: null,
        delaySec: null,
      }));
      const rail1 = railUpcoming[0] ?? null;
      const wait1 = bus1 ? bus1.waitMinutes : 0;
      const wait2 = rail1 ? Math.max(0, Math.round((Date.parse(rail1.departureTime) - leg1ArrMs - walkTransferMin * 60_000) / 60_000)) : 4;
      const finalArriveMs = rail1
        ? Date.parse(rail1.arrivalTime) + walkEndMin * 60_000
        : ready2Ms + (railLeg.rideMinutes + walkEndMin) * 60_000;
      const walkMinutes = walkStartMin + walkTransferMin + walkEndMin;
      const totalMinutes = Math.max(walkMinutes + leg1Min + railLeg.rideMinutes, Math.round((finalArriveMs - departAtMs) / 60_000));

      const legs: PlanLeg[] = [
        {
          mode: "walk",
          fromName: "Origin",
          fromLat,
          fromLon,
          toName: brc.busFromStop.name,
          toStopId: brc.busFromStop.stopId,
          toLat: brc.busFromStop.lat,
          toLon: brc.busFromStop.lon,
          distanceMeters: brc.busFromStop.distMeters ?? 150,
          minutes: walkStartMin,
          departureTime: departAtIso,
          arrivalTime: new Date(ready1Ms).toISOString(),
        },
        {
          mode: "transit",
          agencyId: brc.busAgencyId,
          routeId: brc.busRouteId,
          routeShortName: rm?.shortName ?? brc.busRouteId,
          routeLongName: rm?.longName ?? null,
          routeColor: rm?.color ?? null,
          vehicleMode: inferVehicleMode(brc.busAgencyId, brc.busRouteId, rm?.shortName, rm?.routeType),
          fromName: brc.busFromStop.name,
          fromStopId: brc.busFromStop.stopId,
          fromLat: brc.busFromStop.lat,
          fromLon: brc.busFromStop.lon,
          toName: brc.busToStop.name,
          toStopId: brc.busToStop.stopId,
          toLat: brc.busToStop.lat,
          toLon: brc.busToStop.lon,
          distanceMeters: Math.round(haversineMeters(brc.busFromStop.lat, brc.busFromStop.lon, brc.busToStop.lat, brc.busToStop.lon) * 1.25),
          minutes: leg1Min,
          waitMinutes: wait1,
          departureTime: bus1?.departureTime ?? null,
          arrivalTime: bus1?.arrivalTime ?? null,
          stopsCount: busCalc.stopsCount,
          activeVehicles: activeBusVehicles,
          nearestVehicleId: bus1?.vehicleId ?? null,
          nearestFleetNumber: bus1?.fleetNumber ?? null,
          nearestHeadsign: bus1?.headsign ?? busCalc.defaultHeadsign ?? null,
          upcomingBuses: busCalc.upcomingBuses,
        },
      ];
      if (brc.transferWalkMeters >= 40) {
        legs.push({
          mode: "walk",
          fromName: brc.busToStop.name,
          fromStopId: brc.busToStop.stopId,
          fromLat: brc.busToStop.lat,
          fromLon: brc.busToStop.lon,
          toName: railLeg.originStation.name,
          toStopId: railLeg.originStation.stopId,
          toLat: railLeg.originStation.lat,
          toLon: railLeg.originStation.lon,
          distanceMeters: brc.transferWalkMeters,
          minutes: walkTransferMin,
          departureTime: bus1?.arrivalTime ?? null,
          arrivalTime: new Date(leg1ArrMs + walkTransferMin * 60_000).toISOString(),
        });
      }
      legs.push(
        {
          mode: "transit",
          agencyId: brc.corridor.agencyId,
          routeId: brc.corridor.routeId,
          routeShortName: brc.corridor.shortName,
          routeLongName: brc.corridor.longName,
          routeColor: brc.corridor.color,
          vehicleMode: brc.corridor.mode,
          fromName: railLeg.originStation.name,
          fromStopId: railLeg.originStation.stopId,
          fromLat: railLeg.originStation.lat,
          fromLon: railLeg.originStation.lon,
          toName: railLeg.destStation.name,
          toStopId: railLeg.destStation.stopId,
          toLat: railLeg.destStation.lat,
          toLon: railLeg.destStation.lon,
          distanceMeters: Math.round(haversineMeters(railLeg.originStation.lat, railLeg.originStation.lon, railLeg.destStation.lat, railLeg.destStation.lon) * 1.12),
          minutes: railLeg.rideMinutes,
          waitMinutes: wait2,
          departureTime: rail1?.departureTime ?? null,
          arrivalTime: rail1?.arrivalTime ?? null,
          stopsCount: railLeg.stopsCount,
          activeVehicles: activeRailTrains,
          nearestVehicleId: null,
          nearestFleetNumber: null,
          nearestHeadsign: railLeg.headsign,
          upcomingBuses: railUpcoming,
        },
        {
          mode: "walk",
          fromName: railLeg.destStation.name,
          fromStopId: railLeg.destStation.stopId,
          fromLat: railLeg.destStation.lat,
          fromLon: railLeg.destStation.lon,
          toName: "Destination",
          toLat,
          toLon,
          distanceMeters: brc.endWalkDistMeters,
          minutes: walkEndMin,
          departureTime: rail1?.arrivalTime ?? null,
          arrivalTime: new Date(finalArriveMs).toISOString(),
        }
      );

      options.push({
        id: `xfer-b2r-${brc.busAgencyId}-${brc.busRouteId}-${brc.corridor.agencyId}-${brc.corridor.routeId}`,
        kind: "transfer",
        agencyId: brc.busAgencyId,
        agencies: isCrossAgency ? [brc.busAgencyId, brc.corridor.agencyId] : [brc.busAgencyId],
        isCrossAgency,
        serviceStatus: bus1?.isLive ? "live" : bus1 || rail1 ? "scheduled" : "no_upcoming",
        leaveAt: departAtIso,
        arriveAt: new Date(finalArriveMs).toISOString(),
        nextDepartureAt: bus1?.departureTime ?? null,
        totalMinutes,
        walkMinutes,
        waitMinutes: wait1 + wait2,
        rideMinutes: leg1Min + railLeg.rideMinutes,
        legs,
      });
    } else {
      // rail_to_bus
      const walkStartMin = Math.max(1, Math.round(brc.endWalkDistMeters / 78));
      const walkEndMin = Math.max(1, Math.round((brc.busToStop.distMeters ?? 150) / 78));
      const ready1Ms = departAtMs + walkStartMin * 60_000;

      const railLeg = computeRailLegSchedule({
        corridor: brc.corridor,
        originIdx: brc.railFromIdx,
        destIdx: brc.railToIdx,
        departAtMs,
        readyToBoardMs: ready1Ms,
        maxResults: 3,
      });
      if (!railLeg) continue;

      const railUpcoming: PlannedUpcomingBus[] = railLeg.upcomingDepartures.map((u) => ({
        ...u,
        isLive: false,
        source: "scheduled",
        vehicleId: null,
        fleetNumber: null,
        tripId: null,
        stopsAway: null,
        delaySec: null,
      }));
      const rail1 = railUpcoming[0] ?? null;
      const leg1ArrMs = rail1 ? Date.parse(rail1.arrivalTime) : ready1Ms + railLeg.rideMinutes * 60_000;
      const ready2Ms = leg1ArrMs + transferBufferMin * 60_000;

      const busCalc = computeUpcomingBusesForLeg({
        nowMs,
        departAtMs,
        readyToBoardMs: ready2Ms,
        departServiceSeconds: busInfo.departServiceSeconds,
        fromStop: { stopId: brc.busFromStop.stopId, lat: brc.busFromStop.lat, lon: brc.busFromStop.lon },
        toStop: { stopId: brc.busToStop.stopId, lat: brc.busToStop.lat, lon: brc.busToStop.lon },
        routeId: brc.busRouteId,
        defaultSpeedMps: busSpeed,
        patterns: busInfo.patterns,
        liveVehicles: busInfo.vehicles,
        tripUpdates: busInfo.tripUpdates,
        scheduledDepartures:
          scheduledByPairKey.get(`${brc.busAgencyId}|${brc.busRouteId}|${brc.busFromStop.stopId}|${brc.busToStop.stopId}`) ?? [],
        maxResults: 3,
      });
      if (!busCalc.directionValid) continue;

      const bus2 = busCalc.upcomingBuses[0] ?? null;
      const leg2Min = bus2?.rideMinutes ?? busCalc.baselineRideMinutes;
      const wait1 = rail1 ? rail1.waitMinutes : 0;
      const wait2 = bus2 ? Math.max(0, Math.round((Date.parse(bus2.departureTime) - leg1ArrMs - walkTransferMin * 60_000) / 60_000)) : 4;
      const finalArriveMs = bus2
        ? Date.parse(bus2.arrivalTime) + walkEndMin * 60_000
        : ready2Ms + (leg2Min + walkEndMin) * 60_000;
      const walkMinutes = walkStartMin + walkTransferMin + walkEndMin;
      const totalMinutes = Math.max(walkMinutes + railLeg.rideMinutes + leg2Min, Math.round((finalArriveMs - departAtMs) / 60_000));

      const legs: PlanLeg[] = [
        {
          mode: "walk",
          fromName: "Origin",
          fromLat,
          fromLon,
          toName: railLeg.originStation.name,
          toStopId: railLeg.originStation.stopId,
          toLat: railLeg.originStation.lat,
          toLon: railLeg.originStation.lon,
          distanceMeters: brc.endWalkDistMeters,
          minutes: walkStartMin,
          departureTime: departAtIso,
          arrivalTime: new Date(ready1Ms).toISOString(),
        },
        {
          mode: "transit",
          agencyId: brc.corridor.agencyId,
          routeId: brc.corridor.routeId,
          routeShortName: brc.corridor.shortName,
          routeLongName: brc.corridor.longName,
          routeColor: brc.corridor.color,
          vehicleMode: brc.corridor.mode,
          fromName: railLeg.originStation.name,
          fromStopId: railLeg.originStation.stopId,
          fromLat: railLeg.originStation.lat,
          fromLon: railLeg.originStation.lon,
          toName: railLeg.destStation.name,
          toStopId: railLeg.destStation.stopId,
          toLat: railLeg.destStation.lat,
          toLon: railLeg.destStation.lon,
          distanceMeters: Math.round(haversineMeters(railLeg.originStation.lat, railLeg.originStation.lon, railLeg.destStation.lat, railLeg.destStation.lon) * 1.12),
          minutes: railLeg.rideMinutes,
          waitMinutes: wait1,
          departureTime: rail1?.departureTime ?? null,
          arrivalTime: rail1?.arrivalTime ?? null,
          stopsCount: railLeg.stopsCount,
          activeVehicles: activeRailTrains,
          nearestVehicleId: null,
          nearestFleetNumber: null,
          nearestHeadsign: railLeg.headsign,
          upcomingBuses: railUpcoming,
        },
      ];
      if (brc.transferWalkMeters >= 40) {
        legs.push({
          mode: "walk",
          fromName: railLeg.destStation.name,
          fromStopId: railLeg.destStation.stopId,
          fromLat: railLeg.destStation.lat,
          fromLon: railLeg.destStation.lon,
          toName: brc.busFromStop.name,
          toStopId: brc.busFromStop.stopId,
          toLat: brc.busFromStop.lat,
          toLon: brc.busFromStop.lon,
          distanceMeters: brc.transferWalkMeters,
          minutes: walkTransferMin,
          departureTime: rail1?.arrivalTime ?? null,
          arrivalTime: new Date(leg1ArrMs + walkTransferMin * 60_000).toISOString(),
        });
      }
      legs.push(
        {
          mode: "transit",
          agencyId: brc.busAgencyId,
          routeId: brc.busRouteId,
          routeShortName: rm?.shortName ?? brc.busRouteId,
          routeLongName: rm?.longName ?? null,
          routeColor: rm?.color ?? null,
          vehicleMode: inferVehicleMode(brc.busAgencyId, brc.busRouteId, rm?.shortName, rm?.routeType),
          fromName: brc.busFromStop.name,
          fromStopId: brc.busFromStop.stopId,
          fromLat: brc.busFromStop.lat,
          fromLon: brc.busFromStop.lon,
          toName: brc.busToStop.name,
          toStopId: brc.busToStop.stopId,
          toLat: brc.busToStop.lat,
          toLon: brc.busToStop.lon,
          distanceMeters: Math.round(haversineMeters(brc.busFromStop.lat, brc.busFromStop.lon, brc.busToStop.lat, brc.busToStop.lon) * 1.25),
          minutes: leg2Min,
          waitMinutes: wait2,
          departureTime: bus2?.departureTime ?? null,
          arrivalTime: bus2?.arrivalTime ?? null,
          stopsCount: busCalc.stopsCount,
          activeVehicles: activeBusVehicles,
          nearestVehicleId: bus2?.vehicleId ?? null,
          nearestFleetNumber: bus2?.fleetNumber ?? null,
          nearestHeadsign: bus2?.headsign ?? busCalc.defaultHeadsign ?? null,
          upcomingBuses: busCalc.upcomingBuses,
        },
        {
          mode: "walk",
          fromName: brc.busToStop.name,
          fromStopId: brc.busToStop.stopId,
          fromLat: brc.busToStop.lat,
          fromLon: brc.busToStop.lon,
          toName: "Destination",
          toLat,
          toLon,
          distanceMeters: brc.busToStop.distMeters ?? 150,
          minutes: walkEndMin,
          departureTime: bus2?.arrivalTime ?? null,
          arrivalTime: new Date(finalArriveMs).toISOString(),
        }
      );

      options.push({
        id: `xfer-r2b-${brc.corridor.agencyId}-${brc.corridor.routeId}-${brc.busAgencyId}-${brc.busRouteId}`,
        kind: "transfer",
        agencyId: brc.corridor.agencyId,
        agencies: isCrossAgency ? [brc.corridor.agencyId, brc.busAgencyId] : [brc.corridor.agencyId],
        isCrossAgency,
        serviceStatus: bus2?.isLive ? "live" : rail1 || bus2 ? "scheduled" : "no_upcoming",
        leaveAt: departAtIso,
        arriveAt: new Date(finalArriveMs).toISOString(),
        nextDepartureAt: rail1?.departureTime ?? null,
        totalMinutes,
        walkMinutes,
        waitMinutes: wait1 + wait2,
        rideMinutes: railLeg.rideMinutes + leg2Min,
        legs,
      });
    }
  }

  // 3. Include TTC Subway & GO Rail direct corridor options so trains always show in the planner
  const railCandidates = findRailPlanCandidates({
    fromLat,
    fromLon,
    toLat,
    toLon,
    departAtMs,
    agencyFilter,
  });

  for (const rc of railCandidates) {
    const { corridor, originStation, destStation } = rc;
    const walkStartMin = Math.max(1, Math.round(originStation.distMeters / 78));
    const walkEndMin = Math.max(1, Math.round(destStation.distMeters / 78));
    const walkMinutes = walkStartMin + walkEndMin;
    const readyMs = departAtMs + walkStartMin * 60_000;
    const liveVehiclesForRail = (agencyInfo.get(corridor.agencyId)?.vehicles ?? []).filter(
      (v) =>
        v.freshness !== "stale" &&
        (v.routeId === corridor.routeId || v.routeShortName?.toUpperCase() === corridor.shortName.toUpperCase())
    );
    const activeTrains =
      liveVehiclesForRail.length > 0
        ? liveVehiclesForRail.length
        : generateScheduledRailVehicles(corridor.agencyId, nowMs).filter((v) => v.routeId === corridor.routeId).length;

    const upcomingBuses: PlannedUpcomingBus[] = rc.upcomingDepartures.map((u) => ({
      departureTime: u.departureTime,
      arrivalTime: u.arrivalTime,
      etaMinutes: u.etaMinutes,
      waitMinutes: u.waitMinutes,
      rideMinutes: u.rideMinutes,
      isLive: false,
      source: "scheduled",
      vehicleId: null,
      fleetNumber: null,
      tripId: null,
      headsign: u.headsign,
      stopsAway: null,
      delaySec: null,
    }));

    const firstDep = upcomingBuses[0] ?? null;
    const waitMinutes = firstDep ? firstDep.waitMinutes : 0;
    const arriveMs = firstDep
      ? Date.parse(firstDep.arrivalTime) + walkEndMin * 60_000
      : departAtMs + (walkMinutes + rc.rideMinutes) * 60_000;
    const totalMinutes = Math.max(walkMinutes + rc.rideMinutes, Math.round((arriveMs - departAtMs) / 60_000));
    const rideDist = Math.round(haversineMeters(originStation.lat, originStation.lon, destStation.lat, destStation.lon) * 1.12);

    const dupIdx = options.findIndex(
      (o) =>
        o.kind === "direct" &&
        o.agencyId === corridor.agencyId &&
        o.legs.some((l) => l.mode === "transit" && (l.routeId === corridor.routeId || l.routeShortName === corridor.shortName))
    );
    if (dupIdx !== -1 && options[dupIdx]!.serviceStatus === "live") {
      continue;
    }

    const railOption: PlanOption = {
      id: `rail-${corridor.agencyId}-${corridor.routeId}`,
      kind: "direct",
      agencyId: corridor.agencyId,
      agencies: [corridor.agencyId],
      isCrossAgency: false,
      serviceStatus: firstDep ? "scheduled" : "no_upcoming",
      leaveAt: departAtIso,
      arriveAt: new Date(arriveMs).toISOString(),
      nextDepartureAt: firstDep?.departureTime ?? null,
      totalMinutes,
      walkMinutes,
      waitMinutes,
      rideMinutes: rc.rideMinutes,
      legs: [
        {
          mode: "walk",
          fromName: "Origin",
          fromLat,
          fromLon,
          toName: originStation.name,
          toStopId: originStation.stopId,
          toLat: originStation.lat,
          toLon: originStation.lon,
          distanceMeters: originStation.distMeters,
          minutes: walkStartMin,
          departureTime: departAtIso,
          arrivalTime: new Date(readyMs).toISOString(),
        },
        {
          mode: "transit",
          agencyId: corridor.agencyId,
          routeId: corridor.routeId,
          routeShortName: corridor.shortName,
          routeLongName: corridor.longName,
          routeColor: corridor.color,
          vehicleMode: corridor.mode,
          fromName: originStation.name,
          fromStopId: originStation.stopId,
          fromLat: originStation.lat,
          fromLon: originStation.lon,
          toName: destStation.name,
          toStopId: destStation.stopId,
          toLat: destStation.lat,
          toLon: destStation.lon,
          distanceMeters: rideDist,
          minutes: rc.rideMinutes,
          waitMinutes,
          departureTime: firstDep?.departureTime ?? null,
          arrivalTime: firstDep?.arrivalTime ?? null,
          stopsCount: rc.stopsCount,
          activeVehicles: activeTrains,
          nearestVehicleId: liveVehiclesForRail[0]?.vehicleId ?? null,
          nearestFleetNumber: liveVehiclesForRail[0]?.fleetNumber ?? null,
          nearestHeadsign: rc.headsign,
          upcomingBuses,
        },
        {
          mode: "walk",
          fromName: destStation.name,
          fromStopId: destStation.stopId,
          fromLat: destStation.lat,
          fromLon: destStation.lon,
          toName: "Destination",
          toLat,
          toLon,
          distanceMeters: destStation.distMeters,
          minutes: walkEndMin,
          departureTime: firstDep?.arrivalTime ?? null,
          arrivalTime: new Date(arriveMs).toISOString(),
        },
      ],
    };

    if (dupIdx !== -1) {
      options[dupIdx] = railOption;
    } else {
      options.push(railOption);
    }
  }

  // 3b. Include 1-transfer Rail <-> Rail options (cross-agency GO <-> TTC Subway & TTC Line 1 <-> Line 2)
  const railTransfers = findRailToRailTransfers({
    fromLat,
    fromLon,
    toLat,
    toLon,
    departAtMs,
    agencyFilter,
  });

  for (const rt of railTransfers) {
    const { leg1, leg2, transferWalkMeters, transferWalkMinutes } = rt;
    const walkStartMin = Math.max(1, Math.round(leg1.originDistMeters / 78));
    const walkEndMin = Math.max(1, Math.round(leg2.destDistMeters / 78));
    const walkXferMin = transferWalkMeters >= 40 ? Math.max(1, Math.ceil(transferWalkMeters / 78)) : 0;
    const walkMinutes = walkStartMin + walkXferMin + walkEndMin;

    const up1: PlannedUpcomingBus[] = leg1.upcomingDepartures.map((u) => ({
      ...u,
      isLive: false,
      source: "scheduled",
      vehicleId: null,
      fleetNumber: null,
      tripId: null,
      stopsAway: null,
      delaySec: null,
    }));
    const up2: PlannedUpcomingBus[] = leg2.upcomingDepartures.map((u) => ({
      ...u,
      isLive: false,
      source: "scheduled",
      vehicleId: null,
      fleetNumber: null,
      tripId: null,
      stopsAway: null,
      delaySec: null,
    }));
    const dep1 = up1[0] ?? null;
    const dep2 = up2[0] ?? null;
    const ready1Ms = departAtMs + walkStartMin * 60_000;
    const arr1Ms = dep1 ? Date.parse(dep1.arrivalTime) : ready1Ms + leg1.rideMinutes * 60_000;
    const wait1 = dep1 ? dep1.waitMinutes : 0;
    const wait2 = dep2 ? Math.max(0, Math.round((Date.parse(dep2.departureTime) - arr1Ms - walkXferMin * 60_000) / 60_000)) : transferWalkMinutes;
    const finalArriveMs = dep2
      ? Date.parse(dep2.arrivalTime) + walkEndMin * 60_000
      : arr1Ms + (transferWalkMinutes + leg2.rideMinutes + walkEndMin) * 60_000;
    const totalMinutes = Math.max(walkMinutes + leg1.rideMinutes + leg2.rideMinutes, Math.round((finalArriveMs - departAtMs) / 60_000));
    const isCrossAgency = leg1.corridor.agencyId !== leg2.corridor.agencyId;

    const active1 = generateScheduledRailVehicles(leg1.corridor.agencyId, nowMs).filter(
      (v) => v.routeId === leg1.corridor.routeId
    ).length;
    const active2 = generateScheduledRailVehicles(leg2.corridor.agencyId, nowMs).filter(
      (v) => v.routeId === leg2.corridor.routeId
    ).length;

    const legs: PlanLeg[] = [
      {
        mode: "walk",
        fromName: "Origin",
        fromLat,
        fromLon,
        toName: leg1.originStation.name,
        toStopId: leg1.originStation.stopId,
        toLat: leg1.originStation.lat,
        toLon: leg1.originStation.lon,
        distanceMeters: leg1.originDistMeters,
        minutes: walkStartMin,
        departureTime: departAtIso,
        arrivalTime: new Date(ready1Ms).toISOString(),
      },
      {
        mode: "transit",
        agencyId: leg1.corridor.agencyId,
        routeId: leg1.corridor.routeId,
        routeShortName: leg1.corridor.shortName,
        routeLongName: leg1.corridor.longName,
        routeColor: leg1.corridor.color,
        vehicleMode: leg1.corridor.mode,
        fromName: leg1.originStation.name,
        fromStopId: leg1.originStation.stopId,
        fromLat: leg1.originStation.lat,
        fromLon: leg1.originStation.lon,
        toName: leg1.destStation.name,
        toStopId: leg1.destStation.stopId,
        toLat: leg1.destStation.lat,
        toLon: leg1.destStation.lon,
        distanceMeters: Math.round(haversineMeters(leg1.originStation.lat, leg1.originStation.lon, leg1.destStation.lat, leg1.destStation.lon) * 1.12),
        minutes: leg1.rideMinutes,
        waitMinutes: wait1,
        departureTime: dep1?.departureTime ?? null,
        arrivalTime: dep1?.arrivalTime ?? null,
        stopsCount: leg1.stopsCount,
        activeVehicles: active1,
        nearestVehicleId: null,
        nearestFleetNumber: null,
        nearestHeadsign: leg1.headsign,
        upcomingBuses: up1,
      },
    ];
    if (transferWalkMeters >= 40) {
      legs.push({
        mode: "walk",
        fromName: leg1.destStation.name,
        fromStopId: leg1.destStation.stopId,
        fromLat: leg1.destStation.lat,
        fromLon: leg1.destStation.lon,
        toName: leg2.originStation.name,
        toStopId: leg2.originStation.stopId,
        toLat: leg2.originStation.lat,
        toLon: leg2.originStation.lon,
        distanceMeters: transferWalkMeters,
        minutes: walkXferMin,
        departureTime: dep1?.arrivalTime ?? null,
        arrivalTime: new Date(arr1Ms + walkXferMin * 60_000).toISOString(),
      });
    }
    legs.push(
      {
        mode: "transit",
        agencyId: leg2.corridor.agencyId,
        routeId: leg2.corridor.routeId,
        routeShortName: leg2.corridor.shortName,
        routeLongName: leg2.corridor.longName,
        routeColor: leg2.corridor.color,
        vehicleMode: leg2.corridor.mode,
        fromName: leg2.originStation.name,
        fromStopId: leg2.originStation.stopId,
        fromLat: leg2.originStation.lat,
        fromLon: leg2.originStation.lon,
        toName: leg2.destStation.name,
        toStopId: leg2.destStation.stopId,
        toLat: leg2.destStation.lat,
        toLon: leg2.destStation.lon,
        distanceMeters: Math.round(haversineMeters(leg2.originStation.lat, leg2.originStation.lon, leg2.destStation.lat, leg2.destStation.lon) * 1.12),
        minutes: leg2.rideMinutes,
        waitMinutes: wait2,
        departureTime: dep2?.departureTime ?? null,
        arrivalTime: dep2?.arrivalTime ?? null,
        stopsCount: leg2.stopsCount,
        activeVehicles: active2,
        nearestVehicleId: null,
        nearestFleetNumber: null,
        nearestHeadsign: leg2.headsign,
        upcomingBuses: up2,
      },
      {
        mode: "walk",
        fromName: leg2.destStation.name,
        fromStopId: leg2.destStation.stopId,
        fromLat: leg2.destStation.lat,
        fromLon: leg2.destStation.lon,
        toName: "Destination",
        toLat,
        toLon,
        distanceMeters: leg2.destDistMeters,
        minutes: walkEndMin,
        departureTime: dep2?.arrivalTime ?? null,
        arrivalTime: new Date(finalArriveMs).toISOString(),
      }
    );

    options.push({
      id: `rail-xfer-${leg1.corridor.agencyId}-${leg1.corridor.routeId}-${leg2.corridor.agencyId}-${leg2.corridor.routeId}`,
      kind: "transfer",
      agencyId: leg1.corridor.agencyId,
      agencies: isCrossAgency ? [leg1.corridor.agencyId, leg2.corridor.agencyId] : [leg1.corridor.agencyId],
      isCrossAgency,
      serviceStatus: dep1 || dep2 ? "scheduled" : "no_upcoming",
      leaveAt: departAtIso,
      arriveAt: new Date(finalArriveMs).toISOString(),
      nextDepartureAt: dep1?.departureTime ?? null,
      totalMinutes,
      walkMinutes,
      waitMinutes: wait1 + wait2,
      rideMinutes: leg1.rideMinutes + leg2.rideMinutes,
      legs,
    });
  }

  // 3c. 2-Transfer Regional Routing: Local Bus -> GO Rail / TTC Subway -> Local Bus
  // Enables full door-to-door inter-city trips (e.g. U of Waterloo GRT -> Kitchener GO -> Union -> TTC Bus)
  if (!agencyFilter && directDist >= 6000 && originStops.length > 0 && destStops.length > 0) {
    const regionalCorridors: Array<{
      corridor: (typeof RAIL_CORRIDORS)[number];
      boardIdx: number;
      boardSt: (typeof RAIL_CORRIDORS)[number]["stations"][number];
      exitIdx: number;
      exitSt: (typeof RAIL_CORRIDORS)[number]["stations"][number];
    }> = [];

    for (const cor of RAIL_CORRIDORS) {
      let bestB: { idx: number; dist: number } | null = null;
      let bestE: { idx: number; dist: number } | null = null;
      for (let i = 0; i < cor.stations.length; i++) {
        const st = cor.stations[i]!;
        const dO = Math.round(haversineMeters(fromLat, fromLon, st.lat, st.lon));
        if (dO > 400 && dO <= 18_000 && (!bestB || dO < bestB.dist)) bestB = { idx: i, dist: dO };
        const dD = Math.round(haversineMeters(toLat, toLon, st.lat, st.lon));
        if (dD > 400 && dD <= 18_000 && (!bestE || dD < bestE.dist)) bestE = { idx: i, dist: dD };
      }
      if (bestB && bestE && bestB.idx !== bestE.idx) {
        regionalCorridors.push({
          corridor: cor,
          boardIdx: bestB.idx,
          boardSt: cor.stations[bestB.idx]!,
          exitIdx: bestE.idx,
          exitSt: cor.stations[bestE.idx]!,
        });
      }
    }

    const queryStopsNearStation = async (st: { lat: number; lon: number }) => {
      const sLat = 500 / 111_000;
      const sLon = 500 / (111_000 * Math.max(0.2, Math.cos((st.lat * Math.PI) / 180)));
      const rows = await c.env.DB.prepare(
        `SELECT s.agency_id, s.stop_id, s.name, s.lat, s.lon, s.routes_json
         FROM stops s JOIN feed_versions fv ON fv.id = s.version_id AND fv.status = 'active'
         WHERE s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ? LIMIT 45`
      )
        .bind(st.lat - sLat, st.lat + sLat, st.lon - sLon, st.lon + sLon)
        .all<{ agency_id: string; stop_id: string; name: string; lat: number; lon: number; routes_json: string }>();
      return rows.results
        .map((r) => ({
          agencyId: r.agency_id,
          stopId: r.stop_id,
          name: r.name,
          lat: r.lat,
          lon: r.lon,
          routes: JSON.parse(r.routes_json || "[]") as string[],
          dist: Math.round(haversineMeters(st.lat, st.lon, r.lat, r.lon)),
        }))
        .filter((r) => r.dist <= 500)
        .sort((a, b) => a.dist - b.dist);
    };

    let twoTransferAdded = 0;
    for (const rc of regionalCorridors.slice(0, 3)) {
      if (twoTransferAdded >= 2) break;
      const [nearBoard, nearExit] = await Promise.all([
        queryStopsNearStation(rc.boardSt),
        queryStopsNearStation(rc.exitSt),
      ]);

      let match1: { oStop: (typeof originStops)[number]; hubStop: (typeof nearBoard)[number]; routeId: string } | null = null;
      for (const ns of nearBoard) {
        for (const rId of ns.routes) {
          const os = originByRoute.get(`${ns.agencyId}:${rId}`);
          if (os && os.stopId !== ns.stopId) {
            match1 = { oStop: os, hubStop: ns, routeId: rId };
            break;
          }
        }
        if (match1) break;
      }

      let match2: { hubStop: (typeof nearExit)[number]; dStop: (typeof destStops)[number]; routeId: string } | null = null;
      for (const ns of nearExit) {
        for (const rId of ns.routes) {
          const ds = destByRoute.get(`${ns.agencyId}:${rId}`);
          if (ds && ds.stopId !== ns.stopId) {
            match2 = { hubStop: ns, dStop: ds, routeId: rId };
            break;
          }
        }
        if (match2) break;
      }

      if (!match1 || !match2) continue;

      const info1 = agencyInfo.get(match1.oStop.agencyId);
      const info2 = agencyInfo.get(match2.dStop.agencyId);
      if (!info1 || !info2) continue;

      const rm1 = info1.lookups.routes.get(match1.routeId);
      const rm2 = info2.lookups.routes.get(match2.routeId);
      const walkStartMin = Math.max(1, Math.round(match1.oStop.distMeters / 78));
      const walkXfer1Min = match1.hubStop.dist >= 40 ? Math.max(1, Math.ceil(match1.hubStop.dist / 78)) : 0;
      const walkXfer2Min = match2.hubStop.dist >= 40 ? Math.max(1, Math.ceil(match2.hubStop.dist / 78)) : 0;
      const walkEndMin = Math.max(1, Math.round(match2.dStop.distMeters / 78));

      const ready1Ms = departAtMs + walkStartMin * 60_000;
      const leg1Calc = computeUpcomingBusesForLeg({
        nowMs,
        departAtMs,
        readyToBoardMs: ready1Ms,
        departServiceSeconds: info1.departServiceSeconds,
        fromStop: { stopId: match1.oStop.stopId, lat: match1.oStop.lat, lon: match1.oStop.lon },
        toStop: { stopId: match1.hubStop.stopId, lat: match1.hubStop.lat, lon: match1.hubStop.lon },
        routeId: match1.routeId,
        defaultSpeedMps: 6.4,
        patterns: info1.patterns,
        liveVehicles: info1.vehicles,
        tripUpdates: info1.tripUpdates,
        scheduledDepartures:
          scheduledByPairKey.get(`${match1.oStop.agencyId}|${match1.routeId}|${match1.oStop.stopId}|${match1.hubStop.stopId}`) ?? [],
        maxResults: 3,
      });
      if (!leg1Calc.directionValid) continue;

      const bus1 = leg1Calc.upcomingBuses[0] ?? null;
      const leg1Min = bus1?.rideMinutes ?? leg1Calc.baselineRideMinutes;
      const arr1Ms = bus1 ? Date.parse(bus1.arrivalTime) : ready1Ms + leg1Min * 60_000;
      const readyRailMs = arr1Ms + Math.max(3, walkXfer1Min + 2) * 60_000;

      const railLeg = computeRailLegSchedule({
        corridor: rc.corridor,
        originIdx: rc.boardIdx,
        destIdx: rc.exitIdx,
        departAtMs,
        readyToBoardMs: readyRailMs,
        maxResults: 3,
      });
      if (!railLeg) continue;

      const railUpcoming: PlannedUpcomingBus[] = railLeg.upcomingDepartures.map((u) => ({
        ...u,
        isLive: false,
        source: "scheduled",
        vehicleId: null,
        fleetNumber: null,
        tripId: null,
        stopsAway: null,
        delaySec: null,
      }));
      const rail1 = railUpcoming[0] ?? null;
      const railArrMs = rail1 ? Date.parse(rail1.arrivalTime) : readyRailMs + railLeg.rideMinutes * 60_000;
      const readyBus2Ms = railArrMs + Math.max(3, walkXfer2Min + 2) * 60_000;

      const leg2Calc = computeUpcomingBusesForLeg({
        nowMs,
        departAtMs,
        readyToBoardMs: readyBus2Ms,
        departServiceSeconds: info2.departServiceSeconds,
        fromStop: { stopId: match2.hubStop.stopId, lat: match2.hubStop.lat, lon: match2.hubStop.lon },
        toStop: { stopId: match2.dStop.stopId, lat: match2.dStop.lat, lon: match2.dStop.lon },
        routeId: match2.routeId,
        defaultSpeedMps: 6.4,
        patterns: info2.patterns,
        liveVehicles: info2.vehicles,
        tripUpdates: info2.tripUpdates,
        scheduledDepartures:
          scheduledByPairKey.get(`${match2.dStop.agencyId}|${match2.routeId}|${match2.hubStop.stopId}|${match2.dStop.stopId}`) ?? [],
        maxResults: 3,
      });
      if (!leg2Calc.directionValid) continue;

      const bus2 = leg2Calc.upcomingBuses[0] ?? null;
      const leg2Min = bus2?.rideMinutes ?? leg2Calc.baselineRideMinutes;
      const finalArriveMs = bus2
        ? Date.parse(bus2.arrivalTime) + walkEndMin * 60_000
        : readyBus2Ms + (leg2Min + walkEndMin) * 60_000;

      const walkMinutes = walkStartMin + walkXfer1Min + walkXfer2Min + walkEndMin;
      const wait1 = bus1 ? bus1.waitMinutes : 0;
      const waitRail = rail1 ? Math.max(0, Math.round((Date.parse(rail1.departureTime) - arr1Ms - walkXfer1Min * 60_000) / 60_000)) : 4;
      const wait2 = bus2 ? Math.max(0, Math.round((Date.parse(bus2.departureTime) - railArrMs - walkXfer2Min * 60_000) / 60_000)) : 4;
      const rideMinutes = leg1Min + railLeg.rideMinutes + leg2Min;
      const totalMinutes = Math.max(walkMinutes + rideMinutes, Math.round((finalArriveMs - departAtMs) / 60_000));
      const agenciesOrdered = Array.from(new Set([match1.oStop.agencyId, rc.corridor.agencyId, match2.dStop.agencyId]));

      const legs: PlanLeg[] = [
        {
          mode: "walk",
          fromName: "Origin",
          fromLat,
          fromLon,
          toName: match1.oStop.name,
          toStopId: match1.oStop.stopId,
          toLat: match1.oStop.lat,
          toLon: match1.oStop.lon,
          distanceMeters: match1.oStop.distMeters,
          minutes: walkStartMin,
          departureTime: departAtIso,
          arrivalTime: new Date(ready1Ms).toISOString(),
        },
        {
          mode: "transit",
          agencyId: match1.oStop.agencyId,
          routeId: match1.routeId,
          routeShortName: rm1?.shortName ?? match1.routeId,
          routeLongName: rm1?.longName ?? null,
          routeColor: rm1?.color ?? null,
          vehicleMode: inferVehicleMode(match1.oStop.agencyId, match1.routeId, rm1?.shortName, rm1?.routeType),
          fromName: match1.oStop.name,
          fromStopId: match1.oStop.stopId,
          fromLat: match1.oStop.lat,
          fromLon: match1.oStop.lon,
          toName: match1.hubStop.name,
          toStopId: match1.hubStop.stopId,
          toLat: match1.hubStop.lat,
          toLon: match1.hubStop.lon,
          distanceMeters: Math.round(haversineMeters(match1.oStop.lat, match1.oStop.lon, match1.hubStop.lat, match1.hubStop.lon) * 1.25),
          minutes: leg1Min,
          waitMinutes: wait1,
          departureTime: bus1?.departureTime ?? null,
          arrivalTime: bus1?.arrivalTime ?? null,
          stopsCount: leg1Calc.stopsCount,
          activeVehicles: info1.vehicles.filter((v) => v.routeId === match1!.routeId && v.freshness !== "stale").length,
          nearestVehicleId: bus1?.vehicleId ?? null,
          nearestFleetNumber: bus1?.fleetNumber ?? null,
          nearestHeadsign: bus1?.headsign ?? leg1Calc.defaultHeadsign ?? null,
          upcomingBuses: leg1Calc.upcomingBuses,
        },
      ];
      if (match1.hubStop.dist >= 40) {
        legs.push({
          mode: "walk",
          fromName: match1.hubStop.name,
          fromStopId: match1.hubStop.stopId,
          fromLat: match1.hubStop.lat,
          fromLon: match1.hubStop.lon,
          toName: railLeg.originStation.name,
          toStopId: railLeg.originStation.stopId,
          toLat: railLeg.originStation.lat,
          toLon: railLeg.originStation.lon,
          distanceMeters: match1.hubStop.dist,
          minutes: walkXfer1Min,
          departureTime: bus1?.arrivalTime ?? null,
          arrivalTime: new Date(arr1Ms + walkXfer1Min * 60_000).toISOString(),
        });
      }
      legs.push({
        mode: "transit",
        agencyId: rc.corridor.agencyId,
        routeId: rc.corridor.routeId,
        routeShortName: rc.corridor.shortName,
        routeLongName: rc.corridor.longName,
        routeColor: rc.corridor.color,
        vehicleMode: rc.corridor.mode,
        fromName: railLeg.originStation.name,
        fromStopId: railLeg.originStation.stopId,
        fromLat: railLeg.originStation.lat,
        fromLon: railLeg.originStation.lon,
        toName: railLeg.destStation.name,
        toStopId: railLeg.destStation.stopId,
        toLat: railLeg.destStation.lat,
        toLon: railLeg.destStation.lon,
        distanceMeters: Math.round(haversineMeters(railLeg.originStation.lat, railLeg.originStation.lon, railLeg.destStation.lat, railLeg.destStation.lon) * 1.12),
        minutes: railLeg.rideMinutes,
        waitMinutes: waitRail,
        departureTime: rail1?.departureTime ?? null,
        arrivalTime: rail1?.arrivalTime ?? null,
        stopsCount: railLeg.stopsCount,
        activeVehicles: generateScheduledRailVehicles(rc.corridor.agencyId, nowMs).filter((v) => v.routeId === rc.corridor.routeId).length,
        nearestVehicleId: null,
        nearestFleetNumber: null,
        nearestHeadsign: railLeg.headsign,
        upcomingBuses: railUpcoming,
      });
      if (match2.hubStop.dist >= 40) {
        legs.push({
          mode: "walk",
          fromName: railLeg.destStation.name,
          fromStopId: railLeg.destStation.stopId,
          fromLat: railLeg.destStation.lat,
          fromLon: railLeg.destStation.lon,
          toName: match2.hubStop.name,
          toStopId: match2.hubStop.stopId,
          toLat: match2.hubStop.lat,
          toLon: match2.hubStop.lon,
          distanceMeters: match2.hubStop.dist,
          minutes: walkXfer2Min,
          departureTime: rail1?.arrivalTime ?? null,
          arrivalTime: new Date(railArrMs + walkXfer2Min * 60_000).toISOString(),
        });
      }
      legs.push(
        {
          mode: "transit",
          agencyId: match2.dStop.agencyId,
          routeId: match2.routeId,
          routeShortName: rm2?.shortName ?? match2.routeId,
          routeLongName: rm2?.longName ?? null,
          routeColor: rm2?.color ?? null,
          vehicleMode: inferVehicleMode(match2.dStop.agencyId, match2.routeId, rm2?.shortName, rm2?.routeType),
          fromName: match2.hubStop.name,
          fromStopId: match2.hubStop.stopId,
          fromLat: match2.hubStop.lat,
          fromLon: match2.hubStop.lon,
          toName: match2.dStop.name,
          toStopId: match2.dStop.stopId,
          toLat: match2.dStop.lat,
          toLon: match2.dStop.lon,
          distanceMeters: Math.round(haversineMeters(match2.hubStop.lat, match2.hubStop.lon, match2.dStop.lat, match2.dStop.lon) * 1.25),
          minutes: leg2Min,
          waitMinutes: wait2,
          departureTime: bus2?.departureTime ?? null,
          arrivalTime: bus2?.arrivalTime ?? null,
          stopsCount: leg2Calc.stopsCount,
          activeVehicles: info2.vehicles.filter((v) => v.routeId === match2!.routeId && v.freshness !== "stale").length,
          nearestVehicleId: bus2?.vehicleId ?? null,
          nearestFleetNumber: bus2?.fleetNumber ?? null,
          nearestHeadsign: bus2?.headsign ?? leg2Calc.defaultHeadsign ?? null,
          upcomingBuses: leg2Calc.upcomingBuses,
        },
        {
          mode: "walk",
          fromName: match2.dStop.name,
          fromStopId: match2.dStop.stopId,
          fromLat: match2.dStop.lat,
          fromLon: match2.dStop.lon,
          toName: "Destination",
          toLat,
          toLon,
          distanceMeters: match2.dStop.distMeters,
          minutes: walkEndMin,
          departureTime: bus2?.arrivalTime ?? null,
          arrivalTime: new Date(finalArriveMs).toISOString(),
        }
      );

      options.push({
        id: `regional-2x-${match1.oStop.agencyId}-${match1.routeId}-${rc.corridor.routeId}-${match2.dStop.agencyId}-${match2.routeId}`,
        kind: "transfer",
        transfersCount: 2,
        agencyId: match1.oStop.agencyId,
        agencies: agenciesOrdered,
        isCrossAgency: agenciesOrdered.length > 1,
        serviceStatus: bus1?.isLive || bus2?.isLive ? "live" : rail1 ? "scheduled" : "no_upcoming",
        leaveAt: departAtIso,
        arriveAt: new Date(finalArriveMs).toISOString(),
        nextDepartureAt: bus1?.departureTime ?? null,
        totalMinutes,
        walkMinutes,
        waitMinutes: wait1 + waitRail + wait2,
        rideMinutes,
        legs,
      });
      twoTransferAdded++;
    }
  }

  // 4. Attach Ontario One Fare estimates, Live Transfer Risk Guard, and active Route Service Alerts
  const alertAgencies = Array.from(
    new Set(options.flatMap((o) => o.legs.filter((l) => l.mode === "transit" && l.agencyId).map((l) => l.agencyId!)))
  );
  const alertsByAgency = new Map<
    string,
    Array<{ id: string; effect: string | null; headerText: string; descriptionText: string; routeIds: Set<string> }>
  >();
  if (alertAgencies.length > 0) {
    const aPlaceholders = alertAgencies.map(() => "?").join(",");
    const alertRows = await c.env.DB.prepare(
      `SELECT agency_id, id, effect, header_text, description_text, informed_entities_json
       FROM service_alerts WHERE agency_id IN (${aPlaceholders}) AND active = 1 LIMIT 80`
    )
      .bind(...alertAgencies)
      .all<{
        agency_id: string;
        id: string;
        effect: string | null;
        header_text: string;
        description_text: string;
        informed_entities_json: string | null;
      }>()
      .catch(() => ({ results: [] }));

    for (const row of alertRows.results) {
      const routeIds = new Set<string>();
      try {
        const ents = JSON.parse(row.informed_entities_json || "[]") as Array<{ routeId?: string }>;
        for (const e of ents) {
          if (e.routeId) routeIds.add(e.routeId);
        }
      } catch {
        // ignore
      }
      if (routeIds.size === 0) continue;
      let list = alertsByAgency.get(row.agency_id);
      if (!list) {
        list = [];
        alertsByAgency.set(row.agency_id, list);
      }
      list.push({
        id: row.id,
        effect: row.effect,
        headerText: row.header_text,
        descriptionText: row.description_text,
        routeIds,
      });
    }
  }

  for (const opt of options) {
    const transitLegIndices: number[] = [];
    for (let i = 0; i < opt.legs.length; i++) {
      const leg = opt.legs[i]!;
      if (leg.mode === "transit" && leg.agencyId) {
        transitLegIndices.push(i);
        const agAlerts = alertsByAgency.get(leg.agencyId) ?? [];
        const matched = agAlerts
          .filter((a) => (leg.routeId && a.routeIds.has(leg.routeId)) || (leg.routeShortName && a.routeIds.has(leg.routeShortName)))
          .slice(0, 2)
          .map((a) => ({ id: a.id, effect: a.effect, headerText: a.headerText, descriptionText: a.descriptionText }));
        if (matched.length > 0) leg.alerts = matched;
      }
    }

    opt.transfersCount = Math.max(0, transitLegIndices.length - 1);
    opt.fareEstimate = estimateOntarioTripFare(
      transitLegIndices.map((idx) => {
        const l = opt.legs[idx]!;
        return {
          agencyId: l.agencyId!,
          routeShortName: l.routeShortName,
          distanceMeters: l.distanceMeters,
        };
      })
    );

    const risks: TransferRiskAssessment[] = [];
    for (let t = 0; t < transitLegIndices.length - 1; t++) {
      const idx1 = transitLegIndices[t]!;
      const idx2 = transitLegIndices[t + 1]!;
      const leg1 = opt.legs[idx1]!;
      const leg2 = opt.legs[idx2]!;
      const betweenWalk = opt.legs
        .slice(idx1 + 1, idx2)
        .filter((l) => l.mode === "walk")
        .reduce((s, l) => s + l.minutes, 0);
      risks.push(
        evaluateTransferRisk({
          fromLegIndex: t,
          toLegIndex: t + 1,
          leg1ArrivalTime: leg1.arrivalTime,
          leg1DelaySec: leg1.upcomingBuses?.[0]?.delaySec ?? 0,
          walkMinutes: betweenWalk,
          leg2DepartureTime: leg2.departureTime,
          leg2UpcomingDepartures: leg2.upcomingBuses,
        })
      );
    }
    if (risks.length > 0) opt.transferRisks = risks;
  }

  // Sort: live/scheduled upcoming routes first, then by arrival time (with slight preference for fewer transfers)
  const statusRank = (s: PlanOption["serviceStatus"]) => (s === "live" ? 0 : s === "scheduled" ? 1 : 2);
  options.sort((a, b) => {
    const sDiff = statusRank(a.serviceStatus) - statusRank(b.serviceStatus);
    if (sDiff !== 0) return sDiff;
    const effA = a.totalMinutes + (a.transfersCount ?? 0) * 5;
    const effB = b.totalMinutes + (b.transfersCount ?? 0) * 5;
    if (effA !== effB) return effA - effB;
    return (a.transfersCount ?? 0) - (b.transfersCount ?? 0);
  });

  const primaryTz = involvedAgencies[0] ? agencyInfo.get(involvedAgencies[0])?.timezone ?? "America/Toronto" : "America/Toronto";

  return c.json({
    from: { lat: fromLat, lon: fromLon },
    to: { lat: toLat, lon: toLon },
    departAt: departAtIso,
    serverTime: new Date(nowMs).toISOString(),
    timezone: primaryTz,
    directDistanceMeters: Math.round(directDist),
    options: options.slice(0, 8),
    originStopsChecked: originStops.length,
    destStopsChecked: destStops.length,
  });
});

// ---------------------------------------------------------------------------
// Ontario Place & Stop Geocoder (D1 GTFS Stops + OpenStreetMap Nominatim)
// ---------------------------------------------------------------------------
app.get("/api/v1/geocode", async (c) => {
  const q = c.req.query("q")?.trim() || "";
  if (q.length < 2) return c.json({ results: [] });

  const like = `%${q}%`;
  const stopMatches = await c.env.DB.prepare(
    `SELECT s.agency_id, s.stop_id, s.stop_code, s.name, s.lat, s.lon
     FROM stops s JOIN feed_versions fv ON fv.id = s.version_id AND fv.status = 'active'
     WHERE s.name LIKE ? OR s.stop_code LIKE ?
     LIMIT 6`
  )
    .bind(like, like)
    .all<{ agency_id: string; stop_id: string; stop_code: string | null; name: string; lat: number; lon: number }>();

  const results: Array<{
    id: string;
    label: string;
    subtitle: string;
    lat: number;
    lon: number;
    kind: "stop" | "place";
  }> = stopMatches.results.map((s) => ({
    id: `stop:${s.agency_id}:${s.stop_id}`,
    label: s.name,
    subtitle: `${s.agency_id.toUpperCase()} Stop${s.stop_code ? ` #${s.stop_code}` : ""}`,
    lat: s.lat,
    lon: s.lon,
    kind: "stop",
  }));

  // Complement with OpenStreetMap Nominatim scoped to Ontario (Southern + Northwestern)
  try {
    const nomUrl = new URL("https://nominatim.openstreetmap.org/search");
    nomUrl.searchParams.set("q", `${q}, Ontario, Canada`);
    nomUrl.searchParams.set("format", "jsonv2");
    nomUrl.searchParams.set("limit", "5");
    nomUrl.searchParams.set("viewbox", "-95.2,50.5,-74.3,41.7");
    nomUrl.searchParams.set("bounded", "1");

    const resp = await fetch(nomUrl.toString(), {
      headers: { "User-Agent": "Swisshost/1.0 (+https://swisshost.cc; public transit finder)" },
    });
    if (resp.ok) {
      const places = (await resp.json()) as Array<{
        place_id: number;
        display_name: string;
        lat: string;
        lon: string;
        type: string;
      }>;
      for (const p of places) {
        const parts = p.display_name.split(",").map((x) => x.trim());
        results.push({
          id: `place:${p.place_id}`,
          label: parts.slice(0, 2).join(", "),
          subtitle: parts.slice(2, 4).join(", ") || "Ontario",
          lat: Number(p.lat),
          lon: Number(p.lon),
          kind: "place",
        });
      }
    }
  } catch {
    // Graceful fallback to GTFS stops only
  }

  c.header("Cache-Control", "public, max-age=300");
  return c.json({ results: results.slice(0, 10) });
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
    const rows = parseObservationChunkRows(ch.data_json);
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
        routeId: r.r ?? null,
        tripId: r.t ?? null,
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
    const rows = parseObservationChunkRows(ch.data_json);
    for (const r of rows) {
      if (routeId && r.r !== routeId) continue;
      if (vehicleId && r.v !== vehicleId && r.f !== vehicleId) continue;
      const ts = String(r.ts ?? r.rx);
      if (ts < fromIso || ts > toIso) continue;
      points.push({
        observedAt: ts,
        vehicleId: String(r.v),
        fleetNumber: String(r.f ?? r.v),
        routeId: r.r ?? null,
        tripId: r.t ?? null,
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

interface TripLookupBlob {
  h: string[];
  p: string[];
  m: Record<string, [number, number, number]>;
}

interface AgencyStaticLookups {
  routes: Map<string, { shortName: string; longName: string; color: string | null; routeType: number | null }>;
  stops: Record<string, string>;
  trips: TripLookupBlob | null;
}

const lookupCache = new Map<string, { expiresAt: number; data: AgencyStaticLookups }>();

async function getAgencyStaticLookups(env: Env, agencyId: string): Promise<AgencyStaticLookups> {
  const now = Date.now();
  const hit = lookupCache.get(agencyId);
  if (hit && hit.expiresAt > now) return hit.data;

  const [routesRaw, stopsRaw, tripsRaw] = await Promise.all([
    env.CACHE.get(`routes:${agencyId}`, "json").catch(() => null),
    env.CACHE.get(`stop_lookup:${agencyId}`, "json").catch(() => null),
    env.CACHE.get(`trip_lookup:${agencyId}`, "json").catch(() => null),
  ]);

  let routes = new Map<string, { shortName: string; longName: string; color: string | null; routeType: number | null }>();
  if (Array.isArray(routesRaw)) {
    routes = new Map(
      (
        routesRaw as Array<{
          route_id: string;
          short_name: string;
          long_name: string;
          color: string | null;
          route_type?: number | null;
        }>
      ).map((r) => [
        r.route_id,
        {
          shortName: r.short_name,
          longName: r.long_name,
          color: r.color,
          routeType: r.route_type !== undefined && r.route_type !== null ? Number(r.route_type) : null,
        },
      ])
    );
  } else {
    const versionId = await getActiveVersionId(env.DB, agencyId);
    if (versionId) {
      const rows = await env.DB.prepare(
        "SELECT route_id, short_name, long_name, color, route_type FROM routes WHERE agency_id = ? AND version_id = ?"
      )
        .bind(agencyId, versionId)
        .all<{ route_id: string; short_name: string; long_name: string; color: string | null; route_type: number | null }>();
      routes = new Map(
        rows.results.map((r) => [
          r.route_id,
          { shortName: r.short_name, longName: r.long_name, color: r.color, routeType: r.route_type ?? null },
        ])
      );
      await env.CACHE.put(`routes:${agencyId}`, JSON.stringify(rows.results), { expirationTtl: 600 }).catch(() => undefined);
    }
  }

  // Ensure built-in TTC Subway & GO Rail corridors are always present in route lookups
  for (const corridor of RAIL_CORRIDORS) {
    if (corridor.agencyId !== agencyId) continue;
    if (!routes.has(corridor.routeId)) {
      routes.set(corridor.routeId, {
        shortName: corridor.shortName,
        longName: corridor.longName,
        color: corridor.color,
        routeType: corridor.routeType,
      });
    }
  }

  const data: AgencyStaticLookups = {
    routes,
    stops: (stopsRaw && typeof stopsRaw === "object" ? (stopsRaw as Record<string, string>) : {}),
    trips: (tripsRaw && typeof tripsRaw === "object" ? (tripsRaw as TripLookupBlob) : null),
  };
  lookupCache.set(agencyId, { expiresAt: now + 300_000, data });
  return data;
}

function enrichVehicleWithLookups<
  T extends {
    agencyId?: string;
    routeId: string | null;
    tripId: string | null;
    stopId: string | null;
    directionId: number | null;
    routeShortName?: string | null;
    routeLongName?: string | null;
    routeColor?: string | null;
    routeType?: number | null;
    vehicleMode?: "bus" | "streetcar" | "subway" | "rail" | "ferry" | "unknown";
    positionSource?: "live" | "scheduled";
    headsign?: string | null;
    stopName?: string | null;
    patternTripId?: string | null;
  },
>(v: T, lookups: AgencyStaticLookups, agencyIdOverride?: string): T {
  const ag = agencyIdOverride ?? v.agencyId ?? "";
  const rm = v.routeId ? lookups.routes.get(v.routeId) : undefined;
  const railCorridor = getRailCorridor(ag, rm?.shortName ?? v.routeId);
  const tm = v.tripId && lookups.trips?.m ? lookups.trips.m[v.tripId] : undefined;
  const headsign = tm ? lookups.trips!.h[tm[0]] || null : v.headsign ?? null;
  const directionId = tm ? tm[1] : v.directionId;
  const patternTripId = tm ? lookups.trips!.p[tm[2]] || null : null;
  const stopName = v.stopId ? lookups.stops[v.stopId] || null : null;
  const routeShortName = rm?.shortName ?? railCorridor?.shortName ?? v.routeId;
  const routeLongName = rm?.longName ?? railCorridor?.longName ?? null;
  const routeColorVal = railCorridor?.color ?? rm?.color ?? null;
  const routeType = rm?.routeType ?? railCorridor?.routeType ?? v.routeType ?? null;
  const vehicleMode = inferVehicleMode(ag, v.routeId, routeShortName, routeType);

  return {
    ...v,
    directionId,
    routeShortName,
    routeLongName,
    routeColor: routeColorVal,
    routeType,
    vehicleMode,
    positionSource: v.positionSource ?? "live",
    headsign,
    patternTripId,
    stopName,
  };
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

  // Merge static routes with any live-observed route IDs + built-in TTC Subway & GO Rail lines
  const scheduledTrains = generateScheduledRailVehicles(agencyId, Date.now());
  const scheduledTrainCounts = new Map<string, number>();
  for (const t of scheduledTrains) {
    if (t.routeId) scheduledTrainCounts.set(t.routeId, (scheduledTrainCounts.get(t.routeId) ?? 0) + 1);
  }

  const routeMap = new Map<string, Record<string, unknown>>();
  // Put rail corridors at the top so subway/GO train lines are immediately easy to find
  for (const corridor of RAIL_CORRIDORS) {
    if (corridor.agencyId !== agencyId) continue;
    const liveCount = activeMap.get(corridor.routeId) ?? 0;
    routeMap.set(corridor.routeId, {
      routeId: corridor.routeId,
      shortName: corridor.shortName,
      longName: corridor.longName,
      description: null,
      routeType: corridor.routeType,
      color: corridor.color,
      textColor: corridor.textColor,
      directions: [
        { directionId: 0, headsign: corridor.headsignFwd },
        { directionId: 1, headsign: corridor.headsignRev },
      ],
      activeVehicles: liveCount > 0 ? liveCount : (scheduledTrainCounts.get(corridor.routeId) ?? 0),
      activeAlerts: alertMap.get(corridor.routeId) ?? 0,
      source: liveCount > 0 ? "live" : "scheduled",
    });
  }

  for (const r of staticRoutes.results) {
    const id = String(r.route_id);
    const shortName = String(r.short_name || id);
    const railMatch = getRailCorridor(agencyId, shortName);
    const liveCount = activeMap.get(id) ?? 0;
    const existingRail = railMatch ? routeMap.get(railMatch.routeId) : undefined;
    // Avoid duplicating a rail corridor already added under its canonical short code
    if (railMatch && id !== railMatch.routeId && existingRail) {
      if (liveCount > 0) {
        existingRail.activeVehicles = liveCount;
        existingRail.source = "live";
      }
      continue;
    }
    routeMap.set(id, {
      routeId: id,
      shortName,
      longName: r.long_name,
      description: r.description,
      routeType: railMatch?.routeType ?? r.route_type,
      color: railMatch?.color ?? r.color,
      textColor: railMatch?.textColor ?? r.text_color,
      directions: JSON.parse(String(r.directions_json || "[]")),
      activeVehicles: liveCount > 0 ? liveCount : (scheduledTrainCounts.get(id) ?? 0),
      activeAlerts: alertMap.get(id) ?? 0,
      source: "scheduled",
    });
  }
  for (const [id, count] of activeMap) {
    if (!routeMap.has(id)) {
      const railMatch = getRailCorridor(agencyId, id);
      if (railMatch && routeMap.has(railMatch.routeId)) continue;
      routeMap.set(id, {
        routeId: id,
        shortName: railMatch?.shortName ?? id,
        longName: railMatch?.longName ?? `Route ${id} (observed live)`,
        description: null,
        routeType: railMatch?.routeType ?? (inferVehicleMode(agencyId, id) === "streetcar" ? 0 : 3),
        color: railMatch?.color ?? null,
        textColor: railMatch?.textColor ?? null,
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

  const railCorridor = getRailCorridor(agencyId, routeId);
  if (stops.length === 0 && railCorridor) {
    stops = railCorridor.stations.map((s, idx) => ({
      stop_sequence: idx + 1,
      arrival_sec: null,
      departure_sec: null,
      stop_id: s.stopId,
      stop_code: null,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      wheelchair_boarding: 1,
    }));
  }

  const routeAlerts = alerts.results.filter((a) => {
    const ents = JSON.parse(String(a.informed_entities_json || "[]")) as Array<{ routeId?: string }>;
    return ents.some((e) => e.routeId === routeId || (railCorridor && e.routeId === railCorridor.shortName));
  });

  const lookups = await getAgencyStaticLookups(c.env, agencyId);
  let activeVehicles = liveSnap.vehicles.map((v) => enrichVehicleWithLookups(v, lookups, agencyId));
  if (activeVehicles.length === 0 && railCorridor) {
    activeVehicles = generateScheduledRailVehicles(agencyId, Date.now()).filter((v) => v.routeId === railCorridor.routeId);
  }

  const liveDelays = activeVehicles
    .map((v) => v.scheduleDeviationSec)
    .filter((d): d is number => d !== null);

  const fallbackShape = railCorridor
    ? { type: "LineString" as const, coordinates: railCorridor.stations.map((s) => [s.lon, s.lat] as [number, number]) }
    : null;

  return c.json({
    agencyId,
    route: routeRow
      ? {
          routeId: routeRow.route_id,
          shortName: routeRow.short_name,
          longName: routeRow.long_name,
          description: routeRow.description,
          routeType: railCorridor?.routeType ?? routeRow.route_type,
          color: railCorridor?.color ?? routeRow.color,
          textColor: railCorridor?.textColor ?? routeRow.text_color,
          directions: JSON.parse(String(routeRow.directions_json || "[]")),
          shapeGeoJson: routeRow.shape_geojson ? JSON.parse(String(routeRow.shape_geojson)) : fallbackShape,
          geometrySource: routeRow.shape_geojson ? "static_gtfs" : fallbackShape ? "static_gtfs" : "unavailable",
        }
      : railCorridor
        ? {
            routeId: railCorridor.routeId,
            shortName: railCorridor.shortName,
            longName: railCorridor.longName,
            routeType: railCorridor.routeType,
            color: railCorridor.color,
            textColor: railCorridor.textColor,
            directions: [
              { directionId: 0, headsign: railCorridor.headsignFwd },
              { directionId: 1, headsign: railCorridor.headsignRev },
            ],
            shapeGeoJson: fallbackShape,
            geometrySource: "static_gtfs",
          }
        : {
            routeId,
            shortName: routeId,
            longName: `Route ${routeId}`,
            directions: [],
            shapeGeoJson: null,
            geometrySource: "unavailable",
          },
    activeVehicles,
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

  // Fallback for built-in TTC Subway & GO Rail station IDs (e.g. ttc-l1-union, go-union)
  const matchingRailCorridors = RAIL_CORRIDORS.filter(
    (rc) => rc.agencyId === agencyId && rc.stations.some((s) => s.stopId === stopId)
  );
  const railStationMatch = matchingRailCorridors[0]?.stations.find((s) => s.stopId === stopId) ?? null;

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

  // Synthesize timetable departures for built-in TTC Subway / GO Rail stations when DB has no rows
  if (departures.length === 0 && matchingRailCorridors.length > 0) {
    const serviceMin = ctx.serviceSeconds / 60;
    const isPeak = (serviceMin % 1440 >= 420 && serviceMin % 1440 <= 570) || (serviceMin % 1440 >= 930 && serviceMin % 1440 <= 1140);
    for (const corridor of matchingRailCorridors) {
      const st = corridor.stations.find((s) => s.stopId === stopId);
      if (!st) continue;
      const totalRunMin = corridor.stations[corridor.stations.length - 1]!.offsetMin;
      const headway = isPeak ? corridor.peakHeadwayMin : corridor.offPeakHeadwayMin;
      for (const dir of [0, 1] as const) {
        const offset = dir === 0 ? st.offsetMin : totalRunMin - st.offsetMin;
        if (offset >= totalRunMin) continue; // terminus — no departures in this direction
        const phase = dir === 1 ? Math.floor(headway / 2) : 0;
        const firstDep = Math.max(
          corridor.startMin + offset,
          Math.ceil((serviceMin - offset - phase) / headway) * headway + phase + offset
        );
        for (let k = 0; k < 3; k++) {
          const depMin = firstDep + k * headway;
          const tripStart = depMin - offset;
          if (tripStart < corridor.startMin || tripStart > corridor.endMin || depMin > serviceMin + 120) continue;
          const etaSec = Math.max(0, Math.round((depMin - serviceMin) * 60));
          const predMs = nowMs + etaSec * 1000;
          departures.push({
            tripId: `sched-${corridor.routeId}-${dir}-${Math.round(tripStart)}`,
            routeId: corridor.routeId,
            headsign: dir === 0 ? corridor.headsignFwd : corridor.headsignRev,
            directionId: dir,
            vehicleId: null,
            fleetNumber: null,
            scheduleRelationship: "SCHEDULED",
            scheduledTime: formatSecondsToClock(depMin * 60),
            scheduledSec: Math.round(depMin * 60),
            predictedTime: new Date(predMs).toISOString(),
            etaSeconds: etaSec,
            uncertaintySec: 90,
            predictionSource: "scheduled",
            confidence: 0.65,
            basis: "Rail timetable",
          });
        }
      }
    }
  }

  departures.sort((a, b) => Number(a.etaSeconds) - Number(b.etaSeconds));

  const stopAlerts = alerts.results.filter((a) => {
    const ents = JSON.parse(String(a.informed_entities_json || "[]")) as Array<{ stopId?: string }>;
    return ents.some((e) => e.stopId === resolvedStopId);
  });

  // Approaching vehicles within 2.5km if stop coordinates known
  const effectiveStop =
    stop ??
    (railStationMatch
      ? { stop_id: railStationMatch.stopId, name: railStationMatch.name, lat: railStationMatch.lat, lon: railStationMatch.lon }
      : null);

  const approachingVehicles = effectiveStop
    ? [...liveSnap.vehicles, ...generateScheduledRailVehicles(agencyId, nowMs)]
        .map((v) => ({
          ...v,
          distanceMeters: Math.round(haversineMeters(v.lat, v.lon, Number(effectiveStop.lat), Number(effectiveStop.lon))),
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
    stop: effectiveStop ?? { stop_id: resolvedStopId, name: `Stop ${resolvedStopId}` },
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
  const [versionId, lookups, agency] = await Promise.all([
    getActiveVersionId(c.env.DB, agencyId),
    getAgencyStaticLookups(c.env, agencyId),
    c.env.DB.prepare("SELECT timezone FROM agencies WHERE id = ?").bind(agencyId).first<{ timezone: string }>(),
  ]);
  const serviceDate = c.req.query("date") || getLocalServiceContext(new Date(), agency?.timezone ?? "America/Toronto").serviceDate;

  // Resolve exact tripId OR its canonical patternTripId from KV trip_lookup so every live GTFS-RT trip gets full stop_times!
  const tm = lookups.trips?.m ? lookups.trips.m[tripId] : undefined;
  const lookupTripId = tm ? lookups.trips!.p[tm[2]] || tripId : tripId;
  const resolvedHeadsign = tm ? lookups.trips!.h[tm[0]] || null : null;

  const liveStub = c.env.AGENCY_LIVE.getByName(agencyId);
  const [tripRow, stopTimes, liveTripUpdates, assignments, liveVeh] = await Promise.all([
    versionId
      ? c.env.DB.prepare("SELECT * FROM trips WHERE agency_id = ? AND version_id = ? AND trip_id = ?")
          .bind(agencyId, versionId, lookupTripId)
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
          .bind(agencyId, versionId, lookupTripId)
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

  const enrichedTrip = tripRow
    ? { ...tripRow, headsign: resolvedHeadsign ?? tripRow.headsign }
    : resolvedHeadsign
      ? { trip_id: tripId, headsign: resolvedHeadsign }
      : null;

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
    trip: enrichedTrip,
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
    for (const r of parseObservationChunkRows(ch.data_json)) {
      if (req.routeId && r.r !== req.routeId) continue;
      if (req.vehicleId && r.v !== req.vehicleId && r.f !== req.vehicleId) continue;
      rows.push(r as unknown as Record<string, unknown>);
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
  await c.env.CACHE.delete(`has_subs:${s.agencyId}`).catch(() => undefined);
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
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, withActiveDb(env), ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const activeEnv = withActiveDb(env);
    if (controller.cron === "0 0,12 * * *") {
      ctx.waitUntil(runTwelveHourArchive(activeEnv));
    } else {
      ctx.waitUntil(runWatchdog(activeEnv));
    }
  },
} satisfies ExportedHandler<Env>;
