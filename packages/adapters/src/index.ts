import { unzipSync } from "fflate";
import type {
  FeedKind,
  NormalizedAlert,
  NormalizedBatch,
  NormalizedTripUpdate,
  Observation,
  StopTimeUpdate,
} from "@swisshost/contracts";
import { getLocalServiceContext, parseGtfsTimeToSeconds, resolveFleetNumber } from "@swisshost/transit-core";

export const ADAPTER_VERSION = "swisshost-adapters/1.0.0";

const ALLOWED_HOST_SUFFIXES = [
  "guelph.ca",
  "glphtrpcloud.com",
  "drive.usercontent.google.com",
  "toronto.ca",
  "ttc.ca",
  "umoiq.com",
  "metrolinx.com",
  "openmetrolinx.com",
  "regionofwaterloo.ca",
  "miapp.ca",
  "mississauga.ca",
  "brampton.ca",
  "bt-cadavl.com",
  "arcgis.com",
  "transit.land",
  "mobilitydatabase.org",
  "nextlift.ca",
  "thunderbay.ca",
];

/**
 * SSRF protection: require HTTPS, reject private/loopback/link-local IPs, and check reviewed host allowlist unless explicitly overridden in tests.
 */
export function validateFeedUrl(rawUrl: string, allowCustomPublicHttps = false): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") {
    throw new Error(`Feed URL must use HTTPS: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ||
    host.includes(":")
  ) {
    throw new Error(`Blocked non-public or IP-literal feed host: ${host}`);
  }
  if (!allowCustomPublicHttps) {
    const allowed = ALLOWED_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`)
    );
    if (!allowed) {
      throw new Error(`Feed host is not in the reviewed transit allowlist: ${host}`);
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Native zero-bloat Protobuf wire reader (GTFS-Realtime v2 compliant)
// ---------------------------------------------------------------------------

class ProtoReader {
  private pos = 0;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array, private readonly end = buf.length) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  hasMore(): boolean {
    return this.pos < this.end;
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.end) {
      const byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 53) throw new Error("Varint overflow in GTFS-RT payload");
    }
    throw new Error("Unexpected EOF reading varint");
  }

  readSignedInt32(): number {
    const v = this.readVarint();
    return v > 0x7fffffff ? v - 0x100000000 : v;
  }

  readFloat(): number {
    if (this.pos + 4 > this.end) throw new Error("Unexpected EOF reading float");
    const val = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return val;
  }

  readDouble(): number {
    if (this.pos + 8 > this.end) throw new Error("Unexpected EOF reading double");
    const val = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return val;
  }

  readBytes(): Uint8Array {
    const len = this.readVarint();
    if (this.pos + len > this.end) throw new Error("Unexpected EOF reading bytes");
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.readVarint();
        return;
      case 1:
        this.pos += 8;
        return;
      case 2: {
        const len = this.readVarint();
        this.pos += len;
        return;
      }
      case 5:
        this.pos += 4;
        return;
      default:
        throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
  }
}

const VEHICLE_STOP_STATUS: Record<number, string> = {
  0: "INCOMING_AT",
  1: "STOPPED_AT",
  2: "IN_TRANSIT_TO",
};

const OCCUPANCY_STATUS: Record<number, string> = {
  0: "EMPTY",
  1: "MANY_SEATS_AVAILABLE",
  2: "FEW_SEATS_AVAILABLE",
  3: "STANDING_ROOM_ONLY",
  4: "CRUSHED_STANDING_ROOM_ONLY",
  5: "FULL",
  6: "NOT_ACCEPTING_PASSENGERS",
  7: "NO_DATA_AVAILABLE",
  8: "NOT_BOARDABLE",
};

const TRIP_SCHEDULE_REL: Record<number, string> = {
  0: "SCHEDULED",
  1: "ADDED",
  2: "UNSCHEDULED",
  3: "CANCELED",
  5: "REPLACEMENT",
  6: "DUPLICATED",
};

const STOP_TIME_REL: Record<number, string> = {
  0: "SCHEDULED",
  1: "SKIPPED",
  2: "NO_DATA",
  3: "UNSCHEDULED",
};

const ALERT_CAUSE: Record<number, string> = {
  1: "UNKNOWN_CAUSE",
  2: "OTHER_CAUSE",
  3: "TECHNICAL_PROBLEM",
  4: "STRIKE",
  5: "DEMONSTRATION",
  6: "ACCIDENT",
  7: "HOLIDAY",
  8: "WEATHER",
  9: "MAINTENANCE",
  10: "CONSTRUCTION",
  11: "POLICE_ACTIVITY",
  12: "MEDICAL_EMERGENCY",
};

const ALERT_EFFECT: Record<number, string> = {
  1: "NO_SERVICE",
  2: "REDUCED_SERVICE",
  3: "SIGNIFICANT_DELAYS",
  4: "DETOUR",
  5: "ADDITIONAL_SERVICE",
  6: "MODIFIED_SERVICE",
  7: "OTHER_EFFECT",
  8: "UNKNOWN_EFFECT",
  9: "STOP_MOVED",
  10: "NO_EFFECT",
  11: "ACCESSIBILITY_ISSUE",
};

function readTranslatedString(bytes: Uint8Array): string {
  const r = new ProtoReader(bytes);
  let fallback = "";
  while (r.hasMore()) {
    const tag = r.readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      const tr = new ProtoReader(r.readBytes());
      let text = "";
      let lang = "";
      while (tr.hasMore()) {
        const ttag = tr.readVarint();
        const tf = ttag >>> 3;
        const tw = ttag & 7;
        if (tf === 1 && tw === 2) text = tr.readString();
        else if (tf === 2 && tw === 2) lang = tr.readString();
        else tr.skip(tw);
      }
      if (text && (!fallback || lang.toLowerCase().startsWith("en"))) {
        fallback = text;
      }
    } else {
      r.skip(wire);
    }
  }
  return fallback;
}

function readTripDescriptor(bytes: Uint8Array) {
  const r = new ProtoReader(bytes);
  let tripId: string | null = null;
  let routeId: string | null = null;
  let directionId: number | null = null;
  let startTime: string | null = null;
  let startDate: string | null = null;
  let scheduleRelationship = "SCHEDULED";

  while (r.hasMore()) {
    const tag = r.readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) tripId = r.readString();
    else if (field === 2 && wire === 2) startTime = r.readString();
    else if (field === 3 && wire === 2) startDate = r.readString();
    else if (field === 4 && wire === 0) scheduleRelationship = TRIP_SCHEDULE_REL[r.readVarint()] ?? "SCHEDULED";
    else if (field === 5 && wire === 2) routeId = r.readString();
    else if (field === 6 && wire === 0) directionId = r.readVarint();
    else r.skip(wire);
  }
  return { tripId, routeId, directionId, startTime, startDate, scheduleRelationship };
}

function readVehicleDescriptor(bytes: Uint8Array) {
  const r = new ProtoReader(bytes);
  let id: string | null = null;
  let label: string | null = null;
  let licensePlate: string | null = null;
  while (r.hasMore()) {
    const tag = r.readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) id = r.readString();
    else if (field === 2 && wire === 2) label = r.readString();
    else if (field === 3 && wire === 2) licensePlate = r.readString();
    else r.skip(wire);
  }
  return { id, label, licensePlate };
}

function readPosition(bytes: Uint8Array) {
  const r = new ProtoReader(bytes);
  let lat = NaN;
  let lon = NaN;
  let bearingDeg: number | null = null;
  let speedMps: number | null = null;
  while (r.hasMore()) {
    const tag = r.readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 5) lat = r.readFloat();
    else if (field === 2 && wire === 5) lon = r.readFloat();
    else if (field === 3 && wire === 5) bearingDeg = r.readFloat();
    else if (field === 5 && wire === 5) speedMps = r.readFloat();
    else r.skip(wire);
  }
  return { lat, lon, bearingDeg, speedMps };
}

function readStopTimeEvent(bytes: Uint8Array): { delay: number | null; time: string | null } {
  const r = new ProtoReader(bytes);
  let delay: number | null = null;
  let time: string | null = null;
  while (r.hasMore()) {
    const tag = r.readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) delay = r.readSignedInt32();
    else if (field === 2 && wire === 0) {
      const sec = r.readVarint();
      if (sec > 1_000_000_000) time = new Date(sec * 1000).toISOString();
    } else r.skip(wire);
  }
  return { delay, time };
}

export function decodeGtfsRtFeed(
  payload: Uint8Array,
  context: {
    sourceId: string;
    agencyId: string;
    feedKind: FeedKind;
    timezone: string;
    receivedAt?: string;
  }
): NormalizedBatch {
  const receivedAt = context.receivedAt ?? new Date().toISOString();
  const root = new ProtoReader(payload);
  let incrementality: "FULL_DATASET" | "DIFFERENTIAL" = "FULL_DATASET";
  let feedTimestamp: string | null = null;

  const observations: Observation[] = [];
  const tripUpdates: NormalizedTripUpdate[] = [];
  const alerts: NormalizedAlert[] = [];
  const qualityFlags: string[] = [];

  const serviceCtx = getLocalServiceContext(receivedAt, context.timezone);

  while (root.hasMore()) {
    const tag = root.readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;

    if (field === 1 && wire === 2) {
      // FeedHeader
      const hr = new ProtoReader(root.readBytes());
      while (hr.hasMore()) {
        const htag = hr.readVarint();
        const hf = htag >>> 3;
        const hw = htag & 7;
        if (hf === 2 && hw === 0) {
          incrementality = hr.readVarint() === 1 ? "DIFFERENTIAL" : "FULL_DATASET";
        } else if (hf === 3 && hw === 0) {
          const ts = hr.readVarint();
          if (ts > 1_000_000_000) feedTimestamp = new Date(ts * 1000).toISOString();
        } else {
          hr.skip(hw);
        }
      }
    } else if (field === 2 && wire === 2) {
      // FeedEntity
      const er = new ProtoReader(root.readBytes());
      let entityId = "";
      let isDeleted = false;
      let tripUpdateBytes: Uint8Array | null = null;
      let vehicleBytes: Uint8Array | null = null;
      let alertBytes: Uint8Array | null = null;

      while (er.hasMore()) {
        const etag = er.readVarint();
        const ef = etag >>> 3;
        const ew = etag & 7;
        if (ef === 1 && ew === 2) entityId = er.readString();
        else if (ef === 2 && ew === 0) isDeleted = er.readVarint() !== 0;
        else if (ef === 3 && ew === 2) tripUpdateBytes = er.readBytes();
        else if (ef === 4 && ew === 2) vehicleBytes = er.readBytes();
        else if (ef === 5 && ew === 2) alertBytes = er.readBytes();
        else er.skip(ew);
      }

      if (isDeleted) continue;

      if (vehicleBytes) {
        const vr = new ProtoReader(vehicleBytes);
        let trip = { tripId: null as string | null, routeId: null as string | null, directionId: null as number | null };
        let veh = { id: null as string | null, label: null as string | null, licensePlate: null as string | null };
        let pos: { lat: number; lon: number; bearingDeg: number | null; speedMps: number | null } | null = null;
        let stopSequence: number | null = null;
        let currentStatus: string | null = null;
        let tsSec: number | null = null;
        let stopId: string | null = null;
        let occupancyStatus: string | null = null;

        while (vr.hasMore()) {
          const vtag = vr.readVarint();
          const vf = vtag >>> 3;
          const vw = vtag & 7;
          if (vf === 1 && vw === 2) trip = readTripDescriptor(vr.readBytes());
          else if (vf === 2 && vw === 2) pos = readPosition(vr.readBytes());
          else if (vf === 3 && vw === 0) stopSequence = vr.readVarint();
          else if (vf === 4 && vw === 0) currentStatus = VEHICLE_STOP_STATUS[vr.readVarint()] ?? null;
          else if (vf === 5 && vw === 0) tsSec = vr.readVarint();
          else if (vf === 7 && vw === 2) stopId = vr.readString();
          else if (vf === 8 && vw === 2) veh = readVehicleDescriptor(vr.readBytes());
          else if (vf === 9 && vw === 0) occupancyStatus = OCCUPANCY_STATUS[vr.readVarint()] ?? null;
          else vr.skip(vw);
        }

        if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) {
          const sourceVehicleId = veh.id || veh.label || entityId;
          if (!sourceVehicleId) continue;
          const { vehicleId, fleetNumber } = resolveFleetNumber(sourceVehicleId, veh.label);
          const observedAt =
            tsSec && tsSec > 1_000_000_000
              ? new Date(tsSec * 1000).toISOString()
              : feedTimestamp;
          const timestampBasis =
            tsSec && tsSec > 1_000_000_000
              ? "vehicle"
              : feedTimestamp
                ? "feed"
                : "receipt";

          observations.push({
            sourceId: context.sourceId,
            agencyId: context.agencyId,
            sourceVehicleId,
            vehicleId,
            fleetNumber,
            label: veh.label,
            tripId: trip.tripId,
            routeId: trip.routeId,
            blockId: null,
            directionId: trip.directionId,
            lat: pos.lat,
            lon: pos.lon,
            bearingDeg: pos.bearingDeg !== null && Number.isFinite(pos.bearingDeg) ? pos.bearingDeg : null,
            speedMps: pos.speedMps !== null && Number.isFinite(pos.speedMps) && pos.speedMps >= 0 ? pos.speedMps : null,
            scheduleDeviationSec: null,
            currentStatus,
            stopId,
            stopSequence,
            occupancyStatus,
            observedAt,
            receivedAt,
            timestampBasis,
            qualityFlags: timestampBasis === "receipt" ? ["receipt_time_fallback"] : [],
            matchMethod: trip.tripId ? "explicit_trip" : "unmatched",
            matchConfidence: trip.tripId ? 0.9 : 0,
            rawRef: `${context.sourceId}:${entityId}`,
          });
        }
      }

      if (tripUpdateBytes) {
        const tur = new ProtoReader(tripUpdateBytes);
        let trip = {
          tripId: null as string | null,
          routeId: null as string | null,
          startDate: null as string | null,
          scheduleRelationship: "SCHEDULED",
        };
        let vehId: string | null = null;
        let tsSec: number | null = null;
        let delaySec: number | null = null;
        const stopUpdates: StopTimeUpdate[] = [];

        while (tur.hasMore()) {
          const tutag = tur.readVarint();
          const tuf = tutag >>> 3;
          const tuw = tutag & 7;
          if (tuf === 1 && tuw === 2) trip = readTripDescriptor(tur.readBytes());
          else if (tuf === 2 && tuw === 2) {
            const sr = new ProtoReader(tur.readBytes());
            let stopSequence: number | null = null;
            let stopId: string | null = null;
            let arr = { delay: null as number | null, time: null as string | null };
            let dep = { delay: null as number | null, time: null as string | null };
            let rel = "SCHEDULED";
            while (sr.hasMore()) {
              const stag = sr.readVarint();
              const sf = stag >>> 3;
              const sw = stag & 7;
              if (sf === 1 && sw === 0) stopSequence = sr.readVarint();
              else if (sf === 2 && sw === 2) arr = readStopTimeEvent(sr.readBytes());
              else if (sf === 3 && sw === 2) dep = readStopTimeEvent(sr.readBytes());
              else if (sf === 4 && sw === 2) stopId = sr.readString();
              else if (sf === 5 && sw === 0) rel = STOP_TIME_REL[sr.readVarint()] ?? "SCHEDULED";
              else sr.skip(sw);
            }
            stopUpdates.push({
              stopSequence,
              stopId,
              arrivalDelaySec: arr.delay,
              arrivalTime: arr.time,
              departureDelaySec: dep.delay,
              departureTime: dep.time,
              scheduleRelationship: rel,
            });
          } else if (tuf === 3 && tuw === 2) {
            const v = readVehicleDescriptor(tur.readBytes());
            vehId = v.id || v.label;
          } else if (tuf === 4 && tuw === 0) {
            tsSec = tur.readVarint();
          } else if (tuf === 5 && tuw === 0) {
            delaySec = tur.readSignedInt32();
          } else {
            tur.skip(tuw);
          }
        }

        if (trip.tripId) {
          const formattedDate =
            trip.startDate && /^\d{8}$/.test(trip.startDate)
              ? `${trip.startDate.slice(0, 4)}-${trip.startDate.slice(4, 6)}-${trip.startDate.slice(6, 8)}`
              : serviceCtx.serviceDate;
          if (delaySec === null && stopUpdates.length > 0) {
            delaySec = stopUpdates[0]!.departureDelaySec ?? stopUpdates[0]!.arrivalDelaySec ?? null;
          }
          tripUpdates.push({
            sourceId: context.sourceId,
            agencyId: context.agencyId,
            tripId: trip.tripId,
            routeId: trip.routeId,
            serviceDate: formattedDate,
            vehicleId: vehId,
            scheduleRelationship: trip.scheduleRelationship,
            delaySec,
            stopUpdates,
            observedAt: tsSec && tsSec > 1_000_000_000 ? new Date(tsSec * 1000).toISOString() : feedTimestamp,
            receivedAt,
          });
        }
      }

      if (alertBytes) {
        const ar = new ProtoReader(alertBytes);
        const activePeriods: Array<{ start: string | null; end: string | null }> = [];
        const informedEntities: NormalizedAlert["informedEntities"] = [];
        let cause = "UNKNOWN_CAUSE";
        let effect = "UNKNOWN_EFFECT";
        let url: string | null = null;
        let headerText = "";
        let descriptionText = "";

        while (ar.hasMore()) {
          const atag = ar.readVarint();
          const af = atag >>> 3;
          const aw = atag & 7;
          if (af === 1 && aw === 2) {
            const pr = new ProtoReader(ar.readBytes());
            let start: string | null = null;
            let end: string | null = null;
            while (pr.hasMore()) {
              const ptag = pr.readVarint();
              const pf = ptag >>> 3;
              const pw = ptag & 7;
              if (pf === 1 && pw === 0) {
                const s = pr.readVarint();
                if (s > 1_000_000_000) start = new Date(s * 1000).toISOString();
              } else if (pf === 2 && pw === 0) {
                const e = pr.readVarint();
                if (e > 1_000_000_000) end = new Date(e * 1000).toISOString();
              } else pr.skip(pw);
            }
            activePeriods.push({ start, end });
          } else if (af === 5 && aw === 2) {
            const ier = new ProtoReader(ar.readBytes());
            const ent: NormalizedAlert["informedEntities"][number] = {};
            while (ier.hasMore()) {
              const itag = ier.readVarint();
              const inf = itag >>> 3;
              const inw = itag & 7;
              if (inf === 1 && inw === 2) ent.agencyId = ier.readString();
              else if (inf === 2 && inw === 2) ent.routeId = ier.readString();
              else if (inf === 3 && inw === 0) ent.routeType = ier.readVarint();
              else if (inf === 4 && inw === 2) ent.tripId = readTripDescriptor(ier.readBytes()).tripId ?? undefined;
              else if (inf === 5 && inw === 2) ent.stopId = ier.readString();
              else ier.skip(inw);
            }
            informedEntities.push(ent);
          } else if (af === 6 && aw === 0) cause = ALERT_CAUSE[ar.readVarint()] ?? "UNKNOWN_CAUSE";
          else if (af === 7 && aw === 0) effect = ALERT_EFFECT[ar.readVarint()] ?? "UNKNOWN_EFFECT";
          else if (af === 8 && aw === 2) url = readTranslatedString(ar.readBytes()) || null;
          else if (af === 10 && aw === 2) headerText = readTranslatedString(ar.readBytes());
          else if (af === 11 && aw === 2) descriptionText = readTranslatedString(ar.readBytes());
          else ar.skip(aw);
        }

        if (headerText || descriptionText) {
          alerts.push({
            sourceId: context.sourceId,
            agencyId: context.agencyId,
            sourceAlertId: entityId || crypto.randomUUID(),
            cause,
            effect,
            headerText: headerText || "Service Alert",
            descriptionText,
            url,
            activePeriods,
            informedEntities,
            receivedAt,
          });
        }
      }
    } else {
      root.skip(wire);
    }
  }

  if (incrementality === "DIFFERENTIAL") {
    qualityFlags.push("differential_dataset");
  }

  return {
    batchId: `${context.sourceId}-${Date.parse(receivedAt)}-${payload.byteLength}`,
    sourceId: context.sourceId,
    agencyId: context.agencyId,
    feedKind: context.feedKind,
    incrementality,
    feedTimestamp,
    receivedAt,
    adapterVersion: ADAPTER_VERSION,
    observations,
    tripUpdates,
    alerts,
    qualityFlags,
    rawByteLength: payload.byteLength,
  };
}

// ---------------------------------------------------------------------------
// Umo / NextBus XML Adapter (for TTC legacy / custom NextBus feeds)
// ---------------------------------------------------------------------------

export function decodeUmoXmlVehicles(
  xmlText: string,
  context: { sourceId: string; agencyId: string; receivedAt?: string }
): NormalizedBatch {
  const receivedAt = context.receivedAt ?? new Date().toISOString();
  // Reject DOCTYPE / XML entity expansion attacks (XXE protection)
  if (/<!DOCTYPE|<!ENTITY/i.test(xmlText)) {
    throw new Error("Rejected XML payload containing DOCTYPE/ENTITY declarations");
  }

  const observations: Observation[] = [];
  const vehicleRegex = /<vehicle\s+([^>]+?)\/>/gi;
  let match: RegExpExecArray | null;

  while ((match = vehicleRegex.exec(xmlText)) !== null) {
    const attrStr = match[1] ?? "";
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9_]+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRegex.exec(attrStr)) !== null) {
      attrs[am[1]!] = am[2]!;
    }
    const id = attrs.id;
    const lat = Number(attrs.lat);
    const lon = Number(attrs.lon);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const secsSinceReport = Number(attrs.secsSinceReport ?? "0");
    const observedMs = Date.parse(receivedAt) - (Number.isFinite(secsSinceReport) ? secsSinceReport * 1000 : 0);
    const speedKmHr = attrs.speedKmHr ? Number(attrs.speedKmHr) : null;
    const heading = attrs.heading ? Number(attrs.heading) : null;

    const { vehicleId, fleetNumber } = resolveFleetNumber(id, id);
    observations.push({
      sourceId: context.sourceId,
      agencyId: context.agencyId,
      sourceVehicleId: id,
      vehicleId,
      fleetNumber,
      label: id,
      tripId: attrs.tripTag ?? null,
      routeId: attrs.routeTag ?? null,
      blockId: attrs.blockTag ?? null,
      directionId: null,
      lat,
      lon,
      bearingDeg: heading !== null && heading >= 0 ? heading : null,
      speedMps: speedKmHr !== null && Number.isFinite(speedKmHr) ? speedKmHr / 3.6 : null,
      scheduleDeviationSec: null,
      currentStatus: "IN_TRANSIT_TO",
      stopId: null,
      stopSequence: null,
      occupancyStatus: null,
      observedAt: new Date(observedMs).toISOString(),
      receivedAt,
      timestampBasis: "vehicle",
      qualityFlags: [],
      matchMethod: attrs.tripTag ? "explicit_trip" : "unmatched",
      matchConfidence: attrs.tripTag ? 0.85 : 0,
      rawRef: `${context.sourceId}:${id}`,
    });
  }

  return {
    batchId: `${context.sourceId}-${Date.parse(receivedAt)}-${xmlText.length}`,
    sourceId: context.sourceId,
    agencyId: context.agencyId,
    feedKind: "vehicle_positions",
    incrementality: "FULL_DATASET",
    feedTimestamp: receivedAt,
    receivedAt,
    adapterVersion: ADAPTER_VERSION,
    observations,
    tripUpdates: [],
    alerts: [],
    qualityFlags: [],
    rawByteLength: xmlText.length,
  };
}

// ---------------------------------------------------------------------------
// GTFS Static CSV & ZIP Parser (UTF-8 BOM, RFC 4180 quotes, bounded size)
// ---------------------------------------------------------------------------

export function parseCsv(text: string): Array<Record<string, string>> {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows[0]?.map((h) => h.trim()) ?? [];
  if (header.length === 0) return [];
  const records: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r]!;
    if (vals.length === 1 && vals[0] === "") continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]!] = (vals[c] ?? "").trim();
    }
    records.push(obj);
  }
  return records;
}

export interface ParsedGtfsStatic {
  routes: Array<{
    routeId: string;
    shortName: string;
    longName: string;
    description: string | null;
    routeType: number;
    color: string | null;
    textColor: string | null;
    sortOrder: number | null;
  }>;
  stops: Array<{
    stopId: string;
    stopCode: string | null;
    name: string;
    description: string | null;
    lat: number;
    lon: number;
    locationType: number;
    parentStation: string | null;
    platformCode: string | null;
    wheelchairBoarding: number;
  }>;
  trips: Array<{
    tripId: string;
    routeId: string;
    serviceId: string;
    directionId: number | null;
    headsign: string | null;
    shortName: string | null;
    blockId: string | null;
    shapeId: string | null;
  }>;
  stopTimes: Array<{
    tripId: string;
    stopSequence: number;
    stopId: string;
    arrivalSec: number | null;
    departureSec: number | null;
  }>;
  calendars: Array<{
    serviceId: string;
    daysMask: number;
    startDate: string;
    endDate: string;
    exceptions: Record<string, number>;
  }>;
  shapes: Map<string, Array<[number, number]>>;
  diagnostics: { warnings: string[]; validFrom: string | null; validUntil: string | null };
}

export function parseGtfsStaticZip(
  zipBytes: Uint8Array,
  options: { maxUncompressedBytes?: number; includeStopTimes?: boolean } = {}
): ParsedGtfsStatic {
  const maxBytes = options.maxUncompressedBytes ?? 150 * 1024 * 1024;
  let totalUncompressed = 0;

  const files = unzipSync(zipBytes, {
    filter(file) {
      totalUncompressed += file.originalSize;
      if (totalUncompressed > maxBytes) {
        throw new Error(`GTFS ZIP exceeds max uncompressed safety cap (${maxBytes} bytes)`);
      }
      const name = file.name.split("/").pop() ?? "";
      return [
        "routes.txt",
        "stops.txt",
        "trips.txt",
        "calendar.txt",
        "calendar_dates.txt",
        "shapes.txt",
        "feed_info.txt",
        ...(options.includeStopTimes !== false ? ["stop_times.txt"] : []),
      ].includes(name);
    },
  });

  const dec = new TextDecoder("utf-8");
  const getFile = (name: string) => {
    const key = Object.keys(files).find((k) => k === name || k.endsWith(`/${name}`));
    return key ? dec.decode(files[key]!) : null;
  };

  const warnings: string[] = [];

  const routesText = getFile("routes.txt");
  const routes = routesText
    ? parseCsv(routesText)
        .filter((r) => r.route_id)
        .map((r) => ({
          routeId: r.route_id!,
          shortName: r.route_short_name || r.route_id!,
          longName: r.route_long_name || r.route_short_name || r.route_id!,
          description: r.route_desc || null,
          routeType: Number.isFinite(Number(r.route_type)) ? Number(r.route_type) : 3,
          color: r.route_color ? (r.route_color.startsWith("#") ? r.route_color : `#${r.route_color}`) : null,
          textColor: r.route_text_color
            ? r.route_text_color.startsWith("#")
              ? r.route_text_color
              : `#${r.route_text_color}`
            : null,
          sortOrder: r.route_sort_order ? Number(r.route_sort_order) : null,
        }))
    : [];
  if (!routesText) warnings.push("Missing routes.txt");

  const stopsText = getFile("stops.txt");
  const stops = stopsText
    ? parseCsv(stopsText)
        .filter((s) => s.stop_id && Number.isFinite(Number(s.stop_lat)) && Number.isFinite(Number(s.stop_lon)))
        .map((s) => ({
          stopId: s.stop_id!,
          stopCode: s.stop_code || null,
          name: s.stop_name || s.stop_id!,
          description: s.stop_desc || null,
          lat: Number(s.stop_lat),
          lon: Number(s.stop_lon),
          locationType: Number(s.location_type || "0") || 0,
          parentStation: s.parent_station || null,
          platformCode: s.platform_code || null,
          wheelchairBoarding: Number(s.wheelchair_boarding || "0") || 0,
        }))
    : [];
  if (!stopsText) warnings.push("Missing stops.txt");

  const tripsText = getFile("trips.txt");
  const trips = tripsText
    ? parseCsv(tripsText)
        .filter((t) => t.trip_id && t.route_id)
        .map((t) => ({
          tripId: t.trip_id!,
          routeId: t.route_id!,
          serviceId: t.service_id || "default",
          directionId: t.direction_id !== undefined && t.direction_id !== "" ? Number(t.direction_id) : null,
          headsign: t.trip_headsign || null,
          shortName: t.trip_short_name || null,
          blockId: t.block_id || null,
          shapeId: t.shape_id || null,
        }))
    : [];

  const stopTimesText = options.includeStopTimes !== false ? getFile("stop_times.txt") : null;
  const stopTimes = stopTimesText
    ? parseCsv(stopTimesText)
        .filter((st) => st.trip_id && st.stop_id)
        .map((st) => ({
          tripId: st.trip_id!,
          stopSequence: Number(st.stop_sequence || "0"),
          stopId: st.stop_id!,
          arrivalSec: parseGtfsTimeToSeconds(st.arrival_time),
          departureSec: parseGtfsTimeToSeconds(st.departure_time),
        }))
    : [];

  const calMap = new Map<
    string,
    { serviceId: string; daysMask: number; startDate: string; endDate: string; exceptions: Record<string, number> }
  >();
  const calText = getFile("calendar.txt");
  if (calText) {
    for (const c of parseCsv(calText)) {
      if (!c.service_id) continue;
      const bits = [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday];
      const mask = bits.reduce((acc, v, idx) => (v === "1" ? acc | (1 << idx) : acc), 0);
      calMap.set(c.service_id, {
        serviceId: c.service_id,
        daysMask: mask,
        startDate: c.start_date || "20200101",
        endDate: c.end_date || "20991231",
        exceptions: {},
      });
    }
  }
  const calDatesText = getFile("calendar_dates.txt");
  if (calDatesText) {
    for (const cd of parseCsv(calDatesText)) {
      if (!cd.service_id || !cd.date) continue;
      let entry = calMap.get(cd.service_id);
      if (!entry) {
        entry = {
          serviceId: cd.service_id,
          daysMask: 0,
          startDate: cd.date,
          endDate: cd.date,
          exceptions: {},
        };
        calMap.set(cd.service_id, entry);
      }
      entry.exceptions[cd.date] = Number(cd.exception_type || "1");
      if (cd.date < entry.startDate) entry.startDate = cd.date;
      if (cd.date > entry.endDate) entry.endDate = cd.date;
    }
  }

  const shapes = new Map<string, Array<[number, number]>>();
  const shapesText = getFile("shapes.txt");
  if (shapesText) {
    const rawShapes = new Map<string, Array<{ seq: number; lon: number; lat: number }>>();
    for (const sh of parseCsv(shapesText)) {
      const lat = Number(sh.shape_pt_lat);
      const lon = Number(sh.shape_pt_lon);
      const seq = Number(sh.shape_pt_sequence);
      if (!sh.shape_id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      let arr = rawShapes.get(sh.shape_id);
      if (!arr) {
        arr = [];
        rawShapes.set(sh.shape_id, arr);
      }
      arr.push({ seq, lon, lat });
    }
    for (const [id, pts] of rawShapes) {
      pts.sort((a, b) => a.seq - b.seq);
      // Downsample dense shapes gently to keep GeoJSON fast for browser rendering
      const step = pts.length > 250 ? Math.ceil(pts.length / 250) : 1;
      const simplified: Array<[number, number]> = [];
      for (let i = 0; i < pts.length; i += step) {
        simplified.push([Number(pts[i]!.lon.toFixed(5)), Number(pts[i]!.lat.toFixed(5))]);
      }
      const last = pts[pts.length - 1]!;
      simplified.push([Number(last.lon.toFixed(5)), Number(last.lat.toFixed(5))]);
      shapes.set(id, simplified);
    }
  }

  let validFrom: string | null = null;
  let validUntil: string | null = null;
  const feedInfoText = getFile("feed_info.txt");
  if (feedInfoText) {
    const info = parseCsv(feedInfoText)[0];
    if (info?.feed_start_date) validFrom = info.feed_start_date;
    if (info?.feed_end_date) validUntil = info.feed_end_date;
  }

  return {
    routes,
    stops,
    trips,
    stopTimes,
    calendars: Array.from(calMap.values()),
    shapes,
    diagnostics: { warnings, validFrom, validUntil },
  };
}
