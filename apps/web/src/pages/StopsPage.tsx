import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Accessibility, Clock, MapPin, Star } from "lucide-react";
import { TransitMap } from "../components/TransitMap";
import { apiJson, formatRelativeAge, type LiveVehicle } from "../lib/api";
import { usePreferences } from "../lib/preferences";

interface StopListRow {
  stop_id: string;
  stop_code: string | null;
  name: string;
  lat: number;
  lon: number;
  platform_code: string | null;
  wheelchair_boarding: number;
}

export function StopsPage() {
  const { agencyId } = usePreferences();
  const effectiveAgency = agencyId === "all" ? "guelph" : agencyId;
  const [q, setQ] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["stops", effectiveAgency, q],
    queryFn: () =>
      apiJson<{ agencyId: string; staticVersionId: string | null; stops: StopListRow[] }>(
        `/api/v1/agencies/${effectiveAgency}/stops?q=${encodeURIComponent(q)}&limit=120`
      ),
    staleTime: 60_000,
  });

  return (
    <div className="sh-page">
      <div className="sh-page-head">
        <div>
          <div className="sh-kicker">
            {effectiveAgency.toUpperCase()} Stations &amp; Stops
          </div>
          <h1 className="sh-title">Stops</h1>
          <p className="text-xs m-0 mt-1" style={{ color: "var(--text-muted)" }}>
            Look up any stop by name or stop code for live departure boards, predictions, and approaching vehicles.
          </p>
        </div>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search stop name or code…"
          aria-label="Search stops"
          className="sh-input w-64"
        />
      </div>

      {isLoading && <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading stops…</p>}
      {error && <p className="text-sm" style={{ color: "var(--status-err)" }}>{(error as Error).message}</p>}

      <div className="sh-table-wrap">
        <table className="sh-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Stop Name</th>
              <th>Platform</th>
              <th>Accessibility</th>
              <th>Coordinates</th>
            </tr>
          </thead>
          <tbody>
            {(data?.stops ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center" style={{ color: "var(--text-muted)" }}>
                  {data?.staticVersionId
                    ? "No stops match your search."
                    : "Static GTFS schedule has not been imported for this agency yet. Open /admin and click Import on the agency's static feed."}
                </td>
              </tr>
            ) : (
              data!.stops.map((s) => (
                <tr key={s.stop_id}>
                  <td className="font-mono text-xs font-semibold">{s.stop_code ?? s.stop_id}</td>
                  <td className="font-semibold">
                    <Link to={`/stops/${effectiveAgency}/${encodeURIComponent(s.stop_id)}`} className="inline-flex items-center gap-1.5">
                      <MapPin size={13} style={{ color: "var(--primary)" }} />
                      {s.name}
                    </Link>
                  </td>
                  <td>{s.platform_code ?? "—"}</td>
                  <td className="text-xs">
                    {s.wheelchair_boarding === 1 ? (
                      <span className="sh-pill sh-pill-ok">
                        <Accessibility size={11} /> Accessible
                      </span>
                    ) : s.wheelchair_boarding === 2 ? (
                      <span className="sh-pill sh-pill-warn">Not accessible</span>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>Unknown</span>
                    )}
                  </td>
                  <td className="font-mono text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
                    {s.lat.toFixed(4)}, {s.lon.toFixed(4)}
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

export function StopDetailPage() {
  const { agencyId = "guelph", stopId = "" } = useParams();
  const { isFavorite, toggleFavorite } = usePreferences();

  const { data, isLoading, error } = useQuery({
    queryKey: ["stop-arrivals", agencyId, stopId],
    queryFn: () =>
      apiJson<{
        agencyId: string;
        timezone: string;
        serviceDate: string;
        serverTime: string;
        stop: { stop_id: string; stop_code?: string; name: string; lat?: number; lon?: number; platform_code?: string };
        departures: Array<{
          tripId: string;
          routeId: string;
          headsign: string | null;
          vehicleId: string | null;
          fleetNumber: string | null;
          scheduleRelationship: string;
          scheduledTime: string;
          predictedTime: string;
          etaSeconds: number;
          uncertaintySec: number;
          predictionSource: string;
          confidence: number;
          basis: string;
          distanceMeters: number | null;
        }>;
        approachingVehicles: Array<LiveVehicle & { distanceMeters: number }>;
        alerts: Array<{ id: string; header_text: string; description_text: string }>;
      }>(`/api/v1/agencies/${agencyId}/stops/${encodeURIComponent(stopId)}/arrivals`),
    refetchInterval: 20_000,
  });

  if (isLoading) return <div className="sh-page text-sm">Loading departures…</div>;
  if (error || !data) {
    return (
      <div className="sh-page text-sm" style={{ color: "var(--status-err)" }}>
        {(error as Error)?.message ?? "Failed to load stop"}
      </div>
    );
  }

  const fav = isFavorite(agencyId, "stop", stopId);

  return (
    <div className="sh-page">
      <div className="sh-page-head">
        <div className="space-y-1">
          <div className="sh-kicker">
            <Link to="/stops">Stops</Link> / {agencyId}
          </div>
          <h1 className="sh-title flex flex-wrap items-center gap-2">
            {data.stop.name}
            {data.stop.stop_code && (
              <span className="sh-pill sh-pill-muted font-mono">#{data.stop.stop_code}</span>
            )}
          </h1>
          <div className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
            Service date {data.serviceDate} ({data.timezone}) · Updated {formatRelativeAge(data.serverTime)}
          </div>
        </div>
        <button
          type="button"
          className="sh-btn"
          onClick={() =>
            toggleFavorite({
              agencyId,
              entityType: "stop",
              entityId: stopId,
              label: `${agencyId.toUpperCase()} ${data.stop.name}`,
            })
          }
        >
          <Star size={14} fill={fav ? "currentColor" : "none"} />
          {fav ? "Favorited" : "Favorite"}
        </button>
      </div>

      {/* Swiss Station-Style Live Departure Board (Departures First — PRD §3.1) */}
      <section className="space-y-2.5">
        <h2 className="sh-section-title flex items-center gap-2">
          <Clock size={16} style={{ color: "var(--primary)" }} /> Live Departures
        </h2>
        <div className="sh-card overflow-hidden divide-y" style={{ borderColor: "var(--border)" }}>
          {data.departures.length === 0 ? (
            <div className="p-6 text-sm text-center" style={{ color: "var(--text-muted)" }}>
              No upcoming scheduled or predicted departures within the next 2 hours.
            </div>
          ) : (
            data.departures.map((d, idx) => {
              const mins = Math.round(d.etaSeconds / 60);
              const isLive = d.predictionSource !== "scheduled";
              return (
                <div
                  key={`${d.tripId}-${idx}`}
                  className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 hover:bg-[var(--surface)] transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Link to={`/routes/${agencyId}/${encodeURIComponent(d.routeId)}`} className="no-underline">
                      <span className="sh-route-shield text-white" style={{ backgroundColor: "#E2001A" }}>
                        {d.routeId}
                      </span>
                    </Link>
                    <div className="min-w-0">
                      <div className="font-bold text-sm truncate">
                        {d.headsign || `Route ${d.routeId}`}
                        {d.scheduleRelationship !== "SCHEDULED" && (
                          <span className="sh-pill sh-pill-err ml-2">{d.scheduleRelationship}</span>
                        )}
                      </div>
                      <div className="text-xs flex flex-wrap items-center gap-2 mt-0.5" style={{ color: "var(--text-muted)" }}>
                        <span className="font-mono">Sched {d.scheduledTime}</span>
                        <span>·</span>
                        <span className={isLive ? "sh-pill sh-pill-ok" : "sh-pill sh-pill-muted"}>
                          {d.predictionSource.replace(/_/g, " ")}
                        </span>
                        {d.vehicleId && (
                          <Link
                            to={`/vehicles/${agencyId}/${encodeURIComponent(d.vehicleId)}`}
                            className="font-semibold"
                          >
                            Vehicle #{d.fleetNumber ?? d.vehicleId}
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="text-xl font-extrabold tabular-nums leading-none" style={{ color: isLive ? "var(--primary)" : "var(--text)" }}>
                      {mins <= 0 ? "Due" : `${mins} min`}
                    </div>
                    <div className="text-[11px] tabular-nums mt-0.5" style={{ color: "var(--text-muted)" }}>
                      ±{Math.round((d.uncertaintySec / 60) * 10) / 10}m · {Math.round(d.confidence * 100)}%
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {data.stop.lat !== undefined && data.stop.lon !== undefined && (
        <TransitMap
          center={[data.stop.lon, data.stop.lat]}
          zoom={14.5}
          vehicles={data.approachingVehicles}
          selectedVehicleId={null}
          stops={[{ stop_id: data.stop.stop_id, name: data.stop.name, lat: data.stop.lat, lon: data.stop.lon }]}
          heightClass="h-[38vh] min-h-[260px]"
        />
      )}

      {data.approachingVehicles.length > 0 && (
        <section className="space-y-2.5">
          <h2 className="sh-section-title">Approaching Vehicles (within 2.5 km)</h2>
          <div className="sh-table-wrap">
            <table className="sh-table">
              <thead>
                <tr>
                  <th>Fleet #</th>
                  <th>Route</th>
                  <th>Distance</th>
                  <th>GPS Age</th>
                </tr>
              </thead>
              <tbody>
                {data.approachingVehicles.map((v) => (
                  <tr key={v.sourceVehicleId}>
                    <td className="font-bold tabular-nums">
                      <Link to={`/vehicles/${agencyId}/${encodeURIComponent(v.vehicleId)}`}>#{v.fleetNumber}</Link>
                    </td>
                    <td>{v.routeId ?? "Unassigned"}</td>
                    <td className="tabular-nums">{(v.distanceMeters / 1000).toFixed(2)} km</td>
                    <td className="tabular-nums text-xs">{v.ageSeconds}s</td>
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
