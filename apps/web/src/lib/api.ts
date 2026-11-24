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

export interface LiveVehicle {
  agencyId: string;
  sourceVehicleId: string;
  vehicleId: string;
  fleetNumber: string;
  label: string | null;
  routeId: string | null;
  routeShortName?: string | null;
  routeColor?: string | null;
  tripId: string | null;
  blockId: string | null;
  directionId: number | null;
  lat: number;
  lon: number;
  bearingDeg: number | null;
  speedMps: number | null;
  scheduleDeviationSec: number | null;
  currentStatus: string | null;
  stopId: string | null;
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

export function formatRelativeAge(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const diffSec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}
