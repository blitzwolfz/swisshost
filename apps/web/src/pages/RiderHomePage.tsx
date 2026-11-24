import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bell, Compass, LocateFixed, Navigation, Search } from "lucide-react";
import { apiJson, formatVehicleStatusLine, type LiveVehicle } from "../lib/api";
import { useUserLocation } from "../hooks/useUserLocation";
import { agencyShortName } from "../lib/agencies";
import { routeColor } from "../lib/routeColors";

interface NearbyResponse {
  lat: number;
  lon: number;
  nearbyStops: Array<{
    agencyId: string;
    stopId: string;
    stopCode: string | null;
    name: string;
    distanceMeters: number;
    walkMinutes: number;
    routes: string[];
  }>;
  nearbyVehicles: Array<LiveVehicle & { distanceMeters: number }>;
}

interface RideTimelineResponse {
  agencyId: string;
  vehicle: LiveVehicle;
  stops: Array<{
    stopId: string;
    stopCode: string | null;
    name: string;
    stopSequence: number;
    status: "passed" | "current" | "next" | "upcoming";
    distanceMeters: number;
    etaMinutes: number | null;
  }>;
}

/**
 * Simplified Rider View (/simple):
 * Everyday transit companion without enthusiast jargon (no block IDs, raw GPS, or match confidence).
 * 1. Where are you going? (Route Finder)
 * 2. I'm on a bus/train (auto-detects your vehicle from live GPS + shows upcoming stops & get-off alert)
 * 3. Stops near you (nearest stops + walking time + direct departure board)
 */
export default function RiderHomePage() {
  const navigate = useNavigate();
  const { position, watching, error: gpsError, startWatching, stopWatching } = useUserLocation();
  const [destQuery, setDestQuery] = useState("");
  const [ridingVehicle, setRidingVehicle] = useState<{ agencyId: string; vehicleId: string } | null>(null);
  const [alertStopId, setAlertStopId] = useState<string | null>(null);
  const [alertFired, setAlertFired] = useState<string | null>(null);

  const { data: nearby, isLoading: nearbyLoading } = useQuery({
    queryKey: ["nearby", position ? Math.round(position.lat * 1000) : null, position ? Math.round(position.lon * 1000) : null],
    queryFn: () => apiJson<NearbyResponse>(`/api/v1/nearby?lat=${position!.lat}&lon=${position!.lon}&radius=1000`),
    enabled: Boolean(position),
    refetchInterval: watching ? 15_000 : false,
  });

  // Auto-detect vehicle if the user is within 90m of a live vehicle and hasn't manually picked one
  useEffect(() => {
    if (!watching || ridingVehicle || !nearby?.nearbyVehicles.length) return;
    const closest = nearby.nearbyVehicles[0]!;
    if (closest.distanceMeters <= 95) {
      setRidingVehicle({ agencyId: closest.agencyId, vehicleId: closest.vehicleId });
    }
  }, [watching, nearby, ridingVehicle]);

  const { data: rideData } = useQuery({
    queryKey: ["ride-timeline", ridingVehicle?.agencyId, ridingVehicle?.vehicleId],
    queryFn: () =>
      apiJson<RideTimelineResponse>(
        `/api/v1/agencies/${ridingVehicle!.agencyId}/vehicles/${encodeURIComponent(ridingVehicle!.vehicleId)}/ride`
      ),
    enabled: Boolean(ridingVehicle),
    refetchInterval: 15_000,
  });

  // Trigger get-off alert when approaching the user's chosen stop (1 stop away or <= 2 min)
  useEffect(() => {
    if (!alertStopId || !rideData) return;
    const upcoming = rideData.stops.filter((s) => s.status !== "passed");
    const targetIdx = upcoming.findIndex((s) => s.stopId === alertStopId);
    if (targetIdx >= 0 && targetIdx <= 1) {
      const target = upcoming[targetIdx]!;
      if (alertFired !== target.stopId) {
        setAlertFired(target.stopId);
        navigator.vibrate?.([250, 120, 250]);
      }
    }
  }, [alertStopId, rideData, alertFired]);

  const submitWhereTo = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (destQuery.trim()) params.set("toQuery", destQuery.trim());
    if (position) {
      params.set("fromLat", String(position.lat));
      params.set("fromLon", String(position.lon));
      params.set("fromLabel", "Your current location");
    }
    navigate(`/plan?${params.toString()}`);
  };

  const upcomingStops = (rideData?.stops ?? []).filter((s) => s.status !== "passed");

  return (
    <div className="sh-page sh-page-narrow">
      <div className="sh-page-head">
        <div>
          <h1 className="sh-title sh-title-sm">Simple view</h1>
          <p className="sh-lede">
            Find which route to take, see stops near you, or turn on live GPS to track the bus, streetcar, or train
            you&apos;re on right now.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`sh-btn ${watching ? "" : "sh-btn-primary"}`}
            aria-pressed={watching}
            onClick={watching ? stopWatching : startWatching}
          >
            <LocateFixed size={18} aria-hidden="true" /> {watching ? "Stop GPS tracking" : "Track my location"}
          </button>
          <Link to="/" className="sh-btn no-underline">
            Full live map
          </Link>
        </div>
      </div>

      {gpsError && (
        <div className="py-2 text-sm font-bold" role="alert" style={{ color: "var(--danger)" }}>
          {gpsError}
        </div>
      )}

      {alertFired && (
        <div
          role="alert"
          className="p-4 text-base font-bold flex items-center justify-between gap-3"
          style={{ background: "var(--accent)", color: "var(--on-accent)" }}
        >
          <span>
            <Bell size={18} aria-hidden="true" className="inline mr-2" />
            Get ready to get off. Your stop is next.
          </span>
          <button type="button" className="sh-btn" onClick={() => { setAlertStopId(null); setAlertFired(null); }}>
            Dismiss
          </button>
        </div>
      )}

      {/* 1. Quick "Where are you going?" Route Finder */}
      <form onSubmit={submitWhereTo} className="sh-card p-5 space-y-3">
        <label htmlFor="simple-dest" className="block font-bold text-base">
          Where are you going?
        </label>
        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={18} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="simple-dest"
              type="text"
              value={destQuery}
              onChange={(e) => setDestQuery(e.target.value)}
              placeholder="A stop, station or address, such as Union Station"
              className="sh-input w-full pl-10"
            />
          </div>
          <button type="submit" className="sh-btn sh-btn-primary">
            <Navigation size={18} aria-hidden="true" /> Find a route
          </button>
        </div>
      </form>

      {/* 2. On-Board Live Ride Tracker */}
      {ridingVehicle && rideData ? (
        <section className="sh-card p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b-2" style={{ borderColor: "var(--ink)" }}>
            <div className="flex items-start gap-3">
              <span
                className="sh-badge sh-badge-lg"
                style={{ backgroundColor: routeColor(rideData.agencyId, rideData.vehicle.routeId, rideData.vehicle.routeColor) }}
              >
                {rideData.vehicle.routeShortName ?? rideData.vehicle.routeId ?? "—"}
              </span>
              <div>
                <div className="text-sm sh-muted">
                  You are on {agencyShortName(rideData.agencyId)} <span className="sh-fleet">{rideData.vehicle.fleetNumber}</span>
                </div>
                <div className="text-lg font-bold leading-tight">
                  {rideData.vehicle.headsign || rideData.vehicle.routeLongName || `Route ${rideData.vehicle.routeId}`}
                </div>
                <div className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                  {formatVehicleStatusLine(rideData.vehicle)}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Link
                to={`/?vehicle=${encodeURIComponent(rideData.vehicle.vehicleId)}`}
                className="sh-btn text-xs no-underline"
              >
                Show on map
              </Link>
              <button type="button" className="sh-btn text-xs" onClick={() => setRidingVehicle(null)}>
                Change vehicle
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <h2 className="m-0 text-base font-bold">Upcoming stops</h2>
            <p className="m-0 mb-2 text-sm sh-muted">Pick your stop and we will alert you one stop before it.</p>
            {upcomingStops.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                Upcoming stop list unavailable for this trip right now.
              </p>
            ) : (
              <ol className="m-0 p-0 list-none divide-y" style={{ borderColor: "var(--border)" }}>
                {upcomingStops.slice(0, 20).map((s) => {
                  const isAlert = alertStopId === s.stopId;
                  return (
                    <li key={`${s.stopSequence}-${s.stopId}`} className={`py-2.5 min-h-[44px] flex items-center justify-between gap-3 ${isAlert ? "sh-highlight px-2" : ""}`}>
                      <button
                        type="button"
                        onClick={() => {
                          setAlertStopId(isAlert ? null : s.stopId);
                          setAlertFired(null);
                        }}
                        aria-pressed={isAlert}
                        className="text-left flex items-center gap-3 bg-transparent border-0 p-0 cursor-pointer flex-1 min-w-0 min-h-[44px]"
                        style={{ color: "inherit", font: "inherit" }}
                      >
                        <span
                          className="w-2.5 h-2.5 shrink-0"
                          style={{
                            background: s.status === "current" || s.status === "next" ? "currentColor" : "var(--rule)",
                          }}
                        />
                        <span className="truncate">
                          <strong className={s.status === "current" || s.status === "next" ? "font-bold" : "font-medium"}>
                            {s.name}
                          </strong>
                          {s.status === "current" && <span className="ml-2 text-sm">, here now</span>}
                          {s.status === "next" && <span className="ml-2 text-sm">, next</span>}
                          {isAlert && <span className="ml-2 text-sm font-bold">, alert set</span>}
                        </span>
                      </button>
                      <span className="text-sm font-bold tabular-nums shrink-0">
                        {s.etaMinutes === 0 ? "Now" : s.etaMinutes !== null ? `${s.etaMinutes} min` : ""}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>
      ) : position && (nearby?.nearbyVehicles.length ?? 0) > 0 ? (
        <section className="space-y-3">
          <h2 className="sh-section-title">Vehicles near you. Pick the one you are on.</h2>
          <div className="sh-card divide-y" style={{ borderColor: "var(--border)" }}>
            {nearby!.nearbyVehicles.slice(0, 6).map((v) => (
              <button
                key={`${v.agencyId}-${v.vehicleId}`}
                type="button"
                onClick={() => setRidingVehicle({ agencyId: v.agencyId, vehicleId: v.vehicleId })}
                className="w-full text-left py-3 flex items-center justify-between gap-3 bg-transparent border-0 cursor-pointer"
                style={{ color: "var(--ink)", font: "inherit", borderBottom: "1px solid var(--rule)" }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="sh-badge sh-badge-lg shrink-0" style={{ backgroundColor: routeColor(v.agencyId, v.routeId, v.routeColor) }}>
                    {v.routeShortName ?? v.routeId ?? "—"}
                  </span>
                  <div className="min-w-0">
                    <div className="font-bold text-sm truncate">
                      {v.headsign || v.routeLongName || `Route ${v.routeId ?? "Unassigned"}`}
                    </div>
                    <div className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
                      {v.fleetNumber}. {formatVehicleStatusLine(v)}
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-bold text-sm tabular-nums">{v.distanceMeters} m</div>
                  <div className="text-sm font-bold" style={{ color: "var(--accent)" }}>I am on this</div>
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {/* 3. Nearby Stops */}
      <section className="space-y-3">
        <h2 className="sh-section-title">Stops near you</h2>
        {!position ? (
          <div className="sh-card p-6 text-sm space-y-3">
            <p className="m-0" style={{ color: "var(--text-muted)" }}>
              Turn on location to see the closest stops, vehicles coming your way, and your stops while you ride.
            </p>
            <button type="button" className="sh-btn sh-btn-primary" onClick={startWatching}>
              <Compass size={18} aria-hidden="true" /> Turn on location
            </button>
          </div>
        ) : nearbyLoading ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>Finding stops near you…</p>
        ) : (nearby?.nearbyStops.length ?? 0) === 0 ? (
          <div className="sh-card p-5 text-sm" style={{ color: "var(--text-muted)" }}>
            There are no GO, Guelph, Thunder Bay or TTC stops within 1 km of you. Use Plan a trip to search by name instead.
          </div>
        ) : (
          <div className="sh-card divide-y" style={{ borderColor: "var(--border)" }}>
            {nearby!.nearbyStops.map((s) => (
              <Link
                key={`${s.agencyId}-${s.stopId}`}
                to={`/stops/${s.agencyId}/${encodeURIComponent(s.stopId)}`}
                className="py-3 flex items-center justify-between gap-3 no-underline"
                style={{ color: "var(--ink)", borderBottom: "1px solid var(--rule)" }}
              >
                <div className="min-w-0 space-y-1">
                  <div className="font-bold text-sm flex items-center gap-2">
                    <span className="truncate">{s.name}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {s.routes.slice(0, 8).map((r) => (
                      <span key={r} className="sh-narrow text-base sh-muted">
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-bold text-sm tabular-nums">{s.walkMinutes} min walk</div>
                  <div className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
                    {s.distanceMeters} m, {agencyShortName(s.agencyId)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
