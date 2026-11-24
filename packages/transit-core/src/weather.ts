import { haversineMeters } from "./index";

export interface EcccCityHub {
  siteId: string;
  agencyIds: string[];
  cityName: string;
  lat: number;
  lon: number;
}

/**
 * Verified Environment and Climate Change Canada (ECCC) citypageweather-realtime hubs
 * covering Swisshost's active Ontario transit agencies.
 */
export const ECCC_ONTARIO_HUBS: EcccCityHub[] = [
  {
    siteId: "on-143",
    agencyIds: ["ttc", "go", "all"],
    cityName: "Toronto",
    lat: 43.6532,
    lon: -79.3832,
  },
  {
    siteId: "on-24",
    agencyIds: ["miway"],
    cityName: "Mississauga",
    lat: 43.589,
    lon: -79.6441,
  },
  {
    siteId: "on-4",
    agencyIds: ["brampton"],
    cityName: "Brampton",
    lat: 43.7315,
    lon: -79.7624,
  },
  {
    siteId: "on-59",
    agencyIds: ["yrt"],
    cityName: "Richmond Hill / York",
    lat: 43.87,
    lon: -79.43,
  },
  {
    siteId: "on-117",
    agencyIds: ["drt"],
    cityName: "Oshawa / Durham",
    lat: 43.9,
    lon: -78.86,
  },
  {
    siteId: "on-79",
    agencyIds: ["oakville", "milton"],
    cityName: "Oakville / Halton",
    lat: 43.4675,
    lon: -79.6877,
  },
  {
    siteId: "on-77",
    agencyIds: ["hsr"],
    cityName: "Hamilton",
    lat: 43.2557,
    lon: -79.8711,
  },
  {
    siteId: "on-5",
    agencyIds: ["guelph"],
    cityName: "Guelph",
    lat: 43.5448,
    lon: -80.2482,
  },
  {
    siteId: "on-82",
    agencyIds: ["grt"],
    cityName: "Kitchener-Waterloo",
    lat: 43.4516,
    lon: -80.4925,
  },
  {
    siteId: "on-139",
    agencyIds: ["ontarionorthland"],
    cityName: "North Bay",
    lat: 46.3091,
    lon: -79.4608,
  },
  {
    siteId: "on-40",
    agencyIds: [],
    cityName: "Greater Sudbury",
    lat: 46.49,
    lon: -81.0,
  },
  {
    siteId: "on-100",
    agencyIds: ["thunderbay"],
    cityName: "Thunder Bay",
    lat: 48.3809,
    lon: -89.2477,
  },
];

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

export interface TripWindowWeather {
  cityName: string;
  tempC: number | null;
  feelsLikeC: number | null;
  condition: string;
  iconCode: number | null;
  precipChancePct: number | null;
  windSpeedKmh: number | null;
  isForecast: boolean;
  targetTime: string | null;
  activeAlert: WeatherAlert | null;
  advisoryNote: string | null;
}

export function resolveEcccSiteId(options: {
  agencyId?: string | null;
  lat?: number | null;
  lon?: number | null;
}): EcccCityHub {
  const { agencyId, lat, lon } = options;

  if (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon)
  ) {
    let best = ECCC_ONTARIO_HUBS[0]!;
    let bestDist = Infinity;
    for (const hub of ECCC_ONTARIO_HUBS) {
      const d = haversineMeters(lat, lon, hub.lat, hub.lon);
      if (d < bestDist) {
        bestDist = d;
        best = hub;
      }
    }
    return best;
  }

  const normalized = (agencyId || "").trim().toLowerCase();
  if (normalized) {
    const found = ECCC_ONTARIO_HUBS.find((h) => h.agencyIds.includes(normalized));
    if (found) return found;
  }

  return ECCC_ONTARIO_HUBS[0]!;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(v: unknown): UnknownRecord | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as UnknownRecord) : null;
}

function pickEnString(v: unknown): string | null {
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const rec = asRecord(v);
  if (!rec) return null;
  if (typeof rec.en === "string") {
    const trimmed = rec.en.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (rec.value !== undefined) return pickEnString(rec.value);
  return null;
}

function pickEnNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  const rec = asRecord(v);
  if (!rec) return null;
  if (rec.en !== undefined) return pickEnNumber(rec.en);
  if (rec.value !== undefined) return pickEnNumber(rec.value);
  return null;
}

function normalizeAlertType(raw: string | null): WeatherAlert["type"] {
  const lower = (raw || "").toLowerCase();
  if (lower.includes("warning")) return "warning";
  if (lower.includes("watch")) return "watch";
  if (lower.includes("advisory")) return "advisory";
  return "statement";
}

function normalizeColourLevel(raw: string | null): WeatherAlert["colourLevel"] {
  const lower = (raw || "").toLowerCase();
  if (lower === "red") return "red";
  if (lower === "orange") return "orange";
  if (lower === "yellow") return "yellow";
  return null;
}

function parseWarnings(rawWarnings: unknown, fallbackUrl: string | null): WeatherAlert[] {
  const items: unknown[] = [];
  if (Array.isArray(rawWarnings)) {
    for (const entry of rawWarnings) {
      const rec = asRecord(entry);
      if (rec && Array.isArray(rec.event)) {
        items.push(...rec.event);
      } else if (entry) {
        items.push(entry);
      }
    }
  } else {
    const rec = asRecord(rawWarnings);
    if (rec && Array.isArray(rec.event)) {
      items.push(...rec.event);
    }
  }

  const alerts: WeatherAlert[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const item = asRecord(items[i]);
    if (!item) continue;
    const title =
      pickEnString(item.description) ??
      pickEnString(item.title) ??
      pickEnString(item.headline) ??
      pickEnString(item.event);
    if (!title) continue;

    // Skip "ended" bulletins if ECCC ever includes them
    const status = (pickEnString(item.status) || "").toLowerCase();
    if (status === "ended" || title.toLowerCase().includes("ended")) continue;

    const dedupeKey = title.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const rawType = pickEnString(item.type) ?? title;
    const colourLevel = normalizeColourLevel(
      pickEnString(item.alertColourLevel) ?? pickEnString(item.colourLevel)
    );
    const expiresAt = pickEnString(item.expiryTime) ?? pickEnString(item.expires);
    const url = pickEnString(item.url) ?? fallbackUrl;

    alerts.push({
      id: `eccc-alert-${i}-${dedupeKey.replace(/[^a-z0-9]+/g, "-").slice(0, 32)}`,
      type: normalizeAlertType(rawType),
      colourLevel,
      title,
      expiresAt,
      url,
    });
  }

  return alerts;
}

/**
 * Parse a GeoJSON Feature returned by ECCC MSC GeoMet
 * `https://api.weather.gc.ca/collections/citypageweather-realtime/items/{siteId}?f=json`.
 */
export function parseEcccCityPageWeather(raw: unknown, fallbackHub?: EcccCityHub): WeatherSnapshot {
  const root = asRecord(raw);
  const props = asRecord(root?.properties) ?? root ?? {};

  const siteId = pickEnString(props.identifier) ?? fallbackHub?.siteId ?? "on-143";
  const cityName = pickEnString(props.name) ?? fallbackHub?.cityName ?? "Ontario";
  const region = pickEnString(props.region);
  const lastUpdated = pickEnString(props.lastUpdated);
  const sourceUrl = pickEnString(props.url);

  const hourlyGroup = asRecord(props.hourlyForecastGroup);
  const rawHourly = Array.isArray(hourlyGroup?.hourlyForecasts) ? hourlyGroup.hourlyForecasts : [];
  const hourly: HourlyWeatherPoint[] = [];

  for (const h of rawHourly.slice(0, 12)) {
    const rec = asRecord(h);
    if (!rec) continue;
    const timestamp = pickEnString(rec.timestamp);
    if (!timestamp) continue;
    const wind = asRecord(rec.wind);
    const windChill = pickEnNumber(rec.windChill);
    const humidex = pickEnNumber(rec.humidex);
    hourly.push({
      timestamp,
      tempC: pickEnNumber(rec.temperature),
      feelsLikeC: windChill ?? humidex ?? null,
      condition: pickEnString(rec.condition) ?? "Forecast",
      iconCode: pickEnNumber(rec.iconCode),
      precipChancePct: pickEnNumber(rec.lop),
      windSpeedKmh: pickEnNumber(wind?.speed),
      windDirection: pickEnString(wind?.direction),
    });
  }

  const forecastGroup = asRecord(props.forecastGroup);
  const rawForecasts = Array.isArray(forecastGroup?.forecasts) ? forecastGroup.forecasts : [];
  const firstForecast = asRecord(rawForecasts[0]);
  const firstAbbrev = asRecord(firstForecast?.abbreviatedForecast);
  const todaySummary = pickEnString(firstForecast?.textSummary);

  const curr = asRecord(props.currentConditions) ?? {};
  const currWind = asRecord(curr.wind);
  const windChill = pickEnNumber(curr.windChill);
  const humidex = pickEnNumber(curr.humidex);
  const feelsLikeC = windChill !== null ? windChill : humidex !== null ? humidex : null;
  const feelsLikeType = windChill !== null ? "wind_chill" : humidex !== null ? "humidex" : null;

  // Automated stations (like Guelph Turfgrass Institute) can omit condition/iconCode in currentConditions;
  // fall back cleanly to the first hourly forecast or abbreviated day forecast.
  const condition =
    pickEnString(curr.condition) ??
    hourly[0]?.condition ??
    pickEnString(firstAbbrev?.textSummary) ??
    "Current conditions";

  const iconCode =
    pickEnNumber(curr.iconCode) ??
    hourly[0]?.iconCode ??
    pickEnNumber(firstAbbrev?.icon);

  const alerts = parseWarnings(props.warnings, sourceUrl);

  return {
    siteId,
    cityName,
    region,
    stationName: pickEnString(curr.station),
    observedAt: pickEnString(curr.timestamp) ?? lastUpdated,
    lastUpdated,
    sourceUrl,
    current: {
      tempC: pickEnNumber(curr.temperature) ?? hourly[0]?.tempC ?? null,
      feelsLikeC,
      feelsLikeType,
      condition,
      iconCode,
      windSpeedKmh: pickEnNumber(currWind?.speed) ?? hourly[0]?.windSpeedKmh ?? null,
      windGustKmh: pickEnNumber(currWind?.gust),
      windDirection: pickEnString(currWind?.direction) ?? hourly[0]?.windDirection ?? null,
      humidityPct: pickEnNumber(curr.relativeHumidity),
    },
    todaySummary,
    alerts,
    hourly,
    attribution: "Environment and Climate Change Canada (MSC GeoMet)",
  };
}

/**
 * Pick the most relevant ECCC weather snapshot for a planned trip departure window.
 */
export function findWeatherForTripWindow(
  weather: WeatherSnapshot,
  departAtIso: string,
  nowMs = Date.now()
): TripWindowWeather {
  const departMs = Date.parse(departAtIso);
  const validDepart = Number.isFinite(departMs) ? departMs : nowMs;
  const activeAlert = weather.alerts[0] ?? null;

  // Find closest hourly forecast within 2 hours of departure
  let bestHour: HourlyWeatherPoint | null = null;
  let bestDiff = Infinity;
  for (const h of weather.hourly) {
    const ts = Date.parse(h.timestamp);
    if (!Number.isFinite(ts)) continue;
    const diff = Math.abs(ts - validDepart);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestHour = h;
    }
  }

  const isNearNow = Math.abs(validDepart - nowMs) <= 45 * 60_000;
  const useForecast = !isNearNow && bestHour !== null && bestDiff <= 2 * 3600_000;

  const tempC = useForecast ? bestHour!.tempC : weather.current.tempC;
  const feelsLikeC = useForecast ? bestHour!.feelsLikeC : weather.current.feelsLikeC;
  const condition = useForecast ? bestHour!.condition : weather.current.condition;
  const iconCode = useForecast ? bestHour!.iconCode : weather.current.iconCode;
  const precipChancePct = bestHour && bestDiff <= 2 * 3600_000 ? bestHour.precipChancePct : null;
  const windSpeedKmh = useForecast ? bestHour!.windSpeedKmh : weather.current.windSpeedKmh;

  const lowerCond = condition.toLowerCase();
  let advisoryNote: string | null = null;
  if (lowerCond.includes("freezing rain") || lowerCond.includes("ice")) {
    advisoryNote = "Watch for icy platforms and transit delays.";
  } else if (lowerCond.includes("snow") || lowerCond.includes("flurries") || lowerCond.includes("blizzard")) {
    advisoryNote = "Snow in the forecast; allow extra wait time.";
  } else if (lowerCond.includes("thunder")) {
    advisoryNote = "Thunderstorm risk along the corridor.";
  } else if ((precipChancePct ?? 0) >= 60 || lowerCond.includes("rain") || lowerCond.includes("shower")) {
    advisoryNote = "Bring rain gear for walking legs and open stops.";
  } else if (feelsLikeC !== null && feelsLikeC <= -15) {
    advisoryNote = "Bitter wind chill for outdoor stops.";
  } else if (feelsLikeC !== null && feelsLikeC >= 35) {
    advisoryNote = "High humidex; stay hydrated while waiting.";
  }

  return {
    cityName: weather.cityName,
    tempC,
    feelsLikeC,
    condition,
    iconCode,
    precipChancePct,
    windSpeedKmh,
    isForecast: useForecast,
    targetTime: useForecast ? bestHour!.timestamp : weather.observedAt,
    activeAlert,
    advisoryNote,
  };
}
