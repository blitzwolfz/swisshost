export interface UpcomingBus {
  departureTime: string;
  arrivalTime: string;
  etaMinutes: number;
  waitMinutes: number;
  rideMinutes: number;
  isLive: boolean;
  source: "trip_update" | "live_gps" | "scheduled";
  vehicleId: string | null;
  fleetNumber: string | null;
  tripId: string | null;
  headsign: string | null;
  stopsAway: number | null;
  delaySec: number | null;
}

export interface RouteAlertItem {
  id: string;
  effect: string | null;
  cause?: string | null;
  headerText: string;
  descriptionText: string;
}

export interface TripFareEstimate {
  totalCad: number;
  regularCad: number;
  savingsCad: number;
  oneFareApplied: boolean;
  programLabel: string | null;
  summary: string;
  breakdown: Array<{
    agencyId: string;
    regularCad: number;
    chargedCad: number;
    note: string | null;
  }>;
}

export interface TransferRiskAssessment {
  fromLegIndex: number;
  toLegIndex: number;
  level: "safe" | "tight" | "likely_missed" | "unknown";
  slackMinutes: number | null;
  walkMinutes: number;
  message: string;
  backupDepartureTime: string | null;
}

export interface PlanLeg {
  mode: "walk" | "transit";
  agencyId?: string;
  routeId?: string;
  routeShortName?: string;
  routeLongName?: string | null;
  routeColor?: string | null;
  vehicleMode?: string;
  fromName: string;
  fromStopId?: string;
  fromLat?: number;
  fromLon?: number;
  toName: string;
  toStopId?: string;
  toLat?: number;
  toLon?: number;
  distanceMeters: number;
  minutes: number;
  waitMinutes?: number;
  departureTime?: string | null;
  arrivalTime?: string | null;
  stopsCount?: number | null;
  activeVehicles?: number;
  nearestVehicleId?: string | null;
  nearestFleetNumber?: string | null;
  nearestHeadsign?: string | null;
  upcomingBuses?: UpcomingBus[];
  alerts?: RouteAlertItem[];
}

export interface PlanOption {
  id: string;
  kind: "direct" | "transfer";
  transfersCount?: number;
  agencyId: string;
  agencies?: string[];
  isCrossAgency?: boolean;
  serviceStatus: "live" | "scheduled" | "no_upcoming";
  leaveAt: string;
  arriveAt: string;
  nextDepartureAt: string | null;
  totalMinutes: number;
  walkMinutes: number;
  waitMinutes: number;
  rideMinutes: number;
  fareEstimate?: TripFareEstimate;
  transferRisks?: TransferRiskAssessment[];
  legs: PlanLeg[];
}

export interface ActiveTripSession {
  id: string;
  originLabel: string;
  originLat: number;
  originLon: number;
  destLabel: string;
  destLat: number;
  destLon: number;
  option: PlanOption;
  startedAt: string;
}

export interface CommutePreset {
  id: string;
  name: string;
  origin: { label: string; subtitle: string; lat: number; lon: number };
  dest: { label: string; subtitle: string; lat: number; lon: number };
  createdAt: string;
}

const STORAGE_KEY = "swisshost_active_trip_v1";
const PRESETS_KEY = "swisshost_commute_presets_v1";

export function saveActiveTrip(session: ActiveTripSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // ignore quota errors
  }
}

export function loadActiveTrip(expectedId?: string | null): ActiveTripSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveTripSession;
    if (!parsed?.id || !parsed.option?.legs) return null;
    if (expectedId && parsed.id !== expectedId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearActiveTrip(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function loadCommutePresets(): CommutePreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CommutePreset[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCommutePreset(preset: Omit<CommutePreset, "id" | "createdAt">): CommutePreset[] {
  const existing = loadCommutePresets();
  const next: CommutePreset[] = [
    {
      ...preset,
      id: `preset-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
    },
    ...existing.filter((p) => p.name.toLowerCase() !== preset.name.toLowerCase()),
  ].slice(0, 8);
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function deleteCommutePreset(id: string): CommutePreset[] {
  const next = loadCommutePresets().filter((p) => p.id !== id);
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}
