import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDownUp,
  ArrowRight,
  Bookmark,
  Bus,
  Clock,
  Footprints,
  LocateFixed,
  Navigation,
  RefreshCw,
  ShieldCheck,
  Ticket,
  TrainFront,
  X,
} from "lucide-react";
import { apiJson, formatClock, isTrainMode, type VehicleMode } from "../lib/api";
import { useUserLocation } from "../hooks/useUserLocation";
import { useWeather } from "../hooks/useWeather";
import { usePreferences } from "../lib/preferences";
import { agencyShortName } from "../lib/agencies";
import { routeColor } from "../lib/routeColors";
import {
  deleteCommutePreset,
  loadCommutePresets,
  saveActiveTrip,
  saveCommutePreset,
  type CommutePreset,
  type PlanOption,
} from "../lib/activeTrip";
import { EmptyState, LiveLegend, RouteBadge } from "../components/Transit";
import { TripWeatherNote } from "../components/Weather";

interface GeoChoice {
  id: string;
  label: string;
  subtitle: string;
  lat: number;
  lon: number;
  kind: "stop" | "place";
}

interface PlanResponse {
  from?: { lat: number; lon: number };
  to?: { lat: number; lon: number };
  departAt: string;
  serverTime: string;
  timezone: string;
  directDistanceMeters: number;
  options: PlanOption[];
  originStopsChecked: number;
  destStopsChecked: number;
}

function toLocalDateTimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatEtaLabel(mins: number): string {
  if (mins <= 0) return "Due";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function PlaceField({
  id,
  label,
  placeholder,
  selected,
  onSelect,
  initialText = "",
}: {
  id: string;
  label: string;
  placeholder: string;
  selected: GeoChoice | null;
  onSelect: (choice: GeoChoice | null) => void;
  initialText?: string;
}) {
  const [text, setText] = useState(selected?.label ?? initialText);
  const [debounced, setDebounced] = useState(initialText.trim());
  const [open, setOpen] = useState(Boolean(initialText && !selected));
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) setText(selected.label);
  }, [selected?.id]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 220);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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
  }, []);

  const { data } = useQuery({
    queryKey: ["geocode", debounced],
    queryFn: () => apiJson<{ results: GeoChoice[] }>(`/api/v1/geocode?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length >= 2,
    staleTime: 60_000,
  });

  return (
    <div ref={wrapRef} className="relative flex-1 min-w-[220px]">
      <label htmlFor={id} className="sh-label">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type="text"
          value={text}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            if (selected) onSelect(null);
          }}
          placeholder={placeholder}
          autoComplete="off"
          className="sh-input w-full pr-10"
        />
        {text && (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => {
              setText("");
              onSelect(null);
              setOpen(false);
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center bg-transparent border-0 cursor-pointer"
            style={{ color: "var(--ink-soft)" }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && (data?.results.length ?? 0) > 0 && (
        <div role="listbox" className="sh-popover left-0 right-0 max-h-64 overflow-y-auto z-40">
          {data!.results.map((item) => (
            <button
              key={item.id}
              type="button"
              role="option"
              className="sh-popover-item"
              onClick={() => {
                onSelect(item);
                setText(item.label);
                setOpen(false);
              }}
            >
              <span className="truncate text-left">
                <strong className="block truncate">{item.label}</strong>
                <span className="text-xs sh-muted block truncate">{item.subtitle}</span>
              </span>
              <span className="text-xs sh-muted shrink-0 capitalize">{item.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PlanPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { locateOnce, error: gpsError } = useUserLocation();
  const { agencyId, showWeather, setShowWeather } = usePreferences();

  const [origin, setOrigin] = useState<GeoChoice | null>(() => {
    const lat = Number(searchParams.get("fromLat"));
    const lon = Number(searchParams.get("fromLon"));
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0) {
      return {
        id: "gps-init",
        label: searchParams.get("fromLabel") || "Current location",
        subtitle: "GPS",
        lat,
        lon,
        kind: "place",
      };
    }
    return null;
  });

  const [dest, setDest] = useState<GeoChoice | null>(() => {
    const lat = Number(searchParams.get("toLat"));
    const lon = Number(searchParams.get("toLon"));
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0) {
      return {
        id: "dest-init",
        label: searchParams.get("toLabel") || "Destination",
        subtitle: "Selected",
        lat,
        lon,
        kind: "place",
      };
    }
    return null;
  });

  const [timeMode, setTimeMode] = useState<"now" | "custom">("now");
  const [customTime, setCustomTime] = useState<string>(() => toLocalDateTimeInput(new Date()));
  const [clockNow, setClockNow] = useState<Date>(() => new Date());
  const [locating, setLocating] = useState(false);
  const [presets, setPresets] = useState<CommutePreset[]>(() => loadCommutePresets());
  const [presetName, setPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);

  const QUICK_ONTARIO_TRIPS: Array<{
    name: string;
    origin: GeoChoice;
    dest: GeoChoice;
  }> = [
    {
      name: "Guelph → Toronto",
      origin: { id: "q-guelph", label: "Guelph Central GO", subtitle: "Guelph, ON", lat: 43.5446, lon: -80.2465, kind: "stop" },
      dest: { id: "q-bloor", label: "Bloor-Yonge Station", subtitle: "Toronto, ON", lat: 43.6709, lon: -79.3857, kind: "stop" },
    },
    {
      name: "Mississauga → Bloor-Yonge",
      origin: { id: "q-sq1", label: "City Centre Transit Terminal (Square One)", subtitle: "Mississauga, ON", lat: 43.5931, lon: -79.6443, kind: "stop" },
      dest: { id: "q-bloor2", label: "Bloor-Yonge Station", subtitle: "Toronto, ON", lat: 43.6709, lon: -79.3857, kind: "stop" },
    },
    {
      name: "Kitchener → Union Station",
      origin: { id: "q-kit", label: "Kitchener GO", subtitle: "Kitchener, ON", lat: 43.4557, lon: -80.4932, kind: "stop" },
      dest: { id: "q-union", label: "Union Station", subtitle: "Toronto, ON", lat: 43.6452, lon: -79.3806, kind: "stop" },
    },
  ];

  // Keep the visible "current time" clock ticking every 15s
  useEffect(() => {
    const t = setInterval(() => setClockNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  const departAtIso =
    timeMode === "custom" && customTime && !Number.isNaN(Date.parse(customTime))
      ? new Date(customTime).toISOString()
      : null;

  const { data: weatherData } = useWeather({
    lat: origin?.lat ?? null,
    lon: origin?.lon ?? null,
    agencyId: origin ? null : agencyId,
  });

  const useMyLocation = async () => {
    setLocating(true);
    try {
      const pos = await locateOnce();
      setOrigin({
        id: `gps-${pos.timestamp}`,
        label: "Your current location",
        subtitle: `${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}`,
        lat: pos.lat,
        lon: pos.lon,
        kind: "place",
      });
    } finally {
      setLocating(false);
    }
  };

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["route-plan", origin?.lat, origin?.lon, dest?.lat, dest?.lon, timeMode, departAtIso],
    queryFn: () => {
      const params = new URLSearchParams({
        fromLat: String(origin!.lat),
        fromLon: String(origin!.lon),
        toLat: String(dest!.lat),
        toLon: String(dest!.lon),
      });
      if (departAtIso) params.set("departAt", departAtIso);
      return apiJson<PlanResponse>(`/api/v1/plan?${params.toString()}`);
    },
    enabled: Boolean(origin && dest),
    refetchInterval: timeMode === "now" ? 30_000 : false,
  });

  return (
    <div className="sh-page sh-page-narrow">
      <div className="sh-page-head">
        <div>
          <nav aria-label="Breadcrumb" className="sh-kicker">
            <Link to="/">Map</Link>
          </nav>
          <h1 className="sh-title sh-title-sm">Plan a trip</h1>
          <p className="sh-lede">
            See direct and cross-agency transfer trips timed to right now, then open any route directly in the On-Board map window.
          </p>
        </div>
        <button type="button" className="sh-btn" onClick={useMyLocation} disabled={locating}>
          <LocateFixed size={18} aria-hidden="true" /> {locating ? "Locating…" : "Use my location"}
        </button>
      </div>

      {gpsError && (
        <p className="m-0 text-sm font-bold" style={{ color: "var(--danger)" }} role="alert">
          {gpsError}
        </p>
      )}

      {/* Origin / Destination + Departure Time controls */}
      <section aria-label="Trip search" className="space-y-4 pb-5" style={{ borderBottom: "var(--border-w) solid var(--line)" }}>
        <div className="flex flex-wrap items-end gap-3">
          <PlaceField
            id="plan-from"
            label="From"
            placeholder="Stop name, street, or use my location"
            selected={origin}
            onSelect={setOrigin}
          />
          <button
            type="button"
            className="sh-btn sh-btn-icon shrink-0"
            title="Swap origin and destination"
            aria-label="Swap origin and destination"
            onClick={() => {
              const prevO = origin;
              setOrigin(dest);
              setDest(prevO);
            }}
          >
            <ArrowDownUp size={18} aria-hidden="true" />
          </button>
          <PlaceField
            id="plan-to"
            label="To"
            placeholder="Union Station, Stone Road Mall, Eaton Centre…"
            selected={dest}
            onSelect={setDest}
            initialText={searchParams.get("toQuery") || ""}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Departure time mode" className="sh-seg">
              <button
                type="button"
                aria-pressed={timeMode === "now"}
                onClick={() => setTimeMode("now")}
              >
                Leave now
              </button>
              <button
                type="button"
                aria-pressed={timeMode === "custom"}
                onClick={() => {
                  setCustomTime(toLocalDateTimeInput(new Date()));
                  setTimeMode("custom");
                }}
              >
                Depart at
              </button>
            </div>

            {timeMode === "custom" ? (
              <input
                type="datetime-local"
                aria-label="Departure date and time"
                value={customTime}
                onChange={(e) => setCustomTime(e.target.value)}
                className="sh-input"
              />
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm sh-muted tabular-nums">
                <Clock size={15} aria-hidden="true" />
                Current time: <strong style={{ color: "var(--ink)" }}>{formatClock(clockNow.toISOString())}</strong>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!showWeather && (
              <button type="button" className="sh-btn text-xs" onClick={() => setShowWeather(true)}>
                Show weather
              </button>
            )}
            {origin && dest && (
              <button
                type="button"
                className="sh-btn"
                onClick={() => void refetch()}
                disabled={isFetching}
              >
                <RefreshCw size={16} aria-hidden="true" className={isFetching ? "animate-spin" : ""} />
                Refresh times
              </button>
            )}
          </div>
        </div>
      </section>

      <TripWeatherNote weather={weatherData} departAtIso={departAtIso ?? clockNow.toISOString()} />

      {/* Commute Presets & Quick Ontario Trips */}
      <section aria-label="Saved commutes" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-bold sh-muted inline-flex items-center gap-1.5">
            <Bookmark size={14} aria-hidden="true" />
            {presets.length > 0 ? "Saved commutes" : "Quick cross-agency trips"}
          </span>
          {origin && dest && !savingPreset && (
            <button
              type="button"
              className="bg-transparent border-0 p-0 underline cursor-pointer text-xs"
              style={{ color: "var(--accent)", font: "inherit" }}
              onClick={() => {
                setPresetName(`${origin.label.split(",")[0]} → ${dest.label.split(",")[0]}`.slice(0, 32));
                setSavingPreset(true);
              }}
            >
              Pin this commute
            </button>
          )}
        </div>

        {savingPreset && origin && dest && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!presetName.trim()) return;
              setPresets(
                saveCommutePreset({
                  name: presetName.trim(),
                  origin: { label: origin.label, subtitle: origin.subtitle, lat: origin.lat, lon: origin.lon },
                  dest: { label: dest.label, subtitle: dest.subtitle, lat: dest.lat, lon: dest.lon },
                })
              );
              setSavingPreset(false);
              setPresetName("");
            }}
          >
            <input
              type="text"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="e.g. Home → Work"
              aria-label="Commute preset name"
              className="sh-input text-xs flex-1 min-w-[180px]"
            />
            <button type="submit" className="sh-btn sh-btn-primary text-xs" style={{ minHeight: 38 }}>
              Save
            </button>
            <button type="button" className="sh-btn text-xs" style={{ minHeight: 38 }} onClick={() => setSavingPreset(false)}>
              Cancel
            </button>
          </form>
        )}

        <div className="flex flex-wrap gap-2">
          {presets.length > 0
            ? presets.map((p) => (
                <span key={p.id} className="inline-flex items-stretch">
                  <button
                    type="button"
                    className="sh-btn text-xs"
                    style={{ minHeight: 34, padding: "0 0.65rem" }}
                    onClick={() => {
                      setOrigin({ id: `${p.id}-o`, ...p.origin, kind: "place" });
                      setDest({ id: `${p.id}-d`, ...p.dest, kind: "place" });
                    }}
                  >
                    {p.name}
                  </button>
                  <button
                    type="button"
                    className="sh-btn text-xs"
                    aria-label={`Remove ${p.name}`}
                    style={{ minHeight: 34, padding: "0 0.4rem", borderLeft: 0 }}
                    onClick={() => setPresets(deleteCommutePreset(p.id))}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </span>
              ))
            : QUICK_ONTARIO_TRIPS.map((qt) => (
                <button
                  key={qt.name}
                  type="button"
                  className="sh-btn text-xs"
                  style={{ minHeight: 34, padding: "0 0.65rem" }}
                  onClick={() => {
                    setOrigin(qt.origin);
                    setDest(qt.dest);
                  }}
                >
                  {qt.name}
                </button>
              ))}
        </div>
      </section>

      {!origin || !dest ? (
        <EmptyState>
          Pick both a starting point and a destination above to see upcoming buses and live arrival times.
        </EmptyState>
      ) : null}

      {isLoading && <p className="text-sm sh-muted">Checking live buses and upcoming schedules…</p>}
      {error && (
        <p className="text-sm font-bold" style={{ color: "var(--danger)" }}>
          {(error as Error).message}
        </p>
      )}

      {data && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="sh-section-title m-0 border-0 pb-0">
              {data.options.length === 1 ? "1 route option" : `${data.options.length} route options`}
            </h2>
            <span className="text-xs tabular-nums sh-muted">
              {(data.directDistanceMeters / 1000).toFixed(1)} km apart · based on {formatClock(data.departAt)}
            </span>
          </div>

          <LiveLegend />

          {/* Live "Leave-By" Countdown Banner for the fastest current option */}
          {timeMode === "now" &&
            data.options[0] &&
            data.options[0].nextDepartureAt &&
            (() => {
              const top = data.options[0]!;
              const firstWalk = top.legs[0]?.mode === "walk" ? top.legs[0].minutes : 0;
              const firstTransit = top.legs.find((l) => l.mode === "transit");
              const depMs = Date.parse(top.nextDepartureAt!);
              const leaveByMs = depMs - firstWalk * 60_000;
              const minsUntilLeave = Math.round((leaveByMs - clockNow.getTime()) / 60_000);
              const weatherExtra =
                weatherData &&
                /snow|rain|freezing|ice/i.test(weatherData.current.condition)
                  ? " · Allow 2–3 extra min for weather"
                  : "";
              return (
                <div
                  className="sh-surface px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-sm"
                  style={{ borderLeft: "4px solid var(--accent)" }}
                  role="status"
                >
                  <span className="inline-flex items-center gap-2">
                    <Clock size={16} aria-hidden="true" style={{ color: "var(--accent)" }} />
                    <span>
                      {minsUntilLeave <= 1 ? (
                        <strong>Leave now</strong>
                      ) : (
                        <>
                          Leave in <strong className="tabular-nums">{minsUntilLeave} min</strong> (by{" "}
                          <strong className="tabular-nums">{formatClock(new Date(leaveByMs).toISOString())}</strong>)
                        </>
                      )}{" "}
                      to catch{" "}
                      <strong>
                        {agencyShortName(firstTransit?.agencyId ?? top.agencyId)} {firstTransit?.routeShortName}
                      </strong>
                      {weatherExtra && <span className="sh-muted">{weatherExtra}</span>}
                    </span>
                  </span>
                  {top.fareEstimate && (
                    <span className="text-xs font-bold tabular-nums" style={{ color: "var(--accent)" }}>
                      {top.fareEstimate.summary}
                    </span>
                  )}
                </div>
              );
            })()}

          {data.options.length === 0 ? (
            <EmptyState>
              No direct or 1-transfer transit route was found between these two points. Try choosing a nearby main street
              or transit stop in Toronto (TTC), Mississauga (MiWay), Brampton, York Region (YRT), Durham (DRT), Oakville,
              Milton, Hamilton (HSR), Guelph, Waterloo Region (GRT), Thunder Bay, Ontario Northland, or along the GO network.
            </EmptyState>
          ) : (
            <div className="space-y-5">
              {data.options.map((opt) => {
                const firstTransit = opt.legs.find((l) => l.mode === "transit");
                const firstBus = firstTransit?.upcomingBuses?.[0] ?? null;
                const noService = opt.serviceStatus === "no_upcoming";
                const agencyList = opt.agencies?.length ? opt.agencies : [opt.agencyId];
                const isCrossAgency = Boolean(opt.isCrossAgency || agencyList.length > 1);

                const launchTripOnBoard = () => {
                  if (!origin || !dest) return;
                  const tripId = `${opt.id}-${Date.now().toString(36)}`;
                  saveActiveTrip({
                    id: tripId,
                    originLabel: origin.label,
                    originLat: origin.lat,
                    originLon: origin.lon,
                    destLabel: dest.label,
                    destLat: dest.lat,
                    destLon: dest.lon,
                    option: opt,
                    startedAt: new Date().toISOString(),
                  });
                  navigate(`/?trip=${encodeURIComponent(tripId)}`);
                };

                return (
                  <article
                    key={opt.id}
                    className={`sh-card py-4 space-y-4 ${noService ? "opacity-75" : ""}`}
                  >
                    {/* Header row: route badges + status + clock window & total duration */}
                    <div
                      className="flex flex-wrap items-start justify-between gap-3 pb-3"
                      style={{ borderBottom: "1px solid var(--rule)" }}
                    >
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {opt.legs
                            .filter((l) => l.mode === "transit")
                            .map((leg, idx) => (
                              <React.Fragment key={idx}>
                                {idx > 0 && <ArrowRight size={16} aria-hidden="true" />}
                                <RouteBadge
                                  size="lg"
                                  label={leg.routeShortName ?? leg.routeId ?? "—"}
                                  color={routeColor(leg.agencyId ?? opt.agencyId, leg.routeId, leg.routeColor)}
                                />
                              </React.Fragment>
                            ))}
                          <span className="text-sm font-bold">
                            {agencyList.map((a) => agencyShortName(a)).join(" → ")}
                          </span>
                          <span className="text-sm sh-muted">
                            ·{" "}
                            {opt.kind === "direct"
                              ? "Direct"
                              : (opt.transfersCount ?? 1) >= 2
                                ? `${opt.transfersCount} transfers${isCrossAgency ? " · Cross-agency" : ""}`
                                : isCrossAgency
                                  ? "Cross-agency transfer"
                                  : "1 transfer"}
                          </span>
                        </div>

                        {/* Ontario One Fare / PRESTO estimate + Transfer Connection Risk badges */}
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          {opt.fareEstimate && (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 tabular-nums font-bold"
                              style={{
                                border: "1px solid var(--rule)",
                                background: opt.fareEstimate.oneFareApplied ? "var(--paper-raised)" : "transparent",
                                color: opt.fareEstimate.oneFareApplied ? "var(--accent)" : "var(--ink)",
                              }}
                              title={opt.fareEstimate.breakdown
                                .map((b) => `${agencyShortName(b.agencyId)}: $${b.chargedCad.toFixed(2)}${b.note ? ` (${b.note})` : ""}`)
                                .join(" + ")}
                            >
                              <Ticket size={13} aria-hidden="true" />
                              {opt.fareEstimate.summary}
                            </span>
                          )}
                          {opt.transferRisks?.map((risk, rIdx) => (
                            <span
                              key={rIdx}
                              className="inline-flex items-center gap-1 px-2 py-0.5 font-bold"
                              style={{
                                border: "1px solid var(--rule)",
                                color:
                                  risk.level === "likely_missed"
                                    ? "var(--danger)"
                                    : risk.level === "tight"
                                      ? "var(--accent)"
                                      : "var(--ink-soft)",
                              }}
                            >
                              {risk.level === "safe" ? (
                                <ShieldCheck size={13} aria-hidden="true" />
                              ) : (
                                <AlertTriangle size={13} aria-hidden="true" />
                              )}
                              {risk.message}
                              {risk.level !== "safe" && risk.backupDepartureTime
                                ? ` · Backup ${formatClock(risk.backupDepartureTime)}`
                                : ""}
                            </span>
                          ))}
                        </div>

                        <div className="text-sm">
                          {firstBus ? (
                            firstBus.isLive ? (
                              <span className="sh-live">
                                Next {isTrainMode(firstTransit?.vehicleMode as VehicleMode) ? "train" : "bus"} in{" "}
                                {formatEtaLabel(firstBus.etaMinutes)} ({formatClock(firstBus.departureTime)})
                                {firstBus.fleetNumber ? ` · #${firstBus.fleetNumber}` : ""}
                                {firstBus.stopsAway !== null
                                  ? firstBus.stopsAway === 0
                                    ? " · at stop"
                                    : ` · ${firstBus.stopsAway} ${firstBus.stopsAway === 1 ? "stop" : "stops"} away`
                                  : ""}
                              </span>
                            ) : (
                              <span className="sh-sched">
                                Next scheduled {isTrainMode(firstTransit?.vehicleMode as VehicleMode) ? "train" : "departure"} at{" "}
                                {formatClock(firstBus.departureTime)} (in {formatEtaLabel(firstBus.etaMinutes)})
                              </span>
                            )
                          ) : (
                            <span className="sh-sched">
                              No upcoming departures found around {formatClock(data.departAt)}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="text-right shrink-0 space-y-2">
                        <div>
                          <div className="text-2xl font-extrabold tabular-nums leading-none">
                            {noService ? `~${opt.totalMinutes} min` : `${opt.totalMinutes} min`}
                          </div>
                          {!noService && (
                            <div className="text-sm font-bold tabular-nums mt-1">
                              {formatClock(opt.leaveAt)} → {formatClock(opt.arriveAt)}
                            </div>
                          )}
                          <div className="text-xs tabular-nums sh-muted mt-0.5">
                            {opt.walkMinutes}m walk
                            {opt.waitMinutes > 0 ? ` · ${opt.waitMinutes}m wait` : ""}
                            {" · "}
                            {opt.rideMinutes}m ride
                          </div>
                        </div>
                        <button type="button" className="sh-btn sh-btn-primary text-xs" onClick={launchTripOnBoard}>
                          <Navigation size={15} aria-hidden="true" />
                          Go on map · On board
                        </button>
                      </div>
                    </div>

                    {/* Step-by-step legs */}
                    <ol className="m-0 p-0 list-none space-y-3 text-sm">
                      {opt.legs.map((leg, i) => (
                        <li
                          key={i}
                          className="flex items-start justify-between gap-3 pb-3 last:pb-0"
                          style={i < opt.legs.length - 1 ? { borderBottom: "1px dashed var(--rule)" } : undefined}
                        >
                          <div className="flex items-start gap-3 min-w-0 flex-1">
                            {leg.mode === "walk" ? (
                              <Footprints size={18} className="mt-0.5 shrink-0 sh-muted" aria-hidden="true" />
                            ) : isTrainMode(leg.vehicleMode as VehicleMode) ? (
                              <TrainFront size={18} className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} aria-hidden="true" />
                            ) : (
                              <Bus size={18} className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} aria-hidden="true" />
                            )}

                            <div className="min-w-0 flex-1 space-y-1.5">
                              {leg.mode === "walk" ? (
                                <div>
                                  Walk <strong>{leg.distanceMeters} m</strong> to{" "}
                                  <strong>{leg.toName}</strong>
                                </div>
                              ) : (
                                <>
                                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                    <span>
                                      Take{" "}
                                      {isCrossAgency && leg.agencyId && (
                                        <span className="font-bold">{agencyShortName(leg.agencyId)} </span>
                                      )}
                                      <Link
                                        to={`/routes/${leg.agencyId}/${encodeURIComponent(leg.routeId!)}`}
                                        className="font-bold"
                                      >
                                        Route {leg.routeShortName}
                                        {leg.routeLongName ? ` (${leg.routeLongName})` : ""}
                                      </Link>
                                    </span>
                                    {leg.nearestHeadsign && (
                                      <span className="text-xs sh-muted">towards {leg.nearestHeadsign}</span>
                                    )}
                                  </div>

                                  <div className="text-xs sh-muted">
                                    Board at{" "}
                                    {leg.fromStopId ? (
                                      <Link to={`/stops/${leg.agencyId}/${encodeURIComponent(leg.fromStopId)}`}>
                                        {leg.fromName}
                                      </Link>
                                    ) : (
                                      leg.fromName
                                    )}
                                    {leg.departureTime ? ` (${formatClock(leg.departureTime)})` : ""}
                                    {" → Exit at "}
                                    {leg.toStopId ? (
                                      <Link to={`/stops/${leg.agencyId}/${encodeURIComponent(leg.toStopId)}`}>
                                        {leg.toName}
                                      </Link>
                                    ) : (
                                      leg.toName
                                    )}
                                    {leg.arrivalTime ? ` (${formatClock(leg.arrivalTime)})` : ""}
                                    {leg.stopsCount ? ` · ${leg.stopsCount} stops` : ""}
                                  </div>

                                  {leg.alerts && leg.alerts.length > 0 && (
                                    <div
                                      className="p-2 text-xs space-y-0.5"
                                      style={{ borderLeft: "3px solid var(--danger)", background: "var(--paper-raised)" }}
                                      role="alert"
                                    >
                                      {leg.alerts.map((al) => (
                                        <div key={al.id} className="flex items-start gap-1.5">
                                          <AlertTriangle size={13} className="shrink-0 mt-0.5" style={{ color: "var(--danger)" }} aria-hidden="true" />
                                          <span>
                                            <strong>{al.effect ? `${al.effect.replace(/_/g, " ")}: ` : "Alert: "}</strong>
                                            {al.headerText}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  {/* Upcoming buses strip for this leg */}
                                  {leg.upcomingBuses && leg.upcomingBuses.length > 0 ? (
                                    <div className="pt-1 space-y-1">
                                      <div className="text-xs font-bold sh-muted">
                                        {leg.upcomingBuses.length === 1 ? "Next bus:" : "Upcoming buses:"}
                                      </div>
                                      <div className="flex flex-wrap gap-2">
                                        {leg.upcomingBuses.map((bus, bIdx) => {
                                          const inner = (
                                            <span className="inline-flex items-center gap-1.5 tabular-nums">
                                              <span className={bus.isLive ? "font-extrabold" : "sh-sched"}>
                                                {formatClock(bus.departureTime)}
                                              </span>
                                              <span className="sh-muted">({formatEtaLabel(bus.etaMinutes)})</span>
                                              {bus.fleetNumber && (
                                                <span className="sh-narrow" style={{ color: "var(--accent)" }}>
                                                  #{bus.fleetNumber}
                                                </span>
                                              )}
                                              {!bus.isLive && <span className="sh-sched text-xs">timetable</span>}
                                            </span>
                                          );
                                          const boxClass = `inline-flex items-center px-2.5 py-1 text-xs no-underline ${
                                            bIdx === 0 ? "sh-surface" : ""
                                          }`;
                                          const boxStyle = {
                                            border:
                                              bIdx === 0
                                                ? "var(--border-w) solid var(--line)"
                                                : "1px solid var(--rule)",
                                            color: "var(--ink)",
                                          };

                                          if (bus.vehicleId) {
                                            return (
                                              <Link
                                                key={`${bus.departureTime}-${bIdx}`}
                                                to={`/?vehicle=${encodeURIComponent(bus.vehicleId)}`}
                                                className={boxClass}
                                                style={boxStyle}
                                                title={`Track Bus #${bus.fleetNumber ?? bus.vehicleId} on the live map`}
                                              >
                                                {inner}
                                              </Link>
                                            );
                                          }
                                          if (bus.tripId) {
                                            return (
                                              <Link
                                                key={`${bus.departureTime}-${bIdx}`}
                                                to={`/trips/${leg.agencyId}/${encodeURIComponent(bus.tripId)}`}
                                                className={boxClass}
                                                style={boxStyle}
                                              >
                                                {inner}
                                              </Link>
                                            );
                                          }
                                          return (
                                            <span key={`${bus.departureTime}-${bIdx}`} className={boxClass} style={boxStyle}>
                                              {inner}
                                            </span>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-xs sh-sched pt-0.5">
                                      No approaching live buses or scheduled trips found in the next 3 hours.
                                    </div>
                                  )}

                                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs">
                                    <span className={(leg.activeVehicles ?? 0) > 0 ? "font-bold" : "sh-muted"}>
                                      {leg.activeVehicles ?? 0}{" "}
                                      {(leg.activeVehicles ?? 0) === 1 ? "bus" : "buses"} on route now
                                    </span>
                                    <Link to={`/?route=${encodeURIComponent(leg.routeId!)}`}>
                                      View route on live map
                                    </Link>
                                    {leg.nearestVehicleId && (
                                      <Link to={`/?vehicle=${encodeURIComponent(leg.nearestVehicleId)}`}>
                                        Track Bus #{leg.nearestFleetNumber}
                                      </Link>
                                    )}
                                  </div>
                                </>
                              )}
                            </div>
                          </div>

                          <span className="text-xs tabular-nums shrink-0 font-bold sh-muted">
                            {leg.minutes} min
                          </span>
                        </li>
                      ))}
                    </ol>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
