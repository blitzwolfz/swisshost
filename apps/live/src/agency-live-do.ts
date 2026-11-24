import { DurableObject } from "cloudflare:workers";
import type {
  FeedHealthStatus,
  LiveVehicleState,
  LiveWsClientMessage,
  LiveWsServerMessage,
  NormalizedTripUpdate,
  Observation,
} from "@swisshost/contracts";
import { validateObservationQuality } from "@swisshost/transit-core";
import type { Env } from "../../api/src/env";

type StoredVehicleRow = {
  source_vehicle_id: string;
  vehicle_id: string;
  payload_json: string;
  observed_ms: number;
  received_ms: number;
  route_id: string | null;
  trip_id: string | null;
};

type StoredTripUpdateRow = {
  trip_id: string;
  service_date: string;
  route_id: string | null;
  vehicle_id: string | null;
  delay_sec: number | null;
  payload_json: string;
  updated_ms: number;
};

interface WsAttachment {
  agencyId: string;
  routeId?: string;
}

export class AgencyLiveDO extends DurableObject<Env> {
  private agencyId = "";
  private cursor = 0;
  private feedStatus: FeedHealthStatus = "unknown";
  private lastSuccessAt: string | null = null;
  private staleAfterSeconds = 120;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS live_vehicles (
          source_vehicle_id TEXT PRIMARY KEY,
          vehicle_id TEXT NOT NULL DEFAULT '',
          route_id TEXT,
          trip_id TEXT,
          observed_ms INTEGER NOT NULL,
          received_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS known_vehicles (
          vehicle_id TEXT PRIMARY KEY,
          first_seen_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS live_trip_updates (
          trip_id TEXT PRIMARY KEY,
          service_date TEXT NOT NULL,
          route_id TEXT,
          vehicle_id TEXT,
          delay_sec INTEGER,
          payload_json TEXT NOT NULL,
          updated_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS live_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS delta_log (
          cursor INTEGER PRIMARY KEY,
          created_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
      `);

      // Forward-compatible column additions for DO instances created before this optimization
      try {
        this.ctx.storage.sql.exec("ALTER TABLE live_vehicles ADD COLUMN vehicle_id TEXT NOT NULL DEFAULT ''");
      } catch {
        // already exists
      }
      try {
        this.ctx.storage.sql.exec("ALTER TABLE live_vehicles ADD COLUMN trip_id TEXT");
      } catch {
        // already exists
      }

      const metaRows = this.ctx.storage.sql
        .exec<{ key: string; value: string }>("SELECT key, value FROM live_meta")
        .toArray();
      for (const row of metaRows) {
        if (row.key === "agencyId") this.agencyId = row.value;
        if (row.key === "cursor") this.cursor = Number(row.value) || 0;
        if (row.key === "feedStatus") this.feedStatus = row.value as FeedHealthStatus;
        if (row.key === "lastSuccessAt") this.lastSuccessAt = row.value || null;
        if (row.key === "staleAfterSeconds") this.staleAfterSeconds = Number(row.value) || 120;
      }
    });
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO live_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value
    );
  }

  private hydrateVehicle(raw: LiveVehicleState, nowMs: number): LiveVehicleState {
    const refMs = raw.observedAt ? Date.parse(raw.observedAt) : Date.parse(raw.receivedAt);
    const ageSeconds = Math.max(0, Math.round((nowMs - refMs) / 1000));
    const freshness: LiveVehicleState["freshness"] =
      ageSeconds > this.staleAfterSeconds
        ? "stale"
        : ageSeconds > Math.round(this.staleAfterSeconds * 0.65)
          ? "delayed"
          : "fresh";
    return { ...raw, ageSeconds, freshness };
  }

  async ingestPositions(input: {
    agencyId: string;
    observations: Observation[];
    incrementality: "FULL_DATASET" | "DIFFERENTIAL";
    staleAfterSeconds: number;
    feedTimestamp: string | null;
    receivedAt: string;
  }): Promise<{
    cursor: number;
    upserts: number;
    removed: number;
    accepted: number;
    rejected: number;
    duplicates: number;
    changedObservations: Observation[];
    newVehicles: Observation[];
    assignmentChanges: Observation[];
  }> {
    this.agencyId = input.agencyId;
    this.staleAfterSeconds = input.staleAfterSeconds;
    this.feedStatus = "fresh";
    this.lastSuccessAt = input.receivedAt;
    this.setMeta("agencyId", this.agencyId);
    this.setMeta("staleAfterSeconds", String(this.staleAfterSeconds));
    this.setMeta("feedStatus", this.feedStatus);
    this.setMeta("lastSuccessAt", this.lastSuccessAt);

    const nowMs = Date.now();
    const existingRows = this.ctx.storage.sql
      .exec<StoredVehicleRow>(
        "SELECT source_vehicle_id, vehicle_id, route_id, trip_id, observed_ms, received_ms, payload_json FROM live_vehicles"
      )
      .toArray();
    const existingMap = new Map<string, { row: StoredVehicleRow; state: LiveVehicleState }>();
    for (const r of existingRows) {
      existingMap.set(r.source_vehicle_id, { row: r, state: JSON.parse(r.payload_json) as LiveVehicleState });
    }

    const knownSet = new Set(
      this.ctx.storage.sql.exec<{ vehicle_id: string }>("SELECT vehicle_id FROM known_vehicles").toArray().map((r) => r.vehicle_id)
    );

    // Pull latest trip delays from DO SQLite so live vehicles reflect GTFS-RT TripUpdates immediately
    const delayMap = new Map<string, number>();
    for (const tu of this.ctx.storage.sql
      .exec<{ trip_id: string; delay_sec: number | null }>("SELECT trip_id, delay_sec FROM live_trip_updates WHERE delay_sec IS NOT NULL")
      .toArray()) {
      if (tu.delay_sec !== null) delayMap.set(tu.trip_id, tu.delay_sec);
    }

    const upserts: LiveVehicleState[] = [];
    const changedObservations: Observation[] = [];
    const newVehicles: Observation[] = [];
    const assignmentChanges: Observation[] = [];
    const seenIds = new Set<string>();

    let accepted = 0;
    let rejected = 0;
    let duplicates = 0;

    for (const obs of input.observations) {
      seenIds.add(obs.sourceVehicleId);
      const prevEntry = existingMap.get(obs.sourceVehicleId);
      const prevObs: Observation | null = prevEntry
        ? {
            ...obs,
            lat: prevEntry.state.lat,
            lon: prevEntry.state.lon,
            observedAt: prevEntry.state.observedAt,
            receivedAt: prevEntry.state.receivedAt,
          }
        : null;

      const check = validateObservationQuality(obs, prevObs);
      if (!check.valid) {
        rejected++;
        continue;
      }

      accepted++;
      const obsMs = obs.observedAt ? Date.parse(obs.observedAt) : Date.parse(obs.receivedAt);
      const rxMs = Date.parse(obs.receivedAt);

      // Preserve newer live state when out-of-order data arrives (PRD §6.4)
      if (prevEntry && obsMs < prevEntry.row.observed_ms) {
        continue;
      }

      const scheduleDeviationSec =
        obs.scheduleDeviationSec ??
        (obs.tripId ? delayMap.get(obs.tripId) ?? null : null) ??
        prevEntry?.state.scheduleDeviationSec ??
        null;

      const cleaned: Observation = {
        ...obs,
        scheduleDeviationSec,
        qualityFlags: check.flags,
      };

      const isDuplicate =
        prevEntry &&
        prevEntry.state.observedAt === cleaned.observedAt &&
        Math.abs(prevEntry.state.lat - cleaned.lat) < 0.00001 &&
        Math.abs(prevEntry.state.lon - cleaned.lon) < 0.00001 &&
        prevEntry.state.tripId === cleaned.tripId;

      if (isDuplicate) {
        duplicates++;
      } else {
        changedObservations.push(cleaned);
      }

      if (!knownSet.has(cleaned.vehicleId)) {
        knownSet.add(cleaned.vehicleId);
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO known_vehicles (vehicle_id, first_seen_ms) VALUES (?, ?)",
          cleaned.vehicleId,
          nowMs
        );
        newVehicles.push(cleaned);
      }

      // Only record a D1 assignment write when a vehicle starts or switches route/trip
      const assignmentChanged =
        (cleaned.routeId || cleaned.tripId) &&
        (!prevEntry || prevEntry.state.routeId !== cleaned.routeId || prevEntry.state.tripId !== cleaned.tripId);
      if (assignmentChanged) {
        assignmentChanges.push(cleaned);
      }

      const state: LiveVehicleState = this.hydrateVehicle(
        {
          agencyId: cleaned.agencyId,
          sourceVehicleId: cleaned.sourceVehicleId,
          vehicleId: cleaned.vehicleId,
          fleetNumber: cleaned.fleetNumber,
          label: cleaned.label,
          routeId: cleaned.routeId,
          tripId: cleaned.tripId,
          blockId: cleaned.blockId,
          directionId: cleaned.directionId,
          lat: cleaned.lat,
          lon: cleaned.lon,
          bearingDeg: cleaned.bearingDeg,
          speedMps: cleaned.speedMps,
          scheduleDeviationSec: cleaned.scheduleDeviationSec,
          currentStatus: cleaned.currentStatus,
          stopId: cleaned.stopId,
          stopSequence: cleaned.stopSequence,
          occupancyStatus: cleaned.occupancyStatus,
          observedAt: cleaned.observedAt,
          receivedAt: cleaned.receivedAt,
          timestampBasis: cleaned.timestampBasis,
          ageSeconds: 0,
          freshness: "fresh",
          qualityFlags: cleaned.qualityFlags,
          matchMethod: cleaned.matchMethod,
          matchConfidence: cleaned.matchConfidence,
        },
        nowMs
      );

      this.ctx.storage.sql.exec(
        `INSERT INTO live_vehicles (source_vehicle_id, vehicle_id, route_id, trip_id, observed_ms, received_ms, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_vehicle_id) DO UPDATE SET
           vehicle_id = excluded.vehicle_id,
           route_id = excluded.route_id,
           trip_id = excluded.trip_id,
           observed_ms = excluded.observed_ms,
           received_ms = excluded.received_ms,
           payload_json = excluded.payload_json`,
        cleaned.sourceVehicleId,
        cleaned.vehicleId,
        cleaned.routeId,
        cleaned.tripId,
        obsMs,
        rxMs,
        JSON.stringify(state)
      );
      upserts.push(state);
    }

    // Expire vehicles absent for > 10 minutes on FULL_DATASET (never delete on DIFFERENTIAL or empty feed)
    const removed: string[] = [];
    if (input.incrementality === "FULL_DATASET" && input.observations.length > 0) {
      const expireBeforeMs = nowMs - Math.max(600_000, this.staleAfterSeconds * 4 * 1000);
      for (const [id, entry] of existingMap) {
        if (!seenIds.has(id) && entry.row.received_ms < expireBeforeMs) {
          this.ctx.storage.sql.exec("DELETE FROM live_vehicles WHERE source_vehicle_id = ?", id);
          removed.push(id);
        }
      }
    }

    this.cursor += 1;
    this.setMeta("cursor", String(this.cursor));

    const deltaMsg: LiveWsServerMessage = {
      type: "delta",
      agencyId: this.agencyId,
      cursor: this.cursor,
      serverTime: new Date(nowMs).toISOString(),
      upserts,
      removed,
    };

    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO delta_log (cursor, created_ms, payload_json) VALUES (?, ?, ?)",
      this.cursor,
      nowMs,
      JSON.stringify(deltaMsg)
    );
    this.ctx.storage.sql.exec("DELETE FROM delta_log WHERE cursor < ?", this.cursor - 120);

    this.broadcastDelta(deltaMsg);

    return {
      cursor: this.cursor,
      upserts: upserts.length,
      removed: removed.length,
      accepted,
      rejected,
      duplicates,
      changedObservations,
      newVehicles,
      assignmentChanges,
    };
  }

  async ingestTripUpdates(tripUpdates: NormalizedTripUpdate[]): Promise<{ stored: number }> {
    const nowMs = Date.now();
    for (const tu of tripUpdates.slice(0, 600)) {
      this.ctx.storage.sql.exec(
        `INSERT INTO live_trip_updates (trip_id, service_date, route_id, vehicle_id, delay_sec, payload_json, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trip_id) DO UPDATE SET
           service_date = excluded.service_date,
           route_id = COALESCE(excluded.route_id, live_trip_updates.route_id),
           vehicle_id = COALESCE(excluded.vehicle_id, live_trip_updates.vehicle_id),
           delay_sec = excluded.delay_sec,
           payload_json = excluded.payload_json,
           updated_ms = excluded.updated_ms`,
        tu.tripId,
        tu.serviceDate,
        tu.routeId,
        tu.vehicleId,
        tu.delaySec,
        JSON.stringify({ ...tu, stopUpdates: tu.stopUpdates.slice(0, 40) }),
        nowMs
      );
    }
    // Prune stale trip updates older than 4 hours
    this.ctx.storage.sql.exec("DELETE FROM live_trip_updates WHERE updated_ms < ?", nowMs - 4 * 3600 * 1000);
    return { stored: Math.min(600, tripUpdates.length) };
  }

  async getTripUpdates(filters?: { serviceDate?: string; tripId?: string }): Promise<NormalizedTripUpdate[]> {
    const rows = filters?.tripId
      ? this.ctx.storage.sql
          .exec<StoredTripUpdateRow>("SELECT * FROM live_trip_updates WHERE trip_id = ? LIMIT 1", filters.tripId)
          .toArray()
      : filters?.serviceDate
        ? this.ctx.storage.sql
            .exec<StoredTripUpdateRow>(
              "SELECT * FROM live_trip_updates WHERE service_date = ? ORDER BY updated_ms DESC LIMIT 500",
              filters.serviceDate
            )
            .toArray()
        : this.ctx.storage.sql
            .exec<StoredTripUpdateRow>("SELECT * FROM live_trip_updates ORDER BY updated_ms DESC LIMIT 500")
            .toArray();
    return rows.map((r) => JSON.parse(r.payload_json) as NormalizedTripUpdate);
  }

  async getVehicle(vehicleId: string): Promise<LiveVehicleState | null> {
    const rows = this.ctx.storage.sql
      .exec<{ payload_json: string }>(
        "SELECT payload_json FROM live_vehicles WHERE vehicle_id = ? OR source_vehicle_id = ? LIMIT 1",
        vehicleId,
        vehicleId
      )
      .toArray();
    if (!rows[0]) return null;
    return this.hydrateVehicle(JSON.parse(rows[0].payload_json) as LiveVehicleState, Date.now());
  }

  async getVehicleByTrip(tripId: string): Promise<LiveVehicleState | null> {
    const rows = this.ctx.storage.sql
      .exec<{ payload_json: string }>("SELECT payload_json FROM live_vehicles WHERE trip_id = ? LIMIT 1", tripId)
      .toArray();
    if (!rows[0]) return null;
    return this.hydrateVehicle(JSON.parse(rows[0].payload_json) as LiveVehicleState, Date.now());
  }

  async getStats(): Promise<{
    activeCount: number;
    routeCounts: Record<string, number>;
    feedStatus: FeedHealthStatus;
    lastSuccessAt: string | null;
  }> {
    const rows = this.ctx.storage.sql
      .exec<{ route_id: string | null; c: number }>(
        "SELECT route_id, COUNT(*) as c FROM live_vehicles GROUP BY route_id"
      )
      .toArray();
    let activeCount = 0;
    const routeCounts: Record<string, number> = {};
    for (const r of rows) {
      activeCount += r.c;
      if (r.route_id) routeCounts[r.route_id] = r.c;
    }
    return {
      activeCount,
      routeCounts,
      feedStatus: this.feedStatus,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  async updateFeedStatus(input: {
    agencyId: string;
    feedStatus: FeedHealthStatus;
    lastSuccessAt?: string | null;
    message?: string;
  }): Promise<void> {
    this.agencyId = input.agencyId;
    this.feedStatus = input.feedStatus;
    if (input.lastSuccessAt !== undefined) {
      this.lastSuccessAt = input.lastSuccessAt;
      this.setMeta("lastSuccessAt", input.lastSuccessAt ?? "");
    }
    this.setMeta("agencyId", this.agencyId);
    this.setMeta("feedStatus", this.feedStatus);

    const statusMsg: LiveWsServerMessage = {
      type: "status",
      agencyId: this.agencyId,
      feedStatus: this.feedStatus,
      lastSuccessAt: this.lastSuccessAt,
      message: input.message,
    };
    const encoded = JSON.stringify(statusMsg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(encoded);
      } catch {
        // Ignore dead socket
      }
    }
  }

  async getSnapshot(filters?: {
    agencyId?: string;
    routeId?: string;
    bbox?: [number, number, number, number];
  }): Promise<{
    agencyId: string;
    cursor: number;
    serverTime: string;
    feedStatus: FeedHealthStatus;
    lastSuccessAt: string | null;
    vehicles: LiveVehicleState[];
    connectedClients: number;
  }> {
    if (filters?.agencyId && !this.agencyId) {
      this.agencyId = filters.agencyId;
    }
    const nowMs = Date.now();
    const rows = filters?.routeId
      ? this.ctx.storage.sql
          .exec<StoredVehicleRow>(
            "SELECT source_vehicle_id, vehicle_id, route_id, trip_id, observed_ms, received_ms, payload_json FROM live_vehicles WHERE route_id = ?",
            filters.routeId
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<StoredVehicleRow>(
            "SELECT source_vehicle_id, vehicle_id, route_id, trip_id, observed_ms, received_ms, payload_json FROM live_vehicles"
          )
          .toArray();

    let vehicles = rows.map((r) => this.hydrateVehicle(JSON.parse(r.payload_json) as LiveVehicleState, nowMs));

    if (filters?.bbox) {
      const [minLon, minLat, maxLon, maxLat] = filters.bbox;
      vehicles = vehicles.filter(
        (v) => v.lon >= minLon && v.lon <= maxLon && v.lat >= minLat && v.lat <= maxLat
      );
    }

    const effectiveStatus: FeedHealthStatus =
      this.feedStatus === "fresh" &&
      this.lastSuccessAt &&
      (nowMs - Date.parse(this.lastSuccessAt)) / 1000 > this.staleAfterSeconds
        ? "stale"
        : this.feedStatus;

    return {
      agencyId: this.agencyId,
      cursor: this.cursor,
      serverTime: new Date(nowMs).toISOString(),
      feedStatus: effectiveStatus,
      lastSuccessAt: this.lastSuccessAt,
      vehicles,
      connectedClients: this.ctx.getWebSockets().length,
    };
  }

  private broadcastDelta(delta: Extract<LiveWsServerMessage, { type: "delta" }>): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const fullEncoded = JSON.stringify(delta);

    for (const ws of sockets) {
      try {
        const attachment = (ws.deserializeAttachment() as WsAttachment | null) ?? {
          agencyId: this.agencyId,
        };
        if (attachment.routeId) {
          const filteredUpserts = delta.upserts.filter((v) => v.routeId === attachment.routeId);
          if (filteredUpserts.length === 0 && delta.removed.length === 0) continue;
          ws.send(JSON.stringify({ ...delta, upserts: filteredUpserts }));
        } else {
          ws.send(fullEncoded);
        }
      } catch {
        try {
          ws.close(1011, "Send failed");
        } catch {
          // ignore
        }
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const agencyId = url.searchParams.get("agency") || this.agencyId || "guelph";
    const routeId = url.searchParams.get("route") || undefined;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ agencyId, routeId } satisfies WsAttachment);

    const snapshot = await this.getSnapshot({ agencyId, routeId });
    const msg: LiveWsServerMessage = {
      type: "snapshot",
      agencyId: snapshot.agencyId || agencyId,
      cursor: snapshot.cursor,
      serverTime: snapshot.serverTime,
      feedStatus: snapshot.feedStatus,
      lastSuccessAt: snapshot.lastSuccessAt,
      vehicles: snapshot.vehicles,
    };
    server.send(JSON.stringify(msg));

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let parsed: LiveWsClientMessage;
    try {
      parsed = JSON.parse(message) as LiveWsClientMessage;
    } catch {
      return;
    }

    if (parsed.type === "ping") {
      const pong: LiveWsServerMessage = {
        type: "pong",
        ts: parsed.ts,
        serverTime: new Date().toISOString(),
      };
      ws.send(JSON.stringify(pong));
      return;
    }

    if (parsed.type === "subscribe") {
      ws.serializeAttachment({
        agencyId: parsed.agencyId,
        routeId: parsed.routeId,
      } satisfies WsAttachment);

      if (parsed.cursor !== undefined && parsed.cursor < this.cursor) {
        const missed = this.ctx.storage.sql
          .exec<{ payload_json: string }>(
            "SELECT payload_json FROM delta_log WHERE cursor > ? ORDER BY cursor ASC LIMIT 40",
            parsed.cursor
          )
          .toArray();

        if (missed.length === 0 || this.cursor - parsed.cursor > 40) {
          const snap = await this.getSnapshot({ agencyId: parsed.agencyId, routeId: parsed.routeId });
          ws.send(
            JSON.stringify({
              type: "snapshot",
              agencyId: snap.agencyId || parsed.agencyId,
              cursor: snap.cursor,
              serverTime: snap.serverTime,
              feedStatus: snap.feedStatus,
              lastSuccessAt: snap.lastSuccessAt,
              vehicles: snap.vehicles,
            } satisfies LiveWsServerMessage)
          );
          return;
        }
        for (const row of missed) {
          ws.send(row.payload_json);
        }
      } else {
        const snap = await this.getSnapshot({ agencyId: parsed.agencyId, routeId: parsed.routeId });
        ws.send(
          JSON.stringify({
            type: "snapshot",
            agencyId: snap.agencyId || parsed.agencyId,
            cursor: snap.cursor,
            serverTime: snap.serverTime,
            feedStatus: snap.feedStatus,
            lastSuccessAt: snap.lastSuccessAt,
            vehicles: snap.vehicles,
          } satisfies LiveWsServerMessage)
        );
      }
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "WebSocket error");
    } catch {
      // ignore
    }
  }
}
