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

interface StoredVehicleEntry {
  observedMs: number;
  receivedMs: number;
  state: LiveVehicleState;
}

interface StoredTripUpdateEntry {
  updatedMs: number;
  update: NormalizedTripUpdate;
}

interface WsAttachment {
  agencyId: string;
  routeId?: string;
}

/**
 * AgencyLiveDO keeps real-time fleet state, trip updates, and recent delta frames
 * purely in Durable Object RAM — zero DO SQLite rows written per poll — so high-frequency
 * agencies like TTC (~1,000 vehicles/min) stay at 0% of Cloudflare's free DO SQLite write quota.
 */
export class AgencyLiveDO extends DurableObject<Env> {
  private agencyId = "";
  private cursor = 0;
  private feedStatus: FeedHealthStatus = "unknown";
  private lastSuccessAt: string | null = null;
  private staleAfterSeconds = 120;
  private lastPersistedMs = 0;

  private vehicles = new Map<string, StoredVehicleEntry>();
  private knownVehicleIds = new Set<string>();
  private tripUpdates = new Map<string, StoredTripUpdateEntry>();
  private deltaLog: Array<{ cursor: number; payloadJson: string }> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Rehydrate the latest compact snapshot row after Cloudflare DO hibernation (1 row read)
    ctx.blockConcurrencyWhile(async () => {
      try {
        const rows = this.ctx.storage.sql
          .exec<{ value: string }>("SELECT value FROM live_snapshot WHERE key = 'latest'")
          .toArray();
        if (!rows[0]?.value) return;
        const parsed = JSON.parse(rows[0].value) as {
          agencyId?: string;
          cursor?: number;
          feedStatus?: FeedHealthStatus;
          lastSuccessAt?: string | null;
          staleAfterSeconds?: number;
          vehicles?: Array<[string, StoredVehicleEntry]>;
        };
        if (parsed.agencyId) this.agencyId = parsed.agencyId;
        if (typeof parsed.cursor === "number") this.cursor = parsed.cursor;
        if (parsed.feedStatus) this.feedStatus = parsed.feedStatus;
        if (parsed.lastSuccessAt !== undefined) this.lastSuccessAt = parsed.lastSuccessAt;
        if (typeof parsed.staleAfterSeconds === "number") this.staleAfterSeconds = parsed.staleAfterSeconds;
        if (Array.isArray(parsed.vehicles)) {
          const cutoffMs = Date.now() - 15 * 60_000;
          for (const [id, entry] of parsed.vehicles) {
            if (entry && entry.receivedMs >= cutoffMs) {
              this.vehicles.set(id, entry);
              this.knownVehicleIds.add(entry.state.vehicleId);
            }
          }
        }
      } catch {
        // Table not yet created on a brand-new DO; will be initialized on first ingest
      }
    });
  }

  /** Persist the whole live map as 1 single SQLite row (max once per 45s) so hibernation never loses data. */
  private persistSnapshotBestEffort(nowMs: number): void {
    if (nowMs - this.lastPersistedMs < 45_000) return;
    this.lastPersistedMs = nowMs;
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS live_snapshot (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      const payload = JSON.stringify({
        agencyId: this.agencyId,
        cursor: this.cursor,
        feedStatus: this.feedStatus,
        lastSuccessAt: this.lastSuccessAt,
        staleAfterSeconds: this.staleAfterSeconds,
        vehicles: Array.from(this.vehicles.entries()),
      });
      this.ctx.storage.sql.exec(
        "INSERT INTO live_snapshot (key, value) VALUES ('latest', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        payload
      );
    } catch {
      // Non-fatal: RAM remains authoritative while awake
    }
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

    const nowMs = Date.now();

    // Pull latest trip delays from memory so live vehicles reflect GTFS-RT TripUpdates immediately
    const delayMap = new Map<string, number>();
    for (const [tripId, entry] of this.tripUpdates) {
      if (entry.update.delaySec !== null) delayMap.set(tripId, entry.update.delaySec);
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
      const prevEntry = this.vehicles.get(obs.sourceVehicleId);
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
      if (prevEntry && obsMs < prevEntry.observedMs) {
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

      if (!this.knownVehicleIds.has(cleaned.vehicleId)) {
        this.knownVehicleIds.add(cleaned.vehicleId);
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

      this.vehicles.set(cleaned.sourceVehicleId, {
        observedMs: obsMs,
        receivedMs: rxMs,
        state,
      });
      upserts.push(state);
    }

    // Expire vehicles absent for > 10 minutes on FULL_DATASET (never delete on DIFFERENTIAL or empty feed)
    const removed: string[] = [];
    if (input.incrementality === "FULL_DATASET" && input.observations.length > 0) {
      const expireBeforeMs = nowMs - Math.max(600_000, this.staleAfterSeconds * 4 * 1000);
      for (const [id, entry] of this.vehicles) {
        if (!seenIds.has(id) && entry.receivedMs < expireBeforeMs) {
          this.vehicles.delete(id);
          removed.push(id);
        }
      }
    }

    this.cursor += 1;

    const deltaMsg: LiveWsServerMessage = {
      type: "delta",
      agencyId: this.agencyId,
      cursor: this.cursor,
      serverTime: new Date(nowMs).toISOString(),
      upserts,
      removed,
    };

    const encodedDelta = JSON.stringify(deltaMsg);
    this.deltaLog.push({ cursor: this.cursor, payloadJson: encodedDelta });
    if (this.deltaLog.length > 60) {
      this.deltaLog.splice(0, this.deltaLog.length - 60);
    }

    this.broadcastDelta(deltaMsg, encodedDelta);
    this.persistSnapshotBestEffort(nowMs);

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
      const existing = this.tripUpdates.get(tu.tripId);
      this.tripUpdates.set(tu.tripId, {
        updatedMs: nowMs,
        update: {
          ...tu,
          routeId: tu.routeId ?? existing?.update.routeId ?? null,
          vehicleId: tu.vehicleId ?? existing?.update.vehicleId ?? null,
          stopUpdates: tu.stopUpdates.slice(0, 40),
        },
      });
    }
    // Prune stale trip updates older than 3 hours
    const cutoff = nowMs - 3 * 3600 * 1000;
    for (const [tripId, entry] of this.tripUpdates) {
      if (entry.updatedMs < cutoff) this.tripUpdates.delete(tripId);
    }
    return { stored: Math.min(600, tripUpdates.length) };
  }

  async getTripUpdates(filters?: { serviceDate?: string; tripId?: string }): Promise<NormalizedTripUpdate[]> {
    if (filters?.tripId) {
      const found = this.tripUpdates.get(filters.tripId);
      return found ? [found.update] : [];
    }
    const out: NormalizedTripUpdate[] = [];
    for (const entry of this.tripUpdates.values()) {
      if (filters?.serviceDate && entry.update.serviceDate !== filters.serviceDate) continue;
      out.push(entry.update);
      if (out.length >= 500) break;
    }
    return out;
  }

  async getVehicle(vehicleId: string): Promise<LiveVehicleState | null> {
    const nowMs = Date.now();
    const direct = this.vehicles.get(vehicleId);
    if (direct) return this.hydrateVehicle(direct.state, nowMs);
    for (const entry of this.vehicles.values()) {
      if (entry.state.vehicleId === vehicleId) {
        return this.hydrateVehicle(entry.state, nowMs);
      }
    }
    return null;
  }

  async getVehicleByTrip(tripId: string): Promise<LiveVehicleState | null> {
    const nowMs = Date.now();
    for (const entry of this.vehicles.values()) {
      if (entry.state.tripId === tripId) {
        return this.hydrateVehicle(entry.state, nowMs);
      }
    }
    return null;
  }

  async getStats(): Promise<{
    activeCount: number;
    routeCounts: Record<string, number>;
    feedStatus: FeedHealthStatus;
    lastSuccessAt: string | null;
  }> {
    let activeCount = 0;
    const routeCounts: Record<string, number> = {};
    for (const entry of this.vehicles.values()) {
      activeCount++;
      const r = entry.state.routeId;
      if (r) routeCounts[r] = (routeCounts[r] ?? 0) + 1;
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
    }

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
    let vehicles: LiveVehicleState[] = [];
    for (const entry of this.vehicles.values()) {
      if (filters?.routeId && entry.state.routeId !== filters.routeId) continue;
      const hydrated = this.hydrateVehicle(entry.state, nowMs);
      if (filters?.bbox) {
        const [minLon, minLat, maxLon, maxLat] = filters.bbox;
        if (hydrated.lon < minLon || hydrated.lon > maxLon || hydrated.lat < minLat || hydrated.lat > maxLat) {
          continue;
        }
      }
      vehicles.push(hydrated);
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

  private broadcastDelta(
    delta: Extract<LiveWsServerMessage, { type: "delta" }>,
    fullEncoded: string
  ): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;

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
    // Avoid sending an empty snapshot from a cold/hibernated DO before its first poll
    if (snapshot.vehicles.length > 0 || snapshot.cursor > 0) {
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
    } else {
      server.send(
        JSON.stringify({
          type: "status",
          agencyId: snapshot.agencyId || agencyId,
          feedStatus: snapshot.feedStatus,
          lastSuccessAt: snapshot.lastSuccessAt,
        } satisfies LiveWsServerMessage)
      );
    }

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

      if (parsed.cursor !== undefined && parsed.cursor < this.cursor && this.cursor - parsed.cursor <= 40) {
        const missed = this.deltaLog.filter((d) => d.cursor > parsed.cursor!);
        if (missed.length > 0 && !parsed.routeId) {
          for (const item of missed) {
            ws.send(item.payloadJson);
          }
          return;
        }
      }

      const snap = await this.getSnapshot({ agencyId: parsed.agencyId, routeId: parsed.routeId });
      if (snap.vehicles.length > 0 || snap.cursor > 0) {
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
      } else {
        ws.send(
          JSON.stringify({
            type: "status",
            agencyId: snap.agencyId || parsed.agencyId,
            feedStatus: snap.feedStatus,
            lastSuccessAt: snap.lastSuccessAt,
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
