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

export function todayUtcKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export async function ensureAgenciesSeeded(
  db: D1Database,
  configs: AgencyConfig[]
): Promise<void> {
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

  const compact = observations.map((o) => ({
    v: o.vehicleId,
    f: o.fleetNumber,
    r: o.routeId,
    t: o.tripId,
    b: o.blockId,
    d: o.directionId,
    la: Number(o.lat.toFixed(6)),
    lo: Number(o.lon.toFixed(6)),
    hd: o.bearingDeg !== null ? Math.round(o.bearingDeg) : null,
    sp: o.speedMps !== null ? Number(o.speedMps.toFixed(2)) : null,
    sd: o.scheduleDeviationSec,
    st: o.stopId,
    sq: o.stopSequence,
    ts: o.observedAt ?? o.receivedAt,
    rx: o.receivedAt,
    tb: o.timestampBasis,
    mm: o.matchMethod,
    mc: Number(o.matchConfidence.toFixed(2)),
    qf: o.qualityFlags,
  }));

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
      JSON.stringify(compact),
      new Date().toISOString()
    )
    .run();

  return { chunkId, rowCount: observations.length };
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
