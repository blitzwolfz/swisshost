import React from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiJson } from "../lib/api";
import { agencyShortName } from "../lib/agencies";

function fmtSec(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  const norm = ((Math.round(sec) % 86400) + 86400) % 86400;
  const h = Math.floor(norm / 3600);
  const m = Math.floor((norm % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}${sec >= 86400 ? " (+1d)" : ""}`;
}

export function TripDetailPage() {
  const { agencyId = "guelph", tripId = "" } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["trip", agencyId, tripId],
    queryFn: () =>
      apiJson<{
        agencyId: string;
        serviceDate: string;
        tripId: string;
        staticVersionId: string | null;
        trip: Record<string, unknown> | null;
        stopTimes: Array<{
          stop_sequence: number;
          stop_id: string;
          stop_code: string | null;
          stop_name: string;
          arrival_sec: number | null;
          departure_sec: number | null;
        }>;
        tripUpdate: {
          schedule_relationship: string;
          delay_sec: number | null;
          stopUpdates: Array<{
            stopId?: string;
            stopSequence?: number;
            arrivalDelaySec?: number | null;
            departureDelaySec?: number | null;
            scheduleRelationship?: string;
          }>;
        } | null;
        assignments: Array<{
          id: string;
          vehicle_id: string;
          started_at: string;
          ended_at: string;
          observation_count: number;
        }>;
        liveVehicle: Record<string, unknown> | null;
        note: string | null;
      }>(`/api/v1/agencies/${agencyId}/trips/${encodeURIComponent(tripId)}`),
    refetchInterval: 20_000,
  });

  if (isLoading) return <div className="sh-page text-sm">Loading trip…</div>;
  if (error || !data) {
    return (
      <div className="sh-page text-sm" style={{ color: "var(--status-err)" }}>
        {(error as Error)?.message ?? "Trip not found"}
      </div>
    );
  }

  return (
    <div className="sh-page sh-page-narrow">
      <div>
        <h1 className="sh-title">Trip {data.tripId}</h1>
        <p className="sh-lede">
          {agencyShortName(agencyId)}, service day {data.serviceDate}
        </p>
        <div className="text-xs mt-1 space-x-3" style={{ color: "var(--text-muted)" }}>
          {data.trip?.route_id ? (
            <Link to={`/routes/${agencyId}/${encodeURIComponent(String(data.trip.route_id))}`}>
              Route {String(data.trip.route_id)}
            </Link>
          ) : null}
          {data.trip?.block_id ? (
            <Link to={`/blocks/${agencyId}/${encodeURIComponent(String(data.trip.block_id))}`}>
              Block {String(data.trip.block_id)}
            </Link>
          ) : null}
          {data.trip?.headsign ? <span>Headsign: {String(data.trip.headsign)}</span> : null}
        </div>
      </div>

      {data.note && (
        <div className="sh-surface p-3 text-xs" style={{ color: "var(--text-muted)" }}>
          {data.note}
        </div>
      )}

      {data.liveVehicle && (
        <div className="sh-surface p-3 text-sm flex flex-wrap items-center justify-between gap-2">
          <div>
            Currently assigned to{" "}
            <Link to={`/vehicles/${agencyId}/${encodeURIComponent(String(data.liveVehicle.vehicle_id))}`}>
              <strong>Vehicle <span className="sh-narrow">{String(data.liveVehicle.fleet_number)}</span></strong>
            </Link>
          </div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            Observed: {String(data.liveVehicle.observed_at ?? data.liveVehicle.received_at)}
          </div>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="sh-section-title">Stops in order</h2>
        <div className="sh-table-wrap">
          <table className="sh-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Stop</th>
                <th>Scheduled</th>
                <th>Realtime delay / status</th>
              </tr>
            </thead>
            <tbody>
              {data.stopTimes.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ color: "var(--text-muted)" }}>
                    Static stop_times not loaded for this trip.
                  </td>
                </tr>
              ) : (
                data.stopTimes.map((st) => {
                  const upd = data.tripUpdate?.stopUpdates.find(
                    (u) => u.stopId === st.stop_id || u.stopSequence === st.stop_sequence
                  );
                  const dSec = upd?.departureDelaySec ?? upd?.arrivalDelaySec ?? data.tripUpdate?.delay_sec ?? null;
                  return (
                    <tr key={st.stop_sequence}>
                      <td>{st.stop_sequence}</td>
                      <td>
                        <Link to={`/stops/${agencyId}/${encodeURIComponent(st.stop_id)}`}>{st.stop_name}</Link>
                      </td>
                      <td className="font-mono text-xs">{fmtSec(st.departure_sec ?? st.arrival_sec)}</td>
                      <td className="text-xs">
                        {upd?.scheduleRelationship === "SKIPPED"
                          ? "SKIPPED"
                          : dSec !== null
                            ? `${dSec >= 0 ? "+" : ""}${Math.round(dSec / 60)}m (${dSec}s)`
                            : "Scheduled only"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {data.assignments.length > 0 && (
        <section className="space-y-2">
          <h2 className="sh-section-title">Vehicles seen on this trip</h2>
          <div className="sh-table-wrap">
            <table className="sh-table">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Samples</th>
                </tr>
              </thead>
              <tbody>
                {data.assignments.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link to={`/vehicles/${agencyId}/${encodeURIComponent(a.vehicle_id)}`}>{a.vehicle_id}</Link>
                    </td>
                    <td className="text-xs">{new Date(a.started_at).toLocaleTimeString()}</td>
                    <td className="text-xs">{new Date(a.ended_at).toLocaleTimeString()}</td>
                    <td>{a.observation_count}</td>
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

export function BlockDetailPage() {
  const { agencyId = "guelph", blockId = "" } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["block", agencyId, blockId],
    queryFn: () =>
      apiJson<{
        agencyId: string;
        serviceDate: string;
        blockId: string;
        trips: Array<{ trip_id: string; route_id: string; headsign: string | null }>;
        assignments: Array<{ id: string; vehicle_id: string; trip_id: string | null; started_at: string; ended_at: string }>;
        note: string;
      }>(`/api/v1/agencies/${agencyId}/blocks/${encodeURIComponent(blockId)}`),
  });

  if (isLoading) return <div className="sh-page text-sm">Loading block…</div>;
  if (error || !data) return <div className="sh-page text-sm">This block could not be found for today. It may not run on this service day.</div>;

  return (
    <div className="sh-page sh-page-narrow">
      <div>
        <h1 className="sh-title">Block {data.blockId}</h1>
        <p className="sh-lede">
          {agencyShortName(agencyId)}, service day {data.serviceDate}
        </p>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{data.note}</p>
      </div>

      <section className="space-y-2">
        <h2 className="sh-section-title">Scheduled trips ({data.trips.length})</h2>
        <div className="sh-table-wrap">
          <table className="sh-table">
            <thead>
              <tr>
                <th>Trip</th>
                <th>Route</th>
                <th>Headsign</th>
              </tr>
            </thead>
            <tbody>
              {data.trips.length === 0 ? (
                <tr>
                  <td colSpan={3} style={{ color: "var(--text-muted)" }}>No trips loaded for this block.</td>
                </tr>
              ) : (
                data.trips.map((t) => (
                  <tr key={t.trip_id}>
                    <td>
                      <Link to={`/trips/${agencyId}/${encodeURIComponent(t.trip_id)}`}>{t.trip_id}</Link>
                    </td>
                    <td>
                      <Link to={`/routes/${agencyId}/${encodeURIComponent(t.route_id)}`}>{t.route_id}</Link>
                    </td>
                    <td>{t.headsign ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
