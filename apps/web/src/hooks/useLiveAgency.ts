import { useEffect, useRef, useState } from "react";
import type { LiveVehicle } from "../lib/api";
import { apiJson } from "../lib/api";

interface LiveState {
  vehicles: LiveVehicle[];
  feedStatus: string;
  lastSuccessAt: string | null;
  connection: "connecting" | "live_ws" | "polling" | "error";
  cursor: number;
  error: string | null;
}

function mergeEnrichedVehicle(prev: LiveVehicle | undefined, incoming: LiveVehicle): LiveVehicle {
  if (!prev) return incoming;
  const sameTrip = prev.tripId && prev.tripId === incoming.tripId;
  const sameRoute = prev.routeId && prev.routeId === incoming.routeId;
  const sameStop = prev.stopId && prev.stopId === incoming.stopId;
  return {
    ...incoming,
    routeShortName: incoming.routeShortName ?? (sameRoute ? prev.routeShortName : undefined),
    routeLongName: incoming.routeLongName ?? (sameRoute ? prev.routeLongName : undefined),
    routeColor: incoming.routeColor ?? (sameRoute ? prev.routeColor : undefined),
    routeType: incoming.routeType ?? (sameRoute ? prev.routeType : undefined),
    vehicleMode: incoming.vehicleMode ?? (sameRoute ? prev.vehicleMode : undefined),
    positionSource: incoming.positionSource ?? "live",
    headsign: incoming.headsign ?? (sameTrip ? prev.headsign : undefined),
    patternTripId: incoming.patternTripId ?? (sameTrip ? prev.patternTripId : undefined),
    stopName: incoming.stopName ?? (sameStop ? prev.stopName : undefined),
  };
}

/** Keep scheduled rail trains alongside live WebSocket vehicles unless live GPS is reporting on that rail route. */
function preserveScheduledRail(prevMap: Map<string, LiveVehicle>, nextMap: Map<string, LiveVehicle>) {
  const liveRoutes = new Set<string>();
  for (const v of nextMap.values()) {
    if (v.positionSource !== "scheduled" && v.freshness !== "stale") {
      if (v.routeId) liveRoutes.add(v.routeId);
      if (v.routeShortName) liveRoutes.add(v.routeShortName);
    }
  }
  for (const [id, v] of prevMap) {
    if (v.positionSource !== "scheduled") continue;
    if (v.routeId && liveRoutes.has(v.routeId)) continue;
    if (v.routeShortName && liveRoutes.has(v.routeShortName)) continue;
    if (!nextMap.has(id)) nextMap.set(id, v);
  }
}

export function useLiveAgency(agencyId: string, routeFilter?: string): LiveState {
  const [state, setState] = useState<LiveState>({
    vehicles: [],
    feedStatus: "unknown",
    lastSuccessAt: null,
    connection: "connecting",
    cursor: 0,
    error: null,
  });

  const mapRef = useRef<Map<string, LiveVehicle>>(new Map());
  const cursorRef = useRef(0);
  const lastUpdateMsRef = useRef(0);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryMs = 1500;
    let consecutiveEmptyHttp = 0;

    mapRef.current = new Map();
    cursorRef.current = 0;
    lastUpdateMsRef.current = 0;

    const fetchSnapshot = async (mode: "connecting" | "polling" | "live_ws" = "polling") => {
      try {
        if (agencyId === "all") {
          const agencyIds = ["guelph", "ttc", "go", "thunderbay"];
          const responses = await Promise.all(
            agencyIds.map((id) =>
              apiJson<{
                vehicles: LiveVehicle[];
                feedStatus: string;
                lastSuccessAt: string | null;
              }>(`/api/v1/agencies/${id}/vehicles${routeFilter ? `?route=${encodeURIComponent(routeFilter)}` : ""}`).catch(
                () => ({ vehicles: [], feedStatus: "unavailable", lastSuccessAt: null })
              )
            )
          );
          if (closed) return;
          const merged = responses.flatMap((r) => r.vehicles);
          const freshAny = responses.some((r) => r.feedStatus === "fresh");
          const latestTs = responses
            .map((r) => r.lastSuccessAt)
            .filter((x): x is string => Boolean(x))
            .sort()
            .pop() ?? null;
          if (merged.length > 0 || mapRef.current.size === 0) {
            const m = new Map<string, LiveVehicle>();
            for (const v of merged) m.set(`${v.agencyId}:${v.sourceVehicleId}`, v);
            mapRef.current = m;
            lastUpdateMsRef.current = Date.now();
            setState({
              vehicles: merged,
              feedStatus: freshAny ? "fresh" : "stale",
              lastSuccessAt: latestTs,
              connection: "polling",
              cursor: 0,
              error: null,
            });
          }
          return;
        }

        const qs = routeFilter ? `?route=${encodeURIComponent(routeFilter)}` : "";
        const data = await apiJson<{
          vehicles: LiveVehicle[];
          feedStatus: string;
          lastSuccessAt: string | null;
          cursor: number;
        }>(`/api/v1/agencies/${encodeURIComponent(agencyId)}/vehicles${qs}`);
        if (closed) return;

        // Guard against wiping live vehicles on a single transient empty response
        if (data.vehicles.length === 0 && mapRef.current.size > 0 && data.feedStatus !== "missing_key") {
          consecutiveEmptyHttp += 1;
          if (consecutiveEmptyHttp < 2) {
            return;
          }
        } else {
          consecutiveEmptyHttp = 0;
        }

        const m = new Map<string, LiveVehicle>();
        for (const v of data.vehicles) m.set(v.sourceVehicleId, v);
        mapRef.current = m;
        cursorRef.current = data.cursor;
        lastUpdateMsRef.current = Date.now();
        setState({
          vehicles: data.vehicles,
          feedStatus: data.feedStatus,
          lastSuccessAt: data.lastSuccessAt,
          connection: mode,
          cursor: data.cursor,
          error: null,
        });
      } catch (err) {
        if (closed) return;
        // Keep existing vehicles on screen during transient network glitches
        setState((prev) => ({
          ...prev,
          connection: prev.vehicles.length > 0 ? "polling" : "error",
          error: err instanceof Error ? err.message : "Failed to load vehicles",
        }));
      }
    };

    const connectWs = () => {
      if (closed || agencyId === "all") return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const params = new URLSearchParams({ agency: agencyId });
      if (routeFilter) params.set("route", routeFilter);
      const wsUrl = `${proto}//${window.location.host}/api/v1/live?${params.toString()}`;

      try {
        ws = new WebSocket(wsUrl);
      } catch {
        return;
      }

      ws.onopen = () => {
        retryMs = 1500;
        if (cursorRef.current > 0) {
          ws?.send(
            JSON.stringify({
              type: "subscribe",
              agencyId,
              routeId: routeFilter || undefined,
              cursor: cursorRef.current,
            })
          );
        }
      };

      ws.onmessage = (ev) => {
        if (closed) return;
        try {
          const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (msg.type === "snapshot") {
            const list = (msg.vehicles as LiveVehicle[]) ?? [];
            const incomingCursor = Number(msg.cursor || 0);
            // If DO woke cold/empty while we already have vehicles, trigger HTTP self-heal instead of wiping the map
            if (list.length === 0 && incomingCursor === 0 && mapRef.current.size > 0) {
              void fetchSnapshot("polling");
              return;
            }
            const prevMap = mapRef.current;
            const m = new Map<string, LiveVehicle>();
            for (const v of list) {
              const merged = mergeEnrichedVehicle(prevMap.get(v.sourceVehicleId), v);
              m.set(v.sourceVehicleId, merged);
            }
            preserveScheduledRail(prevMap, m);
            mapRef.current = m;
            cursorRef.current = incomingCursor;
            lastUpdateMsRef.current = Date.now();
            setState({
              vehicles: Array.from(m.values()),
              feedStatus: String(msg.feedStatus || "unknown"),
              lastSuccessAt: (msg.lastSuccessAt as string | null) ?? null,
              connection: "live_ws",
              cursor: cursorRef.current,
              error: null,
            });
          } else if (msg.type === "delta") {
            const upserts = (msg.upserts as LiveVehicle[]) ?? [];
            const removed = (msg.removed as string[]) ?? [];
            for (const id of removed) mapRef.current.delete(id);
            for (const v of upserts) {
              mapRef.current.set(v.sourceVehicleId, mergeEnrichedVehicle(mapRef.current.get(v.sourceVehicleId), v));
            }
            cursorRef.current = Number(msg.cursor || cursorRef.current);
            lastUpdateMsRef.current = Date.now();
            setState((prev) => ({
              ...prev,
              vehicles: Array.from(mapRef.current.values()),
              feedStatus: "fresh",
              lastSuccessAt: String(msg.serverTime || prev.lastSuccessAt || ""),
              connection: "live_ws",
              cursor: cursorRef.current,
              error: null,
            }));
          } else if (msg.type === "status") {
            const nextStatus = String(msg.feedStatus || "");
            if (nextStatus === "unknown" && mapRef.current.size === 0) {
              void fetchSnapshot("polling");
            }
            setState((prev) => ({
              ...prev,
              feedStatus: nextStatus || prev.feedStatus,
              lastSuccessAt: (msg.lastSuccessAt as string | null) ?? prev.lastSuccessAt,
            }));
          }
        } catch {
          // ignore malformed frame
        }
      };

      ws.onclose = () => {
        if (closed) return;
        setState((prev) => ({ ...prev, connection: "polling" }));
        reconnectTimer = setTimeout(() => {
          retryMs = Math.min(20_000, retryMs * 2);
          connectWs();
        }, retryMs);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    // Immediate HTTP snapshot for fast first paint + WebSocket live deltas
    void fetchSnapshot("connecting");
    if (agencyId !== "all") {
      connectWs();
    }

    // Periodic sync (30s): pings live WS and auto-triggers HTTP self-heal whenever updates stall > 65s or scheduled trains need advancing
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      const hasScheduledRail = Array.from(mapRef.current.values()).some((v) => v.positionSource === "scheduled");
      const staleSync = Date.now() - lastUpdateMsRef.current > 65_000;
      if (agencyId === "all" || !ws || ws.readyState !== WebSocket.OPEN) {
        void fetchSnapshot("polling");
      } else {
        try {
          ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        } catch {
          // ignore
        }
        if (staleSync || hasScheduledRail || mapRef.current.size === 0) {
          void fetchSnapshot("live_ws");
        }
      }
    }, 30_000);

    const onVisibility = () => {
      if (closed || document.hidden) return;
      const staleSync = Date.now() - lastUpdateMsRef.current > 20_000;
      if (agencyId === "all" || !ws || ws.readyState !== WebSocket.OPEN) {
        void fetchSnapshot("polling");
      } else {
        try {
          ws.send(
            JSON.stringify({
              type: "subscribe",
              agencyId,
              routeId: routeFilter || undefined,
              cursor: cursorRef.current,
            })
          );
        } catch {
          // ignore
        }
        if (staleSync || mapRef.current.size === 0) {
          void fetchSnapshot("live_ws");
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollTimer) clearInterval(pollTimer);
      ws?.close();
    };
  }, [agencyId, routeFilter]);

  return state;
}
