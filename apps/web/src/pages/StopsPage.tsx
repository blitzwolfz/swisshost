import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { TransitMap } from "../components/TransitMap";
import { apiJson, formatClock, type AgencySummary, type StopArrivals } from "../lib/api";
import { useRouteLookup } from "../lib/routeColors";
import { DepartureRow, EmptyState, LiveLegend, RouteBadge, vehicleNounFor } from "../components/Transit";
import { usePreferences } from "../lib/preferences";
import { agencyName } from "../lib/agencies";

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
          <h1 className="sh-title">{agencyName(effectiveAgency)} stops</h1>
          <p className="sh-lede">Find a stop by name or code to see its next departures.</p>
        </div>
        <div>
          <label htmlFor="stop-search" className="sh-label">
            Stop name or code
          </label>
          <input
            id="stop-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="For example, Central Station"
            className="sh-input w-72"
          />
        </div>
      </div>

      {isLoading && <p className="text-sm sh-muted">Loading stops…</p>}
      {error && <p className="text-sm" style={{ color: "var(--status-err)" }}>{(error as Error).message}</p>}

      <div className="sh-table-wrap">
        <table className="sh-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Stop</th>
              <th className="hidden md:table-cell">Platform</th>
              <th>Accessibility</th>
              <th className="hidden md:table-cell">Coordinates</th>
            </tr>
          </thead>
          <tbody>
            {(data?.stops ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 sh-muted">
                  {data?.staticVersionId
                    ? `No stops match “${q}”. Try part of the street name or the number on the stop sign.`
                    : "The timetable for this agency has not been imported yet, so there are no stops to list. An admin can import it from the Admin page."}
                </td>
              </tr>
            ) : (
              data!.stops.map((s) => (
                <tr key={s.stop_id}>
                  <td className="sh-narrow">{s.stop_code ?? s.stop_id}</td>
                  <td className="font-bold">
                    <Link to={`/stops/${effectiveAgency}/${encodeURIComponent(s.stop_id)}`}>{s.name}</Link>
                  </td>
                  <td className="hidden md:table-cell">{s.platform_code ?? <span className="sh-muted">None</span>}</td>
                  <td>
                    {s.wheelchair_boarding === 1 ? (
                      "Accessible"
                    ) : s.wheelchair_boarding === 2 ? (
                      <span className="font-bold">Not accessible</span>
                    ) : (
                      <span className="sh-muted">Unknown</span>
                    )}
                  </td>
                  <td className="hidden md:table-cell tabular-nums sh-muted">
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
  const routes = useRouteLookup(agencyId);
  const { data: agenciesData } = useQuery({
    queryKey: ["agencies"],
    queryFn: () => apiJson<{ agencies: AgencySummary[] }>("/api/v1/agencies"),
    staleTime: 60_000,
  });
  const noun = vehicleNounFor(agenciesData?.agencies.find((a) => a.id === agencyId)?.modes);

  const { data, isLoading, error } = useQuery({
    queryKey: ["stop-arrivals", agencyId, stopId],
    queryFn: () => apiJson<StopArrivals>(`/api/v1/agencies/${agencyId}/stops/${encodeURIComponent(stopId)}/arrivals`),
    refetchInterval: 20_000,
  });

  if (isLoading) return <div className="sh-page text-sm">Loading departures…</div>;
  if (error || !data) {
    return (
      <div className="sh-page text-sm" style={{ color: "var(--status-err)" }}>
        {(error as Error)?.message ?? "This stop could not be loaded. Check the stop code and try again."}
      </div>
    );
  }

  const fav = isFavorite(agencyId, "stop", stopId);

  return (
    <div className="sh-page sh-page-narrow">
      <nav aria-label="Breadcrumb" className="sh-kicker">
        <Link to="/stops">Stops</Link>
      </nav>
      <div className="sh-page-head" style={{ marginTop: "0.25rem" }}>
        <div>
          <h1 className="sh-title">{data.stop.name}</h1>
          <p className="sh-lede tabular-nums">
            {data.stop.stop_code ? `Stop ${data.stop.stop_code}. ` : ""}Next departures, updated{" "}
            {formatClock(data.serverTime)}. Service day {data.serviceDate} ({data.timezone}).
          </p>
        </div>
        <button
          type="button"
          className="sh-btn"
          aria-pressed={fav}
          onClick={() =>
            toggleFavorite({
              agencyId,
              entityType: "stop",
              entityId: stopId,
              label: `${agencyId.toUpperCase()} ${data.stop.name}`,
            })
          }
        >
          <Star size={18} fill={fav ? "currentColor" : "none"} aria-hidden="true" />
          {fav ? "Saved" : "Save stop"}
        </button>
      </div>

      {data.alerts.length > 0 && (
        <section aria-label="Service alerts" className="sh-card pt-3 space-y-2">
          {data.alerts.map((a) => (
            <div key={a.id} className="text-sm">
              <strong>{a.header_text}</strong>
              {a.description_text && <p className="m-0 mt-1 sh-muted">{a.description_text}</p>}
            </div>
          ))}
        </section>
      )}

      <section aria-labelledby="deps-title" className="space-y-2">
        <h2 id="deps-title" className="sh-section-title">
          Departures
        </h2>
        <LiveLegend />
        {data.departures.length === 0 ? (
          <EmptyState>
            Nothing leaves this stop in the next 2 hours. Check the route timetable for later service.
          </EmptyState>
        ) : (
          <ul className="sh-deps" style={{ borderTop: "var(--border-w) solid var(--line)" }}>
            {data.departures.map((d, idx) => (
              <DepartureRow
                key={`${d.tripId}-${idx}`}
                agencyId={agencyId}
                departure={d}
                routeLabel={routes.shortName(d.routeId)}
                routeColor={routes.color(d.routeId)}
                vehicleNoun={noun}
              />
            ))}
          </ul>
        )}
      </section>

      {data.stop.lat !== undefined && data.stop.lon !== undefined && (
        <TransitMap
          center={[data.stop.lon, data.stop.lat]}
          zoom={14.5}
          vehicles={data.approachingVehicles}
          selectedVehicleId={null}
          stops={[{ stop_id: data.stop.stop_id, name: data.stop.name, lat: data.stop.lat, lon: data.stop.lon }]}
          selectedStopId={data.stop.stop_id}
          heightClass="h-[38vh] min-h-[260px]"
        />
      )}

      {data.approachingVehicles.length > 0 && (
        <section className="space-y-2">
          <h2 className="sh-section-title">Vehicles within 2.5 km</h2>
          <div className="sh-table-wrap">
            <table className="sh-table">
              <thead>
                <tr>
                  <th>Fleet</th>
                  <th>Route</th>
                  <th>Distance</th>
                  <th>Last report</th>
                </tr>
              </thead>
              <tbody>
                {data.approachingVehicles.map((v) => (
                  <tr key={v.sourceVehicleId}>
                    <td>
                      <Link className="sh-fleet" to={`/vehicles/${agencyId}/${encodeURIComponent(v.vehicleId)}`}>
                        {v.fleetNumber}
                      </Link>
                    </td>
                    <td>
                      {v.routeId ? (
                        <RouteBadge
                          label={v.routeShortName ?? routes.shortName(v.routeId)}
                          color={routes.color(v.routeId, v.routeColor)}
                        />
                      ) : (
                        <span className="sh-muted">Not on a route</span>
                      )}
                    </td>
                    <td className="tabular-nums">{(v.distanceMeters / 1000).toFixed(2)} km</td>
                    <td className={`tabular-nums ${v.freshness === "stale" ? "sh-sched" : "sh-live"}`}>
                      {v.freshness === "stale" ? `Last seen ${formatClock(v.observedAt ?? v.receivedAt)}` : `${v.ageSeconds}s ago`}
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
