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
} from "lucide-react";
import { TransitMap, type MapLabelMode } from "../components/TransitMap";
import { BottomSheet } from "../components/BottomSheet";
import { DepartureRow, EmptyState, LiveLegend, RouteBadge, vehicleNounFor } from "../components/Transit";
import { useLiveAgency } from "../hooks/useLiveAgency";
import { useUserLocation } from "../hooks/useUserLocation";
import {
  apiJson,
  formatClock,
  formatCompass,
  formatDelay,
  formatRelativeAge,
  formatSpeed,
  formatVehicleStatusLine,
  type AgencySummary,
  type LiveVehicle,
  type StopArrivals,
} from "../lib/api";
import { agencyName, agencyShortName } from "../lib/agencies";
import { usePreferences } from "../lib/preferences";
import { routeColor, useRouteLookup } from "../lib/routeColors";

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

function useIsDesktop() {
  const query = "(min-width: 1024px)";
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatch(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return match;
}

export default function LiveMapPage() {
  const { agencyId, setAgencyId, units, isFavorite, toggleFavorite } = usePreferences();
  const isDesktop = useIsDesktop();
  const [searchParams, setSearchParams] = useSearchParams();
  const routeFilter = searchParams.get("route") || "";
  const selectedId = searchParams.get("vehicle") || null;
  const selectedStopId = searchParams.get("stop") || null;
  const stopAgency = searchParams.get("stopAgency") || agencyId;

  const [fleetFilter, setFleetFilter] = useState("");
  const [freshnessFilter, setFreshnessFilter] = useState<"all" | "fresh" | "stale">("all");
  const [assignedFilter, setAssignedFilter] = useState<"all" | "assigned" | "unassigned">("all");
  const [labelMode, setLabelMode] = useState<MapLabelMode>("line");
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

  const routes = useRouteLookup(agencyId);

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

  const { data: stopData, isLoading: stopLoading } = useQuery({
    queryKey: ["stop-arrivals", stopAgency, selectedStopId],
    queryFn: () =>
      apiJson<StopArrivals>(
        `/api/v1/agencies/${stopAgency}/stops/${encodeURIComponent(selectedStopId!)}/arrivals`
      ),
    enabled: Boolean(selectedStopId) && stopAgency !== "all",
    refetchInterval: 20_000,
  });
  const stopRoutes = useRouteLookup(stopAgency);

  const live = useLiveAgency(agencyId, routeFilter || undefined);

  // The live hook can stay "connecting" while it polls; after a short wait treat an empty result as real
  const [settledAgency, setSettledAgency] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setSettledAgency(agencyId), 5000);
    return () => clearTimeout(t);
  }, [agencyId]);

  const activeAgency = useMemo(
    () => agenciesData?.agencies.find((a) => a.id === agencyId),
    [agenciesData, agencyId]
  );

  const center: [number, number] = activeAgency?.center ?? [-79.75, 43.6];
  const zoom = activeAgency?.defaultZoom ?? (agencyId === "all" ? 9.5 : 12);

  const filteredVehicles = useMemo(() => {
    const resolved = live.vehicles.map((v) => {
      if (!v.routeId || v.routeShortName) return v;
      const sn = routes.shortName(v.routeId);
      const ln = routes.longName(v.routeId);
      return sn ? { ...v, routeShortName: sn, routeLongName: v.routeLongName ?? (ln || null) } : v;
    });
    const list = resolved.filter((v) => {
      if (fleetFilter) {
        const q = fleetFilter.toLowerCase();
        if (
          !v.fleetNumber.toLowerCase().includes(q) &&
          !v.vehicleId.toLowerCase().includes(q) &&
          !(v.routeId?.toLowerCase().includes(q) ?? false) &&
          !(v.routeShortName?.toLowerCase().includes(q) ?? false)
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
    // Put live in-service buses first, then unassigned live buses, then stale vehicles
    return [...list].sort((a, b) => {
      const rank = (v: LiveVehicle) =>
        (v.freshness === "stale" ? 2 : 0) + (v.routeId || v.tripId ? 0 : 1);
      const rDiff = rank(a) - rank(b);
      if (rDiff !== 0) return rDiff;
      const routeCmp = (a.routeShortName ?? a.routeId ?? "zzz").localeCompare(
        b.routeShortName ?? b.routeId ?? "zzz",
        undefined,
        { numeric: true }
      );
      if (routeCmp !== 0) return routeCmp;
      return a.fleetNumber.localeCompare(b.fleetNumber, undefined, { numeric: true });
    });
  }, [live.vehicles, routes, fleetFilter, freshnessFilter, assignedFilter]);

  const activeFilterCount =
    (fleetFilter ? 1 : 0) + (freshnessFilter !== "all" ? 1 : 0) + (assignedFilter !== "all" ? 1 : 0);

  const liveCount = filteredVehicles.filter((v) => v.freshness !== "stale").length;

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
  const shapeRouteId = activeVehicle?.routeId ?? routeFilter;
  const shapeColor = effectiveRouteShape
    ? activeVehicle
      ? routeColor(activeVehicle.agencyId, activeVehicle.routeId, activeVehicle.routeColor)
      : routes.color(shapeRouteId)
    : null;

  const effectiveStops = useMemo(() => {
    const base = rideData?.stops.length
      ? rideData.stops.map((s) => ({ stop_id: s.stopId, name: s.name, lat: s.lat, lon: s.lon }))
      : (routeDetail?.stops ?? []);
    // Keep the selected stop on the map even after the route or vehicle that showed it is cleared
    const s = stopData?.stop;
    if (s && s.lat !== undefined && s.lon !== undefined && !base.some((b) => b.stop_id === s.stop_id)) {
      return [...base, { stop_id: s.stop_id, name: s.name, lat: s.lat, lon: s.lon }];
    }
    return base;
  }, [rideData, routeDetail, stopData]);

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

  const setParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next, { replace: true });
  };
  const setParam = (key: string, value: string | null) => setParams({ [key]: value });

  const selectVehicle = (id: string | null) => setParams({ vehicle: id, ...(id ? { stop: null, stopAgency: null } : {}) });
  const selectStop = (stop: { stop_id: string } | null) =>
    setParams({
      stop: stop?.stop_id ?? null,
      stopAgency: stop ? (activeVehicle?.agencyId ?? (agencyId !== "all" ? agencyId : null)) : null,
      vehicle: null,
    });

  const toggleOnBoard = () => {
    if (onBoardMode) {
      setOnBoardMode(false);
      stopWatching();
    } else {
      setOnBoardMode(true);
      startWatching();
    }
  };

  const delayInfo = activeVehicle ? formatDelay(activeVehicle.scheduleDeviationSec) : null;
  const noun = vehicleNounFor(activeAgency?.modes);
  const agencyLabel = agencyId === "all" ? "all agencies" : agencyName(agencyId);

  const feedNote =
    live.feedStatus === "missing_key"
      ? "waiting for an API key"
      : live.lastSuccessAt
        ? `updated ${formatRelativeAge(live.lastSuccessAt)}`
        : live.connection === "connecting" && settledAgency !== agencyId
          ? "connecting"
          : live.feedStatus === "fresh"
            ? "live feed"
            : "no recent update";

  // Busiest other agency, offered when the current one has nothing on the road
  const busiestOther = useMemo(
    () =>
      [...(agenciesData?.agencies ?? [])]
        .filter((a) => a.id !== agencyId && a.activeVehicleCount > 0)
        .sort((a, b) => b.activeVehicleCount - a.activeVehicleCount)[0],
    [agenciesData, agencyId]
  );

  const nothingReporting =
    (live.connection !== "connecting" || settledAgency === agencyId) &&
    !live.vehicles.some((v) => v.freshness !== "stale") &&
    live.feedStatus !== "missing_key";

  // Most recent vehicle we still know about, for "Last seen 11:42 pm on route 99"
  const lastSeenVehicle = useMemo(
    () =>
      [...live.vehicles].sort(
        (a, b) => Date.parse(b.observedAt ?? b.receivedAt) - Date.parse(a.observedAt ?? a.receivedAt)
      )[0],
    [live.vehicles]
  );

  /* ---------- Panel pieces (shared by the desktop side panel and the phone sheet) ---------- */

  const routeSelect =
    agencyId !== "all" ? (
      <select
        aria-label="Filter by route"
        value={routeFilter}
        onChange={(e) => setParam("route", e.target.value || null)}
        className="sh-input w-full min-w-0"
      >
        <option value="">All routes</option>
        {routes.routes.map((r) => (
          <option key={r.routeId} value={r.routeId}>
            {r.shortName}
            {r.longName ? `, ${r.longName}` : ""}
          </option>
        ))}
      </select>
    ) : null;

  const emptyNotice = nothingReporting ? (
    <EmptyState
      actions={
        <>
          {busiestOther && (
            <button type="button" className="sh-btn" onClick={() => setAgencyId(busiestOther.id)}>
              Show {agencyShortName(busiestOther.id)}
            </button>
          )}
          {agencyId !== "all" && (
            <button type="button" className="sh-btn" onClick={() => setAgencyId("all")}>
              Show all
            </button>
          )}
        </>
      }
    >
      No {agencyId === "all" ? "" : `${agencyName(agencyId)} `}vehicles are reporting right now.
      {routeFilter ? ` Route ${routes.shortName(routeFilter)} may not be running at this hour.` : ""}
      {lastSeenVehicle
        ? ` Last seen ${formatClock(lastSeenVehicle.observedAt ?? lastSeenVehicle.receivedAt)}${
            lastSeenVehicle.routeId ? ` on route ${lastSeenVehicle.routeShortName ?? routes.shortName(lastSeenVehicle.routeId)}` : ""
          }.`
        : live.lastSuccessAt
          ? ` Last feed update ${formatClock(live.lastSuccessAt)}.`
          : ""}
    </EmptyState>
  ) : null;

  const notices = (
    <>
      {gpsError && (
        <p className="m-0 text-sm font-bold" style={{ color: "var(--danger)" }} role="alert">
          {gpsError}
        </p>
      )}

      {onBoardMode && watching && !activeVehicle && (
        <div className="text-sm flex items-center justify-between gap-2" role="status">
          <span>
            {nearbyOnBoard?.nearbyVehicles.length
              ? `Nearest: route ${nearbyOnBoard.nearbyVehicles[0]!.routeShortName ?? nearbyOnBoard.nearbyVehicles[0]!.routeId ?? "none"}, ${noun.toLowerCase()} ${nearbyOnBoard.nearbyVehicles[0]!.fleetNumber}, ${nearbyOnBoard.nearbyVehicles[0]!.distanceMeters} m away.`
              : "Tracking your location to find the vehicle you are on."}
          </span>
          {nearbyOnBoard?.nearbyVehicles[0] && (
            <button
              type="button"
              className="sh-btn"
              onClick={() => {
                selectVehicle(nearbyOnBoard.nearbyVehicles[0]!.vehicleId);
                setFollowSelected(true);
              }}
            >
              Select
            </button>
          )}
        </div>
      )}

      {activeAgency?.liveStatus === "missing_key" && (
        <p className="m-0 text-sm">
          <strong>{activeAgency.name}</strong> needs <code>GO_TRANSIT_API_KEY</code> before live positions appear.{" "}
          <Link to="/status">Feed status</Link>
        </p>
      )}
    </>
  );

  const filtersForm = (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="map-fleet-filter" className="sh-label">
          Fleet or route number
        </label>
        <input
          id="map-fleet-filter"
          type="text"
          inputMode="numeric"
          value={fleetFilter}
          onChange={(e) => setFleetFilter(e.target.value)}
          placeholder="For example, 4401"
          className="sh-input w-40"
        />
      </div>
      <div>
        <label htmlFor="map-fresh-filter" className="sh-label">
          Reporting
        </label>
        <select
          id="map-fresh-filter"
          value={freshnessFilter}
          onChange={(e) => setFreshnessFilter(e.target.value as "all" | "fresh" | "stale")}
          className="sh-input"
        >
          <option value="all">All</option>
          <option value="fresh">Live now</option>
          <option value="stale">Not reporting</option>
        </select>
      </div>
      <div>
        <label htmlFor="map-assign-filter" className="sh-label">
          Assignment
        </label>
        <select
          id="map-assign-filter"
          value={assignedFilter}
          onChange={(e) => setAssignedFilter(e.target.value as "all" | "assigned" | "unassigned")}
          className="sh-input"
        >
          <option value="all">All</option>
          <option value="assigned">On a route</option>
          <option value="unassigned">Not on a route</option>
        </select>
      </div>
      <div>
        <label htmlFor="map-label-mode" className="sh-label">
          Map labels
        </label>
        <select
          id="map-label-mode"
          value={labelMode}
          onChange={(e) => setLabelMode(e.target.value as MapLabelMode)}
          className="sh-input"
        >
          <option value="line">Line number</option>
          <option value="line+fleet">Line + bus #</option>
          <option value="icons">Bus icons only</option>
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
  );

  const vehicleList =
    filteredVehicles.length === 0 ? (
      nothingReporting ? (
        emptyNotice
      ) : (
        <EmptyState
          actions={
            <button
              type="button"
              className="sh-btn"
              onClick={() => {
                setFleetFilter("");
                setFreshnessFilter("all");
                setAssignedFilter("all");
              }}
            >
              Reset filters
            </button>
          }
        >
          No vehicles match these filters.
        </EmptyState>
      )
    ) : (
      <ul className="sh-deps" style={{ borderTop: "var(--border-w) solid var(--line)" }}>
        {filteredVehicles.slice(0, 200).map((v) => {
          const stale = v.freshness === "stale";
          const d = formatDelay(v.scheduleDeviationSec);
          const rightText = stale
            ? `Last seen ${formatClock(v.observedAt ?? v.receivedAt)}`
            : d.tone !== "muted"
              ? d.text
              : v.speedMps !== null
                ? v.speedMps < 0.5
                  ? "Stopped"
                  : formatSpeed(v.speedMps, units)
                : `${v.ageSeconds}s ago`;
          const rightClass = stale
            ? "sh-sched"
            : d.tone === "err"
              ? "font-bold"
              : d.tone !== "muted"
                ? "font-bold"
                : "sh-muted";
          return (
            <li key={`${v.agencyId}-${v.sourceVehicleId}`}>
              <button
                type="button"
                onClick={() => {
                  selectVehicle(v.vehicleId);
                  setFollowSelected(true);
                }}
                className={`sh-dep w-full text-left bg-transparent border-x-0 border-t-0 cursor-pointer ${stale ? "sh-dep-sched" : ""}`}
                style={{ font: "inherit" }}
                aria-current={v.vehicleId === selectedId ? "true" : undefined}
              >
                <RouteBadge
                  size="lg"
                  label={v.routeShortName ?? v.routeId ?? ""}
                  color={routeColor(v.agencyId, v.routeId, v.routeColor)}
                />
                <span className="sh-dep-main">
                  <span className="sh-dep-dest">
                    {v.headsign ? v.headsign : v.routeId ? `Route ${v.routeShortName ?? v.routeId}` : "Not on a route"}
                  </span>
                  <span className="sh-dep-sub">
                    {noun} #{v.fleetNumber}
                    {agencyId === "all" ? `, ${agencyShortName(v.agencyId)}` : ""}
                    {v.stopName ? ` · ${formatVehicleStatusLine(v)}` : ""}
                  </span>
                </span>
                <span className="sh-dep-leader" aria-hidden="true" />
                <span
                  className={`text-sm text-right shrink-0 tabular-nums ${rightClass}`}
                  style={!stale && d.tone === "err" ? { color: "var(--danger)" } : undefined}
                >
                  {rightText}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );

  const stopPanel = selectedStopId ? (
    <section aria-labelledby="stop-title" className="space-y-2">
      <div className="flex items-start justify-between gap-2 pr-10 lg:pr-0">
        <div className="min-w-0">
          <h2 id="stop-title" className="m-0 text-2xl font-extrabold leading-tight">
            {stopData?.stop.name ?? (stopLoading ? "Loading stop…" : "Stop")}
          </h2>
          {stopData && (
            <p className="m-0 text-sm sh-muted">
              Next departures, updated {formatClock(stopData.serverTime)}
            </p>
          )}
        </div>
        {stopData && (
          <button
            type="button"
            className="sh-btn sh-btn-icon sh-btn-quiet shrink-0"
            aria-pressed={isFavorite(stopAgency, "stop", selectedStopId)}
            aria-label={isFavorite(stopAgency, "stop", selectedStopId) ? "Remove saved stop" : "Save this stop"}
            onClick={() =>
              toggleFavorite({
                agencyId: stopAgency,
                entityType: "stop",
                entityId: selectedStopId,
                label: `${agencyShortName(stopAgency)} ${stopData.stop.name}`,
              })
            }
          >
            <Star
              size={22}
              aria-hidden="true"
              fill={isFavorite(stopAgency, "stop", selectedStopId) ? "currentColor" : "none"}
            />
          </button>
        )}
      </div>
      {isDesktop && routeSelect}
      <LiveLegend className="pt-2" />
      {stopData && stopData.departures.length === 0 ? (
        <EmptyState>Nothing leaves this stop in the next 2 hours.</EmptyState>
      ) : (
        <ul className="sh-deps" style={{ borderTop: "var(--border-w) solid var(--line)" }}>
          {(stopData?.departures ?? []).slice(0, 12).map((d, i) => (
            <DepartureRow
              key={`${d.tripId}-${i}`}
              agencyId={stopAgency}
              departure={d}
              routeLabel={stopRoutes.shortName(d.routeId)}
              routeColor={stopRoutes.color(d.routeId)}
              vehicleNoun={vehicleNounFor(agenciesData?.agencies.find((a) => a.id === stopAgency)?.modes)}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1 text-sm">
        <Link to={`/stops/${stopAgency}/${encodeURIComponent(selectedStopId)}`}>Full stop page</Link>
        <button
          type="button"
          className="bg-transparent border-0 p-0 underline cursor-pointer"
          style={{ color: "var(--accent)", font: "inherit" }}
          onClick={() => selectStop(null)}
        >
          Close stop
        </button>
      </div>
    </section>
  ) : null;

  const vehiclePanel = activeVehicle ? (
    <section aria-label="Selected vehicle" className="space-y-3">
      <div className="flex items-start gap-3 pr-10 lg:pr-0">
        <RouteBadge
          size="lg"
          label={activeVehicle.routeShortName ?? activeVehicle.routeId ?? ""}
          color={routeColor(activeVehicle.agencyId, activeVehicle.routeId, activeVehicle.routeColor)}
        />
        <div className="min-w-0">
          <h2 className="m-0 text-xl font-extrabold leading-tight">
            {activeVehicle.headsign
              ? activeVehicle.headsign
              : activeVehicle.routeLongName || `${noun} ${activeVehicle.fleetNumber}`}
          </h2>
          <p className="m-0 text-sm sh-muted">
            <span className="sh-fleet" style={{ fontSize: "1rem" }}>
              {noun} {activeVehicle.fleetNumber}
            </span>
            , {agencyShortName(activeVehicle.agencyId)}.{" "}
            {activeVehicle.freshness === "stale" ? (
              <i>Last seen {formatClock(activeVehicle.observedAt ?? activeVehicle.receivedAt)}</i>
            ) : (
              <>
                <b style={{ color: delayInfo?.tone === "err" ? "var(--danger)" : "var(--ink)" }}>{delayInfo?.text}</b>,
                reported {activeVehicle.ageSeconds}s ago
              </>
            )}
          </p>
        </div>
      </div>

      <div
        className="py-2 flex items-center justify-between gap-2"
        style={{ borderTop: "var(--border-w) solid var(--line)", borderBottom: "1px solid var(--rule)" }}
      >
        <div className="min-w-0 font-bold truncate">{formatVehicleStatusLine(activeVehicle)}</div>
        {upcomingStops[0]?.etaMinutes !== null && upcomingStops[0]?.etaMinutes !== undefined && (
          <span className="shrink-0 text-xl font-extrabold tabular-nums">
            {upcomingStops[0].etaMinutes === 0 ? "Now" : `${upcomingStops[0].etaMinutes} min`}
          </span>
        )}
      </div>

      <dl className="grid grid-cols-3 m-0 text-sm" style={{ borderBottom: "1px solid var(--rule)" }}>
        <div className="pb-2 pr-2">
          <dt className="sh-muted">Speed</dt>
          <dd className="m-0 font-bold tabular-nums">{formatSpeed(activeVehicle.speedMps, units)}</dd>
        </div>
        <div className="pb-2 px-2" style={{ borderLeft: "1px solid var(--rule)" }}>
          <dt className="sh-muted">Heading</dt>
          <dd className="m-0 font-bold tabular-nums">
            {activeVehicle.bearingDeg !== null
              ? `${Math.round(activeVehicle.bearingDeg)}° ${formatCompass(activeVehicle.bearingDeg)}`
              : "Unknown"}
          </dd>
        </div>
        <div className="pb-2 pl-2" style={{ borderLeft: "1px solid var(--rule)" }}>
          <dt className="sh-muted">Stops left</dt>
          <dd className="m-0 font-bold tabular-nums">{rideData?.stops.length ? upcomingStops.length : "Unknown"}</dd>
        </div>
      </dl>

      {upcomingStops.length > 0 && (
        <div>
          <h3 className="m-0 text-base font-bold">Upcoming stops</h3>
          <p className="m-0 text-sm sh-muted">Use the bell to get a vibration before your stop.</p>
          <ul className="list-none m-0 p-0 mt-1">
            {upcomingStops.slice(0, 12).map((s) => {
              const isAlert = alertStopId === s.stopId;
              const isCurrentOrNext = s.status === "current" || s.status === "next";
              return (
                <li
                  key={`${s.stopId}-${s.stopSequence}`}
                  className="flex items-center justify-between gap-2"
                  style={{ borderBottom: "1px solid var(--rule)", minHeight: 44 }}
                >
                  <Link
                    to={`/stops/${activeVehicle.agencyId}/${encodeURIComponent(s.stopId)}`}
                    className={`truncate ${isCurrentOrNext ? "font-bold" : ""}`}
                  >
                    {s.name}
                  </Link>
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="tabular-nums text-sm sh-muted">
                      {s.status === "current"
                        ? "Here"
                        : s.etaMinutes !== null
                          ? `${s.etaMinutes} min`
                          : `${Math.round(s.distanceMeters)} m`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setAlertStopId(isAlert ? null : s.stopId)}
                      aria-pressed={isAlert}
                      aria-label={isAlert ? `Cancel alert for ${s.name}` : `Alert before ${s.name}`}
                      className="sh-btn sh-btn-icon sh-btn-quiet"
                      style={isAlert ? { color: "var(--accent)" } : undefined}
                    >
                      <Bell size={18} aria-hidden="true" fill={isAlert ? "currentColor" : "none"} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
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
          <HistoryIcon size={18} aria-hidden="true" /> Replay
        </Link>
        <button
          type="button"
          className="sh-btn sh-btn-icon"
          aria-pressed={followSelected}
          aria-label="Follow this vehicle on the map"
          onClick={() => setFollowSelected((f) => !f)}
          style={followSelected ? { background: "var(--accent)", color: "var(--on-accent)", borderColor: "var(--accent)" } : undefined}
        >
          <Crosshair size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sh-btn sh-btn-icon"
          aria-pressed={isFavorite(activeVehicle.agencyId, "vehicle", activeVehicle.vehicleId)}
          aria-label="Save this vehicle"
          onClick={() =>
            toggleFavorite({
              agencyId: activeVehicle.agencyId,
              entityType: "vehicle",
              entityId: activeVehicle.vehicleId,
              label: `${agencyShortName(activeVehicle.agencyId)} ${activeVehicle.fleetNumber}`,
            })
          }
        >
          <Star
            size={20}
            aria-hidden="true"
            fill={isFavorite(activeVehicle.agencyId, "vehicle", activeVehicle.vehicleId) ? "currentColor" : "none"}
          />
        </button>
      </div>

      {activeVehicle.tripId && (
        <p className="m-0 text-sm flex justify-between gap-2">
          <span className="sh-muted">Trip</span>
          <Link to={`/trips/${activeVehicle.agencyId}/${encodeURIComponent(activeVehicle.tripId)}`}>
            {activeVehicle.tripId}
          </Link>
        </p>
      )}

      <button
        type="button"
        className="sh-btn w-full hidden lg:inline-flex"
        onClick={() => selectVehicle(null)}
      >
        Close vehicle
      </button>
    </section>
  ) : null;

  const stopFocus: [number, number] | null =
    selectedStopId && !activeVehicle && stopData?.stop.lon !== undefined && stopData.stop.lat !== undefined
      ? [stopData.stop.lon, stopData.stop.lat]
      : null;
  const sheetOpen = !isDesktop && Boolean(activeVehicle || selectedStopId || showFilters || drawerOpen);

  const map = (
    <TransitMap
      center={stopFocus ?? (userPos && onBoardMode && !activeVehicle ? [userPos.lon, userPos.lat] : center)}
      zoom={stopFocus ? 15 : userPos && onBoardMode && !activeVehicle ? 14 : zoom}
      bottomInset={sheetOpen ? Math.round(window.innerHeight * 0.4) : 0}
      vehicles={filteredVehicles}
      selectedVehicleId={selectedId}
      onSelectVehicle={(v) => selectVehicle(v.vehicleId)}
      routeShape={effectiveRouteShape}
      routeShapeColor={shapeColor}
      stops={effectiveStops}
      selectedStopId={selectedStopId}
      onSelectStop={(s) => selectStop(s)}
      userLocation={userPos ? { lat: userPos.lat, lon: userPos.lon } : null}
      followSelected={followSelected}
      labelMode={labelMode}
      heightClass="h-full w-full"
      rounded={false}
    />
  );

  const countChip = (
    <div className="flex items-center gap-2">
      <div className="sh-chip" role="status" aria-live="polite">
        <b>{liveCount}</b>
        <span className="leading-tight">
          {liveCount === 1 ? noun.toLowerCase() : `${noun.toLowerCase() === "bus" ? "buses" : "vehicles"}`} live
          <span className="block text-xs sh-muted">{feedNote}</span>
        </span>
      </div>
      <div role="group" aria-label="Map bus labels" className="sh-seg bg-[var(--paper)]">
        {(
          [
            ["line", "Line"],
            ["line+fleet", "Line + #"],
            ["icons", "Icons"],
          ] as const
        ).map(([m, text]) => (
          <button
            key={m}
            type="button"
            aria-pressed={labelMode === m}
            onClick={() => setLabelMode(m)}
            className="text-xs px-2.5"
            style={{ minHeight: 44 }}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );

  /* ---------- Desktop: fixed 400px panel + map ---------- */

  if (isDesktop) {
    return (
      <div className="flex-1 min-h-0 flex">
        <aside
          aria-label="Departures and vehicles"
          className="w-[400px] shrink-0 flex flex-col min-h-0"
          style={{ borderRight: "var(--border-w) solid var(--line)" }}
        >
          <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
            {notices}
            {vehiclePanel ??
              stopPanel ?? (
                <section aria-labelledby="live-title" className="space-y-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 id="live-title" className="m-0 text-2xl font-extrabold leading-tight">
                      Live {noun === "Bus" ? "buses" : "vehicles"}, {agencyLabel}
                    </h2>
                  </div>
                  <div className="flex items-stretch gap-2">
                    {routeSelect && <div className="flex-1 min-w-0">{routeSelect}</div>}
                    <button
                      type="button"
                      className={`sh-btn shrink-0 ${showFilters || activeFilterCount > 0 ? "sh-btn-primary" : ""}`}
                      aria-expanded={showFilters}
                      onClick={() => setShowFilters((s) => !s)}
                    >
                      <SlidersHorizontal size={18} aria-hidden="true" />
                      Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
                    </button>
                  </div>
                  <p className="m-0 text-sm sh-muted">
                    {routeFilter
                      ? "Pick a stop on the route to see its next departures, or click any bus."
                      : "Click any bus on the map to follow it, or choose a route to show its stops."}
                  </p>
                  {showFilters && filtersForm}
                  {nothingReporting && filteredVehicles.length > 0 && emptyNotice}
                  {vehicleList}
                </section>
              )}
          </div>
          <div className="flex gap-2 p-5 pt-3" style={{ borderTop: "1px solid var(--rule)" }}>
            <Link to="/plan" className="sh-btn sh-btn-primary flex-1">
              Plan a trip
            </Link>
            <button
              type="button"
              className="sh-btn flex-1"
              aria-pressed={onBoardMode}
              onClick={toggleOnBoard}
              style={onBoardMode ? { background: "var(--accent)", color: "var(--on-accent)", borderColor: "var(--accent)" } : undefined}
            >
              {onBoardMode ? "Tracking you" : "On board"}
            </button>
          </div>
        </aside>

        <div className="sh-map-shell relative flex-1 min-w-0 overflow-hidden">
          {map}
          <div className="absolute top-4 left-4 z-20">{countChip}</div>
        </div>
      </div>
    );
  }

  /* ---------- Phone and tablet: map, one control block, bottom sheet ---------- */

  const sheetMode = activeVehicle ? "vehicle" : selectedStopId ? "stop" : showFilters ? "filters" : drawerOpen ? "list" : null;

  return (
    <div className="sh-map-shell relative w-full flex-1 min-h-[360px] overflow-hidden">
      {map}

      <div className="absolute top-2 left-2 right-2 z-20 flex flex-col gap-2 pointer-events-none">
        <div className="sh-panel pointer-events-auto">
          <div className="flex items-stretch" style={{ borderBottom: "var(--border-w) solid var(--line)" }}>
            <div className="flex items-center gap-2 px-3 shrink-0" role="status" aria-live="polite">
              <b className="text-[22px] font-extrabold tabular-nums leading-none">{liveCount}</b>
              <span className="text-xs leading-tight">
                live
                <span className="block sh-muted">{feedNote}</span>
              </span>
            </div>
            {routeSelect && (
              <div className="flex-1 min-w-0" style={{ borderLeft: "var(--border-w) solid var(--line)" }}>
                {React.cloneElement(routeSelect, {
                  className: "sh-input w-full min-w-0 border-0",
                  style: { backgroundColor: "transparent" },
                })}
              </div>
            )}
          </div>
          <div className="sh-iconrow" style={{ border: 0 }}>
            <Link to="/plan">
              <Navigation size={20} aria-hidden="true" />
              Plan
            </Link>
            <button type="button" aria-pressed={onBoardMode} onClick={toggleOnBoard}>
              <LocateFixed size={20} aria-hidden="true" />
              {onBoardMode ? "Tracking" : "On board"}
            </button>
            <button
              type="button"
              aria-expanded={showFilters}
              onClick={() => {
                setShowFilters((s) => !s);
                setDrawerOpen(false);
              }}
            >
              <SlidersHorizontal size={20} aria-hidden="true" />
              Filters
            </button>
            <button
              type="button"
              aria-expanded={drawerOpen}
              onClick={() => {
                setDrawerOpen((d) => !d);
                setShowFilters(false);
              }}
            >
              <List size={20} aria-hidden="true" />
              List
            </button>
          </div>
        </div>

        {(gpsError || (onBoardMode && watching && !activeVehicle) || activeAgency?.liveStatus === "missing_key" || (nothingReporting && !sheetMode)) && (
          <div className="sh-panel p-3 space-y-2 pointer-events-auto">
            {notices}
            {!sheetMode && emptyNotice}
          </div>
        )}
      </div>

      {sheetMode && (
        <BottomSheet
          label={
            sheetMode === "vehicle"
              ? "Vehicle details"
              : sheetMode === "stop"
                ? "Stop departures"
                : sheetMode === "filters"
                  ? "Filters"
                  : "Vehicle list"
          }
          initial={sheetMode === "list" ? "full" : "peek"}
          onClose={() => {
            if (sheetMode === "vehicle") selectVehicle(null);
            else if (sheetMode === "stop") selectStop(null);
            else if (sheetMode === "filters") setShowFilters(false);
            else setDrawerOpen(false);
          }}
        >
          {sheetMode === "vehicle" && vehiclePanel}
          {sheetMode === "stop" && stopPanel}
          {sheetMode === "filters" && (
            <div className="space-y-3">
              <h2 className="m-0 text-xl font-extrabold">Filters</h2>
              {filtersForm}
            </div>
          )}
          {sheetMode === "list" && (
            <div className="space-y-2">
              <h2 className="m-0 text-xl font-extrabold tabular-nums">
                {filteredVehicles.length} {filteredVehicles.length === 1 ? "vehicle" : "vehicles"}
              </h2>
              {vehicleList}
            </div>
          )}
        </BottomSheet>
      )}
    </div>
  );
}
