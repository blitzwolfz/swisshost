import { DurableObject } from "cloudflare:workers";
import type {
  FeedHealthStatus,
  LiveVehicleState,
  LiveWsClientMessage,
  LiveWsServerMessage,
  Observation,
} from "@swisshost/contracts";
import type { Env } from "../../api/src/env";

type StoredVehicleRow = {
  source_vehicle_id: string;
  payload_json: string;
  observed_ms: number;
  received_ms: number;
  route_id: string | null;
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
          route_id TEXT,
          observed_ms INTEGER NOT NULL,
          received_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL
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
  }): Promise<{ cursor: number; upserts: number; removed: number }> {
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
        "SELECT source_vehicle_id, route_id, observed_ms, received_ms, payload_json FROM live_vehicles"
      )
      .toArray();
    const existingMap = new Map<string, StoredVehicleRow>();
    for (const r of existingRows) {
      existingMap.set(r.source_vehicle_id, r);
    }

    const upserts: LiveVehicleState[] = [];
    const seenIds = new Set<string>();

    for (const obs of input.observations) {
      seenIds.add(obs.sourceVehicleId);
      const obsMs = obs.observedAt ? Date.parse(obs.observedAt) : Date.parse(obs.receivedAt);
      const rxMs = Date.parse(obs.receivedAt);
      const prev = existingMap.get(obs.sourceVehicleId);

      // Preserve newer live state when out-of-order data arrives (PRD §6.4)
      if (prev && obsMs < prev.observed_ms) {
        continue;
      }

      const state: LiveVehicleState = this.hydrateVehicle(
        {
          agencyId: obs.agencyId,
          sourceVehicleId: obs.sourceVehicleId,
          vehicleId: obs.vehicleId,
          fleetNumber: obs.fleetNumber,
          label: obs.label,
          routeId: obs.routeId,
          tripId: obs.tripId,
          blockId: obs.blockId,
          directionId: obs.directionId,
          lat: obs.lat,
          lon: obs.lon,
          bearingDeg: obs.bearingDeg,
          speedMps: obs.speedMps,
          scheduleDeviationSec: obs.scheduleDeviationSec,
          currentStatus: obs.currentStatus,
          stopId: obs.stopId,
          stopSequence: obs.stopSequence,
          occupancyStatus: obs.occupancyStatus,
          observedAt: obs.observedAt,
          receivedAt: obs.receivedAt,
          timestampBasis: obs.timestampBasis,
          ageSeconds: 0,
          freshness: "fresh",
          qualityFlags: obs.qualityFlags,
          matchMethod: obs.matchMethod,
          matchConfidence: obs.matchConfidence,
        },
        nowMs
      );

      this.ctx.storage.sql.exec(
        `INSERT INTO live_vehicles (source_vehicle_id, route_id, observed_ms, received_ms, payload_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_vehicle_id) DO UPDATE SET
           route_id = excluded.route_id,
           observed_ms = excluded.observed_ms,
           received_ms = excluded.received_ms,
           payload_json = excluded.payload_json`,
        obs.sourceVehicleId,
        obs.routeId,
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
      for (const [id, row] of existingMap) {
        if (!seenIds.has(id) && row.received_ms < expireBeforeMs) {
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

    // Broadcast to hibernated WebSockets
    this.broadcastDelta(deltaMsg);

    return { cursor: this.cursor, upserts: upserts.length, removed: removed.length };
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
            "SELECT source_vehicle_id, route_id, observed_ms, received_ms, payload_json FROM live_vehicles WHERE route_id = ?",
            filters.routeId
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<StoredVehicleRow>(
            "SELECT source_vehicle_id, route_id, observed_ms, received_ms, payload_json FROM live_vehicles"
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
