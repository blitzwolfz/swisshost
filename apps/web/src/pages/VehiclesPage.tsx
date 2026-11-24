import React, { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { History as HistoryIcon, Star } from "lucide-react";
import { TransitMap } from "../components/TransitMap";
import { RouteBadge } from "../components/Transit";
import { useLiveAgency } from "../hooks/useLiveAgency";
import { agencyName, agencyShortName } from "../lib/agencies";
import { useRouteLookup } from "../lib/routeColors";
import {
  apiJson,
  formatClock,
  formatCompass,
  formatDelay,
  formatRelativeAge,
  formatSpeed,
  formatVehicleStatusLine,
  type LiveVehicle,
} from "../lib/api";
import { usePreferences } from "../lib/preferences";

interface FleetRow {
  agency_id: string;
  vehicle_id: string;
  fleet_number: string;
  vehicle_type: string;
  manufacturer: string | null;
  model: string | null;
  year: number | null;
  route_id: string | null;
  trip_id: string | null;
  speed_mps: number | null;
  schedule_deviation_sec: number | null;
  last_seen_at: string;
  metadata_source: string;
}

export function VehiclesPage() {
  const { agencyId, units } = usePreferences();
  const effectiveAgency = agencyId === "all" ? "guelph" : agencyId;
  const [q, setQ] = useState("");
  const [routeFilter, setRouteFilter] = useState("");
  const [reporting, setReporting] = useState<"all" | "live" | "off">("all");
  const [sortBy, setSortBy] = useState<"last_seen" | "fleet" | "route">("last_seen");
  const routes = useRouteLookup(effectiveAgency);
  const live = useLiveAgency(effectiveAgency);

  const { data, isLoading, error } = useQuery({
    queryKey: ["fleet", effectiveAgency, q],
    queryFn: () =>
      apiJson<{ agencyId: string; total: number; vehicles: FleetRow[] }>(
        `/api/v1/agencies/${effectiveAgency}/fleet?q=${encodeURIComponent(q)}&limit=150`
      ),
    staleTime: 20_000,
  });

  const liveById = useMemo(() => {
    const m = new Map<string, LiveVehicle>();
    for (const v of live.vehicles) m.set(v.vehicleId, v);
    return m;
  }, [live.vehicles]);

  const isLive = (row: FleetRow) => {
    const lv = liveById.get(row.vehicle_id);
    return Boolean(lv && lv.freshness !== "stale");
  };

  const rows = [...(data?.vehicles ?? [])]
    .filter((v) => !routeFilter || (liveById.get(v.vehicle_id)?.routeId ?? v.route_id) === routeFilter)
    .filter((v) => (reporting === "live" ? isLive(v) : reporting === "off" ? !isLive(v) : true))
    .sort((a, b) => {
      if (sortBy === "fleet") return a.fleet_number.localeCompare(b.fleet_number, undefined, { numeric: true });
      if (sortBy === "route")
        return (a.route_id ?? "zzz").localeCompare(b.route_id ?? "zzz", undefined, { numeric: true });
      return Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at);
    });

  const sortButton = (key: typeof sortBy, label: string) => (
    <button type="button" onClick={() => setSortBy(key)} aria-pressed={sortBy === key}>
      {label}
      {sortBy === key ? <span aria-hidden="true">{" \u2193"}</span> : null}
      {sortBy === key ? <span className="sr-only"> (sorted)</span> : null}
    </button>
  );

  return (
    <div className="sh-page">
      <div className="sh-page-head">
        <div>
          <h1 className="sh-title">{agencyName(effectiveAgency)} fleet</h1>
          <p className="sh-lede">
            {data?.total ?? 0} {data?.total === 1 ? "vehicle" : "vehicles"} seen. Make and model are shown only where they are known.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="fleet-search" className="sh-label">
            Fleet number
          </label>
          <input
            id="fleet-search"
            type="search"
            inputMode="numeric"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="For example, 3000"
            className="sh-input w-52"
          />
        </div>
        <div>
          <label htmlFor="fleet-route" className="sh-label">
            Route
          </label>
          <select
            id="fleet-route"
            value={routeFilter}
            onChange={(e) => setRouteFilter(e.target.value)}
            className="sh-input w-56"
          >
            <option value="">All routes</option>
            {routes.routes.map((r) => (
              <option key={r.routeId} value={r.routeId}>
                {r.shortName}
                {r.longName ? `, ${r.longName}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div role="group" aria-label="Reporting status" className="sh-seg">
          {(
            [
              ["all", "All"],
              ["live", "Live"],
              ["off", "Not reporting"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} type="button" aria-pressed={reporting === key} onClick={() => setReporting(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className="sh-legend" style={{ marginTop: "0.75rem" }}>
        <b>Bold</b> means the vehicle is reporting now. <i>Italic</i> means the last time it was seen.
      </p>

      {isLoading && <p className="text-sm sh-muted">Loading fleet…</p>}
      {error && <p className="text-sm" style={{ color: "var(--status-err)" }}>{(error as Error).message}</p>}

      <div className="sh-table-wrap" style={{ marginTop: "0.5rem" }}>
        <table className="sh-table">
          <thead>
            <tr>
              <th scope="col">{sortButton("fleet", "Fleet")}</th>
              <th scope="col">{sortButton("route", "Route")}</th>
              <th scope="col" className="hidden md:table-cell">Going to</th>
              <th scope="col" className="hidden md:table-cell">Next stop</th>
              <th scope="col">{sortButton("last_seen", "Status")}</th>
              <th scope="col" className="hidden lg:table-cell">Speed</th>
              <th scope="col" className="hidden lg:table-cell">Schedule</th>
              <th scope="col" className="hidden lg:table-cell">Equipment</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-6 sh-muted">
                  {(data?.vehicles.length ?? 0) === 0
                    ? q
                      ? `No ${agencyName(effectiveAgency)} vehicle matches \u201c${q}\u201d. Check the number on the front or side of the vehicle.`
                      : `No ${agencyName(effectiveAgency)} vehicles have been seen yet. They appear here once the live feed reports them.`
                    : reporting === "live"
                      ? "None of these vehicles are reporting right now. Choose All to see when each was last seen."
                      : "No vehicles match these filters. Choose All routes or All to widen the list."}
                </td>
              </tr>
            ) : (
              rows.map((v) => {
                const lv = liveById.get(v.vehicle_id);
                const reportingNow = isLive(v);
                const routeId = lv?.routeId ?? v.route_id;
                const d = formatDelay(lv?.scheduleDeviationSec ?? v.schedule_deviation_sec);
                return (
                  <tr key={v.vehicle_id}>
                    <td>
                      <Link className="sh-fleet" to={`/vehicles/${effectiveAgency}/${encodeURIComponent(v.vehicle_id)}`}>
                        {v.fleet_number}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap">
                      {routeId ? (
                        <Link
                          to={`/routes/${effectiveAgency}/${encodeURIComponent(routeId)}`}
                          className="inline-flex items-center gap-2.5"
                          style={{ color: "var(--ink)" }}
                        >
                          <RouteBadge
                            label={lv?.routeShortName ?? routes.shortName(routeId)}
                            color={routes.color(routeId, lv?.routeColor)}
                          />
                          <span className="hidden sm:inline">{lv?.routeLongName ?? routes.longName(routeId)}</span>
                        </Link>
                      ) : (
                        <span className="sh-muted">Not on a route</span>
                      )}
                    </td>
                    <td className="hidden md:table-cell">{lv?.headsign ?? <span className="sh-muted">Unknown</span>}</td>
                    <td className="hidden md:table-cell">
                      {reportingNow && lv?.stopName ? lv.stopName : <span className="sh-muted">None</span>}
                    </td>
                    <td className="whitespace-nowrap">
                      {reportingNow ? (
                        <span className="sh-live">Live</span>
                      ) : (
                        <span className="sh-sched">Last seen {formatClock(v.last_seen_at)}</span>
                      )}
                    </td>
                    <td className="hidden lg:table-cell tabular-nums whitespace-nowrap">{formatSpeed(lv?.speedMps ?? v.speed_mps, units)}</td>
                    <td className="hidden lg:table-cell whitespace-nowrap" style={d.tone === "err" ? { color: "var(--danger)", fontWeight: 700 } : undefined}>
                      {d.text}
                    </td>
                    <td className="hidden lg:table-cell sh-muted">
                      {v.manufacturer || v.model
                        ? `${v.year ?? ""} ${v.manufacturer ?? ""} ${v.model ?? ""}`.trim()
                        : v.vehicle_type !== "unknown"
                          ? v.vehicle_type
                          : "Unknown"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function VehicleDetailPage() {
  const { agencyId = "guelph", vehicleId = "" } = useParams();
  const { units, isFavorite, toggleFavorite } = usePreferences();
  const routes = useRouteLookup(agencyId);
  const [tab, setTab] = useState<"overview" | "assignments" | "fleet">("overview");

  const { data, isLoading, error } = useQuery({
    queryKey: ["vehicle-detail", agencyId, vehicleId],
    queryFn: () =>
      apiJson<{
        agencyId: string;
        vehicle: Record<string, unknown>;
        latest: Record<string, unknown> | null;
        aliases: Array<{ id: string; alias: string; valid_from: string; valid_until: string | null; source: string }>;
        recentAssignments: Array<{
          id: string;
          route_id: string | null;
          trip_id: string | null;
          block_id: string | null;
          service_date: string;
          started_at: string;
          ended_at: string;
          observation_count: number;
          confidence: number;
          method: string;
        }>;
      }>(`/api/v1/agencies/${agencyId}/vehicles/${encodeURIComponent(vehicleId)}`),
    refetchInterval: 20_000,
  });

  if (isLoading) return <div className="sh-page text-sm">Loading vehicle…</div>;
  if (error || !data) {
    return (
      <div className="sh-page text-sm" style={{ color: "var(--status-err)" }}>
        {(error as Error)?.message ?? "This vehicle could not be found. Check the fleet number and try again."}
      </div>
    );
  }

  const v = data.vehicle;
  const l = data.latest;
  const fleetNum = String(v.fleet_number ?? vehicleId);
  const fav = isFavorite(agencyId, "vehicle", vehicleId);
  const delayInfo = formatDelay(
    l?.schedule_deviation_sec !== null && l?.schedule_deviation_sec !== undefined
      ? Number(l.schedule_deviation_sec)
      : null
  );

  const liveMarker: LiveVehicle[] =
    l && l.lat && l.lon
      ? [
          {
            agencyId,
            sourceVehicleId: String(l.source_vehicle_id ?? vehicleId),
            vehicleId,
            fleetNumber: fleetNum,
            label: fleetNum,
            routeId: (l.route_id as string | null) ?? null,
            tripId: (l.trip_id as string | null) ?? null,
            blockId: (l.block_id as string | null) ?? null,
            directionId: l.direction_id !== null ? Number(l.direction_id) : null,
            lat: Number(l.lat),
            lon: Number(l.lon),
            bearingDeg: l.bearing_deg !== null ? Number(l.bearing_deg) : null,
            speedMps: l.speed_mps !== null ? Number(l.speed_mps) : null,
            scheduleDeviationSec: l.schedule_deviation_sec !== null ? Number(l.schedule_deviation_sec) : null,
            currentStatus: (l.current_status as string | null) ?? null,
            stopId: (l.stop_id as string | null) ?? null,
            stopSequence: l.stop_sequence !== null ? Number(l.stop_sequence) : null,
            occupancyStatus: (l.occupancy_status as string | null) ?? null,
            observedAt: (l.observed_at as string | null) ?? null,
            receivedAt: String(l.received_at ?? new Date().toISOString()),
            timestampBasis: (l.timestamp_basis as "vehicle" | "feed" | "receipt") ?? "receipt",
            ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(String(l.observed_at ?? l.received_at))) / 1000)),
            freshness: "fresh",
            qualityFlags: [],
            matchMethod: String(l.match_method ?? "unmatched"),
            matchConfidence: Number(l.match_confidence ?? 0),
          },
        ]
      : [];

  return (
    <div className="sh-page">
      <nav aria-label="Breadcrumb" className="sh-kicker">
        <Link to="/vehicles">Vehicles</Link>
      </nav>
      <div className="sh-page-head" style={{ marginTop: "0.25rem" }}>
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            {l?.route_id ? (
              <Link to={`/routes/${agencyId}/${encodeURIComponent(String(l.route_id))}`} aria-label={`Route ${String(l.route_short_name ?? l.route_id)}`}>
                <RouteBadge
                  size="lg"
                  label={String(l.route_short_name ?? routes.shortName(String(l.route_id)))}
                  color={routes.color(String(l.route_id))}
                />
              </Link>
            ) : null}
            <h1 className="sh-title">
              {agencyShortName(agencyId)} <span className="sh-narrow">{fleetNum}</span>
            </h1>
          </div>
          <p className="sh-lede">
            <b style={{ color: delayInfo.tone === "err" ? "var(--danger)" : "var(--ink)" }}>{delayInfo.text}</b>. Internal
            ID <code>{vehicleId}</code>. Details from {String(v.metadata_source ?? "observed")} data.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="sh-btn"
            aria-pressed={fav}
            onClick={() =>
              toggleFavorite({
                agencyId,
                entityType: "vehicle",
                entityId: vehicleId,
                label: `${agencyShortName(agencyId)} ${fleetNum}`,
              })
            }
          >
            <Star size={18} aria-hidden="true" fill={fav ? "currentColor" : "none"} />
            {fav ? "Saved" : "Save vehicle"}
          </button>
          <Link
            to={`/history?agency=${agencyId}&vehicle=${encodeURIComponent(vehicleId)}`}
            className="sh-btn sh-btn-primary"
          >
            <HistoryIcon size={18} aria-hidden="true" /> Replay history
          </Link>
        </div>
      </div>

      <div role="group" aria-label="Vehicle sections" className="sh-seg">
        {(
          [
            ["overview", "Overview"],
            ["assignments", `Assignments (${data.recentAssignments.length})`],
            ["fleet", "Fleet details"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-5">
          {liveMarker[0] && (
            <TransitMap
              center={[liveMarker[0].lon, liveMarker[0].lat]}
              zoom={14.5}
              vehicles={liveMarker}
              selectedVehicleId={vehicleId}
              heightClass="h-[40vh] min-h-[280px]"
            />
          )}

          <div className="sh-table-wrap">
            <table className="sh-table">
              <tbody>
                <tr>
                  <th scope="row" className="w-52">Route</th>
                  <td>
                    {l?.route_id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={`/routes/${agencyId}/${encodeURIComponent(String(l.route_id))}`} className="font-semibold">
                          Route {String(l.route_short_name ?? l.route_id)}
                          {l.route_long_name ? `, ${String(l.route_long_name)}` : ""}
                        </Link>
                        {l.headsign ? <span className="sh-muted">going to {String(l.headsign)}</span> : null}
                      </div>
                    ) : (
                      "Not on a route"
                    )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Stop</th>
                  <td>
                    {l?.stop_name ? (
                      <Link to={`/stops/${agencyId}/${encodeURIComponent(String(l.stop_id ?? ""))}`} className="font-semibold">
                        {formatVehicleStatusLine({
                          currentStatus: (l.current_status as string | null) ?? null,
                          stopName: String(l.stop_name),
                          stopId: (l.stop_id as string | null) ?? null,
                        })}
                      </Link>
                    ) : l?.current_status ? (
                      <span className="capitalize">{String(l.current_status).replace(/_/g, " ").toLowerCase()}</span>
                    ) : (
                      "Unknown"
                    )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Trip and block</th>
                  <td>
                    {l?.trip_id ? (
                      <Link to={`/trips/${agencyId}/${encodeURIComponent(String(l.trip_id))}`}>
                        {String(l.trip_id)}
                      </Link>
                    ) : (
                      "None"
                    )}
                    {l?.block_id ? (
                      <>
                        {", block "}
                        <Link to={`/blocks/${agencyId}/${encodeURIComponent(String(l.block_id))}`}>
                          {String(l.block_id)}
                        </Link>
                      </>
                    ) : null}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Position, heading, speed</th>
                  <td className="tabular-nums">
                    {l
                      ? `${Number(l.lat).toFixed(5)}, ${Number(l.lon).toFixed(5)}; ${
                          l.bearing_deg !== null
                            ? `${Math.round(Number(l.bearing_deg))}° ${formatCompass(Number(l.bearing_deg))}`
                            : "Unknown heading"
                        }; ${formatSpeed(l.speed_mps !== null ? Number(l.speed_mps) : null, units)}`
                      : "No recent GPS"}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Last report</th>
                  <td className="tabular-nums">
                    {l ? (
                      <>
                        {new Date(String(l.observed_at ?? l.received_at)).toLocaleString()} (
                        {formatRelativeAge(String(l.observed_at ?? l.received_at))}). Time source:{" "}
                        {String(l.timestamp_basis ?? "receipt")}
                      </>
                    ) : (
                      "Unknown"
                    )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Trip matching</th>
                  <td>
                    {l ? `${String(l.match_method)}, ${Math.round(Number(l.match_confidence ?? 0) * 100)}% confidence` : "Unknown"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "assignments" && (
        <div className="sh-table-wrap">
          <table className="sh-table">
            <thead>
              <tr>
                <th>Service day</th>
                <th>Route</th>
                <th>Trip</th>
                <th>Seen between</th>
                <th>Reports</th>
                <th>Matched by</th>
              </tr>
            </thead>
            <tbody>
              {data.recentAssignments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="sh-muted">
                    No route assignments recorded for this vehicle yet. They appear after it runs a matched trip.
                  </td>
                </tr>
              ) : (
                data.recentAssignments.map((a) => (
                  <tr key={a.id}>
                    <td className="tabular-nums">{a.service_date}</td>
                    <td>
                      {a.route_id ? (
                        <Link to={`/routes/${agencyId}/${encodeURIComponent(a.route_id)}`} aria-label={`Route ${routes.shortName(a.route_id)}`}>
                          <RouteBadge label={routes.shortName(a.route_id)} color={routes.color(a.route_id)} />
                        </Link>
                      ) : (
                        <span className="sh-muted">None</span>
                      )}
                    </td>
                    <td>
                      {a.trip_id ? (
                        <Link to={`/trips/${agencyId}/${encodeURIComponent(a.trip_id)}`}>{a.trip_id}</Link>
                      ) : (
                        <span className="sh-muted">None</span>
                      )}
                    </td>
                    <td className="tabular-nums">
                      {formatClock(a.started_at)} to {formatClock(a.ended_at)}
                    </td>
                    <td className="tabular-nums">{a.observation_count}</td>
                    <td>{a.method}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "fleet" && (
        <div className="sh-table-wrap">
          <table className="sh-table">
            <tbody>
              <tr><th scope="row" className="w-52">Vehicle type</th><td>{String(v.vehicle_type ?? "Unknown")}</td></tr>
              <tr><th scope="row">Manufacturer</th><td>{String(v.manufacturer ?? "Unknown")}</td></tr>
              <tr><th scope="row">Model</th><td>{String(v.model ?? "Unknown")}</td></tr>
              <tr><th scope="row">Model year</th><td>{v.year ? String(v.year) : "Unknown"}</td></tr>
              <tr><th scope="row">Propulsion</th><td>{String(v.propulsion ?? "Unknown")}</td></tr>
              <tr><th scope="row">Accessibility</th><td>{String(v.accessibility ?? "Unknown")}</td></tr>
              <tr><th scope="row">Garage</th><td>{String(v.garage ?? "Unknown")}</td></tr>
              <tr><th scope="row">First and last seen</th><td className="tabular-nums">{String(v.first_seen_at ?? "Unknown")} to {String(v.last_seen_at ?? "Unknown")}</td></tr>
              <tr><th scope="row">Source of these details</th><td>{String(v.metadata_source ?? "observed")}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
