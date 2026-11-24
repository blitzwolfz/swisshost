import React, { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { History as HistoryIcon, Star } from "lucide-react";
import { TransitMap } from "../components/TransitMap";
import { RouteBadge } from "../components/Transit";
import { apiJson, formatDelay, formatSpeed, type LiveVehicle } from "../lib/api";
import { usePreferences } from "../lib/preferences";
import { agencyName } from "../lib/agencies";
import { routeColor } from "../lib/routeColors";

interface RouteRow {
  routeId: string;
  shortName: string;
  longName: string;
  routeType: number;
  color: string | null;
  textColor: string | null;
  activeVehicles: number;
  activeAlerts: number;
  source: string;
}

function routeTypeLabel(routeType: number): string {
  if (routeType === 1) return "Subway";
  if (routeType === 2) return "Train";
  if (routeType === 0) return "Streetcar";
  if (routeType === 4) return "Ferry";
  return "Bus";
}

export function RoutesPage() {
  const { agencyId } = usePreferences();
  const effectiveAgency = agencyId === "all" ? "guelph" : agencyId;
  const [query, setQuery] = useState("");
  const [onlyActive, setOnlyActive] = useState(false);
  const [modeFilter, setModeFilter] = useState<"all" | "rail" | "streetcar" | "bus">("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["routes", effectiveAgency],
    queryFn: () =>
      apiJson<{ agencyId: string; staticVersionId: string | null; routes: RouteRow[] }>(
        `/api/v1/agencies/${effectiveAgency}/routes`
      ),
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.routes ?? []).filter((r) => {
      if (onlyActive && r.activeVehicles === 0) return false;
      if (modeFilter === "rail" && r.routeType !== 1 && r.routeType !== 2) return false;
      if (modeFilter === "streetcar" && r.routeType !== 0) return false;
      if (modeFilter === "bus" && r.routeType !== 3) return false;
      if (!q) return true;
      return (
        r.shortName.toLowerCase().includes(q) ||
        r.longName.toLowerCase().includes(q) ||
        r.routeId.toLowerCase().includes(q)
      );
    });
  }, [data, query, onlyActive, modeFilter]);

  return (
    <div className="sh-page">
      <div className="sh-page-head">
        <div>
          <h1 className="sh-title">{agencyName(effectiveAgency)} routes</h1>
          <p className="text-xs m-0 mt-1" style={{ color: "var(--text-muted)" }}>
            {data?.staticVersionId
              ? `Active static GTFS version ${data.staticVersionId} · ${filtered.length} routes shown`
              : `${filtered.length} live-observed routes (import static GTFS in Admin for full route shapes & timetables)`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(effectiveAgency === "ttc" || effectiveAgency === "go") && (
            <div role="group" aria-label="Filter routes by mode" className="sh-seg">
              {(
                effectiveAgency === "ttc"
                  ? ([
                      ["all", "All"],
                      ["rail", "Subway"],
                      ["streetcar", "Streetcar"],
                      ["bus", "Bus"],
                    ] as const)
                  : ([
                      ["all", "All"],
                      ["rail", "Trains"],
                      ["bus", "Buses"],
                    ] as const)
              ).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={modeFilter === key} onClick={() => setModeFilter(key)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Route number or name"
            aria-label="Filter routes"
            className="sh-input w-56"
          />
          <button
            type="button"
            onClick={() => setOnlyActive((a) => !a)}
            aria-pressed={onlyActive}
            className={`sh-btn ${onlyActive ? "sh-btn-primary" : ""}`}
          >
            Running now only
          </button>
        </div>
      </div>

      {isLoading && <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading routes…</p>}
      {error && <p className="text-sm" style={{ color: "var(--status-err)" }}>{(error as Error).message}</p>}

      <div className="sh-table-wrap">
        <table className="sh-table">
          <thead>
            <tr>
              <th>Route</th>
              <th>Name</th>
              <th>Mode</th>
              <th>Live fleet</th>
              <th>Alerts</th>
              <th>Provenance</th>
              <th className="text-right">Explore</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center" style={{ color: "var(--text-muted)" }}>
                  No routes match your filter right now.
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.routeId}>
                  <td className="w-24">
                    <Link
                      to={`/routes/${effectiveAgency}/${encodeURIComponent(r.routeId)}`}
                      className="no-underline hover:no-underline"
                    >
                      <RouteBadge
                        label={r.shortName}
                        color={routeColor(effectiveAgency, r.shortName || r.routeId, r.color)}
                      />
                    </Link>
                  </td>
                  <td>
                    <Link
                      to={`/routes/${effectiveAgency}/${encodeURIComponent(r.routeId)}`}
                      className="font-semibold text-[var(--text)] hover:text-[var(--primary)]"
                    >
                      {r.longName}
                    </Link>
                  </td>
                  <td className="text-xs sh-muted whitespace-nowrap">{routeTypeLabel(r.routeType)}</td>
                  <td>
                    {r.activeVehicles > 0 ? (
                      <span className="sh-pill sh-pill-ok tabular-nums">
                        <span className="w-1.5 h-1.5 bg-current" />
                        {r.activeVehicles} active
                      </span>
                    ) : (
                      <span className="sh-pill sh-pill-muted tabular-nums">0 active</span>
                    )}
                  </td>
                  <td>
                    {r.activeAlerts > 0 ? (
                      <span className="sh-pill sh-pill-warn">
                        {r.activeAlerts} {r.activeAlerts === 1 ? "alert" : "alerts"}
                      </span>
                    ) : (
                      <span className="text-xs sh-muted">—</span>
                    )}
                  </td>
                  <td>
                    <span className="sh-pill sh-pill-muted">
                      {r.source === "scheduled" ? "Timetable" : r.source === "observed_live" ? "Live only" : r.source}
                    </span>
                  </td>
                  <td className="text-right whitespace-nowrap space-x-3 text-xs font-semibold">
                    <Link to={`/?route=${encodeURIComponent(r.routeId)}`}>Map</Link>
                    <Link to={`/history?agency=${effectiveAgency}&route=${encodeURIComponent(r.routeId)}`}>
                      History
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RouteDetailPage() {
  const { agencyId = "guelph", routeId = "" } = useParams();
  const { units, isFavorite, toggleFavorite } = usePreferences();
  const [selectedDir, setSelectedDir] = useState<string>("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["route-detail", agencyId, routeId],
    queryFn: () =>
      apiJson<{
        agencyId: string;
        route: {
          routeId: string;
          shortName: string;
          longName: string;
          color: string | null;
          directions: Array<{ directionId: number; headsign: string }>;
          shapeGeoJson: { type: "LineString"; coordinates: Array<[number, number]> } | null;
          geometrySource: string;
        };
        activeVehicles: LiveVehicle[];
        stops: Array<{ stop_id: string; stop_code: string | null; name: string; lat: number; lon: number; stop_sequence: number }>;
        trips: Array<{ trip_id: string; direction_id: number | null; headsign: string | null; block_id: string | null }>;
        alerts: Array<{ id: string; header_text: string; description_text: string; effect: string }>;
        performance: {
          liveAdherence: {
            sampleCount: number;
            onTimeRate: number | null;
            meanDelaySec: number | null;
            medianDelaySec: number | null;
          };
        };
      }>(`/api/v1/agencies/${agencyId}/routes/${encodeURIComponent(routeId)}`),
    refetchInterval: 25_000,
  });

  if (isLoading) return <div className="sh-page text-sm">Loading route…</div>;
  if (error || !data) {
    return (
      <div className="sh-page text-sm" style={{ color: "var(--status-err)" }}>
        Failed to load route: {(error as Error)?.message ?? "Not found"}
      </div>
    );
  }

  const center: [number, number] =
    data.activeVehicles[0]
      ? [data.activeVehicles[0].lon, data.activeVehicles[0].lat]
      : data.stops[0]
        ? [data.stops[0].lon, data.stops[0].lat]
        : [-79.3832, 43.6532];

  const filteredTrips =
    selectedDir === "all"
      ? data.trips
      : data.trips.filter((t) => String(t.direction_id ?? "") === selectedDir);

  const fav = isFavorite(agencyId, "route", routeId);

  return (
    <div className="sh-page">
      <div className="sh-page-head">
        <div className="space-y-1">
          <nav aria-label="Breadcrumb" className="sh-kicker">
            <Link to="/routes">Routes</Link>
          </nav>
          <div className="flex items-center gap-3">
            <RouteBadge
              size="lg"
              label={data.route.shortName}
              color={routeColor(agencyId, data.route.routeId ?? routeId, data.route.color)}
            />
            <h1 className="sh-title">{data.route.longName}</h1>
          </div>
          <div className="text-xs flex flex-wrap gap-3 pt-0.5" style={{ color: "var(--text-muted)" }}>
            <span>
              Route map:{" "}
              <strong>{data.route.geometrySource === "static_gtfs" ? "Loaded" : "Unavailable"}</strong>
            </span>
            <span>Active vehicles: <strong className="tabular-nums">{data.activeVehicles.length}</strong></span>
            {data.performance.liveAdherence.sampleCount > 0 && (
              <span>
                Live adherence:{" "}
                <strong className="tabular-nums">
                  {Math.round((data.performance.liveAdherence.onTimeRate ?? 0) * 100)}% on-time
                </strong>{" "}
                (n={data.performance.liveAdherence.sampleCount})
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="sh-btn"
            onClick={() =>
              toggleFavorite({
                agencyId,
                entityType: "route",
                entityId: routeId,
                label: `${agencyId.toUpperCase()} Route ${data.route.shortName}`,
              })
            }
          >
            <Star size={14} fill={fav ? "currentColor" : "none"} />
            {fav ? "Favorited" : "Favorite"}
          </button>
          <Link to={`/history?agency=${agencyId}&route=${encodeURIComponent(routeId)}`} className="sh-btn sh-btn-primary">
            <HistoryIcon size={18} aria-hidden="true" /> History and export
          </Link>
        </div>
      </div>

      {data.alerts.length > 0 && (
        <div className="space-y-2">
          {data.alerts.map((a) => (
            <div
              key={a.id}
              className="sh-card py-3 text-sm"
              style={{ borderBottom: "1px solid var(--rule)" }}
            >
              <div>
                <div className="font-bold">{a.header_text}</div>
                {a.description_text && <p className="m-0 mt-1 text-xs">{a.description_text}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      <TransitMap
        center={center}
        zoom={12.5}
        vehicles={data.activeVehicles}
        selectedVehicleId={null}
        routeShape={data.route.shapeGeoJson}
        routeShapeColor={routeColor(agencyId, data.route.routeId ?? routeId, data.route.color)}
        stops={data.stops}
        heightClass="h-[44vh] min-h-[320px]"
      />

      <section className="space-y-2.5">
        <h2 className="sh-section-title">Vehicles on this route ({data.activeVehicles.length})</h2>
        <div className="sh-table-wrap">
          <table className="sh-table">
            <thead>
              <tr>
                <th>Fleet</th>
                <th>Trip</th>
                <th>Speed</th>
                <th>Deviation</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {data.activeVehicles.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ color: "var(--text-muted)" }}>
                    No vehicles currently reporting on this route.
                  </td>
                </tr>
              ) : (
                data.activeVehicles.map((v) => {
                  const d = formatDelay(v.scheduleDeviationSec);
                  return (
                    <tr key={v.sourceVehicleId}>
                      <td className="font-bold tabular-nums">
                        <Link to={`/vehicles/${agencyId}/${encodeURIComponent(v.vehicleId)}`} className="inline-flex items-center gap-1">
                          {v.fleetNumber}
                        </Link>
                      </td>
                      <td className="font-mono text-xs">
                        {v.tripId ? (
                          <Link to={`/trips/${agencyId}/${encodeURIComponent(v.tripId)}`}>{v.tripId}</Link>
                        ) : (
                          "Unassigned"
                        )}
                      </td>
                      <td className="tabular-nums">{formatSpeed(v.speedMps, units)}</td>
                      <td>
                        <span className={`sh-pill sh-pill-${d.tone}`}>{d.text}</span>
                      </td>
                      <td className="tabular-nums text-xs" style={{ color: "var(--text-muted)" }}>
                        {v.ageSeconds}s
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {data.stops.length > 0 && (
        <section className="space-y-2.5">
          <h2 className="sh-section-title flex items-center gap-2">
            Stops ({data.stops.length})
          </h2>
          <div className="sh-table-wrap max-h-96 overflow-y-auto">
            <table className="sh-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Code</th>
                  <th>Stop name</th>
                </tr>
              </thead>
              <tbody>
                {data.stops.map((s) => (
                  <tr key={`${s.stop_sequence}-${s.stop_id}`}>
                    <td className="tabular-nums text-xs" style={{ color: "var(--text-muted)" }}>
                      {s.stop_sequence}
                    </td>
                    <td className="font-mono text-xs">{s.stop_code ?? s.stop_id}</td>
                    <td className="font-medium">
                      <Link to={`/stops/${agencyId}/${encodeURIComponent(s.stop_id)}`}>{s.name}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data.trips.length > 0 && (
        <section className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="sh-section-title">Scheduled trips ({filteredTrips.length})</h2>
            {data.route.directions.length > 0 && (
              <select
                value={selectedDir}
                onChange={(e) => setSelectedDir(e.target.value)}
                className="sh-input text-xs"
                aria-label="Filter direction"
              >
                <option value="all">All directions</option>
                {data.route.directions.map((d) => (
                  <option key={d.directionId} value={String(d.directionId)}>
                    Direction {d.directionId}: {d.headsign}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="sh-table-wrap max-h-80 overflow-y-auto">
            <table className="sh-table">
              <thead>
                <tr>
                  <th>Trip ID</th>
                  <th>Headsign</th>
                  <th>Block</th>
                </tr>
              </thead>
              <tbody>
                {filteredTrips.slice(0, 40).map((t) => (
                  <tr key={t.trip_id}>
                    <td className="font-mono text-xs">
                      <Link to={`/trips/${agencyId}/${encodeURIComponent(t.trip_id)}`}>{t.trip_id}</Link>
                    </td>
                    <td>{t.headsign ?? "—"}</td>
                    <td className="font-mono text-xs">
                      {t.block_id ? (
                        <Link to={`/blocks/${agencyId}/${encodeURIComponent(t.block_id)}`}>{t.block_id}</Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
