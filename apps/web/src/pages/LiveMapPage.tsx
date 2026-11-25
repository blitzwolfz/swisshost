import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  Bell,
  CloudRain,
  Crosshair,
  Footprints,
  History as HistoryIcon,
  List,
  LocateFixed,
  Navigation,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Ticket,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { TransitMap, type MapLabelMode } from "../components/TransitMap";
import { BottomSheet } from "../components/BottomSheet";
import { DepartureRow, EmptyState, LiveLegend, RouteBadge, vehicleNounFor } from "../components/Transit";
import { WeatherAlertBanner, WeatherGlyph, WeatherMapChip } from "../components/Weather";
import { useLiveAgency } from "../hooks/useLiveAgency";
import { useUserLocation } from "../hooks/useUserLocation";
import { useWeather } from "../hooks/useWeather";
import {
  apiJson,
  formatClock,
  formatCompass,
  formatDelay,
  formatOccupancy,
  formatRelativeAge,
  formatSpeed,
  formatTemperature,
  formatVehicleStatusLine,
  isTrainMode,
  vehicleModeNoun,
  type AgencySummary,
  type LiveVehicle,
  type RailCorridorOverlay,
  type StopArrivals,
  type VehicleMode,
} from "../lib/api";
import { agencyName, agencyShortName } from "../lib/agencies";
import { clearActiveTrip, loadActiveTrip, type ActiveTripSession, type PlanLeg, type RouteAlertItem } from "../lib/activeTrip";
import { requestStopNotificationPermission, triggerStopAlert, useWakeLock } from "../lib/stopAlert";
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

interface OnBoardRouteCandidate {
  agencyId: string;
  routeId: string;
  routeShortName: string;
  routeLongName: string | null;
  routeColor: string | null;
  vehicleMode: string;
  nearestStopId: string | null;
  nearestStopName: string | null;
  nearestStopDistanceMeters: number;
  vehicles: Array<LiveVehicle & { distanceMeters: number }>;
}

interface OnBoardRouteResponse {
  agencyId: string;
  route: {
    routeId: string;
    shortName: string;
    longName: string | null;
    color: string | null;
    vehicleMode: string;
  };
  trackingBasis: "user_gps" | "vehicle_gps" | "route_start";
  activeDirectionId: number;
  activeHeadsign: string | null;
  directions: Array<{ directionId: number; headsign: string; stopCount: number }>;
  routeShape: { type: "LineString"; coordinates: Array<[number, number]> } | null;
  distanceToRouteMeters: number;
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
    wheelchairBoarding?: number;
  }>;
  alerts?: RouteAlertItem[];
  selectedVehicle: LiveVehicle | null;
  vehiclesOnRoute: Array<LiveVehicle & { distanceMeters: number; onPortion: boolean }>;
  vehiclesOnPortionCount: number;
  serverTime: string;
}

interface OnBoardTarget {
  agencyId: string;
  routeId: string;
  directionId: number | null;
  vehicleId: string | null;
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
  const {
    agencyId,
    setAgencyId,
    units,
    showWeather,
    setShowWeather,
    showWeatherRadar,
    setShowWeatherRadar,
    isFavorite,
    toggleFavorite,
  } = usePreferences();
  const isDesktop = useIsDesktop();
  const { data: weatherData } = useWeather({ agencyId });
  const [searchParams, setSearchParams] = useSearchParams();
  const routeFilter = searchParams.get("route") || "";
  const selectedId = searchParams.get("vehicle") || null;
  const selectedStopId = searchParams.get("stop") || null;
  const stopAgency = searchParams.get("stopAgency") || agencyId;
  const tripParam = searchParams.get("trip") || null;

  const [fleetFilter, setFleetFilter] = useState("");
  const [freshnessFilter, setFreshnessFilter] = useState<"all" | "fresh" | "stale">("all");
  const [assignedFilter, setAssignedFilter] = useState<"all" | "assigned" | "unassigned">("all");
  const [modeFilter, setModeFilter] = useState<"all" | "trains" | "subway" | "streetcar" | "bus">("all");
  const [labelMode, setLabelMode] = useState<MapLabelMode>("line");
  const [showFilters, setShowFilters] = useState(false);

  // Reset mode filter when switching agencies
  useEffect(() => {
    setModeFilter("all");
  }, [agencyId]);

  const { data: railData } = useQuery({
    queryKey: ["rail-corridors", agencyId],
    queryFn: () =>
      apiJson<{ corridors: RailCorridorOverlay[] }>(`/api/v1/rail-corridors?agency=${encodeURIComponent(agencyId)}`),
    enabled: agencyId === "ttc" || agencyId === "go" || agencyId === "all",
    staleTime: 300_000,
  });
  const [followSelected, setFollowSelected] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [onBoardMode, setOnBoardMode] = useState(false);
  const [onBoardTarget, setOnBoardTarget] = useState<OnBoardTarget | null>(null);
  const [activeTrip, setActiveTrip] = useState<ActiveTripSession | null>(() =>
    tripParam ? loadActiveTrip(tripParam) : null
  );
  const [activeTripLegIdx, setActiveTripLegIdx] = useState(0);
  const [tripLegVehicles, setTripLegVehicles] = useState<Record<number, string | null>>({});
  const [alertStopId, setAlertStopId] = useState<string | null>(null);
  const { position: userPos, watching, error: gpsError, startWatching, stopWatching } = useUserLocation();

  // Sync planned trip session when URL ?trip=... changes
  useEffect(() => {
    if (!tripParam) {
      setActiveTrip(null);
      return;
    }
    const loaded = loadActiveTrip(tripParam);
    setActiveTrip(loaded);
    if (loaded) {
      setActiveTripLegIdx(0);
      const tLegs = loaded.option.legs.filter((l) => l.mode === "transit");
      const initialVehs: Record<number, string | null> = {};
      tLegs.forEach((leg, i) => {
        initialVehs[i] = leg.nearestVehicleId ?? leg.upcomingBuses?.[0]?.vehicleId ?? null;
      });
      setTripLegVehicles(initialVehs);
      setOnBoardMode(true);
      setOnBoardTarget(null);
      startWatching();
    }
  }, [tripParam, startWatching]);

  const tripTransitLegs: PlanLeg[] = useMemo(
    () => (activeTrip ? activeTrip.option.legs.filter((l) => l.mode === "transit") : []),
    [activeTrip]
  );
  const activeTripLeg: PlanLeg | null = tripTransitLegs[activeTripLegIdx] ?? tripTransitLegs[0] ?? null;

  // Auto-arm get-off bell alert for the active planned trip leg's exit stop
  useEffect(() => {
    if (activeTrip && activeTripLeg?.toStopId) {
      setAlertStopId(activeTripLeg.toStopId);
    }
  }, [activeTrip?.id, activeTripLegIdx, activeTripLeg?.toStopId]);

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
        stops: Array<{ stop_id: string; name: string; lat: number; lon: number; wheelchair_boarding?: number }>;
        alerts?: Array<{ id: string; effect?: string | null; header_text: string; description_text?: string }>;
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
      if (modeFilter === "trains" && !isTrainMode(v.vehicleMode)) return false;
      if (modeFilter === "subway" && v.vehicleMode !== "subway") return false;
      if (modeFilter === "streetcar" && v.vehicleMode !== "streetcar") return false;
      if (modeFilter === "bus" && v.vehicleMode && v.vehicleMode !== "bus") return false;
      return true;
    });
    // Put live GPS vehicles first, then timetable-estimated trains, then unassigned, then stale
    return [...list].sort((a, b) => {
      const rank = (v: LiveVehicle) =>
        (v.freshness === "stale" ? 8 : 0) +
        (v.positionSource === "scheduled"
          ? 2
          : isTrainMode(v.vehicleMode)
            ? 0
            : v.routeId || v.tripId
              ? 1
              : 3);
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
  }, [live.vehicles, routes, fleetFilter, freshnessFilter, assignedFilter, modeFilter]);

  const activeFilterCount =
    (fleetFilter ? 1 : 0) +
    (freshnessFilter !== "all" ? 1 : 0) +
    (assignedFilter !== "all" ? 1 : 0) +
    (modeFilter !== "all" ? 1 : 0);

  const visibleRailCorridors = useMemo(() => {
    if (modeFilter === "bus" || modeFilter === "streetcar") return [];
    const all = railData?.corridors ?? [];
    if (routeFilter) {
      return all.filter((c) => c.routeId === routeFilter || c.shortName === routeFilter);
    }
    return all;
  }, [railData, modeFilter, routeFilter]);

  const liveGpsCount = filteredVehicles.filter((v) => v.freshness !== "stale" && v.positionSource !== "scheduled").length;
  const scheduledTrainCount = filteredVehicles.filter((v) => v.positionSource === "scheduled").length;
  const liveCount = liveGpsCount + scheduledTrainCount;

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

  // Location + existing route data: find routes & vehicles near user when choosing On-Board
  const gpsBucketLat = userPos ? Math.round(userPos.lat * 2000) / 2000 : null;
  const gpsBucketLon = userPos ? Math.round(userPos.lon * 2000) / 2000 : null;

  const { data: onBoardCandidatesData, isLoading: candidatesLoading } = useQuery({
    queryKey: ["onboard-candidates", gpsBucketLat, gpsBucketLon],
    queryFn: () =>
      apiJson<{ candidates: OnBoardRouteCandidate[] }>(
        `/api/v1/onboard/candidates?lat=${userPos!.lat}&lon=${userPos!.lon}&radius=700`
      ),
    enabled: onBoardMode && !onBoardTarget && !activeTrip && Boolean(userPos),
    refetchInterval: 15_000,
  });

  // Focused On-Board route spec (either from Planned Trip active leg OR selected On-Board route)
  const focusedRouteSpec = useMemo(() => {
    if (activeTrip && activeTripLeg?.agencyId && activeTripLeg.routeId) {
      return {
        agencyId: activeTripLeg.agencyId,
        routeId: activeTripLeg.routeId,
        directionId: null as number | null,
        vehicleId: tripLegVehicles[activeTripLegIdx] ?? null,
        fromStopId: activeTripLeg.fromStopId ?? null,
        toStopId: activeTripLeg.toStopId ?? null,
      };
    }
    if (onBoardMode && onBoardTarget) {
      return {
        agencyId: onBoardTarget.agencyId,
        routeId: onBoardTarget.routeId,
        directionId: onBoardTarget.directionId,
        vehicleId: onBoardTarget.vehicleId,
        fromStopId: null,
        toStopId: null,
      };
    }
    return null;
  }, [activeTrip, activeTripLeg, activeTripLegIdx, tripLegVehicles, onBoardMode, onBoardTarget]);

  const { data: onBoardRouteData, isLoading: onBoardRouteLoading } = useQuery({
    queryKey: [
      "onboard-route",
      focusedRouteSpec?.agencyId,
      focusedRouteSpec?.routeId,
      focusedRouteSpec?.directionId,
      focusedRouteSpec?.vehicleId,
      focusedRouteSpec?.fromStopId,
      focusedRouteSpec?.toStopId,
      gpsBucketLat,
      gpsBucketLon,
    ],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (userPos) {
        sp.set("lat", String(userPos.lat));
        sp.set("lon", String(userPos.lon));
        if (userPos.headingDeg !== null) sp.set("heading", String(Math.round(userPos.headingDeg)));
        if (userPos.speedMps !== null) sp.set("speed", String(userPos.speedMps.toFixed(1)));
      }
      if (focusedRouteSpec!.directionId !== null) sp.set("direction", String(focusedRouteSpec!.directionId));
      if (focusedRouteSpec!.vehicleId) sp.set("vehicle", focusedRouteSpec!.vehicleId);
      if (focusedRouteSpec!.fromStopId) sp.set("fromStop", focusedRouteSpec!.fromStopId);
      if (focusedRouteSpec!.toStopId) sp.set("toStop", focusedRouteSpec!.toStopId);
      return apiJson<OnBoardRouteResponse>(
        `/api/v1/agencies/${encodeURIComponent(focusedRouteSpec!.agencyId)}/routes/${encodeURIComponent(
          focusedRouteSpec!.routeId
        )}/onboard?${sp.toString()}`
      );
    },
    enabled: Boolean(focusedRouteSpec),
    refetchInterval: 15_000,
    staleTime: 6_000,
  });

  const isFocusedOnBoard = Boolean(focusedRouteSpec);

  const activeVehicle = rideData?.vehicle ?? selectedVehicle;
  const upcomingStops = (rideData?.stops ?? []).filter((s) => s.status !== "passed");

  // Stops along the focused On-Board route or active planned trip leg
  const focusedStops = useMemo(() => {
    const raw = onBoardRouteData?.stops ?? [];
    if (!activeTrip || !activeTripLeg?.fromStopId || !activeTripLeg.toStopId || raw.length === 0) {
      return raw;
    }
    const fi = raw.findIndex((s) => s.stopId === activeTripLeg.fromStopId);
    const ti = raw.findIndex((s) => s.stopId === activeTripLeg.toStopId);
    if (fi !== -1 && ti !== -1 && fi < ti) {
      return raw.slice(fi, ti + 1);
    }
    return raw;
  }, [onBoardRouteData, activeTrip, activeTripLeg]);

  const focusedUpcomingStops = useMemo(
    () => focusedStops.filter((s) => s.status !== "passed"),
    [focusedStops]
  );

  // When in focused On-Board / Planned Trip mode, show ONLY that route's shape, stops, and vehicle(s) — nothing else!
  const effectiveRouteShape = isFocusedOnBoard
    ? (onBoardRouteData?.routeShape ?? null)
    : (rideData?.routeShape ?? routeDetail?.route.shapeGeoJson ?? null);

  const shapeRouteId = isFocusedOnBoard
    ? (focusedRouteSpec?.routeId ?? "")
    : (activeVehicle?.routeId ?? routeFilter);

  const shapeColor = isFocusedOnBoard
    ? routeColor(
        focusedRouteSpec!.agencyId,
        onBoardRouteData?.route.shortName ?? focusedRouteSpec!.routeId,
        onBoardRouteData?.route.color ?? activeTripLeg?.routeColor
      )
    : effectiveRouteShape
      ? activeVehicle
        ? routeColor(activeVehicle.agencyId, activeVehicle.routeId, activeVehicle.routeColor)
        : routes.color(shapeRouteId)
      : null;

  const effectiveStops = useMemo(() => {
    if (isFocusedOnBoard) {
      return focusedStops.map((s) => ({ stop_id: s.stopId, name: s.name, lat: s.lat, lon: s.lon }));
    }
    const base = rideData?.stops.length
      ? rideData.stops.map((s) => ({ stop_id: s.stopId, name: s.name, lat: s.lat, lon: s.lon }))
      : (routeDetail?.stops ?? []);
    // Keep the selected stop on the map even after the route or vehicle that showed it is cleared
    const s = stopData?.stop;
    if (s && s.lat !== undefined && s.lon !== undefined && !base.some((b) => b.stop_id === s.stop_id)) {
      return [...base, { stop_id: s.stop_id, name: s.name, lat: s.lat, lon: s.lon }];
    }
    return base;
  }, [isFocusedOnBoard, focusedStops, rideData, routeDetail, stopData]);

  // Vehicles shown on the map: strictly scoped to the active route/vehicle when On-Board or in a Planned Trip!
  const mapVehicles = useMemo(() => {
    if (!isFocusedOnBoard) return filteredVehicles;
    if (!onBoardRouteData) return [];
    if (focusedRouteSpec?.vehicleId) {
      const chosen = onBoardRouteData.vehiclesOnRoute.find((v) => v.vehicleId === focusedRouteSpec.vehicleId);
      if (chosen) return [chosen];
    }
    const onPortion = onBoardRouteData.vehiclesOnRoute.filter((v) => v.onPortion);
    return onPortion.length > 0 ? onPortion : onBoardRouteData.vehiclesOnRoute.slice(0, 6);
  }, [isFocusedOnBoard, filteredVehicles, onBoardRouteData, focusedRouteSpec?.vehicleId]);

  const mapRailCorridors = useMemo(() => {
    if (isFocusedOnBoard) return [];
    return visibleRailCorridors;
  }, [isFocusedOnBoard, visibleRailCorridors]);

  const tripWalkSegments = useMemo(() => {
    if (!activeTrip) return [];
    return activeTrip.option.legs
      .filter(
        (l) =>
          l.mode === "walk" &&
          l.fromLat !== undefined &&
          l.fromLon !== undefined &&
          l.toLat !== undefined &&
          l.toLon !== undefined
      )
      .map((l) => [
        [l.fromLon!, l.fromLat!] as [number, number],
        [l.toLon!, l.toLat!] as [number, number],
      ]);
  }, [activeTrip]);

  const tripMarkers = useMemo(() => {
    if (!activeTrip) return [];
    const out: Array<{ lat: number; lon: number; label: string; accent?: boolean }> = [
      { lat: activeTrip.originLat, lon: activeTrip.originLon, label: "Start" },
      { lat: activeTrip.destLat, lon: activeTrip.destLon, label: "Destination", accent: true },
    ];
    if (activeTripLeg?.fromLat !== undefined && activeTripLeg.fromLon !== undefined) {
      out.push({
        lat: activeTripLeg.fromLat,
        lon: activeTripLeg.fromLon,
        label: `Board: ${activeTripLeg.fromName}`,
      });
    }
    if (activeTripLeg?.toLat !== undefined && activeTripLeg.toLon !== undefined) {
      const isTransfer = activeTripLegIdx < tripTransitLegs.length - 1;
      out.push({
        lat: activeTripLeg.toLat,
        lon: activeTripLeg.toLon,
        label: `${isTransfer ? "Transfer" : "Exit"}: ${activeTripLeg.toName}`,
        accent: true,
      });
    }
    return out;
  }, [activeTrip, activeTripLeg, activeTripLegIdx, tripTransitLegs.length]);

  // Keep phone screen awake while actively riding On-Board or in a Planned Trip window
  const { awake: screenAwake } = useWakeLock(isFocusedOnBoard);
  const firedAlertKeyRef = useRef<string | null>(null);
  const [triggeredStopBanner, setTriggeredStopBanner] = useState<string | null>(null);

  const toggleStopBell = (stopId: string) => {
    if (alertStopId === stopId) {
      setAlertStopId(null);
      setTriggeredStopBanner(null);
      firedAlertKeyRef.current = null;
    } else {
      setAlertStopId(stopId);
      setTriggeredStopBanner(null);
      firedAlertKeyRef.current = null;
      void requestStopNotificationPermission();
    }
  };

  // Trigger audio chime + haptic vibration + browser notification when armed stop is next or current
  useEffect(() => {
    const stopsSource = isFocusedOnBoard ? focusedStops : (rideData?.stops ?? []);
    if (!alertStopId || !stopsSource.length) return;
    const target = stopsSource.find((s) => s.stopId === alertStopId);
    if (target && (target.status === "next" || target.status === "current")) {
      const fireKey = `${alertStopId}:${target.status}`;
      if (firedAlertKeyRef.current !== fireKey) {
        firedAlertKeyRef.current = fireKey;
        const routeLabel = isFocusedOnBoard
          ? (onBoardRouteData?.route.shortName ?? activeTripLeg?.routeShortName ?? undefined)
          : (activeVehicle?.routeShortName ?? activeVehicle?.routeId ?? undefined);
        triggerStopAlert({ stopName: target.name, status: target.status, routeLabel });
        setTriggeredStopBanner(
          target.status === "current"
            ? `Arriving now at ${target.name} — exit here.`
            : `Next stop is ${target.name} — get ready to exit.`
        );
      }
    }
  }, [alertStopId, isFocusedOnBoard, focusedStops, rideData, onBoardRouteData, activeTripLeg, activeVehicle]);

  // Clear stop alert when switching non-trip vehicles
  useEffect(() => {
    if (!activeTrip) setAlertStopId(null);
  }, [selectedId, activeTrip]);

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
  const selectStop = (stop: { stop_id: string; agencyId?: string } | null) =>
    setParams({
      stop: stop?.stop_id ?? null,
      stopAgency: stop ? (stop.agencyId ?? activeVehicle?.agencyId ?? (agencyId !== "all" ? agencyId : null)) : null,
      vehicle: null,
    });

  const exitOnBoardAndTrip = () => {
    setOnBoardMode(false);
    setOnBoardTarget(null);
    setActiveTrip(null);
    clearActiveTrip();
    stopWatching();
    if (tripParam) setParam("trip", null);
  };

  const toggleOnBoard = () => {
    if (onBoardMode || activeTrip) {
      exitOnBoardAndTrip();
    } else {
      setOnBoardMode(true);
      startWatching();
      if (activeVehicle?.routeId) {
        setOnBoardTarget({
          agencyId: activeVehicle.agencyId,
          routeId: activeVehicle.routeId,
          directionId: activeVehicle.directionId,
          vehicleId: activeVehicle.vehicleId,
        });
        selectVehicle(null);
      } else if (routeFilter && agencyId !== "all") {
        setOnBoardTarget({
          agencyId,
          routeId: routeFilter,
          directionId: null,
          vehicleId: null,
        });
      }
    }
  };

  const delayInfo = activeVehicle ? formatDelay(activeVehicle.scheduleDeviationSec) : null;
  const noun = vehicleNounFor(activeAgency?.modes);
  const agencyLabel = agencyId === "all" ? "all agencies" : agencyName(agencyId);

  const feedNote =
    live.feedStatus === "missing_key"
      ? scheduledTrainCount > 0
        ? `${scheduledTrainCount} calculated trains (API key pending)`
        : "waiting for an API key"
      : live.lastSuccessAt
        ? scheduledTrainCount > 0
          ? `${liveGpsCount} GPS · ${scheduledTrainCount} calculated`
          : `updated ${formatRelativeAge(live.lastSuccessAt)}`
        : live.connection === "connecting" && settledAgency !== agencyId
          ? "connecting"
          : scheduledTrainCount > 0
            ? `${scheduledTrainCount} calculated trains`
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

  const modeOptions: Array<{ id: typeof modeFilter; label: string }> =
    agencyId === "ttc"
      ? [
          { id: "all", label: "All" },
          { id: "subway", label: "Subway" },
          { id: "streetcar", label: "Streetcar" },
          { id: "bus", label: "Bus" },
        ]
      : agencyId === "grt"
        ? [
            { id: "all", label: "All" },
            { id: "streetcar", label: "ION LRT" },
            { id: "bus", label: "Bus" },
          ]
        : agencyId === "go" || agencyId === "ontarionorthland" || agencyId === "all"
          ? [
              { id: "all", label: "All" },
              { id: "trains", label: "Trains" },
              { id: "bus", label: "Buses" },
            ]
          : [];

  const modeSwitcher =
    modeOptions.length > 0 ? (
      <div role="group" aria-label="Filter by vehicle type" className="sh-seg w-full">
        {modeOptions.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={modeFilter === m.id}
            onClick={() => setModeFilter(m.id)}
            style={{ minHeight: 38, padding: "0 0.5rem" }}
            className="text-xs"
          >
            {m.label}
          </button>
        ))}
      </div>
    ) : null;

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
      <WeatherAlertBanner weather={weatherData} compact />

      {triggeredStopBanner && (
        <div
          className="p-3 text-sm font-bold flex items-center justify-between gap-2"
          style={{ background: "var(--accent)", color: "var(--on-accent)" }}
          role="alert"
        >
          <span className="inline-flex items-center gap-2">
            <Volume2 size={16} aria-hidden="true" className="shrink-0" />
            {triggeredStopBanner}
          </span>
          <button
            type="button"
            className="bg-transparent border-0 p-1 cursor-pointer"
            style={{ color: "inherit" }}
            aria-label="Dismiss stop alert"
            onClick={() => setTriggeredStopBanner(null)}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      {!isFocusedOnBoard && routeFilter && routeDetail?.alerts && routeDetail.alerts.length > 0 && (
        <div
          className="p-2.5 text-xs space-y-1"
          style={{ borderLeft: "3px solid var(--danger)", background: "var(--paper-raised)" }}
          role="alert"
        >
          {routeDetail.alerts.slice(0, 2).map((al) => (
            <div key={al.id} className="flex items-start gap-1.5">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: "var(--danger)" }} aria-hidden="true" />
              <span>
                <strong>
                  {al.effect && al.effect !== "UNKNOWN_EFFECT" && al.effect !== "OTHER_EFFECT"
                    ? `${al.effect.replace(/_/g, " ")}: `
                    : "Service alert: "}
                </strong>
                {al.header_text}
              </span>
            </div>
          ))}
        </div>
      )}

      {gpsError && (
        <p className="m-0 text-sm font-bold" style={{ color: "var(--danger)" }} role="alert">
          {gpsError}
        </p>
      )}

      {activeAgency?.liveStatus === "missing_key" && !isFocusedOnBoard && (
        <p className="m-0 text-sm">
          <strong>{activeAgency.name}</strong> train positions are calculated from the rail schedule &amp; speed model while{" "}
          <code>GO_TRANSIT_API_KEY</code> is pending. Live GPS trains &amp; buses activate automatically once set.{" "}
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
          setModeFilter("all");
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
          const scheduled = v.positionSource === "scheduled";
          const d = formatDelay(v.scheduleDeviationSec);
          const vNoun = vehicleModeNoun(v.vehicleMode, noun);
          const rightText = stale
            ? `Last seen ${formatClock(v.observedAt ?? v.receivedAt)}`
            : scheduled
              ? "Calculated"
              : d.tone !== "muted"
                ? d.text
                : v.speedMps !== null
                  ? v.speedMps < 0.5
                    ? "Stopped"
                    : formatSpeed(v.speedMps, units)
                  : `${v.ageSeconds}s ago`;
          const rightClass = stale || scheduled
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
                className={`sh-dep w-full text-left bg-transparent border-x-0 border-t-0 cursor-pointer ${stale || scheduled ? "sh-dep-sched" : ""}`}
                style={{ font: "inherit" }}
                aria-current={v.vehicleId === selectedId ? "true" : undefined}
              >
                <RouteBadge
                  size="lg"
                  label={v.routeShortName ?? v.routeId ?? ""}
                  color={routeColor(v.agencyId, v.routeShortName ?? v.routeId, v.routeColor)}
                />
                <span className="sh-dep-main">
                  <span className="sh-dep-dest">
                    {v.headsign ? v.headsign : v.routeId ? `Line ${v.routeShortName ?? v.routeId}` : "Not on a route"}
                  </span>
                  <span className="sh-dep-sub">
                    {vNoun} #{v.fleetNumber}
                    {agencyId === "all" ? `, ${agencyShortName(v.agencyId)}` : ""}
                    {v.stopName ? ` · ${formatVehicleStatusLine(v)}` : ""}
                  </span>
                </span>
                <span className="sh-dep-leader" aria-hidden="true" />
                <span
                  className={`text-sm text-right shrink-0 tabular-nums ${rightClass}`}
                  style={!stale && !scheduled && d.tone === "err" ? { color: "var(--danger)" } : undefined}
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
          color={routeColor(activeVehicle.agencyId, activeVehicle.routeShortName ?? activeVehicle.routeId, activeVehicle.routeColor)}
        />
        <div className="min-w-0">
          <h2 className="m-0 text-xl font-extrabold leading-tight">
            {activeVehicle.headsign
              ? activeVehicle.headsign
              : activeVehicle.routeLongName || `${vehicleModeNoun(activeVehicle.vehicleMode, noun)} ${activeVehicle.fleetNumber}`}
          </h2>
          <p className="m-0 text-sm sh-muted">
            <span className="sh-fleet" style={{ fontSize: "1rem" }}>
              {vehicleModeNoun(activeVehicle.vehicleMode, noun)} {activeVehicle.fleetNumber}
            </span>
            , {agencyShortName(activeVehicle.agencyId)}.{" "}
            {activeVehicle.positionSource === "scheduled" ? (
              <i>Position calculated from schedule &amp; train speed model (no public live GPS feed)</i>
            ) : activeVehicle.freshness === "stale" ? (
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

      {(() => {
        const occ = formatOccupancy(activeVehicle.occupancyStatus);
        if (!occ) return null;
        return (
          <div className="flex items-center gap-2 text-xs">
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 font-bold"
              style={{
                border: "1px solid var(--rule)",
                color: occ.tone === "err" ? "var(--danger)" : occ.tone === "warn" ? "var(--accent)" : "var(--ink)",
              }}
            >
              <Users size={13} aria-hidden="true" />
              Crowding: {occ.label}
            </span>
          </div>
        );
      })()}

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
                      onClick={() => toggleStopBell(s.stopId)}
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

  /* ---------- On-Board Mode & Planned Trip On-Board Window ---------- */

  const handleSelectFocusedVehicle = (vehicleId: string | null) => {
    if (activeTrip) {
      setTripLegVehicles((prev) => ({ ...prev, [activeTripLegIdx]: vehicleId }));
    } else if (onBoardTarget) {
      setOnBoardTarget((prev) => (prev ? { ...prev, vehicleId } : prev));
    }
    if (vehicleId) setFollowSelected(true);
  };

  const onBoardPanel =
    activeTrip || onBoardMode ? (
      <section aria-label={activeTrip ? "Active trip on-board window" : "On-board route tracker"} className="space-y-3">
        {/* Planned Trip Header + Leg Switcher */}
        {activeTrip && (
          <div className="space-y-2 pb-3" style={{ borderBottom: "var(--border-w) solid var(--line)" }}>
            <div className="flex items-start justify-between gap-2 pr-10 lg:pr-0">
              <div className="min-w-0">
                <div className="text-xs font-bold sh-muted">
                  Active trip · {(activeTrip.option.agencies ?? [activeTrip.option.agencyId]).map(agencyShortName).join(" → ")}
                </div>
                <h2 className="m-0 text-lg font-extrabold leading-tight truncate">
                  {activeTrip.originLabel} → {activeTrip.destLabel}
                </h2>
                <div className="text-xs sh-muted tabular-nums mt-0.5">
                  {activeTrip.option.totalMinutes} min · {formatClock(activeTrip.option.leaveAt)} →{" "}
                  {formatClock(activeTrip.option.arriveAt)}
                </div>
                {activeTrip.option.fareEstimate && (
                  <div
                    className="inline-flex items-center gap-1 text-xs font-bold mt-1"
                    style={{ color: activeTrip.option.fareEstimate.oneFareApplied ? "var(--accent)" : "var(--ink)" }}
                  >
                    <Ticket size={13} aria-hidden="true" />
                    {activeTrip.option.fareEstimate.summary}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="sh-btn sh-btn-icon shrink-0"
                aria-label="Exit active trip"
                title="Exit active trip"
                onClick={exitOnBoardAndTrip}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            {tripTransitLegs.length > 1 && (
              <div role="tablist" aria-label="Trip transit legs" className="sh-seg w-full">
                {tripTransitLegs.map((leg, idx) => (
                  <button
                    key={`${leg.agencyId}-${leg.routeId}-${idx}`}
                    type="button"
                    role="tab"
                    aria-selected={activeTripLegIdx === idx}
                    aria-pressed={activeTripLegIdx === idx}
                    onClick={() => setActiveTripLegIdx(idx)}
                    className="text-xs"
                    style={{ minHeight: 38, padding: "0 0.5rem" }}
                  >
                    Leg {idx + 1}: {agencyShortName(leg.agencyId ?? activeTrip.option.agencyId)} {leg.routeShortName}
                  </button>
                ))}
              </div>
            )}

            {/* Walk / transfer hints around the active leg */}
            {activeTripLeg && (
              <div className="text-xs sh-muted space-y-1">
                <div className="flex items-center gap-1.5">
                  <Footprints size={13} aria-hidden="true" className="shrink-0" />
                  <span>
                    Board at <strong style={{ color: "var(--ink)" }}>{activeTripLeg.fromName}</strong>
                    {activeTripLeg.departureTime ? ` (${formatClock(activeTripLeg.departureTime)})` : ""} → Exit at{" "}
                    <strong style={{ color: "var(--ink)" }}>{activeTripLeg.toName}</strong>
                    {activeTripLeg.arrivalTime ? ` (${formatClock(activeTripLeg.arrivalTime)})` : ""}
                  </span>
                </div>
                {activeTripLegIdx < tripTransitLegs.length - 1 && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 font-bold" style={{ color: "var(--accent)" }}>
                      <ArrowRight size={13} aria-hidden="true" className="shrink-0" />
                      <span>
                        Transfer next to {agencyShortName(tripTransitLegs[activeTripLegIdx + 1]!.agencyId ?? "")} Route{" "}
                        {tripTransitLegs[activeTripLegIdx + 1]!.routeShortName}
                      </span>
                    </div>
                    {activeTrip.option.transferRisks?.[activeTripLegIdx] &&
                      (() => {
                        const risk = activeTrip.option.transferRisks![activeTripLegIdx]!;
                        return (
                          <div
                            className="inline-flex items-center gap-1.5 font-bold"
                            style={{
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
                            <span>
                              {risk.message}
                              {risk.level !== "safe" && risk.backupDepartureTime
                                ? ` · Next backup ${formatClock(risk.backupDepartureTime)}`
                                : ""}
                            </span>
                          </div>
                        );
                      })()}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* CASE 1: Focused on a specific route (either On-Board Route or Active Planned Trip Leg) */}
        {focusedRouteSpec ? (
          <>
            <div className="flex items-start justify-between gap-2 pr-10 lg:pr-0">
              <div className="flex items-start gap-2.5 min-w-0">
                <RouteBadge
                  size="lg"
                  label={onBoardRouteData?.route.shortName ?? activeTripLeg?.routeShortName ?? focusedRouteSpec.routeId}
                  color={shapeColor ?? "#1D3E8A"}
                />
                <div className="min-w-0">
                  <h3 className="m-0 text-lg font-extrabold leading-tight truncate">
                    {onBoardRouteData?.activeHeadsign ??
                      activeTripLeg?.nearestHeadsign ??
                      onBoardRouteData?.route.longName ??
                      `Route ${focusedRouteSpec.routeId}`}
                  </h3>
                  <p className="m-0 text-xs sh-muted">
                    {agencyShortName(focusedRouteSpec.agencyId)} ·{" "}
                    {userPos ? (
                      <span className="sh-live">Tracked by your GPS</span>
                    ) : onBoardRouteData?.selectedVehicle ? (
                      <span>Tracked via #{onBoardRouteData.selectedVehicle.fleetNumber}</span>
                    ) : (
                      <span>Route view (waiting for GPS)</span>
                    )}
                    {onBoardRouteData?.selectedVehicle && userPos
                      ? ` · ${vehicleModeNoun(onBoardRouteData.selectedVehicle.vehicleMode, "Bus")} #${onBoardRouteData.selectedVehicle.fleetNumber}`
                      : ""}
                    {screenAwake ? " · Screen awake" : ""}
                  </p>
                </div>
              </div>
              {!activeTrip && (
                <button
                  type="button"
                  className="sh-btn sh-btn-icon shrink-0"
                  aria-label="Exit on-board mode"
                  title="Exit on-board mode"
                  onClick={exitOnBoardAndTrip}
                >
                  <X size={18} aria-hidden="true" />
                </button>
              )}
            </div>

            {/* Active Route Detours & Service Alerts */}
            {onBoardRouteData?.alerts && onBoardRouteData.alerts.length > 0 && (
              <div
                className="p-2.5 text-xs space-y-1"
                style={{ borderLeft: "3px solid var(--danger)", background: "var(--paper-raised)" }}
                role="alert"
              >
                {onBoardRouteData.alerts.slice(0, 2).map((al) => (
                  <div key={al.id} className="flex items-start gap-1.5">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5" style={{ color: "var(--danger)" }} aria-hidden="true" />
                    <span>
                      <strong>
                        {al.effect && al.effect !== "UNKNOWN_EFFECT" && al.effect !== "OTHER_EFFECT"
                          ? `${al.effect.replace(/_/g, " ")}: `
                          : "Service alert: "}
                      </strong>
                      {al.headerText}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Direction flip & route-picker controls */}
            {!activeTrip && (
              <div className="flex flex-wrap items-center gap-2">
                {onBoardRouteData && onBoardRouteData.directions.length > 1 && (
                  <button
                    type="button"
                    className="sh-btn text-xs"
                    onClick={() => {
                      const dirs = onBoardRouteData.directions;
                      const currIdx = dirs.findIndex((d) => d.directionId === onBoardRouteData.activeDirectionId);
                      const nextDir = dirs[(currIdx + 1) % dirs.length]!;
                      setOnBoardTarget((prev) => (prev ? { ...prev, directionId: nextDir.directionId } : prev));
                    }}
                  >
                    <ArrowLeftRight size={14} aria-hidden="true" /> Flip direction
                  </button>
                )}
                <button
                  type="button"
                  className="sh-btn text-xs"
                  onClick={() => setOnBoardTarget(null)}
                >
                  Change route
                </button>
                <button
                  type="button"
                  className="sh-btn text-xs"
                  onClick={exitOnBoardAndTrip}
                >
                  Exit on board
                </button>
              </div>
            )}

            {/* Multi-vehicle selector when 1+ vehicles (especially multiple!) are on this portion of the route */}
            {onBoardRouteData && onBoardRouteData.vehiclesOnRoute.length > 0 && (
              <div className="p-2.5 space-y-2 sh-surface">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <strong className="font-bold">
                    {onBoardRouteData.vehiclesOnPortionCount > 1
                      ? `${onBoardRouteData.vehiclesOnPortionCount} vehicles on this portion — select yours:`
                      : onBoardRouteData.vehiclesOnPortionCount === 1
                        ? "Vehicle on this portion:"
                        : `Vehicles on Route ${onBoardRouteData.route.shortName}:`}
                  </strong>
                  {focusedRouteSpec.vehicleId && (
                    <button
                      type="button"
                      className="bg-transparent border-0 p-0 underline cursor-pointer text-xs"
                      style={{ color: "var(--accent)", font: "inherit" }}
                      onClick={() => handleSelectFocusedVehicle(null)}
                    >
                      GPS only
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {onBoardRouteData.vehiclesOnRoute.slice(0, 6).map((v) => {
                    const isPicked = focusedRouteSpec.vehicleId === v.vehicleId;
                    const vNoun = vehicleModeNoun(v.vehicleMode, "Bus");
                    const occ = formatOccupancy(v.occupancyStatus);
                    return (
                      <button
                        key={v.vehicleId}
                        type="button"
                        aria-pressed={isPicked}
                        onClick={() => handleSelectFocusedVehicle(isPicked ? null : v.vehicleId)}
                        className={`sh-btn text-xs ${isPicked ? "sh-btn-primary" : ""}`}
                        style={{ minHeight: 34, padding: "0 0.55rem" }}
                      >
                        <span className="tabular-nums font-bold">
                          {vNoun} #{v.fleetNumber}
                        </span>
                        <span className="tabular-nums opacity-85">
                          · {v.distanceMeters < 1000 ? `${v.distanceMeters}m` : `${(v.distanceMeters / 1000).toFixed(1)}km`}
                        </span>
                        {occ ? <span className="opacity-85">· {occ.short}</span> : null}
                        {v.headsign ? <span className="truncate max-w-[100px]">· {v.headsign}</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Next stop highlight */}
            {focusedUpcomingStops.length > 0 ? (
              <div
                className="py-2 flex items-center justify-between gap-2"
                style={{ borderTop: "var(--border-w) solid var(--line)", borderBottom: "1px solid var(--rule)" }}
              >
                <div className="min-w-0">
                  <div className="text-xs sh-muted">
                    {focusedUpcomingStops[0]!.status === "current" ? "Current stop" : "Next stop"} ·{" "}
                    {focusedUpcomingStops.length} {focusedUpcomingStops.length === 1 ? "stop" : "stops"} left
                  </div>
                  <div className="font-extrabold truncate">{focusedUpcomingStops[0]!.name}</div>
                </div>
                {focusedUpcomingStops[0]!.etaMinutes !== null && (
                  <span className="shrink-0 text-xl font-extrabold tabular-nums">
                    {focusedUpcomingStops[0]!.etaMinutes === 0 ? "Here" : `${focusedUpcomingStops[0]!.etaMinutes} min`}
                  </span>
                )}
              </div>
            ) : onBoardRouteLoading ? (
              <p className="m-0 text-sm sh-muted">Loading route stops &amp; live positions…</p>
            ) : (
              <p className="m-0 text-sm sh-muted">
                Route shape loaded. Stop sequence will appear once static schedules are synced for{" "}
                {agencyShortName(focusedRouteSpec.agencyId)}.
              </p>
            )}

            {/* Stop-by-stop timeline with vibration bell */}
            {focusedUpcomingStops.length > 0 && (
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h4 className="m-0 text-sm font-bold">Upcoming stops</h4>
                  <span className="text-xs sh-muted">Tap bell for stop alert</span>
                </div>
                <ul className="list-none m-0 p-0 mt-1">
                  {focusedUpcomingStops.slice(0, 16).map((s) => {
                    const isAlert = alertStopId === s.stopId;
                    const isCurrentOrNext = s.status === "current" || s.status === "next";
                    const isExitStop = activeTripLeg?.toStopId === s.stopId;
                    return (
                      <li
                        key={`${s.stopId}-${s.stopSequence}`}
                        className="flex items-center justify-between gap-2"
                        style={{ borderBottom: "1px solid var(--rule)", minHeight: 42 }}
                      >
                        <span className={`truncate text-sm ${isCurrentOrNext || isExitStop ? "font-bold" : ""}`}>
                          {s.name}
                          {s.wheelchairBoarding === 1 && (
                            <span className="ml-1 text-xs sh-muted" title="Wheelchair accessible stop" aria-label="Accessible">
                              ♿
                            </span>
                          )}
                          {isExitStop && (
                            <span
                              className="ml-1.5 text-xs font-extrabold"
                              style={{ color: "var(--accent)" }}
                            >
                              {activeTripLegIdx < tripTransitLegs.length - 1 ? "(Transfer)" : "(Exit)"}
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-1 shrink-0">
                          <span className="tabular-nums text-xs sh-muted">
                            {s.status === "current"
                              ? "Here"
                              : s.etaMinutes !== null
                                ? `${s.etaMinutes} min`
                                : `${Math.round(s.distanceMeters)} m`}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleStopBell(s.stopId)}
                            aria-pressed={isAlert}
                            aria-label={isAlert ? `Cancel alert for ${s.name}` : `Alert before ${s.name}`}
                            className="sh-btn sh-btn-icon sh-btn-quiet"
                            style={isAlert ? { color: "var(--accent)" } : undefined}
                          >
                            <Bell size={17} aria-hidden="true" fill={isAlert ? "currentColor" : "none"} />
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {activeTrip && (
              <div className="flex flex-wrap gap-2 pt-1">
                {activeTripLegIdx < tripTransitLegs.length - 1 && (
                  <button
                    type="button"
                    className="sh-btn sh-btn-primary flex-1 text-xs"
                    onClick={() => setActiveTripLegIdx((i) => Math.min(tripTransitLegs.length - 1, i + 1))}
                  >
                    Next leg: {agencyShortName(tripTransitLegs[activeTripLegIdx + 1]!.agencyId ?? "")}{" "}
                    {tripTransitLegs[activeTripLegIdx + 1]!.routeShortName} →
                  </button>
                )}
                <Link to="/plan" className="sh-btn text-xs">
                  Back to planner
                </Link>
                <button type="button" className="sh-btn text-xs" onClick={exitOnBoardAndTrip}>
                  Exit trip
                </button>
              </div>
            )}
          </>
        ) : (
          /* CASE 2: Choosing which route / vehicle the rider is on board (location + existing route data) */
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-2 pr-10 lg:pr-0">
              <div>
                <h2 className="m-0 text-xl font-extrabold leading-tight">On board</h2>
                <p className="m-0 text-sm sh-muted">
                  Pick the route or vehicle you are riding. The map will show only that route.
                </p>
              </div>
              <button
                type="button"
                className="sh-btn sh-btn-icon shrink-0"
                aria-label="Exit on-board mode"
                onClick={exitOnBoardAndTrip}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            {!userPos && !gpsError && (
              <p className="m-0 text-sm sh-muted">Locating your GPS position to match nearby routes…</p>
            )}

            {userPos && candidatesLoading && (
              <p className="m-0 text-sm sh-muted">Matching your location with nearby routes and vehicles…</p>
            )}

            {userPos && onBoardCandidatesData && onBoardCandidatesData.candidates.length > 0 && (
              <div className="space-y-2.5">
                <div className="text-xs font-bold sh-muted">
                  Routes near your location ({onBoardCandidatesData.candidates.length})
                </div>
                <ul className="list-none m-0 p-0 space-y-2">
                  {onBoardCandidatesData.candidates.slice(0, 10).map((cand) => (
                    <li
                      key={`${cand.agencyId}:${cand.routeId}`}
                      className="p-2.5 space-y-2 sh-surface"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <RouteBadge
                            size="lg"
                            label={cand.routeShortName}
                            color={routeColor(cand.agencyId, cand.routeShortName, cand.routeColor)}
                          />
                          <div className="min-w-0">
                            <div className="font-bold text-sm truncate">
                              {cand.routeLongName || `Route ${cand.routeShortName}`}
                            </div>
                            <div className="text-xs sh-muted truncate">
                              {agencyShortName(cand.agencyId)}
                              {cand.nearestStopName ? ` · near ${cand.nearestStopName} (${cand.nearestStopDistanceMeters}m)` : ""}
                            </div>
                          </div>
                        </div>
                        {cand.vehicles.length <= 1 && (
                          <button
                            type="button"
                            className="sh-btn sh-btn-primary text-xs shrink-0"
                            style={{ minHeight: 36, padding: "0 0.65rem" }}
                            onClick={() =>
                              setOnBoardTarget({
                                agencyId: cand.agencyId,
                                routeId: cand.routeId,
                                directionId: cand.vehicles[0]?.directionId ?? null,
                                vehicleId: cand.vehicles[0]?.vehicleId ?? null,
                              })
                            }
                          >
                            Board
                          </button>
                        )}
                      </div>

                      {cand.vehicles.length > 1 ? (
                        <div className="space-y-1.5 pt-1" style={{ borderTop: "1px solid var(--rule)" }}>
                          <div className="text-xs sh-muted">
                            {cand.vehicles.length} vehicles on this portion — select yours:
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {cand.vehicles.slice(0, 5).map((v) => (
                              <button
                                key={v.vehicleId}
                                type="button"
                                className="sh-btn text-xs"
                                style={{ minHeight: 34, padding: "0 0.55rem" }}
                                onClick={() =>
                                  setOnBoardTarget({
                                    agencyId: cand.agencyId,
                                    routeId: cand.routeId,
                                    directionId: v.directionId,
                                    vehicleId: v.vehicleId,
                                  })
                                }
                              >
                                <strong>
                                  {vehicleModeNoun(v.vehicleMode as VehicleMode, "Bus")} #{v.fleetNumber}
                                </strong>
                                <span className="tabular-nums sh-muted">· {v.distanceMeters}m</span>
                                {v.headsign ? <span className="truncate max-w-[110px]">· {v.headsign}</span> : null}
                              </button>
                            ))}
                            <button
                              type="button"
                              className="sh-btn text-xs"
                              style={{ minHeight: 34, padding: "0 0.55rem" }}
                              onClick={() =>
                                setOnBoardTarget({
                                  agencyId: cand.agencyId,
                                  routeId: cand.routeId,
                                  directionId: null,
                                  vehicleId: null,
                                })
                              }
                            >
                              Track route by GPS only
                            </button>
                          </div>
                        </div>
                      ) : cand.vehicles.length === 1 ? (
                        <div className="text-xs sh-muted">
                          {vehicleModeNoun(cand.vehicles[0]!.vehicleMode as VehicleMode, "Bus")} #{cand.vehicles[0]!.fleetNumber} ·{" "}
                          {cand.vehicles[0]!.distanceMeters}m away
                          {cand.vehicles[0]!.headsign ? ` · towards ${cand.vehicles[0]!.headsign}` : ""}
                        </div>
                      ) : (
                        <div className="text-xs sh-muted">
                          No live vehicle nearby — tracks your ride using your GPS and route stops.
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {userPos && onBoardCandidatesData && onBoardCandidatesData.candidates.length === 0 && (
              <p className="m-0 text-sm sh-muted">
                No transit routes found within 700 m of your current location. You can pick any route below.
              </p>
            )}

            {/* Manual route picker fallback (works even indoors or before GPS lock) */}
            {agencyId !== "all" && routes.routes.length > 0 && (
              <div className="pt-2 space-y-1.5" style={{ borderTop: "1px solid var(--rule)" }}>
                <label htmlFor="onboard-manual-route" className="sh-label">
                  Or pick a {agencyShortName(agencyId)} route directly
                </label>
                <select
                  id="onboard-manual-route"
                  value=""
                  onChange={(e) => {
                    if (!e.target.value) return;
                    setOnBoardTarget({
                      agencyId,
                      routeId: e.target.value,
                      directionId: null,
                      vehicleId: null,
                    });
                  }}
                  className="sh-input w-full"
                >
                  <option value="">Choose a route…</option>
                  {routes.routes.map((r) => (
                    <option key={r.routeId} value={r.routeId}>
                      {r.shortName}
                      {r.longName ? `, ${r.longName}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
      </section>
    ) : null;

  const focusedCenter: [number, number] | null = useMemo(() => {
    if (!isFocusedOnBoard) return null;
    if (userPos) return [userPos.lon, userPos.lat];
    if (onBoardRouteData?.selectedVehicle) {
      return [onBoardRouteData.selectedVehicle.lon, onBoardRouteData.selectedVehicle.lat];
    }
    if (activeTripLeg?.fromLon !== undefined && activeTripLeg.fromLat !== undefined) {
      return [activeTripLeg.fromLon, activeTripLeg.fromLat];
    }
    if (focusedStops[0]) return [focusedStops[0].lon, focusedStops[0].lat];
    return null;
  }, [isFocusedOnBoard, userPos, onBoardRouteData?.selectedVehicle, activeTripLeg, focusedStops]);

  const stopFocus: [number, number] | null =
    selectedStopId && !activeVehicle && !isFocusedOnBoard && stopData?.stop.lon !== undefined && stopData.stop.lat !== undefined
      ? [stopData.stop.lon, stopData.stop.lat]
      : null;
  const sheetOpen = !isDesktop && Boolean(onBoardMode || activeTrip || activeVehicle || selectedStopId || showFilters || drawerOpen);

  const map = (
    <TransitMap
      center={focusedCenter ?? stopFocus ?? (userPos && onBoardMode ? [userPos.lon, userPos.lat] : center)}
      zoom={focusedCenter ? 14 : stopFocus ? 15 : userPos && onBoardMode ? 14 : zoom}
      bottomInset={sheetOpen ? Math.round(window.innerHeight * 0.4) : 0}
      vehicles={mapVehicles}
      selectedVehicleId={isFocusedOnBoard ? (focusedRouteSpec?.vehicleId ?? null) : selectedId}
      onSelectVehicle={(v) => {
        if (isFocusedOnBoard) {
          handleSelectFocusedVehicle(v.vehicleId);
        } else {
          selectVehicle(v.vehicleId);
        }
      }}
      routeShape={effectiveRouteShape}
      routeShapeColor={shapeColor}
      railCorridors={mapRailCorridors}
      walkSegments={tripWalkSegments}
      tripMarkers={tripMarkers}
      stops={effectiveStops}
      selectedStopId={isFocusedOnBoard ? (alertStopId ?? null) : selectedStopId}
      onSelectStop={(s) => {
        if (isFocusedOnBoard) {
          setAlertStopId((prev) => (prev === s.stop_id ? null : s.stop_id));
        } else {
          selectStop(s);
        }
      }}
      userLocation={userPos ? { lat: userPos.lat, lon: userPos.lon } : null}
      followSelected={isFocusedOnBoard ? Boolean(focusedRouteSpec?.vehicleId && !userPos) : followSelected}
      labelMode={labelMode}
      showWeatherRadar={showWeatherRadar}
      heightClass="h-full w-full"
      rounded={false}
    />
  );

  const countChip = isFocusedOnBoard ? (
    <div className="flex flex-wrap items-center gap-2">
      <div className="sh-chip" role="status" aria-live="polite">
        <b>{onBoardRouteData?.route.shortName ?? activeTripLeg?.routeShortName ?? focusedRouteSpec?.routeId}</b>
        <span className="leading-tight">
          {activeTrip ? `Trip · Leg ${activeTripLegIdx + 1}/${tripTransitLegs.length}` : "On board · route only"}
          <span className="block text-xs sh-muted">
            {userPos ? "Live GPS tracking" : `${mapVehicles.length} on route`}
          </span>
        </span>
      </div>
      <button type="button" className="sh-btn text-xs" style={{ minHeight: 44, background: "var(--paper)" }} onClick={exitOnBoardAndTrip}>
        <X size={16} aria-hidden="true" />
        Exit
      </button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-2">
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
      <WeatherMapChip weather={weatherData} />
      <button
        type="button"
        aria-pressed={showWeatherRadar}
        onClick={() => setShowWeatherRadar(!showWeatherRadar)}
        title={showWeatherRadar ? "Hide Environment Canada precipitation radar" : "Show Environment Canada live rain & snow radar"}
        className={`sh-btn text-xs ${showWeatherRadar ? "sh-btn-primary" : ""}`}
        style={{ minHeight: 44, background: showWeatherRadar ? "var(--accent)" : "var(--paper)" }}
      >
        <CloudRain size={16} aria-hidden="true" />
        Radar
      </button>
    </div>
  );

  const radarLegend = showWeatherRadar ? (
    <div
      className="sh-panel px-2.5 py-1.5 text-xs flex items-center gap-2.5"
      role="status"
      aria-label="Live precipitation radar active"
    >
      <span className="inline-flex items-center gap-1.5 font-bold">
        <CloudRain size={14} aria-hidden="true" />
        ECCC 1 km radar
      </span>
      <span className="inline-flex items-center gap-1 sh-muted">
        <span className="inline-block w-2.5 h-2.5" style={{ background: "#2563EB" }} aria-hidden="true" /> Rain
      </span>
      <span className="inline-flex items-center gap-1 sh-muted">
        <span className="inline-block w-2.5 h-2.5" style={{ background: "#7C3AED" }} aria-hidden="true" /> Snow
      </span>
      <button
        type="button"
        onClick={() => setShowWeatherRadar(false)}
        className="bg-transparent border-0 p-0 underline cursor-pointer text-xs"
        style={{ color: "var(--accent)", font: "inherit" }}
      >
        Off
      </button>
    </div>
  ) : null;

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
            {onBoardPanel ??
              vehiclePanel ??
              stopPanel ?? (
                <section aria-labelledby="live-title" className="space-y-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 id="live-title" className="m-0 text-2xl font-extrabold leading-tight">
                      Live {noun === "Bus" ? "buses" : "vehicles"}, {agencyLabel}
                    </h2>
                  </div>
                  {modeSwitcher}
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
              aria-pressed={onBoardMode || Boolean(activeTrip)}
              onClick={toggleOnBoard}
              style={
                onBoardMode || activeTrip
                  ? { background: "var(--accent)", color: "var(--on-accent)", borderColor: "var(--accent)" }
                  : undefined
              }
            >
              {activeTrip ? "Exit trip" : onBoardMode ? "Exit on board" : "On board"}
            </button>
          </div>
        </aside>

        <div className="sh-map-shell relative flex-1 min-w-0 overflow-hidden">
          {map}
          <div className="absolute top-4 left-4 right-4 z-20 pointer-events-none">
            <div className="pointer-events-auto inline-block">{countChip}</div>
          </div>
          {radarLegend && (
            <div className="absolute bottom-4 left-4 z-20">{radarLegend}</div>
          )}
        </div>
      </div>
    );
  }

  /* ---------- Phone and tablet: map, one control block, bottom sheet ---------- */

  const sheetMode =
    onBoardMode || activeTrip
      ? "onboard"
      : activeVehicle
        ? "vehicle"
        : selectedStopId
          ? "stop"
          : showFilters
            ? "filters"
            : drawerOpen
              ? "list"
              : null;

  return (
    <div className="sh-map-shell relative w-full flex-1 min-h-[360px] overflow-hidden">
      {map}

      <div className="absolute top-2 left-2 right-2 z-20 flex flex-col gap-2 pointer-events-none">
        {isFocusedOnBoard ? (
          <div className="pointer-events-auto flex items-center justify-between gap-2">{countChip}</div>
        ) : (
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
              {onBoardMode ? "Exit" : "On board"}
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
        )}

        {(gpsError ||
          (activeAgency?.liveStatus === "missing_key" && !isFocusedOnBoard) ||
          (showWeather && !isFocusedOnBoard && (weatherData?.alerts.length ?? 0) > 0) ||
          (nothingReporting && !sheetMode && !isFocusedOnBoard)) && (
          <div className="sh-panel p-3 space-y-2 pointer-events-auto">
            {notices}
            {!sheetMode && !isFocusedOnBoard && emptyNotice}
          </div>
        )}

        {showWeather && weatherData && !sheetMode && (
          <div className="pointer-events-auto flex items-center justify-between gap-2">
            <div
              className="sh-panel px-2.5 py-1.5 text-xs flex items-center gap-2"
              aria-label={`Weather in ${weatherData.cityName}`}
            >
              <WeatherGlyph iconCode={weatherData.current.iconCode} condition={weatherData.current.condition} size={15} />
              <b className="tabular-nums">{formatTemperature(weatherData.current.tempC, units)}</b>
              <span className="truncate max-w-[140px]">{weatherData.current.condition}</span>
            </div>
            <button
              type="button"
              aria-pressed={showWeatherRadar}
              onClick={() => setShowWeatherRadar(!showWeatherRadar)}
              className={`sh-btn text-xs ${showWeatherRadar ? "sh-btn-primary" : ""}`}
              style={{ minHeight: 34, padding: "0 0.625rem", background: showWeatherRadar ? "var(--accent)" : "var(--paper)" }}
            >
              <CloudRain size={14} aria-hidden="true" />
              Radar
            </button>
          </div>
        )}
      </div>

      {radarLegend && !sheetMode && (
        <div className="absolute bottom-3 left-2 z-20">{radarLegend}</div>
      )}

      {sheetMode && (
        <BottomSheet
          label={
            sheetMode === "onboard"
              ? activeTrip
                ? "Active trip on board"
                : "On board"
              : sheetMode === "vehicle"
                ? "Vehicle details"
                : sheetMode === "stop"
                  ? "Stop departures"
                  : sheetMode === "filters"
                    ? "Filters"
                    : "Vehicle list"
          }
          initial={sheetMode === "list" ? "full" : "peek"}
          onClose={() => {
            if (sheetMode === "onboard") exitOnBoardAndTrip();
            else if (sheetMode === "vehicle") selectVehicle(null);
            else if (sheetMode === "stop") selectStop(null);
            else if (sheetMode === "filters") setShowFilters(false);
            else setDrawerOpen(false);
          }}
        >
          {sheetMode === "onboard" && onBoardPanel}
          {sheetMode === "vehicle" && vehiclePanel}
          {sheetMode === "stop" && stopPanel}
          {sheetMode === "filters" && (
            <div className="space-y-3">
              <h2 className="m-0 text-xl font-extrabold">Filters</h2>
              {modeSwitcher}
              {filtersForm}
              <div className="pt-2 space-y-1 text-sm" style={{ borderTop: "1px solid var(--rule)" }}>
                <div className="font-bold">Weather (Environment Canada)</div>
                <label className="flex items-center gap-2.5 cursor-pointer min-h-[38px]">
                  <input
                    type="checkbox"
                    checked={showWeather}
                    onChange={(e) => setShowWeather(e.target.checked)}
                    className="w-4 h-4"
                  />
                  Show conditions &amp; alerts
                </label>
                <label className="flex items-center gap-2.5 cursor-pointer min-h-[38px]">
                  <input
                    type="checkbox"
                    checked={showWeatherRadar}
                    onChange={(e) => setShowWeatherRadar(e.target.checked)}
                    className="w-4 h-4"
                  />
                  Show live rain &amp; snow radar
                </label>
              </div>
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
