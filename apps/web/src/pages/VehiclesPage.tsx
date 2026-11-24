import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, History as HistoryIcon, Star } from "lucide-react";
import { TransitMap } from "../components/TransitMap";
import { apiJson, formatDelay, formatRelativeAge, formatSpeed, type LiveVehicle } from "../lib/api";
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
  const [sortBy, setSortBy] = useState<"last_seen" | "fleet" | "route">("last_seen");

  const { data, isLoading, error } = useQuery({
    queryKey: ["fleet", effectiveAgency, q],
    queryFn: () =>
      apiJson<{ agencyId: string; total: number; vehicles: FleetRow[] }>(
        `/api/v1/agencies/${effectiveAgency}/fleet?q=${encodeURIComponent(q)}&limit=150`
      ),
    staleTime: 20_000,
  });

  const sorted = [...(data?.vehicles ?? [])].sort((a, b) => {
    if (sortBy === "fleet") return a.fleet_number.localeCompare(b.fleet_number, undefined, { numeric: true });
    if (sortBy === "route") return (a.route_id ?? "zzz").localeCompare(b.route_id ?? "zzz", undefined, { numeric: true });
    return Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at);
  });

  return (
    <div className="max-w-6xl mx-auto w-full px-3 sm:px-6 py-6 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--primary)" }}>
            {effectiveAgency.toUpperCase()} Fleet Registry
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight m-0 mt-0.5">Vehicles</h1>
          <p className="text-xs m-0 mt-1 tabular-nums" style={{ color: "var(--text-muted)" }}>
            {data?.total ?? 0} observed vehicles recorded · Unknown manufacturer/model attributes remain honestly labeled unknown.
          </p>
        </div>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search fleet #, route, model…"
          aria-label="Search fleet"
          className="sh-input w-64"
        />
      </div>

      {isLoading && <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading fleet…</p>}
      {error && <p className="text-sm" style={{ color: "var(--status-err)" }}>{(error as Error).message}</p>}

      <div className="sh-table-wrap">
        <table className="sh-table">
          <thead>
            <tr>
              <th>
                <button type="button" className="bg-transparent border-0 font-semibold uppercase tracking-wider text-inherit cursor-pointer p-0" onClick={() => setSortBy("fleet")}>
                  Fleet # {sortBy === "fleet" ? "▾" : ""}
                </button>
              </th>
              <th>
                <button type="button" className="bg-transparent border-0 font-semibold uppercase tracking-wider text-inherit cursor-pointer p-0" onClick={() => setSortBy("route")}>
                  Route {sortBy === "route" ? "▾" : ""}
                </button>
              </th>
              <th>Trip</th>
              <th>Speed</th>
              <th>Deviation</th>
              <th>Equipment</th>
              <th>
                <button type="button" className="bg-transparent border-0 font-semibold uppercase tracking-wider text-inherit cursor-pointer p-0" onClick={() => setSortBy("last_seen")}>
                  Last Seen {sortBy === "last_seen" ? "▾" : ""}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center" style={{ color: "var(--text-muted)" }}>
                  No vehicles observed yet for {effectiveAgency.toUpperCase()}.
                </td>
              </tr>
            ) : (
              sorted.map((v) => {
                const d = formatDelay(v.schedule_deviation_sec);
                return (
                  <tr key={v.vehicle_id}>
                    <td className="font-bold tabular-nums">
                      <Link
                        to={`/vehicles/${effectiveAgency}/${encodeURIComponent(v.vehicle_id)}`}
                        className="inline-flex items-center gap-1"
                      >
                        #{v.fleet_number} <ArrowUpRight size={12} />
                      </Link>
                    </td>
                    <td>
                      {v.route_id ? (
                        <Link
                          to={`/routes/${effectiveAgency}/${encodeURIComponent(v.route_id)}`}
                          className="no-underline hover:no-underline"
                        >
                          <span className="sh-route-shield text-white" style={{ backgroundColor: "#B91C1C" }}>
                            {v.route_id}
                          </span>
                        </Link>
                      ) : (
                        <span className="sh-pill sh-pill-muted">Unassigned</span>
                      )}
                    </td>
                    <td className="font-mono text-xs">
                      {v.trip_id ? (
                        <Link to={`/trips/${effectiveAgency}/${encodeURIComponent(v.trip_id)}`}>{v.trip_id}</Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="tabular-nums">{formatSpeed(v.speed_mps, units)}</td>
                    <td>
                      <span className={`sh-pill sh-pill-${d.tone}`}>{d.text}</span>
                    </td>
                    <td className="text-xs" style={{ color: "var(--text-muted)" }}>
                      {v.manufacturer || v.model
                        ? `${v.year ?? ""} ${v.manufacturer ?? ""} ${v.model ?? ""}`.trim()
                        : v.vehicle_type !== "unknown"
                          ? v.vehicle_type
                          : "Unknown"}
                    </td>
                    <td className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
                      {formatRelativeAge(v.last_seen_at)}
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

  if (isLoading) return <div className="max-w-6xl mx-auto p-6 text-sm">Loading vehicle…</div>;
  if (error || !data) {
    return (
      <div className="max-w-6xl mx-auto p-6 text-sm" style={{ color: "var(--status-err)" }}>
        {(error as Error)?.message ?? "Vehicle not found"}
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
    <div className="max-w-6xl mx-auto w-full px-3 sm:px-6 py-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            <Link to="/vehicles">Vehicles</Link> / {agencyId}
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            {l?.route_id ? (
              <Link to={`/routes/${agencyId}/${encodeURIComponent(String(l.route_id))}`} className="no-underline">
                <span className="sh-route-shield text-white text-sm px-2.5 py-1" style={{ backgroundColor: "#B91C1C" }}>
                  Route {String(l.route_id)}
                </span>
              </Link>
            ) : null}
            <h1 className="text-2xl font-extrabold tracking-tight m-0 tabular-nums">Vehicle #{fleetNum}</h1>
            <span className={`sh-pill sh-pill-${delayInfo.tone}`}>{delayInfo.text}</span>
          </div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            Internal ID <code>{vehicleId}</code> · Provenance: {String(v.metadata_source ?? "observed")}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="sh-btn"
            onClick={() =>
              toggleFavorite({
                agencyId,
                entityType: "vehicle",
                entityId: vehicleId,
                label: `${agencyId.toUpperCase()} #${fleetNum}`,
              })
            }
          >
            <Star size={14} fill={fav ? "currentColor" : "none"} />
            {fav ? "Favorited" : "Favorite"}
          </button>
          <Link
            to={`/history?agency=${agencyId}&vehicle=${encodeURIComponent(vehicleId)}`}
            className="sh-btn sh-btn-primary"
          >
            <HistoryIcon size={14} /> Replay History
          </Link>
        </div>
      </div>

      {/* Text tabs */}
      <div className="flex gap-1 border-b text-sm font-semibold" style={{ borderColor: "var(--border)" }}>
        {(
          [
            ["overview", "Overview"],
            ["assignments", `Assignments (${data.recentAssignments.length})`],
            ["fleet", "Fleet Metadata"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className="px-3.5 py-2 bg-transparent border-0 border-b-2 cursor-pointer transition-colors"
            style={{
              color: tab === key ? "var(--primary)" : "var(--text-muted)",
              borderBottomColor: tab === key ? "var(--primary)" : "transparent",
            }}
          >
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
                  <th className="w-52">Current Route</th>
                  <td>
                    {l?.route_id ? (
                      <Link to={`/routes/${agencyId}/${encodeURIComponent(String(l.route_id))}`} className="font-semibold">
                        Route {String(l.route_id)}
                      </Link>
                    ) : (
                      "Unassigned"
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Current Trip / Block</th>
                  <td className="font-mono text-xs">
                    {l?.trip_id ? (
                      <Link to={`/trips/${agencyId}/${encodeURIComponent(String(l.trip_id))}`}>
                        {String(l.trip_id)}
                      </Link>
                    ) : (
                      "None"
                    )}
                    {l?.block_id ? (
                      <>
                        {" · Block "}
                        <Link to={`/blocks/${agencyId}/${encodeURIComponent(String(l.block_id))}`}>
                          {String(l.block_id)}
                        </Link>
                      </>
                    ) : null}
                  </td>
                </tr>
                <tr>
                  <th>Raw GPS / Heading / Speed</th>
                  <td className="tabular-nums">
                    {l
                      ? `${Number(l.lat).toFixed(5)}, ${Number(l.lon).toFixed(5)} · ${
                          l.bearing_deg !== null ? `${Math.round(Number(l.bearing_deg))}°` : "Unknown heading"
                        } · ${formatSpeed(l.speed_mps !== null ? Number(l.speed_mps) : null, units)}`
                      : "No recent GPS"}
                  </td>
                </tr>
                <tr>
                  <th>Last Observation</th>
                  <td className="tabular-nums text-xs">
                    {l ? (
                      <>
                        {new Date(String(l.observed_at ?? l.received_at)).toLocaleString()} (
                        {formatRelativeAge(String(l.observed_at ?? l.received_at))}) · Basis:{" "}
                        <span className="sh-pill sh-pill-muted">{String(l.timestamp_basis ?? "receipt")}</span>
                      </>
                    ) : (
                      "Unknown"
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Match Method</th>
                  <td className="text-xs">
                    {l ? `${String(l.match_method)} (${Math.round(Number(l.match_confidence ?? 0) * 100)}% confidence)` : "—"}
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
                <th>Service Date</th>
                <th>Route</th>
                <th>Trip</th>
                <th>Observed Window</th>
                <th>Samples</th>
                <th>Method</th>
              </tr>
            </thead>
            <tbody>
              {data.recentAssignments.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ color: "var(--text-muted)" }}>
                    No assignment intervals recorded yet.
                  </td>
                </tr>
              ) : (
                data.recentAssignments.map((a) => (
                  <tr key={a.id}>
                    <td className="tabular-nums">{a.service_date}</td>
                    <td>
                      {a.route_id ? (
                        <Link to={`/routes/${agencyId}/${encodeURIComponent(a.route_id)}`}>
                          <span className="sh-route-shield text-white" style={{ backgroundColor: "#B91C1C" }}>
                            {a.route_id}
                          </span>
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="font-mono text-xs">
                      {a.trip_id ? (
                        <Link to={`/trips/${agencyId}/${encodeURIComponent(a.trip_id)}`}>{a.trip_id}</Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="text-xs tabular-nums">
                      {new Date(a.started_at).toLocaleTimeString()} – {new Date(a.ended_at).toLocaleTimeString()}
                    </td>
                    <td className="tabular-nums">{a.observation_count}</td>
                    <td><span className="sh-pill sh-pill-muted">{a.method}</span></td>
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
              <tr><th className="w-52">Vehicle Type</th><td>{String(v.vehicle_type ?? "Unknown")}</td></tr>
              <tr><th>Manufacturer</th><td>{String(v.manufacturer ?? "Unknown")}</td></tr>
              <tr><th>Model</th><td>{String(v.model ?? "Unknown")}</td></tr>
              <tr><th>Model Year</th><td>{v.year ? String(v.year) : "Unknown"}</td></tr>
              <tr><th>Propulsion</th><td>{String(v.propulsion ?? "Unknown")}</td></tr>
              <tr><th>Accessibility</th><td>{String(v.accessibility ?? "Unknown")}</td></tr>
              <tr><th>Garage / Division</th><td>{String(v.garage ?? "Unknown")}</td></tr>
              <tr><th>First / Last Seen</th><td className="tabular-nums text-xs">{String(v.first_seen_at ?? "—")} / {String(v.last_seen_at ?? "—")}</td></tr>
              <tr><th>Metadata Provenance</th><td><span className="sh-pill sh-pill-muted">{String(v.metadata_source ?? "observed")}</span></td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
