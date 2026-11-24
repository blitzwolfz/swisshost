import type { AgencyConfig, Observation } from "@swisshost/contracts";

export interface QuotaStatus {
  dateKey: string;
  d1Writes: number;
  doRequests: number;
  workerRequests: number;
  archiveBytes: number;
  d1WriteBudget: number;
  doRequestBudget: number;
  workerRequestBudget: number;
  maxRatio: number;
  tier: "normal" | "warn_70" | "throttle_85" | "paused_95";
}

export interface CompactObservationRow {
  v: string;
  f: string;
  r: string | null;
  t: string | null;
  b: string | null;
  d: number | null;
  la: number;
  lo: number;
  hd: number | null;
  sp: number | null;
  sd: number | null;
  st: string | null;
  ts: string;
  rx: string;
  tb: string;
  mm: string;
  mc: number;
}

export function todayUtcKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Only writes agency/feed definitions when missing or explicitly forced,
 * avoiding 15 wasted D1 writes on every isolate cold start or cron tick.
 */
export async function ensureAgenciesSeeded(
  db: D1Database,
  configs: AgencyConfig[],
  force = false
): Promise<void> {
  if (!force) {
    const existing = await db
      .prepare("SELECT COUNT(*) as c FROM agencies")
      .first<{ c: number }>()
      .catch(() => null);
    if ((existing?.c ?? 0) >= configs.length) {
      return;
    }
  }

  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];

  for (const agency of configs) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO agencies (
            id, name, short_name, region, timezone, modes_json,
            center_lon, center_lat, default_zoom, enabled, attribution,
            license_url, archive_policy, capabilities_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            short_name = excluded.short_name,
            region = excluded.region,
            timezone = excluded.timezone,
            modes_json = excluded.modes_json,
            center_lon = excluded.center_lon,
            center_lat = excluded.center_lat,
            default_zoom = excluded.default_zoom,
            attribution = excluded.attribution,
            license_url = excluded.license_url,
            archive_policy = excluded.archive_policy,
            capabilities_json = excluded.capabilities_json,
            updated_at = excluded.updated_at`
        )
        .bind(
          agency.id,
          agency.name,
          agency.shortName,
          agency.region,
          agency.timezone,
          JSON.stringify(agency.modes),
          agency.center[0],
          agency.center[1],
          agency.defaultZoom,
          agency.enabled ? 1 : 0,
          agency.attribution,
          agency.licenseUrl ?? null,
          agency.archivePolicy,
          JSON.stringify(agency.capabilities),
          now,
          now
        )
    );

    for (const feed of agency.feeds) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO feeds (
              id, agency_id, kind, adapter, url, fallback_url,
              auth_query_param, auth_secret_ref, refresh_seconds, stale_after_seconds,
              enabled, status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?)
            ON CONFLICT(id) DO UPDATE SET
              url = excluded.url,
              fallback_url = excluded.fallback_url,
              auth_query_param = excluded.auth_query_param,
              auth_secret_ref = excluded.auth_secret_ref,
              stale_after_seconds = excluded.stale_after_seconds,
              updated_at = excluded.updated_at`
          )
          .bind(
            feed.id,
            agency.id,
            feed.kind,
            feed.adapter,
            feed.url,
            feed.fallbackUrl ?? null,
            feed.authQueryParam ?? null,
            feed.authSecretRef ?? null,
            feed.refreshSeconds,
            feed.staleAfterSeconds,
            feed.enabled ? 1 : 0,
            now
          )
      );
    }
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
  }
}

export async function recordQuotaUsage(
  db: D1Database,
  delta: { d1Writes?: number; doRequests?: number; workerRequests?: number; archiveBytes?: number },
  budgets: { d1Writes: number; doRequests: number; workerRequests: number }
): Promise<QuotaStatus> {
  const dateKey = todayUtcKey();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO quota_ledger (date_key, d1_writes, do_requests, worker_requests, archive_bytes, status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'normal', ?)
       ON CONFLICT(date_key) DO UPDATE SET
         d1_writes = d1_writes + excluded.d1_writes,
         do_requests = do_requests + excluded.do_requests,
         worker_requests = worker_requests + excluded.worker_requests,
         archive_bytes = archive_bytes + excluded.archive_bytes,
         updated_at = excluded.updated_at`
    )
    .bind(
      dateKey,
      delta.d1Writes ?? 0,
      delta.doRequests ?? 0,
      delta.workerRequests ?? 0,
      delta.archiveBytes ?? 0,
      now
    )
    .run();

  return getQuotaStatus(db, budgets);
}

export async function getQuotaStatus(
  db: D1Database,
  budgets: { d1Writes: number; doRequests: number; workerRequests: number }
): Promise<QuotaStatus> {
  const dateKey = todayUtcKey();
  const row = await db
    .prepare(
      `SELECT d1_writes, do_requests, worker_requests, archive_bytes FROM quota_ledger WHERE date_key = ?`
    )
    .bind(dateKey)
    .first<{
      d1_writes: number;
      do_requests: number;
      worker_requests: number;
      archive_bytes: number;
    }>();

  const d1Writes = row?.d1_writes ?? 0;
  const doRequests = row?.do_requests ?? 0;
  const workerRequests = row?.worker_requests ?? 0;
  const archiveBytes = row?.archive_bytes ?? 0;

  const maxRatio = Math.max(
    d1Writes / Math.max(1, budgets.d1Writes),
    doRequests / Math.max(1, budgets.doRequests),
    workerRequests / Math.max(1, budgets.workerRequests)
  );

  let tier: QuotaStatus["tier"] = "normal";
  if (maxRatio >= 0.95) tier = "paused_95";
  else if (maxRatio >= 0.85) tier = "throttle_85";
  else if (maxRatio >= 0.7) tier = "warn_70";

  return {
    dateKey,
    d1Writes,
    doRequests,
    workerRequests,
    archiveBytes,
    d1WriteBudget: budgets.d1Writes,
    doRequestBudget: budgets.doRequests,
    workerRequestBudget: budgets.workerRequests,
    maxRatio,
    tier,
  };
}

export function getWindowKey(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const half = d.getUTCHours() < 12 ? "00-12" : "12-24";
  return `${yyyy}/${mm}/${dd}/${half}`;
}

/**
 * Decode either compact tuple format (v2, ~55% smaller) or legacy object format (v1).
 */
export function parseObservationChunkRows(dataJson: string): CompactObservationRow[] {
  const raw = JSON.parse(dataJson) as unknown[];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const first = raw[0];
  if (Array.isArray(first)) {
    return (raw as unknown[][]).map((t) => ({
      v: String(t[0] ?? ""),
      f: String(t[1] ?? t[0] ?? ""),
      r: (t[2] as string | null) ?? null,
      t: (t[3] as string | null) ?? null,
      b: (t[4] as string | null) ?? null,
      d: t[5] !== null && t[5] !== undefined ? Number(t[5]) : null,
      la: Number(t[6]),
      lo: Number(t[7]),
      hd: t[8] !== null && t[8] !== undefined ? Number(t[8]) : null,
      sp: t[9] !== null && t[9] !== undefined ? Number(t[9]) : null,
      sd: t[10] !== null && t[10] !== undefined ? Number(t[10]) : null,
      st: (t[11] as string | null) ?? null,
      ts: String(t[12] ?? ""),
      rx: String(t[13] ?? t[12] ?? ""),
      tb: String(t[14] ?? "receipt"),
      mm: String(t[15] ?? "unmatched"),
      mc: Number(t[16] ?? 0),
    }));
  }
  return raw as CompactObservationRow[];
}

export async function insertObservationChunk(
  db: D1Database,
  agencyId: string,
  observations: Observation[]
): Promise<{ chunkId: string; rowCount: number } | null> {
  if (observations.length === 0) return null;
  const times = observations.map((o) => o.observedAt ?? o.receivedAt).sort();
  const windowStart = times[0]!;
  const windowEnd = times[times.length - 1]!;
  const windowKey = getWindowKey(windowEnd);
  const chunkId = `${agencyId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  // Compact positional tuple encoding cuts D1 storage & read payload size by ~55%
  const tuples = observations.map((o) => [
    o.vehicleId,
    o.fleetNumber,
    o.routeId,
    o.tripId,
    o.blockId,
    o.directionId,
    Number(o.lat.toFixed(5)),
    Number(o.lon.toFixed(5)),
    o.bearingDeg !== null ? Math.round(o.bearingDeg) : null,
    o.speedMps !== null ? Number(o.speedMps.toFixed(1)) : null,
    o.scheduleDeviationSec,
    o.stopId,
    o.observedAt ?? o.receivedAt,
    o.receivedAt,
    o.timestampBasis,
    o.matchMethod,
    Number(o.matchConfidence.toFixed(2)),
  ]);

  await db
    .prepare(
      `INSERT INTO observation_chunks (
        id, agency_id, window_key, window_start, window_end,
        vehicle_id, route_id, row_count, data_json, archived, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?)`
    )
    .bind(
      chunkId,
      agencyId,
      windowKey,
      windowStart,
      windowEnd,
      observations.length,
      JSON.stringify(tuples),
      new Date().toISOString()
    )
    .run();

  return { chunkId, rowCount: observations.length };
}

/**
 * Bounded hot-staging retention so D1 never approaches its 5 GB Free storage cap.
 * - Archived chunks (already verified in blitzwolfz/swisshost-data): retain 24h in hot D1.
 * - Unarchived chunks: retain up to 7 days in hot D1, plus clean expired export_jobs & sessions.
 */
export async function pruneHotStaging(db: D1Database): Promise<void> {
  const now = Date.now();
  const archivedCutoff = new Date(now - 24 * 3600 * 1000).toISOString();
  const unarchivedCutoff = new Date(now - 7 * 86400 * 1000).toISOString();
  const nowIso = new Date(now).toISOString();

  await db.batch([
    db.prepare("DELETE FROM observation_chunks WHERE archived = 1 AND created_at < ?").bind(archivedCutoff),
    db.prepare("DELETE FROM observation_chunks WHERE created_at < ?").bind(unarchivedCutoff),
    db.prepare("DELETE FROM export_jobs WHERE expires_at < ?").bind(nowIso),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso),
  ]);
}

export async function appendAuditLog(
  db: D1Database,
  actor: string,
  action: string,
  target: string,
  detail: unknown = {}
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_audit_log (id, actor, action, target, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      actor,
      action,
      target,
      JSON.stringify(detail),
      new Date().toISOString()
    )
    .run();
}
