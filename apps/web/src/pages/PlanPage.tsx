import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, ArrowRight, Footprints, LocateFixed, MapPin, Navigation } from "lucide-react";
import { apiJson } from "../lib/api";
import { useUserLocation } from "../hooks/useUserLocation";
import { agencyShortName } from "../lib/agencies";
import { routeColor } from "../lib/routeColors";

interface GeoChoice {
  id: string;
  label: string;
  subtitle: string;
  lat: number;
  lon: number;
  kind: "stop" | "place";
}

interface PlanLeg {
  mode: "walk" | "transit";
  agencyId?: string;
  routeId?: string;
  routeShortName?: string;
  routeLongName?: string | null;
  routeColor?: string | null;
  fromName: string;
  fromStopId?: string;
  toName: string;
  toStopId?: string;
  distanceMeters: number;
  minutes: number;
  activeVehicles?: number;
  nearestVehicleId?: string | null;
  nearestFleetNumber?: string | null;
  nearestHeadsign?: string | null;
}

interface PlanOption {
  id: string;
  kind: "direct" | "transfer";
  agencyId: string;
  totalMinutes: number;
  walkMinutes: number;
  rideMinutes: number;
  legs: PlanLeg[];
}

function PlaceField({
  label,
  placeholder,
  selected,
  onSelect,
  initialText = "",
}: {
  label: string;
  placeholder: string;
  selected: GeoChoice | null;
  onSelect: (choice: GeoChoice | null) => void;
  initialText?: string;
}) {
  const [text, setText] = useState(selected?.label ?? initialText);
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (selected) setText(selected.label);
  }, [selected?.id]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 240);
    return () => clearTimeout(t);
  }, [text]);

  const { data } = useQuery({
    queryKey: ["geocode", debounced],
    queryFn: () => apiJson<{ results: GeoChoice[] }>(`/api/v1/geocode?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length >= 2,
    staleTime: 60_000,
  });

  return (
    <div className="relative flex-1 min-w-[220px]">
      <label className="block text-xs font-bold mb-1">{label}</label>
      <input
        type="text"
        value={text}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (selected) onSelect(null);
        }}
        placeholder={placeholder}
        className="sh-input w-full"
      />
      {open && (data?.results.length ?? 0) > 0 && (
        <div
          role="listbox"
          className="sh-popover left-0 right-0 max-h-64 overflow-y-auto z-40"
        >
          {data!.results.map((item) => (
            <button
              key={item.id}
              type="button"
              className="sh-popover-item"
              onClick={() => {
                onSelect(item);
                setText(item.label);
                setOpen(false);
              }}
            >
              <span className="truncate text-left">
                <strong className="block truncate">{item.label}</strong>
                <span className="text-xs opacity-70 block truncate">{item.subtitle}</span>
              </span>
              <span className="text-sm sh-muted shrink-0">{item.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PlanPage() {
  const [searchParams] = useSearchParams();
  const { locateOnce, error: gpsError } = useUserLocation();

  const [origin, setOrigin] = useState<GeoChoice | null>(() => {
    const lat = Number(searchParams.get("fromLat"));
    const lon = Number(searchParams.get("fromLon"));
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0) {
      return { id: "gps-init", label: searchParams.get("fromLabel") || "Current location", subtitle: "GPS", lat, lon, kind: "place" };
    }
    return null;
  });

  const [dest, setDest] = useState<GeoChoice | null>(() => {
    const lat = Number(searchParams.get("toLat"));
    const lon = Number(searchParams.get("toLon"));
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0) {
      return { id: "dest-init", label: searchParams.get("toLabel") || "Destination", subtitle: "Selected", lat, lon, kind: "place" };
    }
    return null;
  });

  const [locating, setLocating] = useState(false);

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

  const { data, isLoading, error } = useQuery({
    queryKey: ["route-plan", origin?.lat, origin?.lon, dest?.lat, dest?.lon],
    queryFn: () =>
      apiJson<{
        directDistanceMeters: number;
        options: PlanOption[];
        originStopsChecked: number;
        destStopsChecked: number;
      }>(
        `/api/v1/plan?fromLat=${origin!.lat}&fromLon=${origin!.lon}&toLat=${dest!.lat}&toLon=${dest!.lon}`
      ),
    enabled: Boolean(origin && dest),
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
            Enter where you are and where you&apos;re going to see direct and 1-transfer bus, streetcar, or GO routes
            with live vehicles.
          </p>
        </div>
        <button type="button" className="sh-btn" onClick={useMyLocation} disabled={locating}>
          <LocateFixed size={18} aria-hidden="true" /> {locating ? "Locating…" : "Use my location"}
        </button>
      </div>

      {gpsError && (
        <div className="p-3 text-sm border-2" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
          {gpsError}
        </div>
      )}

      <div className="sh-card p-5 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <PlaceField
            label="From"
            placeholder="Stop name, street, or click 'Use my location'"
            selected={origin}
            onSelect={setOrigin}
          />
          <button
            type="button"
            className="sh-btn sh-btn-icon"
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
            label="To"
            placeholder="e.g. Union Station, Stone Road Mall, Eaton Centre"
            selected={dest}
            onSelect={setDest}
            initialText={searchParams.get("toQuery") || ""}
          />
        </div>
      </div>

      {isLoading && <p className="text-sm" style={{ color: "var(--text-muted)" }}>Finding transit routes…</p>}
      {error && <p className="text-sm" style={{ color: "var(--status-err)" }}>{(error as Error).message}</p>}

      {data && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="sh-section-title m-0 border-0 pb-0">
              Suggested routes ({data.options.length})
            </h2>
            <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
              Straight-line distance {(data.directDistanceMeters / 1000).toFixed(1)} km · checked {data.originStopsChecked} origin stops &amp; {data.destStopsChecked} destination stops
            </span>
          </div>

          {data.options.length === 0 ? (
            <div className="sh-card p-6 text-sm space-y-2">
              <div className="font-bold">No direct or 1-transfer transit route found between these two points.</div>
              <p className="m-0 text-xs" style={{ color: "var(--text-muted)" }}>
                Try picking a nearby major stop or station in Guelph, Toronto (TTC), or along the GO network.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {data.options.map((opt) => (
                <article key={opt.id} className="sh-card p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b" style={{ borderColor: "var(--border)" }}>
                    <div className="flex flex-wrap items-center gap-2">
                      {opt.legs
                        .filter((l) => l.mode === "transit")
                        .map((leg, idx) => (
                          <React.Fragment key={idx}>
                            {idx > 0 && <ArrowRight size={18} aria-hidden="true" />}
                            <span
                              className="sh-route-shield text-white"
                              style={{ backgroundColor: routeColor(opt.agencyId, leg.routeId, leg.routeColor) }}
                            >
                              {leg.routeShortName}
                            </span>
                          </React.Fragment>
                        ))}
                      <span className="sh-pill sh-pill-muted">{agencyShortName(opt.agencyId)}</span>
                      <span className="sh-pill sh-pill-muted">
                        {opt.kind === "direct" ? "Direct" : "1 transfer"}
                      </span>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold tabular-nums leading-none">
                        ~{opt.totalMinutes} min
                      </div>
                      <div className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
                        {opt.walkMinutes}m walk · {opt.rideMinutes}m transit
                      </div>
                    </div>
                  </div>

                  <ol className="m-0 p-0 list-none space-y-3 text-sm">
                    {opt.legs.map((leg, i) => (
                      <li key={i} className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                          {leg.mode === "walk" ? (
                            <Footprints size={16} className="mt-0.5 shrink-0" style={{ color: "var(--text-muted)" }} />
                          ) : (
                            <Navigation size={16} className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
                          )}
                          <div>
                            {leg.mode === "walk" ? (
                              <div>
                                Walk <strong>{leg.distanceMeters} m</strong> ({leg.minutes} min) to{" "}
                                <strong>{leg.toName}</strong>
                              </div>
                            ) : (
                              <div className="space-y-1">
                                <div>
                                  Take{" "}
                                  <Link
                                    to={`/routes/${leg.agencyId}/${encodeURIComponent(leg.routeId!)}`}
                                    className="font-bold"
                                  >
                                    Route {leg.routeShortName}
                                    {leg.routeLongName ? ` (${leg.routeLongName})` : ""}
                                  </Link>
                                </div>
                                {leg.nearestHeadsign && (
                                  <div className="text-xs font-medium">
                                    Direction: {leg.nearestHeadsign}
                                  </div>
                                )}
                                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                                  Board at{" "}
                                  {leg.fromStopId ? (
                                    <Link to={`/stops/${leg.agencyId}/${encodeURIComponent(leg.fromStopId)}`}>
                                      {leg.fromName}
                                    </Link>
                                  ) : (
                                    leg.fromName
                                  )}{" "}
                                  → Exit at{" "}
                                  {leg.toStopId ? (
                                    <Link to={`/stops/${leg.agencyId}/${encodeURIComponent(leg.toStopId)}`}>
                                      {leg.toName}
                                    </Link>
                                  ) : (
                                    leg.toName
                                  )}
                                </div>
                                <div className="flex flex-wrap gap-2 pt-1 text-xs">
                                  <span className={`sh-pill ${(leg.activeVehicles ?? 0) > 0 ? "sh-pill-ok" : "sh-pill-muted"}`}>
                                    {leg.activeVehicles ?? 0} live now
                                  </span>
                                  <Link
                                    to={`/?route=${encodeURIComponent(leg.routeId!)}`}
                                    className="font-semibold"
                                  >
                                    View on live map
                                  </Link>
                                  {leg.nearestVehicleId && (
                                    <Link
                                      to={`/?vehicle=${encodeURIComponent(leg.nearestVehicleId)}`}
                                      className="font-semibold"
                                    >
                                      Track nearest, {leg.nearestFleetNumber}
                                    </Link>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                        <span className="text-xs tabular-nums shrink-0 font-semibold" style={{ color: "var(--text-muted)" }}>
                          {leg.minutes} min
                        </span>
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
