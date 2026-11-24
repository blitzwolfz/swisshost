import type { Observation } from "@swisshost/contracts";

const EARTH_RADIUS_M = 6_371_000;

/**
 * Parse GTFS HH:MM:SS time string (including after-midnight values like 25:15:00) into seconds since service-day noon-12h.
 */
export function parseGtfsTimeToSeconds(timeStr: string | null | undefined): number | null {
  if (!timeStr) return null;
  const trimmed = timeStr.trim();
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3]);
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

export function formatSecondsToGtfsTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "-" : "";
  const abs = Math.abs(Math.round(seconds));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatSecondsToClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const normalized = ((Math.round(seconds) % 86400) + 86400) % 86400;
  const h = Math.floor(normalized / 3600);
  const m = Math.floor((normalized % 3600) / 60);
  const nextDay = seconds >= 86400 ? " (+1d)" : "";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}${nextDay}`;
}

/**
 * Resolve an instant into an agency's local service date (YYYY-MM-DD) and local seconds-since-midnight.
 * Handles DST transitions using Intl.DateTimeFormat and optional early-morning spillover (before 03:30 counts as previous service day if requested).
 */
export function getLocalServiceContext(
  instant: Date | string,
  timeZone: string,
  rolloverHour = 3
): { calendarDate: string; serviceDate: string; localSeconds: number; serviceSeconds: number } {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");

  const calendarDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const localSeconds = hour * 3600 + minute * 60 + second;

  if (hour < rolloverHour) {
    const prev = new Date(Date.UTC(year, month - 1, day - 1));
    const serviceDate = prev.toISOString().slice(0, 10);
    return {
      calendarDate,
      serviceDate,
      localSeconds,
      serviceSeconds: localSeconds + 86400,
    };
  }

  return { calendarDate, serviceDate: calendarDate, localSeconds, serviceSeconds: localSeconds };
}

/**
 * Check if a GTFS calendar record is active on a given YYYY-MM-DD serviceDate.
 * daysMask bit 0 = Monday ... bit 6 = Sunday.
 */
export function isServiceActiveOnDate(
  calendar: { daysMask: number; startDate: string; endDate: string; exceptions: Record<string, number> },
  serviceDate: string
): boolean {
  const compact = serviceDate.replace(/-/g, "");
  const exception = calendar.exceptions[compact] ?? calendar.exceptions[serviceDate];
  if (exception === 1) return true;
  if (exception === 2) return false;

  const start = calendar.startDate.replace(/-/g, "");
  const end = calendar.endDate.replace(/-/g, "");
  if (compact < start || compact > end) return false;

  const [y, m, d] = serviceDate.split("-").map(Number);
  if (!y || !m || !d) return false;
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  const gtfsBit = jsDay === 0 ? 6 : jsDay - 1; // 0=Mon..6=Sun
  return (calendar.daysMask & (1 << gtfsBit)) !== 0;
}

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearingDegrees(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function angularDifferenceDeg(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export interface PolylineMatchResult {
  snappedLat: number;
  snappedLon: number;
  distanceMeters: number;
  progressMeters: number;
  segmentBearingDeg: number;
}

/**
 * Project a raw GPS point onto a route polyline ([lon, lat][]), preserving raw GPS separately.
 */
export function projectPointOntoPolyline(
  lat: number,
  lon: number,
  coords: Array<[number, number]>
): PolylineMatchResult | null {
  if (coords.length < 2) return null;
  let bestDist = Infinity;
  let bestResult: PolylineMatchResult | null = null;
  let cumulative = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const [lonA, latA] = coords[i]!;
    const [lonB, latB] = coords[i + 1]!;
    const segLen = haversineMeters(latA, lonA, latB, lonB);

    const cosLat = Math.cos(((latA + latB) / 2) * (Math.PI / 180));
    const dx = (lonB - lonA) * cosLat;
    const dy = latB - latA;
    const px = (lon - lonA) * cosLat;
    const py = lat - latA;
    const denom = dx * dx + dy * dy;
    const t = denom > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / denom)) : 0;

    const projLon = lonA + t * (lonB - lonA);
    const projLat = latA + t * (latB - latA);
    const dist = haversineMeters(lat, lon, projLat, projLon);

    if (dist < bestDist) {
      bestDist = dist;
      bestResult = {
        snappedLat: projLat,
        snappedLon: projLon,
        distanceMeters: dist,
        progressMeters: cumulative + segLen * t,
        segmentBearingDeg: bearingDegrees(latA, lonA, latB, lonB),
      };
    }
    cumulative += segLen;
  }

  return bestResult;
}

export interface MatchScore {
  method: "explicit_trip" | "route_shape_proximity" | "unmatched";
  confidence: number;
  offRoute: boolean;
}

export function evaluateTripMatch(
  obs: Pick<Observation, "tripId" | "routeId" | "lat" | "lon" | "bearingDeg">,
  routeShapeCoords?: Array<[number, number]> | null
): MatchScore {
  if (obs.tripId && obs.routeId) {
    if (routeShapeCoords && routeShapeCoords.length >= 2) {
      const proj = projectPointOntoPolyline(obs.lat, obs.lon, routeShapeCoords);
      if (proj) {
        const headingPenalty =
          obs.bearingDeg !== null && angularDifferenceDeg(obs.bearingDeg, proj.segmentBearingDeg) > 120
            ? 0.15
            : 0;
        const offRoute = proj.distanceMeters > 250;
        const confidence = Math.max(
          0.35,
          Math.min(0.99, (offRoute ? 0.6 : 0.96) - headingPenalty)
        );
        return { method: "explicit_trip", confidence, offRoute };
      }
    }
    return { method: "explicit_trip", confidence: 0.9, offRoute: false };
  }

  if (obs.routeId && routeShapeCoords && routeShapeCoords.length >= 2) {
    const proj = projectPointOntoPolyline(obs.lat, obs.lon, routeShapeCoords);
    if (proj && proj.distanceMeters <= 120) {
      const headingScore =
        obs.bearingDeg === null
          ? 0.72
          : angularDifferenceDeg(obs.bearingDeg, proj.segmentBearingDeg) <= 45
            ? 0.85
            : 0.55;
      return { method: "route_shape_proximity", confidence: headingScore, offRoute: false };
    }
  }

  return { method: "unmatched", confidence: 0, offRoute: false };
}

export interface DetectedStopEvent {
  stopId: string;
  observedArrivalAt: string;
  observedDepartureAt: string | null;
  uncertaintySec: number;
  eventType: "reported_stop" | "inferred_dwell" | "inferred_passthrough";
  source: "reported" | "inferred";
  confidence: number;
}

/**
 * Infer stop arrival/departure from consecutive GPS observations and nearby stop locations.
 * Never claims exact second precision; computes explicit uncertainty from sample cadence.
 */
export function detectStopEvent(
  prev: Observation | null,
  curr: Observation,
  candidateStops: Array<{ stopId: string; lat: number; lon: number }>,
  radiusMeters = 45
): DetectedStopEvent | null {
  const currTs = curr.observedAt ?? curr.receivedAt;
  const prevTs = prev ? prev.observedAt ?? prev.receivedAt : null;
  const cadenceSec =
    prevTs !== null
      ? Math.max(10, Math.min(300, Math.round((Date.parse(currTs) - Date.parse(prevTs)) / 1000)))
      : 60;
  const uncertaintySec = Math.round(cadenceSec / 2);

  if (curr.stopId && curr.currentStatus === "STOPPED_AT") {
    return {
      stopId: curr.stopId,
      observedArrivalAt: currTs,
      observedDepartureAt: null,
      uncertaintySec,
      eventType: "reported_stop",
      source: "reported",
      confidence: 0.92,
    };
  }

  let nearest: { stopId: string; dist: number } | null = null;
  for (const stop of candidateStops) {
    const dist = haversineMeters(curr.lat, curr.lon, stop.lat, stop.lon);
    if (dist <= radiusMeters && (!nearest || dist < nearest.dist)) {
      nearest = { stopId: stop.stopId, dist };
    }
  }
  if (!nearest) return null;

  const isDwelling = curr.speedMps !== null ? curr.speedMps < 1.5 : prev !== null && haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon) < 15;
  return {
    stopId: nearest.stopId,
    observedArrivalAt: currTs,
    observedDepartureAt: isDwelling ? null : currTs,
    uncertaintySec,
    eventType: isDwelling ? "inferred_dwell" : "inferred_passthrough",
    source: "inferred",
    confidence: Number(Math.max(0.4, 0.85 - nearest.dist / 100).toFixed(2)),
  };
}

/**
 * Validate GPS observation quality and detect improbable jumps (> 55 m/s = ~198 km/h for regional rail/bus).
 */
export function validateObservationQuality(
  obs: Observation,
  prev: Observation | null
): { valid: boolean; flags: string[] } {
  const flags = [...obs.qualityFlags];

  if (
    !Number.isFinite(obs.lat) ||
    !Number.isFinite(obs.lon) ||
    obs.lat < -90 ||
    obs.lat > 90 ||
    obs.lon < -180 ||
    obs.lon > 180 ||
    (Math.abs(obs.lat) < 0.0001 && Math.abs(obs.lon) < 0.0001)
  ) {
    return { valid: false, flags: [...flags, "invalid_coordinates"] };
  }

  if (!obs.observedAt) {
    flags.push("receipt_time_fallback");
  }

  if (prev) {
    const currTime = Date.parse(obs.observedAt ?? obs.receivedAt);
    const prevTime = Date.parse(prev.observedAt ?? prev.receivedAt);
    const dtSec = (currTime - prevTime) / 1000;
    if (dtSec < 0) {
      flags.push("out_of_order_timestamp");
    } else if (dtSec > 0) {
      const dist = haversineMeters(prev.lat, prev.lon, obs.lat, obs.lon);
      const impliedSpeed = dist / dtSec;
      if (impliedSpeed > 55) {
        flags.push("improbable_jump");
      }
    }
  }

  return { valid: true, flags: Array.from(new Set(flags)) };
}

export function resolveFleetNumber(
  sourceVehicleId: string,
  label: string | null
): { vehicleId: string; fleetNumber: string } {
  const cleanedLabel = label?.trim() || "";
  const cleanedId = sourceVehicleId.trim();
  const fleetNumber = cleanedLabel.length > 0 && cleanedLabel.length <= 24 ? cleanedLabel : cleanedId;
  const vehicleId = cleanedId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return { vehicleId, fleetNumber };
}
