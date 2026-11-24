import type { NormalizedBatch, Observation } from "@swisshost/contracts";
import { insertObservationChunk, recordQuotaUsage } from "@swisshost/database";
import { getLocalServiceContext, validateObservationQuality } from "@swisshost/transit-core";
import type { Env } from "../../api/src/env";
import { getBudgets } from "../../api/src/env";

export interface ProcessBatchResult {
  acceptedObservations: number;
  rejectedObservations: number;
  duplicateObservations: number;
  tripUpdatesProcessed: number;
  alertsProcessed: number;
  chunkId: string | null;
}

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

  if (batch.observations.length > 0) {
    // Load current latest timestamps for deduplication & jump detection
    const existingRows = await env.DB.prepare(
      `SELECT source_vehicle_id, lat, lon, observed_at, received_at, route_id, trip_id
       FROM vehicle_latest WHERE agency_id = ?`
    )
      .bind(batch.agencyId)
      .all<{
        source_vehicle_id: string;
        lat: number;
        lon: number;
        observed_at: string | null;
        received_at: string;
        route_id: string | null;
        trip_id: string | null;
      }>();

    const prevMap = new Map(existingRows.results.map((r) => [r.source_vehicle_id, r]));
    const validObs: Observation[] = [];
    const changedObs: Observation[] = [];

    for (const obs of batch.observations) {
      const prevRow = prevMap.get(obs.sourceVehicleId);
      const prevObs: Observation | null = prevRow
        ? {
            ...obs,
            lat: prevRow.lat,
            lon: prevRow.lon,
            observedAt: prevRow.observed_at,
            receivedAt: prevRow.received_at,
          }
        : null;

      const check = validateObservationQuality(obs, prevObs);
      if (!check.valid) {
        rejectedObservations++;
        continue;
      }

      const cleaned: Observation = { ...obs, qualityFlags: check.flags };
      validObs.push(cleaned);

      // Deduplicate identical timestamp + position repeats
      const isDuplicate =
        prevRow &&
        prevRow.observed_at === cleaned.observedAt &&
        Math.abs(prevRow.lat - cleaned.lat) < 0.00001 &&
        Math.abs(prevRow.lon - cleaned.lon) < 0.00001 &&
        prevRow.trip_id === cleaned.tripId;

      if (isDuplicate) {
        duplicateObservations++;
      } else {
        changedObs.push(cleaned);
      }
    }

    acceptedObservations = validObs.length;

    // 1. Push to AgencyLiveDO immediately for sub-second live WebSocket fanout
    const liveStub = env.AGENCY_LIVE.getByName(batch.agencyId);
    await liveStub.ingestPositions({
      agencyId: batch.agencyId,
      observations: validObs,
      incrementality: batch.incrementality,
      staleAfterSeconds: options.staleAfterSeconds,
      feedTimestamp: batch.feedTimestamp,
      receivedAt: batch.receivedAt,
    });

    // 2. Persist batched D1 state (bounded writes: 1 chunk row + changed vehicle upserts)
    if (changedObs.length > 0) {
      if (options.archivePermitted) {
        const chunk = await insertObservationChunk(env.DB, batch.agencyId, changedObs);
        chunkId = chunk?.chunkId ?? null;
      }

      // Upsert vehicles + vehicle_latest in batches of 50 to stay well within D1 limits
      const stmts: D1PreparedStatement[] = [];
      for (const obs of changedObs.slice(0, 250)) {
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

        stmts.push(
          env.DB.prepare(
            `INSERT INTO vehicle_latest (
              agency_id, source_vehicle_id, vehicle_id, fleet_number,
              route_id, trip_id, block_id, direction_id,
              lat, lon, bearing_deg, speed_mps, schedule_deviation_sec,
              current_status, stop_id, stop_sequence, occupancy_status,
              observed_at, received_at, timestamp_basis, quality_flags_json,
              match_method, match_confidence, raw_ref, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(agency_id, source_vehicle_id) DO UPDATE SET
              route_id = excluded.route_id,
              trip_id = excluded.trip_id,
              block_id = excluded.block_id,
              direction_id = excluded.direction_id,
              lat = excluded.lat,
              lon = excluded.lon,
              bearing_deg = excluded.bearing_deg,
              speed_mps = excluded.speed_mps,
              schedule_deviation_sec = COALESCE(excluded.schedule_deviation_sec, vehicle_latest.schedule_deviation_sec),
              current_status = excluded.current_status,
              stop_id = excluded.stop_id,
              stop_sequence = excluded.stop_sequence,
              occupancy_status = excluded.occupancy_status,
              observed_at = excluded.observed_at,
              received_at = excluded.received_at,
              timestamp_basis = excluded.timestamp_basis,
              quality_flags_json = excluded.quality_flags_json,
              match_method = excluded.match_method,
              match_confidence = excluded.match_confidence,
              raw_ref = excluded.raw_ref,
              updated_at = excluded.updated_at
            WHERE vehicle_latest.observed_at IS NULL
               OR excluded.observed_at IS NULL
               OR excluded.observed_at >= vehicle_latest.observed_at`
          ).bind(
            obs.agencyId,
            obs.sourceVehicleId,
            obs.vehicleId,
            obs.fleetNumber,
            obs.routeId,
            obs.tripId,
            obs.blockId,
            obs.directionId,
            obs.lat,
            obs.lon,
            obs.bearingDeg,
            obs.speedMps,
            obs.scheduleDeviationSec,
            obs.currentStatus,
            obs.stopId,
            obs.stopSequence,
            obs.occupancyStatus,
            obs.observedAt,
            obs.receivedAt,
            obs.timestampBasis,
            JSON.stringify(obs.qualityFlags),
            obs.matchMethod,
            obs.matchConfidence,
            obs.rawRef,
            now
          )
        );

        // Track assignment interval (keyed by agency + vehicle + route + trip + service_date)
        if (obs.routeId || obs.tripId) {
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
      }

      // Execute D1 batches in chunks of 80 statements
      for (let i = 0; i < stmts.length; i += 80) {
        await env.DB.batch(stmts.slice(i, i + 80));
      }

      await recordQuotaUsage(
        env.DB,
        { d1Writes: stmts.length + 1, doRequests: 1 },
        budgets
      );
    }

    // 3. Evaluate server-side vehicle notification subscriptions (best-effort)
    await evaluateVehicleSubscriptions(env, batch.agencyId, changedObs).catch(() => undefined);
  }

  // 4. Process TripUpdates
  if (batch.tripUpdates.length > 0) {
    const stmts: D1PreparedStatement[] = [];
    for (const tu of batch.tripUpdates.slice(0, 300)) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO trip_updates (
            agency_id, trip_id, service_date, route_id, vehicle_id,
            schedule_relationship, delay_sec, stop_updates_json, observed_at, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(agency_id, service_date, trip_id) DO UPDATE SET
            route_id = COALESCE(excluded.route_id, trip_updates.route_id),
            vehicle_id = COALESCE(excluded.vehicle_id, trip_updates.vehicle_id),
            schedule_relationship = excluded.schedule_relationship,
            delay_sec = excluded.delay_sec,
            stop_updates_json = excluded.stop_updates_json,
            observed_at = excluded.observed_at,
            received_at = excluded.received_at`
        ).bind(
          tu.agencyId,
          tu.tripId,
          tu.serviceDate,
          tu.routeId,
          tu.vehicleId,
          tu.scheduleRelationship,
          tu.delaySec,
          JSON.stringify(tu.stopUpdates.slice(0, 40)),
          tu.observedAt,
          tu.receivedAt
        )
      );

      // Propagate reported schedule deviation onto vehicle_latest if matched by trip_id
      if (tu.delaySec !== null) {
        stmts.push(
          env.DB.prepare(
            `UPDATE vehicle_latest SET schedule_deviation_sec = ? WHERE agency_id = ? AND trip_id = ?`
          ).bind(tu.delaySec, tu.agencyId, tu.tripId)
        );
      }
    }

    for (let i = 0; i < stmts.length; i += 80) {
      await env.DB.batch(stmts.slice(i, i + 80));
    }
    await recordQuotaUsage(env.DB, { d1Writes: stmts.length }, budgets);
  }

  // 5. Process Service Alerts
  if (batch.alerts.length > 0) {
    const activeIds: string[] = [];
    const stmts: D1PreparedStatement[] = [];

    for (const alert of batch.alerts.slice(0, 100)) {
      activeIds.push(alert.sourceAlertId);
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
      await recordQuotaUsage(env.DB, { d1Writes: stmts.length }, budgets);
    }
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

  if (subs.results.length === 0) return;
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
