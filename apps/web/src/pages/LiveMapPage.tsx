import React, { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Compass,
  Crosshair,
  Gauge,
  History as HistoryIcon,
  List,
  SlidersHorizontal,
  Star,
  X,
} from "lucide-react";
import { TransitMap } from "../components/TransitMap";
import { useLiveAgency } from "../hooks/useLiveAgency";
import {
  apiJson,
  formatDelay,
  formatRelativeAge,
  formatSpeed,
  type AgencySummary,
  type LiveVehicle,
} from "../lib/api";
import { usePreferences } from "../lib/preferences";

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

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const isLiveFresh = live.feedStatus === "fresh";
  const delayInfo = selectedVehicle ? formatDelay(selectedVehicle.scheduleDeviationSec) : null;

  return (
    <div className="relative w-full h-[calc(100dvh-55px)] min-h-[520px] overflow-hidden">
      {/* Full-bleed WebGL MapLibre Canvas */}
      <TransitMap
        center={center}
        zoom={zoom}
        vehicles={filteredVehicles}
        selectedVehicleId={selectedId}
        onSelectVehicle={(v) => setParam("vehicle", v.vehicleId)}
        routeShape={routeDetail?.route.shapeGeoJson ?? null}
        stops={routeDetail?.stops}
        followSelected={followSelected}
        heightClass="h-full w-full"
        rounded={false}
      />

      {/* Floating Top-Left HUD Bar */}
      <div className="absolute top-3 left-3 right-3 sm:right-auto z-20 flex flex-col gap-2 max-w-[calc(100vw-24px)] sm:max-w-xl pointer-events-none">
        <div className="sh-glass rounded-xl px-3 py-2 flex flex-wrap items-center gap-2 pointer-events-auto">
          <div className="flex items-center gap-2 pr-1">
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
            <span className="text-xs font-bold tabular-nums">
              {filteredVehicles.length}
            </span>
            <span className="text-xs hidden sm:inline" style={{ color: "var(--text-muted)" }}>
              {live.feedStatus === "missing_key"
                ? "Awaiting API key"
                : live.connection === "live_ws"
                  ? "live"
                  : live.feedStatus}
              {live.lastSuccessAt ? ` · ${formatRelativeAge(live.lastSuccessAt)}` : ""}
            </span>
          </div>

          {agencyId !== "all" && (
            <select
              aria-label="Filter by route"
              value={routeFilter}
              onChange={(e) => setParam("route", e.target.value || null)}
              className="sh-input text-xs py-1 max-w-[170px]"
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
            className={`sh-btn py-1 px-2.5 text-xs ${showFilters ? "sh-highlight" : ""}`}
            onClick={() => setShowFilters((s) => !s)}
            aria-expanded={showFilters}
          >
            <SlidersHorizontal size={13} /> Filters
          </button>

          <button
            type="button"
            className={`sh-btn py-1 px-2.5 text-xs ${drawerOpen ? "sh-btn-primary" : ""}`}
            onClick={() => setDrawerOpen((d) => !d)}
          >
            <List size={13} /> List
          </button>
        </div>

        {/* Missing Key Notice (GO Transit) */}
        {activeAgency?.liveStatus === "missing_key" && (
          <div
            className="sh-glass rounded-xl px-3.5 py-2.5 text-xs pointer-events-auto flex items-center justify-between gap-3"
            style={{ background: "var(--gold-surface)", color: "var(--text)" }}
          >
            <span>
              <strong>{activeAgency.name}</strong> is ready and awaiting <code>GO_TRANSIT_API_KEY</code>.
            </span>
            <Link to="/status" className="font-semibold shrink-0">
              Status →
            </Link>
          </div>
        )}

        {/* Expandable Advanced Filter Popover */}
        {showFilters && (
          <div className="sh-glass rounded-xl p-3 flex flex-wrap items-end gap-2.5 text-xs pointer-events-auto">
            <div>
              <label className="block font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                Fleet # / Route
              </label>
              <input
                type="text"
                value={fleetFilter}
                onChange={(e) => setFleetFilter(e.target.value)}
                placeholder="e.g. 4401, 504"
                className="sh-input py-1 text-xs w-36"
              />
            </div>
            <div>
              <label className="block font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                Freshness
              </label>
              <select
                value={freshnessFilter}
                onChange={(e) => setFreshnessFilter(e.target.value as "all" | "fresh" | "stale")}
                className="sh-input py-1 text-xs"
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
                className="sh-input py-1 text-xs"
              >
                <option value="all">All</option>
                <option value="assigned">Assigned</option>
                <option value="unassigned">Unassigned</option>
              </select>
            </div>
            <button
              type="button"
              className="sh-btn py-1 text-xs"
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
      {selectedVehicle && (
        <aside
          aria-label="Selected vehicle details"
          className="sh-glass absolute bottom-3 left-3 right-3 sm:right-auto sm:w-[400px] z-20 rounded-2xl p-4 space-y-3"
          style={{ boxShadow: "var(--shadow-lg)" }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span
                className="sh-route-shield text-white"
                style={{ backgroundColor: selectedVehicle.routeColor || "#B91C1C" }}
              >
                {selectedVehicle.routeShortName ?? selectedVehicle.routeId ?? "—"}
              </span>
              <div>
                <div className="font-bold text-base leading-tight tabular-nums flex items-center gap-1.5">
                  Vehicle #{selectedVehicle.fleetNumber}
                  <span className="sh-pill sh-pill-muted uppercase">{selectedVehicle.agencyId}</span>
                </div>
                <div className="text-xs mt-0.5 flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
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
                    {selectedVehicle.ageSeconds}s ago ({selectedVehicle.timestampBasis})
                  </span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setParam("vehicle", null)}
              aria-label="Close vehicle panel"
              className="sh-btn p-1.5 rounded-lg"
            >
              <X size={14} />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-lg p-2 border" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
              <div className="flex items-center gap-1 mb-0.5" style={{ color: "var(--text-muted)" }}>
                <Gauge size={11} /> Speed
              </div>
              <div className="font-bold tabular-nums">{formatSpeed(selectedVehicle.speedMps, units)}</div>
            </div>
            <div className="rounded-lg p-2 border" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
              <div className="flex items-center gap-1 mb-0.5" style={{ color: "var(--text-muted)" }}>
                <Compass size={11} /> Heading
              </div>
              <div className="font-bold tabular-nums">
                {selectedVehicle.bearingDeg !== null ? `${Math.round(selectedVehicle.bearingDeg)}°` : "Unknown"}
              </div>
            </div>
            <div className="rounded-lg p-2 border" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
              <div className="mb-0.5" style={{ color: "var(--text-muted)" }}>Status</div>
              <div className="font-bold truncate">{selectedVehicle.currentStatus?.replace(/_/g, " ") || "In transit"}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Link
              to={`/vehicles/${selectedVehicle.agencyId}/${encodeURIComponent(selectedVehicle.vehicleId)}`}
              className="sh-btn sh-btn-primary text-xs flex-1 no-underline hover:no-underline"
            >
              Vehicle Page <ArrowRight size={13} />
            </Link>
            <Link
              to={`/history?agency=${selectedVehicle.agencyId}&vehicle=${encodeURIComponent(selectedVehicle.vehicleId)}`}
              className="sh-btn text-xs no-underline hover:no-underline"
            >
              <HistoryIcon size={13} /> Replay
            </Link>
            <button
              type="button"
              className={`sh-btn text-xs ${followSelected ? "sh-highlight" : ""}`}
              onClick={() => setFollowSelected((f) => !f)}
              title="Follow vehicle"
            >
              <Crosshair size={13} />
            </button>
            <button
              type="button"
              className="sh-btn text-xs"
              title="Toggle favorite"
              onClick={() =>
                toggleFavorite({
                  agencyId: selectedVehicle.agencyId,
                  entityType: "vehicle",
                  entityId: selectedVehicle.vehicleId,
                  label: `${selectedVehicle.agencyId.toUpperCase()} #${selectedVehicle.fleetNumber}`,
                })
              }
            >
              <Star
                size={13}
                fill={isFavorite(selectedVehicle.agencyId, "vehicle", selectedVehicle.vehicleId) ? "currentColor" : "none"}
              />
            </button>
          </div>

          {selectedVehicle.tripId && (
            <div className="text-xs pt-1 border-t flex justify-between" style={{ borderColor: "var(--border)" }}>
              <span style={{ color: "var(--text-muted)" }}>Trip</span>
              <Link
                to={`/trips/${selectedVehicle.agencyId}/${encodeURIComponent(selectedVehicle.tripId)}`}
                className="font-mono font-semibold"
              >
                {selectedVehicle.tripId} →
              </Link>
            </div>
          )}
        </aside>
      )}

      {/* Slide-over Accessible Vehicle List Drawer */}
      {drawerOpen && (
        <aside
          aria-label="Live vehicles list"
          className="sh-glass absolute top-3 bottom-3 right-3 w-[360px] max-w-[calc(100vw-24px)] z-30 rounded-2xl flex flex-col overflow-hidden"
          style={{ boxShadow: "var(--shadow-lg)" }}
        >
          <div className="px-3.5 py-2.5 border-b flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
            <div className="font-bold text-sm tabular-nums">
              Active Vehicles ({filteredVehicles.length})
            </div>
            <button type="button" className="sh-btn p-1" onClick={() => setDrawerOpen(false)} aria-label="Close list">
              <X size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto divide-y" style={{ borderColor: "var(--border)" }}>
            {filteredVehicles.length === 0 ? (
              <div className="p-4 text-xs" style={{ color: "var(--text-muted)" }}>
                No active vehicles match the current filter.
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
                    className={`w-full text-left px-3.5 py-2.5 flex items-center justify-between gap-2 cursor-pointer border-0 transition-colors ${
                      isSel ? "sh-highlight" : "bg-transparent hover:bg-[var(--surface)]"
                    }`}
                    style={{ color: "var(--text)" }}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="sh-route-shield text-white shrink-0"
                        style={{ backgroundColor: v.routeColor || "#B91C1C" }}
                      >
                        {v.routeShortName ?? v.routeId ?? "—"}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-bold tabular-nums truncate">
                          #{v.fleetNumber}{" "}
                          <span className="font-normal uppercase" style={{ color: "var(--text-muted)" }}>
                            {v.agencyId}
                          </span>
                        </div>
                        <div className="text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
                          {formatSpeed(v.speedMps, units)} · {v.ageSeconds}s ago
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
          className="sh-glass hidden sm:flex items-center gap-3 absolute bottom-3 left-3 z-10 rounded-lg px-2.5 py-1 text-[11px]"
          style={{ color: "var(--text-muted)" }}
        >
          <Link to="/status" className="font-medium">Status</Link>
          <span>·</span>
          <Link to="/alerts" className="font-medium">Alerts</Link>
          <span>·</span>
          <a href="/openapi.json" target="_blank" rel="noreferrer" className="font-medium">API</a>
          <span>·</span>
          <Link to="/admin" className="font-medium">Admin</Link>
        </div>
      )}
    </div>
  );
}
