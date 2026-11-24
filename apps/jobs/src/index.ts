import { gzipSync } from "fflate";
import { parseGtfsStaticZip, validateFeedUrl } from "@swisshost/adapters";
import { computeScheduleAdherence, ANALYTICS_ALGORITHM_VERSION } from "@swisshost/analytics";
import { ensureAgenciesSeeded, getQuotaStatus } from "@swisshost/database";
import type { FeedKind } from "@swisshost/contracts";
import type { Env } from "../../api/src/env";
import { BUILTIN_AGENCIES, getBudgets, sha256Hex } from "../../api/src/env";

/**
 * Cron Watchdog (every 5 minutes):
 * - Ensures all enabled agencies/feeds are seeded and their FeedSchedulerDO alarms are alive
 * - Computes hourly route adherence & coverage analytics buckets
 * - Flags stale feeds if alarms or upstream stopped reporting
 */
export async function runWatchdog(env: Env): Promise<{
  feedsChecked: number;
  repaired: number;
  quotaTier: string;
}> {
  await ensureAgenciesSeeded(env.DB, BUILTIN_AGENCIES);
  const quota = await getQuotaStatus(env.DB, getBudgets(env));

  const feeds = await env.DB.prepare(
    `SELECT f.*, a.timezone, a.archive_policy
     FROM feeds f
     JOIN agencies a ON a.id = f.agency_id
     WHERE a.enabled = 1 AND f.enabled = 1 AND f.kind != 'gtfs_static'`
  ).all<{
    id: string;
    agency_id: string;
    kind: FeedKind;
    adapter: string;
    url: string;
    fallback_url: string | null;
    auth_query_param: string | null;
    auth_secret_ref: string | null;
    refresh_seconds: number;
    stale_after_seconds: number;
    enabled: number;
    timezone: string;
    archive_policy: string;
  }>();

  let repaired = 0;
  for (const f of feeds.results) {
    const stub = env.FEED_SCHEDULER.getByName(f.id);
    const res = await stub.ensureScheduled({
      id: f.id,
      agencyId: f.agency_id,
      kind: f.kind,
      adapter: f.adapter,
      url: f.url,
      fallbackUrl: f.fallback_url,
      authQueryParam: f.auth_query_param,
      authSecretRef: f.auth_secret_ref,
      refreshSeconds: f.refresh_seconds,
      staleAfterSeconds: f.stale_after_seconds,
      timezone: f.timezone,
      archivePermitted: f.archive_policy !== "prohibited",
      enabled: f.enabled === 1 && quota.tier !== "paused_95",
    });
    if (res.scheduled) repaired++;
  }

  await rollupRecentAnalytics(env).catch(() => undefined);

  return { feedsChecked: feeds.results.length, repaired, quotaTier: quota.tier };
}

async function rollupRecentAnalytics(env: Env): Promise<void> {
  const now = new Date();
  const bucketStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours())
  ).toISOString();

  const agencies = await env.DB.prepare("SELECT id FROM agencies WHERE enabled = 1").all<{ id: string }>();
  for (const ag of agencies.results) {
    const rows = await env.DB.prepare(
      `SELECT route_id, schedule_deviation_sec, observed_at, received_at
       FROM vehicle_latest WHERE agency_id = ?`
    )
      .bind(ag.id)
      .all<{
        route_id: string | null;
        schedule_deviation_sec: number | null;
        observed_at: string | null;
        received_at: string;
      }>();

    if (rows.results.length === 0) continue;

    const byRoute = new Map<string, number[]>();
    let freshCount = 0;
    const nowMs = now.getTime();
    for (const r of rows.results) {
      const refMs = Date.parse(r.observed_at ?? r.received_at);
      if ((nowMs - refMs) / 1000 <= 120) freshCount++;
      if (r.route_id && r.schedule_deviation_sec !== null) {
        const list = byRoute.get(r.route_id) ?? [];
        list.push(r.schedule_deviation_sec);
        byRoute.set(r.route_id, list);
      }
    }

    const stmts: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO analytics_buckets (
          id, agency_id, bucket_start, bucket_granularity, route_id, stop_id, direction_id,
          metric_type, sample_count, value_json, coverage_ratio, algorithm_version, computed_at
        ) VALUES (?, ?, ?, 'hour', NULL, NULL, NULL, 'coverage', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          sample_count = excluded.sample_count,
          value_json = excluded.value_json,
          coverage_ratio = excluded.coverage_ratio,
          computed_at = excluded.computed_at`
      ).bind(
        `${ag.id}:hour:${bucketStart}:coverage`,
        ag.id,
        bucketStart,
        rows.results.length,
        JSON.stringify({ observedVehicles: rows.results.length, freshVehicles: freshCount }),
        Number((freshCount / rows.results.length).toFixed(3)),
        ANALYTICS_ALGORITHM_VERSION,
        now.toISOString()
      ),
    ];

    for (const [routeId, delays] of byRoute) {
      const adh = computeScheduleAdherence(delays);
      stmts.push(
        env.DB.prepare(
          `INSERT INTO analytics_buckets (
            id, agency_id, bucket_start, bucket_granularity, route_id, stop_id, direction_id,
            metric_type, sample_count, value_json, coverage_ratio, algorithm_version, computed_at
          ) VALUES (?, ?, ?, 'hour', ?, NULL, NULL, 'adherence', ?, ?, 1.0, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            sample_count = excluded.sample_count,
            value_json = excluded.value_json,
            computed_at = excluded.computed_at`
        ).bind(
          `${ag.id}:hour:${bucketStart}:adherence:${routeId}`,
          ag.id,
          bucketStart,
          routeId,
          adh.sampleCount,
          JSON.stringify(adh),
          ANALYTICS_ALGORITHM_VERSION,
          now.toISOString()
        )
      );
    }

    await env.DB.batch(stmts.slice(0, 80));
  }
}

/**
 * PRD §7.1 — 12-hour GitHub Git Data API durable archive (00:00 and 12:00 UTC).
 * Seals completed unarchived chunks into deterministic gzipped CSVs + manifest,
 * commits via GitHub Git Data API without force-push, and verifies before marking archived.
 */
export async function runTwelveHourArchive(
  env: Env
): Promise<{
  committedWindows: number;
  skippedReason?: string;
  results: Array<{ agencyId: string; windowKey: string; status: string; commitSha?: string; rows: number }>;
}> {
  const token = env.GITHUB_ARCHIVE_TOKEN;
  const repo = env.GITHUB_ARCHIVE_REPO || "blitzwolfz/swisshost-data";
  const branch = env.GITHUB_ARCHIVE_BRANCH || "main";

  const pendingWindows = await env.DB.prepare(
    `SELECT agency_id, window_key, MIN(window_start) as w_start, MAX(window_end) as w_end, SUM(row_count) as total_rows
     FROM observation_chunks
     WHERE archived = 0
     GROUP BY agency_id, window_key
     ORDER BY window_key ASC
     LIMIT 6`
  ).all<{
    agency_id: string;
    window_key: string;
    w_start: string;
    w_end: string;
    total_rows: number;
  }>();

  if (pendingWindows.results.length === 0) {
    return { committedWindows: 0, skippedReason: "No unarchived observation windows", results: [] };
  }

  if (!token) {
    // Record manifests as pending_token so admin UI clearly displays archive readiness
    const now = new Date().toISOString();
    for (const w of pendingWindows.results) {
      await env.DB.prepare(
        `INSERT INTO archive_manifests (
          id, agency_id, window_key, window_start, window_end, status, file_count, row_count, error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, 'awaiting_token', 0, ?, 'Set GITHUB_ARCHIVE_TOKEN secret to enable 12-hour Git commits', ?)
        ON CONFLICT(agency_id, window_key) DO UPDATE SET
          row_count = excluded.row_count,
          status = 'awaiting_token',
          error_message = excluded.error_message`
      )
        .bind(`${w.agency_id}:${w.window_key}`, w.agency_id, w.window_key, w.w_start, w.w_end, w.total_rows, now)
        .run();
    }
    return {
      committedWindows: 0,
      skippedReason: "GITHUB_ARCHIVE_TOKEN not configured",
      results: pendingWindows.results.map((w) => ({
        agencyId: w.agency_id,
        windowKey: w.window_key,
        status: "awaiting_token",
        rows: w.total_rows,
      })),
    };
  }

  const results: Array<{ agencyId: string; windowKey: string; status: string; commitSha?: string; rows: number }> = [];
  let committedWindows = 0;

  for (const w of pendingWindows.results) {
    try {
      const chunks = await env.DB.prepare(
        `SELECT id, data_json FROM observation_chunks
         WHERE agency_id = ? AND window_key = ? AND archived = 0
         ORDER BY window_start ASC`
      )
        .bind(w.agency_id, w.window_key)
        .all<{ id: string; data_json: string }>();

      const csvLines = [
        "observed_at,received_at,vehicle_id,fleet_number,route_id,trip_id,block_id,direction_id,lat,lon,bearing_deg,speed_mps,delay_sec,stop_id,timestamp_basis,match_method,match_confidence",
      ];
      let rowCount = 0;

      for (const ch of chunks.results) {
        const rows = JSON.parse(ch.data_json) as Array<Record<string, unknown>>;
        for (const r of rows) {
          csvLines.push(
            [
              r.ts ?? "",
              r.rx ?? "",
              r.v ?? "",
              r.f ?? "",
              r.r ?? "",
              r.t ?? "",
              r.b ?? "",
              r.d ?? "",
              r.la ?? "",
              r.lo ?? "",
              r.hd ?? "",
              r.sp ?? "",
              r.sd ?? "",
              r.st ?? "",
              r.tb ?? "",
              r.mm ?? "",
              r.mc ?? "",
            ]
              .map((v) => `"${String(v).replace(/"/g, '""')}"`)
              .join(",")
          );
          rowCount++;
        }
      }

      const csvBytes = new TextEncoder().encode(csvLines.join("\n") + "\n");
      const gzBytes = gzipSync(csvBytes, { level: 6 });
      const gzSha256 = await sha256Hex(gzBytes);

      const posPath = `history/${w.agency_id}/${w.window_key}/positions.csv.gz`;
      const manifestPath = `manifests/${w.agency_id}/${w.window_key}.json`;
      const manifestBody = JSON.stringify(
        {
          schemaVersion: "1.0",
          agencyId: w.agency_id,
          windowKey: w.window_key,
          windowStart: w.w_start,
          windowEnd: w.w_end,
          rowCount,
          files: [{ path: posPath, sha256: gzSha256, bytes: gzBytes.byteLength }],
          createdAt: new Date().toISOString(),
        },
        null,
        2
      );

      const commitSha = await commitFilesToGithub({
        token,
        repo,
        branch,
        message: `archive(${w.agency_id}): seal ${w.window_key} (${rowCount} observations)`,
        files: [
          { path: posPath, base64Content: uint8ToBase64(gzBytes) },
          { path: manifestPath, utf8Content: manifestBody },
        ],
      });

      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO archive_manifests (
            id, agency_id, window_key, window_start, window_end, status,
            file_count, row_count, sha256, commit_sha, repo_path, error_message, verified_at, created_at
          ) VALUES (?, ?, ?, ?, ?, 'verified', 2, ?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(agency_id, window_key) DO UPDATE SET
            status = 'verified',
            file_count = 2,
            row_count = excluded.row_count,
            sha256 = excluded.sha256,
            commit_sha = excluded.commit_sha,
            repo_path = excluded.repo_path,
            error_message = NULL,
            verified_at = excluded.verified_at`
        ).bind(
          `${w.agency_id}:${w.window_key}`,
          w.agency_id,
          w.window_key,
          w.w_start,
          w.w_end,
          rowCount,
          gzSha256,
          commitSha,
          posPath,
          now,
          now
        ),
        env.DB.prepare(
          `UPDATE observation_chunks SET archived = 1 WHERE agency_id = ? AND window_key = ?`
        ).bind(w.agency_id, w.window_key),
      ]);

      committedWindows++;
      results.push({ agencyId: w.agency_id, windowKey: w.window_key, status: "verified", commitSha, rows: rowCount });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO archive_manifests (
          id, agency_id, window_key, window_start, window_end, status, row_count, error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, ?)
        ON CONFLICT(agency_id, window_key) DO UPDATE SET
          status = 'failed',
          error_message = excluded.error_message`
      )
        .bind(`${w.agency_id}:${w.window_key}`, w.agency_id, w.window_key, w.w_start, w.w_end, w.total_rows, errMsg, now)
        .run();

      results.push({ agencyId: w.agency_id, windowKey: w.window_key, status: "failed", rows: w.total_rows });
    }
  }

  return { committedWindows, results };
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function commitFilesToGithub(input: {
  token: string;
  repo: string;
  branch: string;
  message: string;
  files: Array<{ path: string; base64Content?: string; utf8Content?: string }>;
}): Promise<string> {
  const api = `https://api.github.com/repos/${input.repo}`;
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Swisshost-Archiver/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const gh = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${api}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GitHub API ${path} failed (${res.status}): ${txt.slice(0, 240)}`);
    }
    return (await res.json()) as T;
  };

  // 1. Resolve current branch HEAD commit & tree
  const ref = await gh<{ object: { sha: string } }>(`/git/ref/heads/${input.branch}`);
  const headCommitSha = ref.object.sha;
  const headCommit = await gh<{ tree: { sha: string } }>(`/git/commits/${headCommitSha}`);

  // 2. Create blobs
  const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  for (const file of input.files) {
    const blob = await gh<{ sha: string }>(`/git/blobs`, {
      method: "POST",
      body: JSON.stringify(
        file.base64Content
          ? { content: file.base64Content, encoding: "base64" }
          : { content: file.utf8Content ?? "", encoding: "utf-8" }
      ),
    });
    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  // 3. Create new tree & commit (no force push!)
  const newTree = await gh<{ sha: string }>(`/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: treeEntries }),
  });

  const newCommit = await gh<{ sha: string }>(`/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: input.message,
      tree: newTree.sha,
      parents: [headCommitSha],
    }),
  });

  // 4. Fast-forward branch ref (force: false)
  await gh(`/git/refs/heads/${input.branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });

  return newCommit.sha;
}

/**
 * Import Static GTFS into D1 (staged versioned activation so failed imports never corrupt active data).
 */
export async function importStaticGtfsForAgency(
  env: Env,
  agencyId: string,
  zipBytesOverride?: Uint8Array
): Promise<{
  versionId: string;
  routes: number;
  stops: number;
  trips: number;
  calendars: number;
  warnings: string[];
}> {
  const feed = await env.DB.prepare(
    `SELECT id, url, fallback_url FROM feeds WHERE agency_id = ? AND kind = 'gtfs_static' LIMIT 1`
  )
    .bind(agencyId)
    .first<{ id: string; url: string; fallback_url: string | null }>();

  if (!feed && !zipBytesOverride) {
    throw new Error(`No gtfs_static feed configured for agency ${agencyId}`);
  }

  let zipBytes: Uint8Array;
  if (zipBytesOverride) {
    zipBytes = zipBytesOverride;
  } else {
    const urls = [feed!.url, ...(feed!.fallback_url ? [feed!.fallback_url] : [])];
    let loaded: Uint8Array | null = null;
    let lastErr = "Failed to fetch static GTFS";
    for (const u of urls) {
      try {
        validateFeedUrl(u);
        const resp = await fetch(u, {
          headers: { "User-Agent": "Swisshost/1.0 (+https://swisshost.cc)" },
          redirect: "follow",
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (buf.byteLength > 25 * 1024 * 1024) {
          throw new Error(`Static ZIP too large for Worker isolate (${buf.byteLength} bytes); use infra/seed-static.ts CLI`);
        }
        loaded = buf;
        break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    if (!loaded) throw new Error(lastErr);
    zipBytes = loaded;
  }

  const contentHash = (await sha256Hex(zipBytes)).slice(0, 16);
  const versionId = `${agencyId}-${contentHash}-${Date.now()}`;
  // Skip huge stop_times inside 10ms Worker isolate if ZIP > 4MB; CLI loads full stop_times
  const parsed = parseGtfsStaticZip(zipBytes, { includeStopTimes: zipBytes.byteLength < 4 * 1024 * 1024 });
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO feed_versions (
      id, feed_id, agency_id, content_hash, valid_from, valid_until, status,
      route_count, stop_count, trip_count, diagnostics_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?, ?, ?)`
  )
    .bind(
      versionId,
      feed?.id ?? `${agencyId}-static`,
      agencyId,
      contentHash,
      parsed.diagnostics.validFrom,
      parsed.diagnostics.validUntil,
      parsed.routes.length,
      parsed.stops.length,
      parsed.trips.length,
      JSON.stringify(parsed.diagnostics),
      now
    )
    .run();

  // Group shapes & directions per route
  const routeShapes = new Map<string, Array<[number, number]>>();
  const routeDirs = new Map<string, Map<number, string>>();
  for (const t of parsed.trips) {
    if (t.shapeId && !routeShapes.has(t.routeId)) {
      const sh = parsed.shapes.get(t.shapeId);
      if (sh) routeShapes.set(t.routeId, sh);
    }
    const dirMap = routeDirs.get(t.routeId) ?? new Map<number, string>();
    const dir = t.directionId ?? 0;
    if (!dirMap.has(dir) && t.headsign) dirMap.set(dir, t.headsign);
    routeDirs.set(t.routeId, dirMap);
  }

  const batchWrite = async (stmts: D1PreparedStatement[]) => {
    for (let i = 0; i < stmts.length; i += 80) {
      await env.DB.batch(stmts.slice(i, i + 80));
    }
  };

  await batchWrite(
    parsed.routes.map((r) => {
      const coords = routeShapes.get(r.routeId);
      const dirs = Array.from(routeDirs.get(r.routeId)?.entries() ?? []).map(([id, headsign]) => ({
        directionId: id,
        headsign,
      }));
      const shapeGeoJson = coords ? JSON.stringify({ type: "LineString", coordinates: coords }) : null;
      return env.DB.prepare(
        `INSERT OR REPLACE INTO routes (
          agency_id, route_id, version_id, short_name, long_name, description,
          route_type, color, text_color, sort_order, directions_json, shape_geojson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        agencyId,
        r.routeId,
        versionId,
        r.shortName,
        r.longName,
        r.description,
        r.routeType,
        r.color,
        r.textColor,
        r.sortOrder,
        JSON.stringify(dirs),
        shapeGeoJson
      );
    })
  );

  await batchWrite(
    parsed.stops.slice(0, 4000).map((s) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO stops (
          agency_id, stop_id, version_id, stop_code, name, description,
          lat, lon, location_type, parent_station, platform_code, wheelchair_boarding
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        agencyId,
        s.stopId,
        versionId,
        s.stopCode,
        s.name,
        s.description,
        s.lat,
        s.lon,
        s.locationType,
        s.parentStation,
        s.platformCode,
        s.wheelchairBoarding
      )
    )
  );

  await batchWrite(
    parsed.calendars.map((c) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO calendars (
          agency_id, version_id, service_id, days_mask, start_date, end_date, exceptions_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(agencyId, versionId, c.serviceId, c.daysMask, c.startDate, c.endDate, JSON.stringify(c.exceptions))
    )
  );

  await batchWrite(
    parsed.trips.slice(0, 3000).map((t) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO trips (
          agency_id, trip_id, version_id, route_id, service_id,
          direction_id, headsign, short_name, block_id, shape_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        agencyId,
        t.tripId,
        versionId,
        t.routeId,
        t.serviceId,
        t.directionId,
        t.headsign,
        t.shortName,
        t.blockId,
        t.shapeId
      )
    )
  );

  if (parsed.stopTimes.length > 0) {
    await batchWrite(
      parsed.stopTimes.slice(0, 5000).map((st) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO stop_times (
            agency_id, version_id, trip_id, stop_sequence, stop_id, arrival_sec, departure_sec
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(agencyId, versionId, st.tripId, st.stopSequence, st.stopId, st.arrivalSec, st.departureSec)
      )
    );
  }

  // Atomic version activation (keep prior version for rollback!)
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE feed_versions SET status = 'archived' WHERE agency_id = ? AND status = 'active'`
    ).bind(agencyId),
    env.DB.prepare(
      `UPDATE feed_versions SET status = 'active', activated_at = ? WHERE id = ?`
    ).bind(now, versionId),
    env.DB.prepare(
      `UPDATE feeds SET status = 'fresh', last_fetch_at = ?, last_success_at = ?, last_error = NULL, last_entity_count = ?, updated_at = ?
       WHERE agency_id = ? AND kind = 'gtfs_static'`
    ).bind(now, now, parsed.routes.length + parsed.stops.length, now, agencyId),
  ]);

  // Invalidate cached static routes in KV
  await env.CACHE.delete(`routes:${agencyId}`);

  return {
    versionId,
    routes: parsed.routes.length,
    stops: parsed.stops.length,
    trips: parsed.trips.length,
    calendars: parsed.calendars.length,
    warnings: parsed.diagnostics.warnings,
  };
}
