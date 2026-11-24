import type { NormalizedBatch, Observation } from "@swisshost/contracts";
import { insertObservationChunk, recordQuotaUsage } from "@swisshost/database";
import { getLocalServiceContext } from "@swisshost/transit-core";
import type { Env } from "../../api/src/env";
import { getBudgets, sha256Hex } from "../../api/src/env";

export interface ProcessBatchResult {
  acceptedObservations: number;
  rejectedObservations: number;
  duplicateObservations: number;
  tripUpdatesProcessed: number;
  alertsProcessed: number;
  chunkId: string | null;
}

/**
 * Free-tier optimized processor:
 * - Live positions & TripUpdates live in AgencyLiveDO SQLite (0 D1 row writes per vehicle/trip)
 * - D1 receives ONLY 1 batched observation_chunk row per poll, newly discovered fleet vehicles,
 *   actual route/trip assignment transitions, and changed service alerts.
 * Reduces D1 writes by ~97% (~3-6k/day total across all agencies instead of ~1.9M/day).
 */
export async function processNormalizedBatch(
  env: Env,
  batch: NormalizedBatch,
  options: { timezone: string; staleAfterSeconds: number; archivePermitted: boolean }
): Promise<ProcessBatchResult> {
  const now = new Date().toISOString();
  const budgets = getBudgets(env);
  const serviceCtx = getLocalServiceContext(batch.receivedAt, options.timezone);

  let acceptedObservations = 0;
  let rejectedObservations = 0;
  let duplicateObservations = 0;
  let chunkId: string | null = null;
  let d1Writes = 0;
  let doRequests = 0;

  const liveStub = env.AGENCY_LIVE.getByName(batch.agencyId);

  if (batch.observations.length > 0) {
    // 1. Validate, deduplicate, and broadcast live positions inside AgencyLiveDO SQLite
    const ingestRes = await liveStub.ingestPositions({
      agencyId: batch.agencyId,
      observations: batch.observations,
      incrementality: batch.incrementality,
      staleAfterSeconds: options.staleAfterSeconds,
      feedTimestamp: batch.feedTimestamp,
      receivedAt: batch.receivedAt,
    });
    doRequests += 1;

    acceptedObservations = ingestRes.accepted;
    rejectedObservations = ingestRes.rejected;
    duplicateObservations = ingestRes.duplicates;

    // 2. Write 1 single batched observation_chunk row for history & 12-hour GitHub archiving
    if (ingestRes.changedObservations.length > 0 && options.archivePermitted) {
      const chunk = await insertObservationChunk(env.DB, batch.agencyId, ingestRes.changedObservations);
      chunkId = chunk?.chunkId ?? null;
      if (chunk) d1Writes += 1;
    }

    // 3. Only write to D1 `vehicles` for brand-new fleet numbers + `vehicle_assignments` on route/trip change
    const stmts: D1PreparedStatement[] = [];
    for (const obs of ingestRes.newVehicles.slice(0, 80)) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO vehicles (
            agency_id, vehicle_id, source_vehicle_id, fleet_number, label,
            first_seen_at, last_seen_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(agency_id, vehicle_id) DO UPDATE SET
            fleet_number = excluded.fleet_number,
            label = COALESCE(excluded.label, vehicles.label),
            last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at`
        ).bind(
          obs.agencyId,
          obs.vehicleId,
          obs.sourceVehicleId,
          obs.fleetNumber,
          obs.label,
          obs.observedAt ?? obs.receivedAt,
          obs.observedAt ?? obs.receivedAt,
          now
        )
      );
    }

    for (const obs of ingestRes.assignmentChanges.slice(0, 40)) {
      const assignId = `${obs.agencyId}:${serviceCtx.serviceDate}:${obs.vehicleId}:${obs.routeId ?? "none"}:${obs.tripId ?? "none"}`;
      const ts = obs.observedAt ?? obs.receivedAt;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO vehicle_assignments (
            id, agency_id, vehicle_id, route_id, trip_id, block_id,
            service_date, started_at, ended_at, observation_count, confidence, method
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            ended_at = MAX(vehicle_assignments.ended_at, excluded.ended_at),
            started_at = MIN(vehicle_assignments.started_at, excluded.started_at),
            observation_count = vehicle_assignments.observation_count + 1`
        ).bind(
          assignId,
          obs.agencyId,
          obs.vehicleId,
          obs.routeId,
          obs.tripId,
          obs.blockId,
          serviceCtx.serviceDate,
          ts,
          ts,
          obs.matchConfidence,
          obs.matchMethod
        )
      );
    }

    if (stmts.length > 0) {
      for (let i = 0; i < stmts.length; i += 80) {
        await env.DB.batch(stmts.slice(i, i + 80));
      }
      d1Writes += stmts.length;
    }

    // 4. Evaluate server-side vehicle notification subscriptions only when subscriptions exist
    if (ingestRes.changedObservations.length > 0) {
      const hasSubs = await env.CACHE.get(`has_subs:${batch.agencyId}`).catch(() => null);
      if (hasSubs !== "0") {
        await evaluateVehicleSubscriptions(env, batch.agencyId, ingestRes.changedObservations).catch(() => undefined);
      }
    }
  }

  // 5. Store TripUpdates directly in AgencyLiveDO SQLite (0 D1 writes!)
  if (batch.tripUpdates.length > 0) {
    await liveStub.ingestTripUpdates(batch.tripUpdates);
    doRequests += 1;
  }

  // 6. Persist Service Alerts to D1 only when alert content hash actually changes
  if (batch.alerts.length > 0) {
    const alertHash = await sha256Hex(
      JSON.stringify(
        batch.alerts.slice(0, 100).map((a) => [a.sourceAlertId, a.cause, a.effect, a.headerText, a.descriptionText])
      )
    );
    const cacheKey = `alerts_hash:${batch.agencyId}`;
    const prevHash = await env.CACHE.get(cacheKey).catch(() => null);

    if (prevHash !== alertHash) {
      const stmts: D1PreparedStatement[] = [];
      for (const alert of batch.alerts.slice(0, 100)) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO service_alerts (
              id, agency_id, source_alert_id, cause, effect,
              header_text, description_text, url, active_periods_json,
              informed_entities_json, active, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(agency_id, source_alert_id) DO UPDATE SET
              cause = excluded.cause,
              effect = excluded.effect,
              header_text = excluded.header_text,
              description_text = excluded.description_text,
              url = excluded.url,
              active_periods_json = excluded.active_periods_json,
              informed_entities_json = excluded.informed_entities_json,
              active = 1,
              last_seen_at = excluded.last_seen_at`
          ).bind(
            `${alert.agencyId}:${alert.sourceAlertId}`,
            alert.agencyId,
            alert.sourceAlertId,
            alert.cause,
            alert.effect,
            alert.headerText,
            alert.descriptionText,
            alert.url,
            JSON.stringify(alert.activePeriods),
            JSON.stringify(alert.informedEntities),
            alert.receivedAt,
            alert.receivedAt
          )
        );
      }
      if (stmts.length > 0) {
        await env.DB.batch(stmts);
        d1Writes += stmts.length;
      }
      await env.CACHE.put(cacheKey, alertHash, { expirationTtl: 3600 }).catch(() => undefined);
    }
  }

  // Only hit D1 quota_ledger when actual D1 writes occurred (saves ~5,000+ D1 writes/day on TripUpdate/Alert polls)
  if (d1Writes > 0) {
    await recordQuotaUsage(env.DB, { d1Writes: d1Writes + 1, doRequests }, budgets);
  }

  return {
    acceptedObservations,
    rejectedObservations,
    duplicateObservations,
    tripUpdatesProcessed: batch.tripUpdates.length,
    alertsProcessed: batch.alerts.length,
    chunkId,
  };
}

async function evaluateVehicleSubscriptions(
  env: Env,
  agencyId: string,
  observations: Observation[]
): Promise<void> {
  if (observations.length === 0) return;
  const subs = await env.DB.prepare(
    `SELECT id, user_id, target_type, target_id, rule_json, quiet_hours_json, cooldown_sec, last_notified_at
     FROM subscriptions WHERE agency_id = ? AND enabled = 1 AND target_type = 'vehicle'`
  )
    .bind(agencyId)
    .all<{
      id: string;
      user_id: string;
      target_type: string;
      target_id: string;
      rule_json: string;
      quiet_hours_json: string | null;
      cooldown_sec: number;
      last_notified_at: string | null;
    }>();

  if (subs.results.length === 0) {
    await env.CACHE.put(`has_subs:${agencyId}`, "0", { expirationTtl: 1800 }).catch(() => undefined);
    return;
  }
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const obsByVeh = new Map(observations.map((o) => [o.vehicleId, o]));

  for (const sub of subs.results) {
    const obs = obsByVeh.get(sub.target_id);
    if (!obs) continue;
    if (sub.last_notified_at && nowMs - Date.parse(sub.last_notified_at) < sub.cooldown_sec * 1000) {
      continue;
    }
    const rule = JSON.parse(sub.rule_json) as { event: string; routeId?: string };
    if (rule.event === "vehicle_on_route" && rule.routeId && obs.routeId !== rule.routeId) {
      continue;
    }

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO notifications_inbox (
          id, user_id, subscription_id, agency_id, title, body, link, delivery_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'delivered', ?)`
      ).bind(
        crypto.randomUUID(),
        sub.user_id,
        sub.id,
        agencyId,
        `Vehicle ${obs.fleetNumber} spotted in service`,
        obs.routeId
          ? `Observed on route ${obs.routeId} at ${obs.observedAt ?? obs.receivedAt}`
          : `Observed active at ${obs.observedAt ?? obs.receivedAt}`,
        `/vehicles/${agencyId}/${encodeURIComponent(obs.vehicleId)}`,
        nowIso
      ),
      env.DB.prepare(`UPDATE subscriptions SET last_notified_at = ? WHERE id = ?`).bind(nowIso, sub.id),
    ]);
  }
}
