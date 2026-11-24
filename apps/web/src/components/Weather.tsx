import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  ExternalLink,
  EyeOff,
  Moon,
  Sun,
  Wind,
  X,
} from "lucide-react";
import {
  formatClock,
  formatTemperature,
  formatWindKmh,
  type HourlyWeatherPoint,
  type WeatherAlert,
  type WeatherSnapshot,
} from "../lib/api";
import { usePreferences } from "../lib/preferences";

export function WeatherGlyph({
  iconCode,
  condition,
  size = 18,
}: {
  iconCode: number | null | undefined;
  condition?: string | null;
  size?: number;
}) {
  const lower = (condition || "").toLowerCase();
  const code = typeof iconCode === "number" ? iconCode : -1;

  if (code === 19 || code === 39 || code === 46 || code === 47 || lower.includes("thunder")) {
    return <CloudLightning size={size} aria-hidden="true" />;
  }
  if (
    code === 14 ||
    code === 15 ||
    code === 16 ||
    code === 17 ||
    code === 18 ||
    code === 25 ||
    code === 26 ||
    code === 27 ||
    code === 38 ||
    code === 40 ||
    lower.includes("snow") ||
    lower.includes("flurr") ||
    lower.includes("blizzard") ||
    lower.includes("ice")
  ) {
    return <CloudSnow size={size} aria-hidden="true" />;
  }
  if (code === 11 || code === 12 || code === 13 || code === 36 || lower.includes("rain") || lower.includes("shower")) {
    return <CloudRain size={size} aria-hidden="true" />;
  }
  if (code === 6 || code === 7 || code === 8 || code === 28 || lower.includes("drizzle")) {
    return <CloudDrizzle size={size} aria-hidden="true" />;
  }
  if (code === 23 || code === 24 || code === 44 || lower.includes("fog") || lower.includes("haze") || lower.includes("mist") || lower.includes("smoke")) {
    return <CloudFog size={size} aria-hidden="true" />;
  }
  if (code === 43 || lower.includes("wind")) {
    return <Wind size={size} aria-hidden="true" />;
  }
  if (code === 0 || code === 1) return <Sun size={size} aria-hidden="true" />;
  if (code === 30) return <Moon size={size} aria-hidden="true" />;
  if (code === 2 || code === 3 || code === 4 || code === 5) return <CloudSun size={size} aria-hidden="true" />;
  if (code === 31 || code === 32 || code === 33 || code === 34) return <CloudMoon size={size} aria-hidden="true" />;
  if (lower.includes("sunny")) return <Sun size={size} aria-hidden="true" />;
  if (lower.includes("clear")) return <Moon size={size} aria-hidden="true" />;
  return <Cloud size={size} aria-hidden="true" />;
}

function alertBadgeColors(alert: WeatherAlert): { bg: string; fg: string } {
  if (alert.colourLevel === "red" || alert.type === "warning") {
    return { bg: "var(--danger)", fg: "#ffffff" };
  }
  if (alert.colourLevel === "orange" || alert.type === "watch") {
    return { bg: "#B45309", fg: "#ffffff" };
  }
  return { bg: "var(--ink)", fg: "var(--paper)" };
}

export function WeatherAlertBanner({
  weather,
  compact = false,
}: {
  weather: WeatherSnapshot | undefined;
  compact?: boolean;
}) {
  const { showWeather } = usePreferences();
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);

  if (!showWeather || !weather || weather.alerts.length === 0) return null;

  const visible = weather.alerts.filter((a) => !dismissedIds.includes(a.id));
  if (visible.length === 0) return null;

  const top = visible[0]!;
  const colors = alertBadgeColors(top);

  return (
    <div
      role="status"
      className={`flex items-start justify-between gap-2 ${compact ? "px-3 py-2 text-xs" : "px-3.5 py-2.5 text-sm"}`}
      style={{
        background: "var(--paper-raised)",
        border: "var(--border-w) solid var(--danger)",
        color: "var(--ink)",
      }}
    >
      <div className="flex items-start gap-2 min-w-0">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-bold shrink-0"
          style={{ background: colors.bg, color: colors.fg }}
        >
          <AlertTriangle size={13} aria-hidden="true" />
          {top.type === "warning"
            ? "Warning"
            : top.type === "watch"
              ? "Watch"
              : top.type === "advisory"
                ? "Advisory"
                : "Alert"}
        </span>
        <div className="min-w-0">
          <span className="font-bold">{top.title}</span>
          <span className="sh-muted"> · {weather.cityName}</span>
          {visible.length > 1 && <span className="sh-muted"> (+{visible.length - 1} more)</span>}
          {top.url && (
            <>
              {" "}
              <a href={top.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 whitespace-nowrap">
                ECCC details <ExternalLink size={12} aria-hidden="true" />
              </a>
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss weather alert"
        onClick={() => setDismissedIds((prev) => [...prev, top.id])}
        className="bg-transparent border-0 p-1 cursor-pointer shrink-0"
        style={{ color: "var(--ink-soft)" }}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

export function WeatherMapChip({
  weather,
}: {
  weather: WeatherSnapshot | undefined;
}) {
  const { units, showWeather, setShowWeather, showWeatherRadar, setShowWeatherRadar } = usePreferences();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!showWeather || !weather) return null;

  const { current } = weather;
  const hasAlert = weather.alerts.length > 0;
  const showFeels =
    current.feelsLikeC !== null &&
    current.tempC !== null &&
    Math.abs(current.feelsLikeC - current.tempC) >= 2;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Weather in ${weather.cityName}: ${formatTemperature(current.tempC, units)}, ${current.condition}`}
        className="sh-chip cursor-pointer text-left"
        style={{
          minHeight: 44,
          borderColor: hasAlert ? "var(--danger)" : "var(--line)",
        }}
      >
        <span className="inline-flex items-center gap-1.5" style={{ color: hasAlert ? "var(--danger)" : "var(--ink)" }}>
          <WeatherGlyph iconCode={current.iconCode} condition={current.condition} size={18} />
          <b className="tabular-nums">{formatTemperature(current.tempC, units)}</b>
        </span>
        <span className="leading-tight hidden xl:inline">
          <span className="block text-xs font-bold truncate max-w-[140px]">
            {weather.cityName} · {current.condition}
          </span>
          <span className="block text-xs sh-muted tabular-nums">
            {showFeels
              ? `Feels ${formatTemperature(current.feelsLikeC, units)}`
              : current.windSpeedKmh !== null
                ? `Wind ${formatWindKmh(current.windSpeedKmh, units)}${current.windDirection ? ` ${current.windDirection}` : ""}`
                : "ECCC live"}
            {hasAlert ? ` · ${weather.alerts.length} alert${weather.alerts.length === 1 ? "" : "s"}` : ""}
          </span>
        </span>
      </button>

      {open && (
        <div
          className="sh-panel absolute left-0 top-full mt-1.5 w-[340px] max-w-[90vw] p-3.5 space-y-3 z-30 text-sm"
          role="dialog"
          aria-label={`Weather details for ${weather.cityName}`}
        >
          <div className="flex items-start justify-between gap-2 pb-2" style={{ borderBottom: "1px solid var(--rule)" }}>
            <div className="min-w-0">
              <div className="font-extrabold text-base flex items-center gap-2">
                <WeatherGlyph iconCode={current.iconCode} condition={current.condition} size={20} />
                <span>
                  {weather.cityName}: {formatTemperature(current.tempC, units)}
                </span>
              </div>
              <div className="text-xs sh-muted">
                {current.condition}
                {showFeels ? ` · Feels like ${formatTemperature(current.feelsLikeC, units)}` : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close weather details"
              className="bg-transparent border-0 p-1 cursor-pointer"
              style={{ color: "var(--ink-soft)" }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          <WeatherAlertBanner weather={weather} compact />

          <dl className="grid grid-cols-3 gap-2 m-0 text-xs pb-2" style={{ borderBottom: "1px solid var(--rule)" }}>
            <div>
              <dt className="sh-muted">Wind</dt>
              <dd className="m-0 font-bold tabular-nums">
                {current.windSpeedKmh !== null
                  ? `${formatWindKmh(current.windSpeedKmh, units)}${current.windDirection ? ` ${current.windDirection}` : ""}`
                  : "Calm"}
              </dd>
              {current.windGustKmh !== null && current.windGustKmh > 0 && (
                <dd className="m-0 sh-muted tabular-nums">Gusts {formatWindKmh(current.windGustKmh, units)}</dd>
              )}
            </div>
            <div>
              <dt className="sh-muted">Humidity</dt>
              <dd className="m-0 font-bold tabular-nums">
                {current.humidityPct !== null ? `${Math.round(current.humidityPct)}%` : "--"}
              </dd>
            </div>
            <div>
              <dt className="sh-muted">Feels like</dt>
              <dd className="m-0 font-bold tabular-nums">
                {current.feelsLikeC !== null
                  ? formatTemperature(current.feelsLikeC, units)
                  : formatTemperature(current.tempC, units)}
              </dd>
            </div>
          </dl>

          {weather.hourly.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-bold sh-muted">Next 6 hours</div>
              <div className="grid grid-cols-6 gap-1 text-center text-xs tabular-nums">
                {weather.hourly.slice(0, 6).map((h) => (
                  <div
                    key={h.timestamp}
                    className="py-1.5 px-1 flex flex-col items-center gap-0.5"
                    style={{ border: "1px solid var(--rule)", background: "var(--paper-raised)" }}
                    title={`${formatClock(h.timestamp)}: ${h.condition}`}
                  >
                    <span className="text-[11px] sh-muted">{formatClock(h.timestamp).replace(":00", "")}</span>
                    <WeatherGlyph iconCode={h.iconCode} condition={h.condition} size={14} />
                    <span className="font-bold">{formatTemperature(h.tempC, units).replace(/[CF]/, "")}</span>
                    {h.precipChancePct !== null && h.precipChancePct > 0 && (
                      <span className="text-[10px]" style={{ color: "var(--accent)" }}>
                        {h.precipChancePct}%
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {weather.todaySummary && (
            <p className="m-0 text-xs sh-muted leading-snug">{weather.todaySummary}</p>
          )}

          <div
            className="flex flex-wrap items-center justify-between gap-2 pt-2 text-xs"
            style={{ borderTop: "1px solid var(--rule)" }}
          >
            <label className="flex items-center gap-2 cursor-pointer font-bold">
              <input
                type="checkbox"
                checked={showWeatherRadar}
                onChange={(e) => setShowWeatherRadar(e.target.checked)}
                className="w-4 h-4"
              />
              Live rain &amp; snow radar
            </label>
            <button
              type="button"
              onClick={() => {
                setShowWeather(false);
                setOpen(false);
              }}
              className="inline-flex items-center gap-1 bg-transparent border-0 p-0 underline cursor-pointer text-xs"
              style={{ color: "var(--ink-soft)", font: "inherit" }}
            >
              <EyeOff size={13} aria-hidden="true" /> Hide weather
            </button>
          </div>

          <div className="text-[11px] sh-muted flex items-center justify-between gap-2">
            <span>
              {weather.stationName || "Environment Canada"}
              {weather.observedAt ? ` · ${formatClock(weather.observedAt)}` : ""}
            </span>
            {weather.sourceUrl && (
              <a href={weather.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5">
                weather.gc.ca <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Compact inline weather strip for the Trip Planner, matched to the selected departure time.
 */
export function TripWeatherNote({
  weather,
  departAtIso,
}: {
  weather: WeatherSnapshot | undefined;
  departAtIso: string;
}) {
  const { units, showWeather, setShowWeather } = usePreferences();

  if (!showWeather || !weather) return null;

  const departMs = Date.parse(departAtIso);
  const nowMs = Date.now();
  const validDepart = Number.isFinite(departMs) ? departMs : nowMs;

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
  const precipChance = bestHour && bestDiff <= 2 * 3600_000 ? bestHour.precipChancePct : null;
  const windKmh = useForecast ? bestHour!.windSpeedKmh : weather.current.windSpeedKmh;

  const lower = condition.toLowerCase();
  let tip: string | null = null;
  if (lower.includes("freezing rain") || lower.includes("ice")) {
    tip = "Watch for icy platforms and transit delays.";
  } else if (lower.includes("snow") || lower.includes("flurr") || lower.includes("blizzard")) {
    tip = "Snow in the forecast; allow extra wait time.";
  } else if (lower.includes("thunder")) {
    tip = "Thunderstorm risk along your trip.";
  } else if ((precipChance ?? 0) >= 60 || lower.includes("rain") || lower.includes("shower")) {
    tip = "Bring rain gear for walking legs and open stops.";
  } else if (feelsLikeC !== null && feelsLikeC <= -15) {
    tip = "Bitter wind chill for outdoor stops.";
  } else if (feelsLikeC !== null && feelsLikeC >= 35) {
    tip = "High humidex; stay hydrated while waiting.";
  }

  const showFeels = feelsLikeC !== null && tempC !== null && Math.abs(feelsLikeC - tempC) >= 2;

  return (
    <div className="space-y-2">
      <WeatherAlertBanner weather={weather} compact />
      <div
        className="px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-sm"
        style={{ background: "var(--paper-raised)", border: "1px solid var(--rule)" }}
      >
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 min-w-0">
          <span className="inline-flex items-center gap-1.5 font-extrabold tabular-nums">
            <WeatherGlyph iconCode={iconCode} condition={condition} size={18} />
            {formatTemperature(tempC, units)}
          </span>
          <span className="font-bold">{condition}</span>
          <span className="text-xs sh-muted">
            in {weather.cityName}
            {useForecast && bestHour ? ` around ${formatClock(bestHour.timestamp)}` : " now"}
            {showFeels ? ` · Feels ${formatTemperature(feelsLikeC, units)}` : ""}
            {windKmh !== null ? ` · Wind ${formatWindKmh(windKmh, units)}` : ""}
          </span>
          {precipChance !== null && precipChance > 0 && (
            <span className="inline-flex items-center gap-1 text-xs font-bold tabular-nums" style={{ color: "var(--accent)" }}>
              <Droplets size={13} aria-hidden="true" />
              {precipChance}% precip
            </span>
          )}
          {tip && <span className="text-xs font-bold">{tip}</span>}
        </div>
        <div className="flex items-center gap-3 text-xs shrink-0">
          {weather.sourceUrl && (
            <a href={weather.sourceUrl} target="_blank" rel="noreferrer" className="sh-muted">
              ECCC
            </a>
          )}
          <button
            type="button"
            onClick={() => setShowWeather(false)}
            className="bg-transparent border-0 p-0 underline cursor-pointer text-xs"
            style={{ color: "var(--ink-soft)", font: "inherit" }}
          >
            Hide
          </button>
        </div>
      </div>
    </div>
  );
}
