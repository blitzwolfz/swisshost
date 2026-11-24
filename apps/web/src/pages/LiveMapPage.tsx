import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  Crosshair,
  History as HistoryIcon,
  List,
  LocateFixed,
  Navigation,
  SlidersHorizontal,
  Star,
  X,
} from "lucide-react";
import { TransitMap } from "../components/TransitMap";
import { useLiveAgency } from "../hooks/useLiveAgency";
import { useUserLocation } from "../hooks/useUserLocation";
import {
  apiJson,
  formatCompass,
  formatDelay,
  formatRelativeAge,
  formatSpeed,
  formatVehicleStatusLine,
  type AgencySummary,
  type LiveVehicle,
} from "../lib/api";
import { usePreferences } from "../lib/preferences";

interface RideTimeline {
  agencyId: string;
  vehicle: LiveVehicle;
  routeShape: { type: "LineString"; coordinates: Array<[number, number]> } | null;
  stops: Array<{
    stopId: string;
    stopCode: string | null;
    name: string;
    lat: number;
    lon: number;
    stopSequence: number;
    status: "passed" | "current" | "next" | "upcoming";
    distanceMeters: number;
    etaMinutes: number | null;
  }>;
}

export default function LiveMapPage() {
  const { agencyId, units, isFavorite, toggleFavorite } = usePreferences();
  const [searchParams, setSearchParams] = useSearchParams();
  const routeFilter = searchParams.get("route") || "";
  const selectedId = searchParams.get("vehicle") || null;

  const [fleetFilter, setFleetFilter] = useState("");
  const [freshnessFilter, setFreshnessFilter] = useState<"all" | "fresh" | "stale">("all");
  const [assignedFilter, setAssignedFilter] = useState<"all" | "assigned" | "unassigned">("all");
  const [showFilters, setShowFilters] = useState(false);
  const [followSelected, setFollowSelected] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [onBoardMode, setOnBoardMode] = useState(false);
  const [alertStopId, setAlertStopId] = useState<string | null>(null);
  const { position: userPos, watching, error: gpsError, startWatching, stopWatching } = useUserLocation();

  const { data: agenciesData } = useQuery({
    queryKey: ["agencies"],
    queryFn: () => apiJson<{ agencies: AgencySummary[] }>("/api/v1/agencies"),
    staleTime: 60_000,
  });

  const { data: routesData } = useQuery({
    queryKey: ["routes", agencyId],
    queryFn: () =>
      apiJson<{ routes: Array<{ routeId: string; shortName: string; longName: string }> }>(
        `/api/v1/agencies/${agencyId}/routes`
      ),
    enabled: agencyId !== "all",
    staleTime: 60_000,
  });

  const { data: routeDetail } = useQuery({
    queryKey: ["route-shape", agencyId, routeFilter],
    queryFn: () =>
      apiJson<{
        route: { shapeGeoJson: { type: "LineString"; coordinates: Array<[number, number]> } | null };
        stops: Array<{ stop_id: string; name: string; lat: number; lon: number }>;
      }>(`/api/v1/agencies/${agencyId}/routes/${encodeURIComponent(routeFilter)}`),
    enabled: agencyId !== "all" && Boolean(routeFilter),
    staleTime: 120_000,
  });

  const live = useLiveAgency(agencyId, routeFilter || undefined);

  const activeAgency = useMemo(
    () => agenciesData?.agencies.find((a) => a.id === agencyId),
    [agenciesData, agencyId]
  );

  const center: [number, number] = activeAgency?.center ?? [-79.75, 43.6];
  const zoom = activeAgency?.defaultZoom ?? (agencyId === "all" ? 9.5 : 12);

  const filteredVehicles = useMemo(() => {
    return live.vehicles.filter((v) => {
      if (fleetFilter) {
        const q = fleetFilter.toLowerCase();
        if (
          !v.fleetNumber.toLowerCase().includes(q) &&
          !v.vehicleId.toLowerCase().includes(q) &&
          !(v.routeId?.toLowerCase().includes(q) ?? false)
        ) {
          return false;
        }
      }
      if (freshnessFilter === "fresh" && v.freshness === "stale") return false;
      if (freshnessFilter === "stale" && v.freshness !== "stale") return false;
      if (assignedFilter === "assigned" && !v.routeId && !v.tripId) return false;
      if (assignedFilter === "unassigned" && (v.routeId || v.tripId)) return false;
      return true;
    });
  }, [live.vehicles, fleetFilter, freshnessFilter, assignedFilter]);

  const selectedVehicle: LiveVehicle | null = useMemo(() => {
    if (!selectedId) return null;
    return (
      filteredVehicles.find((v) => v.vehicleId === selectedId) ??
      live.vehicles.find((v) => v.vehicleId === selectedId) ??
      null
    );
  }, [selectedId, filteredVehicles, live.vehicles]);

  // Fetch full destination headsign, route shape, and upcoming stops whenever a vehicle is selected
  const { data: rideData } = useQuery({
    queryKey: ["vehicle-ride", selectedVehicle?.agencyId, selectedVehicle?.vehicleId],
    queryFn: () =>
      apiJson<RideTimeline>(
        `/api/v1/agencies/${selectedVehicle!.agencyId}/vehicles/${encodeURIComponent(selectedVehicle!.vehicleId)}/ride`
      ),
    enabled: Boolean(selectedVehicle),
    refetchInterval: 20_000,
    staleTime: 10_000,
  });

  // When On-Board GPS mode is enabled, auto-detect nearest live vehicle within 120m
  const { data: nearbyOnBoard } = useQuery({
    queryKey: ["nearby-onboard", userPos ? Math.round(userPos.lat * 1000) : null, userPos ? Math.round(userPos.lon * 1000) : null],
    queryFn: () =>
      apiJson<{ nearbyVehicles: Array<LiveVehicle & { distanceMeters: number }> }>(
        `/api/v1/nearby?lat=${userPos!.lat}&lon=${userPos!.lon}&radius=800`
      ),
    enabled: onBoardMode && Boolean(userPos),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    if (!onBoardMode || selectedId || !nearbyOnBoard?.nearbyVehicles.length) return;
    const closest = nearbyOnBoard.nearbyVehicles[0]!;
    if (closest.distanceMeters <= 120) {
      const next = new URLSearchParams(searchParams);
      next.set("vehicle", closest.vehicleId);
      setSearchParams(next, { replace: true });
      setFollowSelected(true);
    }
  }, [onBoardMode, selectedId, nearbyOnBoard]);

  const activeVehicle = rideData?.vehicle ?? selectedVehicle;
  const upcomingStops = (rideData?.stops ?? []).filter((s) => s.status !== "passed");
  const effectiveRouteShape = rideData?.routeShape ?? routeDetail?.route.shapeGeoJson ?? null;
  const effectiveStops = rideData?.stops.length
    ? rideData.stops.map((s) => ({ stop_id: s.stopId, name: s.name, lat: s.lat, lon: s.lon }))
    : routeDetail?.stops;

  // Trigger haptic alert when the selected get-off stop is next or current
  useEffect(() => {
    if (!alertStopId || !rideData?.stops.length) return;
    const target = rideData.stops.find((s) => s.stopId === alertStopId);
    if (target && (target.status === "next" || target.status === "current")) {
      if ("vibrate" in navigator) {
        try {
          navigator.vibrate([220, 100, 220]);
        } catch {
          // ignore
        }
      }
    }
  }, [alertStopId, rideData]);

  // Clear stop alert when switching vehicles
  useEffect(() => {
    setAlertStopId(null);
  }, [selectedId]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const isLiveFresh = live.feedStatus === "fresh";
  const delayInfo = activeVehicle ? formatDelay(activeVehicle.scheduleDeviationSec) : null;

  return (
    <div className="sh-map-shell relative w-full flex-1 min-h-[360px] overflow-hidden">
      {/* Full-bleed WebGL MapLibre Canvas */}
      <TransitMap
        center={userPos && onBoardMode && !activeVehicle ? [userPos.lon, userPos.lat] : center}
        zoom={userPos && onBoardMode && !activeVehicle ? 14 : zoom}
        vehicles={filteredVehicles}
        selectedVehicleId={selectedId}
        onSelectVehicle={(v) => setParam("vehicle", v.vehicleId)}
        routeShape={effectiveRouteShape}
        stops={effectiveStops}
        userLocation={userPos ? { lat: userPos.lat, lon: userPos.lon } : null}
        followSelected={followSelected}
        heightClass="h-full w-full"
        rounded={false}
      />

      {/* Floating Top-Left HUD Bar */}
      <div className="absolute top-3 left-3 right-3 sm:right-auto z-20 flex flex-col gap-2 sm:max-w-2xl pointer-events-none">
        <div className="sh-panel p-2 pl-3 flex flex-wrap items-center gap-2 pointer-events-auto">
          <div className="flex items-center gap-2 pr-1 mr-auto">
            <span
              className="sh-pulse-dot"
              style={{
                color: isLiveFresh
                  ? "var(--status-ok)"
                  : live.feedStatus === "missing_key"
                    ? "var(--status-warn)"
                    : "var(--status-err)",
                background: "currentColor",
              }}
            />
            <span className="text-xl font-bold tabular-nums leading-none tracking-tight">
              {filteredVehicles.length}
            </span>
            <span className="text-xs leading-tight" style={{ color: "var(--text-muted)" }}>
              {filteredVehicles.length === 1 ? "vehicle" : "vehicles"}
              <br className="sm:hidden" />
              <span className="hidden sm:inline">, </span>
              {live.feedStatus === "missing_key"
                ? "awaiting API key"
                : live.connection === "live_ws"
                  ? "live"
                  : live.feedStatus}
              {live.lastSuccessAt ? `, updated ${formatRelativeAge(live.lastSuccessAt)}` : ""}
            </span>
          </div>

          {agencyId !== "all" && (
            <select
              aria-label="Filter by route"
              value={routeFilter}
              onChange={(e) => setParam("route", e.target.value || null)}
              className="sh-input order-last basis-full sm:order-none sm:basis-auto sm:max-w-[190px]"
            >
              <option value="">All routes</option>
              {(routesData?.routes ?? []).map((r) => (
                <option key={r.routeId} value={r.routeId}>
                  {r.shortName} — {r.longName}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            className={`sh-btn px-3 ${onBoardMode ? "sh-highlight" : ""}`}
            onClick={() => {
              if (onBoardMode) {
                setOnBoardMode(false);
                stopWatching();
              } else {
                setOnBoardMode(true);
                startWatching();
              }
            }}
            title="Track my live location and detect which vehicle I'm on"
          >
            <LocateFixed size={13} /> {onBoardMode ? "Tracking me" : "On board"}
          </button>

          <Link to="/plan" className="sh-btn px-3 no-underline" title="Find which route to take">
            <Navigation size={13} /> Plan
          </Link>

          <button
            type="button"
            className={`sh-btn px-3 ${showFilters ? "sh-highlight" : ""}`}
            onClick={() => setShowFilters((s) => !s)}
            aria-expanded={showFilters}
          >
            <SlidersHorizontal size={13} /> Filters
          </button>

          <button
            type="button"
            className={`sh-btn px-3 ${drawerOpen ? "sh-highlight" : ""}`}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((d) => !d)}
          >
            <List size={13} /> List
          </button>
        </div>

        {gpsError && (
          <div className="sh-panel p-2.5 text-xs pointer-events-auto" style={{ color: "var(--status-err)" }}>
            {gpsError}
          </div>
        )}

        {onBoardMode && watching && !activeVehicle && (
          <div className="sh-panel sh-highlight px-3 py-2 text-xs pointer-events-auto flex items-center justify-between gap-2">
            <span>
              {nearbyOnBoard?.nearbyVehicles.length
                ? `Nearest vehicle: Route ${nearbyOnBoard.nearbyVehicles[0]!.routeShortName ?? nearbyOnBoard.nearbyVehicles[0]!.routeId} (#${nearbyOnBoard.nearbyVehicles[0]!.fleetNumber}, ${nearbyOnBoard.nearbyVehicles[0]!.distanceMeters} m away)`
                : "Tracking your GPS — scanning for the bus or train you're on…"}
            </span>
            {nearbyOnBoard?.nearbyVehicles[0] && (
              <button
                type="button"
                className="sh-btn py-1 px-2 text-xs"
                onClick={() => {
                  setParam("vehicle", nearbyOnBoard.nearbyVehicles[0]!.vehicleId);
                  setFollowSelected(true);
                }}
              >
                Select
              </button>
            )}
          </div>
        )}

        {/* Missing Key Notice (GO Transit) */}
        {activeAgency?.liveStatus === "missing_key" && (
          <div
            className="sh-panel sh-highlight px-3 py-2.5 text-sm pointer-events-auto flex items-center justify-between gap-3"
          >
            <span>
              <strong>{activeAgency.name}</strong> needs <code>GO_TRANSIT_API_KEY</code> before live positions appear.
            </span>
            <Link to="/status" className="font-semibold shrink-0" style={{ color: "#000" }}>
              Feed status
            </Link>
          </div>
        )}

        {/* Expandable Advanced Filter Popover */}
        {showFilters && (
          <div className="sh-panel p-3 flex flex-wrap items-end gap-3 text-xs pointer-events-auto">
            <div>
              <label className="block font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                Fleet or route number
              </label>
              <input
                type="text"
                value={fleetFilter}
                onChange={(e) => setFleetFilter(e.target.value)}
                placeholder="e.g. 4401, 504"
                className="sh-input w-40"
              />
            </div>
            <div>
              <label className="block font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                Freshness
              </label>
              <select
                value={freshnessFilter}
                onChange={(e) => setFreshnessFilter(e.target.value as "all" | "fresh" | "stale")}
                className="sh-input"
              >
                <option value="all">All</option>
                <option value="fresh">Fresh only</option>
                <option value="stale">Stale only</option>
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                Assignment
              </label>
              <select
                value={assignedFilter}
                onChange={(e) => setAssignedFilter(e.target.value as "all" | "assigned" | "unassigned")}
                className="sh-input"
              >
                <option value="all">All</option>
                <option value="assigned">Assigned</option>
                <option value="unassigned">Unassigned</option>
              </select>
            </div>
            <button
              type="button"
              className="sh-btn"
              onClick={() => {
                setFleetFilter("");
                setFreshnessFilter("all");
                setAssignedFilter("all");
                setParam("route", null);
              }}
            >
              Reset
            </button>
          </div>
        )}
      </div>

      {/* Floating Selected Vehicle Card (Desktop bottom-left / Mobile bottom sheet) */}
      {activeVehicle && (
        <aside
          aria-label="Selected vehicle details"
          className="sh-panel absolute bottom-0 left-0 right-0 sm:bottom-3 sm:left-3 sm:right-auto sm:w-[430px] max-h-[75vh] overflow-y-auto z-20 p-4 space-y-3 border-x-0 border-b-0 border-t-2 sm:border sm:border-t-2"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2.5 min-w-0">
              <span
                className="sh-route-shield text-white shrink-0 mt-0.5"
                style={{ backgroundColor: activeVehicle.routeColor || "#E2001A" }}
              >
                {activeVehicle.routeShortName ?? activeVehicle.routeId ?? "—"}
              </span>
              <div className="min-w-0">
                <div className="font-bold text-lg leading-tight tracking-tight truncate">
                  {activeVehicle.headsign
                    ? `To ${activeVehicle.headsign}`
                    : activeVehicle.routeLongName || `Vehicle #${activeVehicle.fleetNumber}`}
                </div>
                <div className="text-xs mt-0.5 flex flex-wrap items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                  <span className="font-semibold tabular-nums" style={{ color: "var(--text)" }}>
                    #{activeVehicle.fleetNumber}
                  </span>
                  <span className="sh-pill sh-pill-muted uppercase">{activeVehicle.agencyId}</span>
                  <span
                    className={
                      delayInfo?.tone === "ok"
                        ? "sh-pill sh-pill-ok"
                        : delayInfo?.tone === "err"
                          ? "sh-pill sh-pill-err"
                          : delayInfo?.tone === "warn"
                            ? "sh-pill sh-pill-warn"
                            : "sh-pill sh-pill-muted"
                    }
                  >
                    {delayInfo?.text}
                  </span>
                  <span className="tabular-nums">
                    {activeVehicle.ageSeconds}s ago
                  </span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setParam("vehicle", null)}
              aria-label="Close vehicle panel"
              className="sh-btn sh-btn-icon shrink-0"
            >
              <X size={16} />
            </button>
          </div>

          <div
            className="px-2.5 py-2 border-y text-xs flex items-center justify-between gap-2"
            style={{ borderColor: "var(--ink)", background: "var(--surface)" }}
          >
            <div className="min-w-0">
              <div className="uppercase tracking-wider text-[10px] font-bold" style={{ color: "var(--text-muted)" }}>
                Current position
              </div>
              <div className="font-bold text-sm truncate">
                {formatVehicleStatusLine(activeVehicle)}
              </div>
            </div>
            {upcomingStops[0]?.etaMinutes !== null && upcomingStops[0]?.etaMinutes !== undefined && (
              <span className="sh-pill sh-pill-ok shrink-0 tabular-nums">
                {upcomingStops[0].etaMinutes === 0 ? "Now" : `${upcomingStops[0].etaMinutes} min`}
              </span>
            )}
          </div>

          <div className="grid grid-cols-3 text-xs border-b" style={{ borderColor: "var(--border)" }}>
            <div className="pb-2 pr-2">
              <div className="mb-0.5" style={{ color: "var(--text-muted)" }}>
                Speed
              </div>
              <div className="font-bold text-sm tabular-nums">{formatSpeed(activeVehicle.speedMps, units)}</div>
            </div>
            <div className="pb-2 px-2 border-l" style={{ borderColor: "var(--border)" }}>
              <div className="mb-0.5" style={{ color: "var(--text-muted)" }}>
                Heading
              </div>
              <div className="font-bold text-sm tabular-nums">
                {activeVehicle.bearingDeg !== null
                  ? `${Math.round(activeVehicle.bearingDeg)}° ${formatCompass(activeVehicle.bearingDeg)}`
                  : "Unknown"}
              </div>
            </div>
            <div className="pb-2 pl-2 border-l" style={{ borderColor: "var(--border)" }}>
              <div className="mb-0.5" style={{ color: "var(--text-muted)" }}>Stops left</div>
              <div className="font-bold text-sm tabular-nums">
                {rideData?.stops.length ? upcomingStops.length : "—"}
              </div>
            </div>
          </div>

          {upcomingStops.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                <span>Upcoming stops</span>
                <span>Tap bell for stop alert</span>
              </div>
              <div className="max-h-40 overflow-y-auto border divide-y" style={{ borderColor: "var(--border)" }}>
                {upcomingStops.slice(0, 12).map((s) => {
                  const isAlert = alertStopId === s.stopId;
                  const isCurrentOrNext = s.status === "current" || s.status === "next";
                  return (
                    <div
                      key={`${s.stopId}-${s.stopSequence}`}
                      className={`px-2.5 py-1.5 text-xs flex items-center justify-between gap-2 ${
                        isAlert ? "sh-highlight" : ""
                      }`}
                    >
                      <div className="min-w-0 flex items-center gap-2">
                        <span
                          className="w-2 h-2 shrink-0"
                          style={{
                            background: isCurrentOrNext ? "var(--primary)" : "var(--text-muted)",
                          }}
                        />
                        <Link
                          to={`/stops/${activeVehicle.agencyId}/${encodeURIComponent(s.stopId)}`}
                          className={`truncate ${isCurrentOrNext ? "font-bold" : ""}`}
                          style={{ color: isAlert ? "#000" : "var(--text)" }}
                        >
                          {s.name}
                        </Link>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="tabular-nums text-[11px]" style={{ color: isAlert ? "#000" : "var(--text-muted)" }}>
                          {s.status === "current"
                            ? "Here"
                            : s.etaMinutes !== null
                              ? `${s.etaMinutes}m`
                              : `${Math.round(s.distanceMeters)}m`}
                        </span>
                        <button
                          type="button"
                          onClick={() => setAlertStopId(isAlert ? null : s.stopId)}
                          aria-label={isAlert ? `Cancel alert for ${s.name}` : `Alert before ${s.name}`}
                          title={isAlert ? "Cancel stop alert" : "Vibrate before this stop"}
                          className="p-1 bg-transparent border-0 cursor-pointer"
                          style={{ color: isAlert ? "#000" : "var(--text-muted)" }}
                        >
                          <Bell size={12} fill={isAlert ? "currentColor" : "none"} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Link
              to={`/vehicles/${activeVehicle.agencyId}/${encodeURIComponent(activeVehicle.vehicleId)}`}
              className="sh-btn sh-btn-primary flex-1"
            >
              Open vehicle
            </Link>
            <Link
              to={`/history?agency=${activeVehicle.agencyId}&vehicle=${encodeURIComponent(activeVehicle.vehicleId)}`}
              className="sh-btn"
            >
              <HistoryIcon size={13} /> Replay
            </Link>
            <button
              type="button"
              className={`sh-btn sh-btn-icon ${followSelected ? "sh-highlight" : ""}`}
              aria-pressed={followSelected}
              aria-label="Follow vehicle"
              onClick={() => setFollowSelected((f) => !f)}
              title="Follow vehicle"
            >
              <Crosshair size={13} />
            </button>
            <button
              type="button"
              className="sh-btn sh-btn-icon"
              title="Favourite"
              aria-label="Favourite"
              onClick={() =>
                toggleFavorite({
                  agencyId: activeVehicle.agencyId,
                  entityType: "vehicle",
                  entityId: activeVehicle.vehicleId,
                  label: `${activeVehicle.agencyId.toUpperCase()} #${activeVehicle.fleetNumber}`,
                })
              }
            >
              <Star
                size={13}
                fill={isFavorite(activeVehicle.agencyId, "vehicle", activeVehicle.vehicleId) ? "currentColor" : "none"}
              />
            </button>
          </div>

          {activeVehicle.tripId && (
            <div className="text-xs pt-1 border-t flex justify-between" style={{ borderColor: "var(--border)" }}>
              <span style={{ color: "var(--text-muted)" }}>Trip</span>
              <Link
                to={`/trips/${activeVehicle.agencyId}/${encodeURIComponent(activeVehicle.tripId)}`}
                className="font-mono font-semibold"
              >
                {activeVehicle.tripId}
              </Link>
            </div>
          )}
        </aside>
      )}

      {/* Slide-over Accessible Vehicle List Drawer */}
      {drawerOpen && (
        <aside
          aria-label="Live vehicles list"
          className="sh-panel absolute inset-0 sm:inset-auto sm:top-3 sm:bottom-3 sm:right-3 sm:w-[380px] z-30 flex flex-col overflow-hidden border-0 sm:border"
        >
          <div className="pl-4 pr-2 py-2 border-b-2 flex items-center justify-between" style={{ borderColor: "var(--ink)" }}>
            <div className="font-bold text-lg tracking-tight tabular-nums">
              {filteredVehicles.length} vehicles
            </div>
            <button type="button" className="sh-btn sh-btn-icon" onClick={() => setDrawerOpen(false)} aria-label="Close list">
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain">
            {filteredVehicles.length === 0 ? (
              <div className="p-4 text-sm" style={{ color: "var(--text-muted)" }}>
                No vehicles match these filters. Reset filters to see the whole fleet.
              </div>
            ) : (
              filteredVehicles.slice(0, 200).map((v) => {
                const d = formatDelay(v.scheduleDeviationSec);
                const isSel = v.vehicleId === selectedId;
                return (
                  <button
                    key={`${v.agencyId}-${v.sourceVehicleId}`}
                    type="button"
                    onClick={() => {
                      setParam("vehicle", v.vehicleId);
                      setFollowSelected(true);
                    }}
                    className={`w-full text-left px-4 py-3 flex items-center justify-between gap-3 cursor-pointer border-0 border-b ${
                      isSel ? "sh-highlight" : "bg-transparent hover:bg-[var(--surface)]"
                    }`}
                    style={{ borderColor: "var(--border)", color: isSel ? "#000" : "var(--text)" }}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="sh-route-shield text-white shrink-0"
                        style={{ backgroundColor: v.routeColor || "#E2001A" }}
                      >
                        {v.routeShortName ?? v.routeId ?? "—"}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-bold tabular-nums truncate">
                          {v.headsign ? `To ${v.headsign}` : `#${v.fleetNumber}`}{" "}
                          <span className="font-normal uppercase" style={{ color: "var(--text-muted)" }}>
                            {v.headsign ? `#${v.fleetNumber}` : v.agencyId}
                          </span>
                        </div>
                        <div className="text-[11px] tabular-nums truncate" style={{ color: "var(--text-muted)" }}>
                          {v.stopName
                            ? formatVehicleStatusLine(v)
                            : `${formatSpeed(v.speedMps, units)}, ${v.ageSeconds}s ago`}
                        </div>
                      </div>
                    </div>
                    <span className={`sh-pill sh-pill-${d.tone} shrink-0`}>{d.text}</span>
                  </button>
                );
              })
            )}
          </div>
        </aside>
      )}

      {/* Subtle Bottom-Left Utility Strip when no vehicle selected */}
      {!selectedVehicle && (
        <div
          className="sh-panel hidden sm:flex items-center gap-4 absolute bottom-3 left-3 z-10 px-3 py-1.5 text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          <Link to="/status" className="font-medium">Status</Link>
          <Link to="/alerts" className="font-medium">Alerts</Link>
          <a href="/openapi.json" target="_blank" rel="noreferrer" className="font-medium">API</a>
          <Link to="/admin" className="font-medium">Admin</Link>
        </div>
      )}
    </div>
  );
}
