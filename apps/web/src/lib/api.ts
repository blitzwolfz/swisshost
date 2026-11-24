export interface AgencySummary {
  id: string;
  name: string;
  shortName: string;
  region: string;
  timezone: string;
  modes: string[];
  center: [number, number];
  defaultZoom: number;
  attribution: string;
  licenseUrl: string | null;
  archivePolicy: string;
  capabilities: {
    staticSchedule: boolean;
    vehiclePositions: boolean;
    tripUpdates: boolean;
    serviceAlerts: boolean;
    historicalArchive: boolean;
  };
  liveStatus: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  activeVehicleCount: number;
  feeds: Array<Record<string, unknown>>;
}

export type VehicleMode = "bus" | "streetcar" | "subway" | "rail" | "ferry" | "unknown";

export interface RailCorridorOverlay {
  agencyId: string;
  routeId: string;
  shortName: string;
  longName: string;
  mode: "subway" | "rail" | "streetcar";
  color: string;
  textColor: string;
  coordinates: Array<[number, number]>;
  stations: Array<{ stopId: string; name: string; lat: number; lon: number }>;
}

export interface LiveVehicle {
  agencyId: string;
  sourceVehicleId: string;
  vehicleId: string;
  fleetNumber: string;
  label: string | null;
  routeId: string | null;
  routeShortName?: string | null;
  routeLongName?: string | null;
  routeColor?: string | null;
  routeType?: number | null;
  vehicleMode?: VehicleMode;
  positionSource?: "live" | "scheduled";
  tripId: string | null;
  patternTripId?: string | null;
  headsign?: string | null;
  blockId: string | null;
  directionId: number | null;
  lat: number;
  lon: number;
  bearingDeg: number | null;
  speedMps: number | null;
  scheduleDeviationSec: number | null;
  currentStatus: string | null;
  stopId: string | null;
  stopName?: string | null;
  stopSequence: number | null;
  occupancyStatus: string | null;
  observedAt: string | null;
  receivedAt: string;
  timestampBasis: "vehicle" | "feed" | "receipt";
  ageSeconds: number;
  freshness: "fresh" | "delayed" | "stale";
  qualityFlags: string[];
  matchMethod: string;
  matchConfidence: number;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      "X-Swisshost-App": "1",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string; title?: string };
    throw new Error(err.detail || err.title || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function formatSpeed(speedMps: number | null | undefined, units: "metric" | "imperial"): string {
  if (speedMps === null || speedMps === undefined || !Number.isFinite(speedMps)) return "Unknown";
  if (units === "imperial") {
    return `${(speedMps * 2.23694).toFixed(1)} mph`;
  }
  return `${(speedMps * 3.6).toFixed(1)} km/h`;
}

export function formatTemperature(tempC: number | null | undefined, units: "metric" | "imperial"): string {
  if (tempC === null || tempC === undefined || !Number.isFinite(tempC)) return "--";
  if (units === "imperial") {
    return `${Math.round((tempC * 9) / 5 + 32)}°F`;
  }
  return `${Math.round(tempC)}°C`;
}

export function formatWindKmh(kmh: number | null | undefined, units: "metric" | "imperial"): string {
  if (kmh === null || kmh === undefined || !Number.isFinite(kmh)) return "";
  if (units === "imperial") {
    return `${Math.round(kmh * 0.621371)} mph`;
  }
  return `${Math.round(kmh)} km/h`;
}

export interface WeatherAlert {
  id: string;
  type: "warning" | "watch" | "advisory" | "statement";
  colourLevel: "red" | "orange" | "yellow" | null;
  title: string;
  expiresAt: string | null;
  url: string | null;
}

export interface HourlyWeatherPoint {
  timestamp: string;
  tempC: number | null;
  feelsLikeC: number | null;
  condition: string;
  iconCode: number | null;
  precipChancePct: number | null;
  windSpeedKmh: number | null;
  windDirection: string | null;
}

export interface WeatherSnapshot {
  siteId: string;
  cityName: string;
  region: string | null;
  stationName: string | null;
  observedAt: string | null;
  lastUpdated: string | null;
  sourceUrl: string | null;
  current: {
    tempC: number | null;
    feelsLikeC: number | null;
    feelsLikeType: "wind_chill" | "humidex" | null;
    condition: string;
    iconCode: number | null;
    windSpeedKmh: number | null;
    windGustKmh: number | null;
    windDirection: string | null;
    humidityPct: number | null;
  };
  todaySummary: string | null;
  alerts: WeatherAlert[];
  hourly: HourlyWeatherPoint[];
  attribution: string;
  stale?: boolean;
}

export function formatDelay(delaySec: number | null | undefined): { text: string; tone: "ok" | "warn" | "err" | "muted" } {
  if (delaySec === null || delaySec === undefined || !Number.isFinite(delaySec)) {
    return { text: "Unknown", tone: "muted" };
  }
  const mins = Math.round(delaySec / 60);
  if (delaySec < -60) return { text: `${Math.abs(mins)}m early`, tone: "warn" };
  if (delaySec > 300) return { text: `${mins}m late`, tone: "err" };
  if (delaySec > 60) return { text: `${mins}m late`, tone: "warn" };
  return { text: "On time", tone: "ok" };
}

export function formatOccupancy(
  status: string | null | undefined
): { label: string; short: string; tone: "ok" | "warn" | "err" } | null {
  if (!status || status === "NO_DATA_AVAILABLE") return null;
  switch (status) {
    case "EMPTY":
      return { label: "Empty", short: "Empty", tone: "ok" };
    case "MANY_SEATS_AVAILABLE":
      return { label: "Many seats", short: "Quiet", tone: "ok" };
    case "FEW_SEATS_AVAILABLE":
      return { label: "Few seats", short: "Moderate", tone: "warn" };
    case "STANDING_ROOM_ONLY":
      return { label: "Standing room", short: "Busy", tone: "warn" };
    case "CRUSHED_STANDING_ROOM_ONLY":
    case "FULL":
      return { label: "Full", short: "Full", tone: "err" };
    case "NOT_ACCEPTING_PASSENGERS":
    case "NOT_BOARDABLE":
      return { label: "Not boarding", short: "Full", tone: "err" };
    default:
      return null;
  }
}

export function formatRelativeAge(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const diffSec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function formatCompass(bearingDeg: number | null | undefined): string {
  if (bearingDeg === null || bearingDeg === undefined || !Number.isFinite(bearingDeg)) return "";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return dirs[idx] ?? "";
}

export function formatVehicleStatusLine(v: Pick<LiveVehicle, "currentStatus" | "stopName" | "stopId">): string {
  const stopLabel = v.stopName || (v.stopId ? `Stop ${v.stopId}` : null);
  const raw = v.currentStatus || "IN_TRANSIT_TO";
  if (raw === "STOPPED_AT") return stopLabel ? `Stopped at ${stopLabel}` : "Stopped at stop";
  if (raw === "INCOMING_AT") return stopLabel ? `Arriving at ${stopLabel}` : "Approaching stop";
  if (raw === "IN_TRANSIT_TO") return stopLabel ? `Next: ${stopLabel}` : "In transit";
  return stopLabel ? `${raw.replace(/_/g, " ")} ${stopLabel}` : raw.replace(/_/g, " ");
}

export interface StopDeparture {
  tripId: string;
  routeId: string;
  headsign: string | null;
  vehicleId: string | null;
  fleetNumber?: string | null;
  scheduleRelationship: string;
  scheduledTime: string;
  predictedTime: string;
  etaSeconds: number;
  uncertaintySec: number;
  predictionSource: string;
  confidence: number;
  basis: string;
  distanceMeters?: number | null;
}

export interface StopArrivals {
  agencyId: string;
  timezone: string;
  serviceDate: string;
  serverTime: string;
  stop: { stop_id: string; stop_code?: string; name: string; lat?: number; lon?: number; platform_code?: string };
  departures: StopDeparture[];
  approachingVehicles: Array<LiveVehicle & { distanceMeters: number }>;
  alerts: Array<{ id: string; header_text: string; description_text: string }>;
}

/** True when a departure time is backed by live data rather than the timetable alone. */
export function isLiveDeparture(d: Pick<StopDeparture, "predictionSource">): boolean {
  return d.predictionSource !== "scheduled" && d.predictionSource !== "unknown";
}

export function vehicleModeNoun(mode: VehicleMode | undefined | null, fallback = "Bus"): string {
  if (mode === "subway") return "Subway";
  if (mode === "rail") return "Train";
  if (mode === "streetcar") return "Streetcar";
  if (mode === "ferry") return "Ferry";
  if (mode === "bus") return "Bus";
  return fallback;
}

export function isTrainMode(mode: VehicleMode | undefined | null): boolean {
  return mode === "subway" || mode === "rail";
}

/** "11:42 pm" in the viewer's locale clock. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d
    .toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s?a\.?m\.?/i, " am")
    .replace(/\s?p\.?m\.?/i, " pm");
}
