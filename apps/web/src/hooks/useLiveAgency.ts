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

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryMs = 1500;

    mapRef.current = new Map();
    cursorRef.current = 0;

    const fetchSnapshot = async (mode: "connecting" | "polling" = "polling") => {
      try {
        if (agencyId === "all") {
          const agencyIds = ["guelph", "ttc", "go"];
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
          setState({
            vehicles: merged,
            feedStatus: freshAny ? "fresh" : "stale",
            lastSuccessAt: latestTs,
            connection: "polling",
            cursor: 0,
            error: null,
          });
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
        const m = new Map<string, LiveVehicle>();
        for (const v of data.vehicles) m.set(v.sourceVehicleId, v);
        mapRef.current = m;
        cursorRef.current = data.cursor;
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
        setState((prev) => ({
          ...prev,
          connection: "error",
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
            const m = new Map<string, LiveVehicle>();
            for (const v of list) m.set(v.sourceVehicleId, v);
            mapRef.current = m;
            cursorRef.current = Number(msg.cursor || 0);
            setState({
              vehicles: list,
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
            for (const v of upserts) mapRef.current.set(v.sourceVehicleId, v);
            cursorRef.current = Number(msg.cursor || cursorRef.current);
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
            setState((prev) => ({
              ...prev,
              feedStatus: String(msg.feedStatus || prev.feedStatus),
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

    // Periodic polling fallback (30s) when WS is unavailable or in multi-agency overlay mode
    pollTimer = setInterval(() => {
      if (agencyId === "all" || !ws || ws.readyState !== WebSocket.OPEN) {
        void fetchSnapshot("polling");
      } else {
        try {
          ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        } catch {
          // ignore
        }
      }
    }, 30_000);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollTimer) clearInterval(pollTimer);
      ws?.close();
    };
  }, [agencyId, routeFilter]);

  return state;
}
