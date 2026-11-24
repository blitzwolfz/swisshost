import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, Pause, Play } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { TransitMap } from "../components/TransitMap";
import { apiJson, formatSpeed, type LiveVehicle } from "../lib/api";
import { usePreferences } from "../lib/preferences";

interface HistoryPoint {
  observedAt: string;
  vehicleId?: string;
  fleetNumber?: string;
  routeId: string | null;
  tripId: string | null;
  lat: number;
  lon: number;
  bearingDeg?: number | null;
  speedMps: number | null;
  delaySec: number | null;
  gapFromPrevSec?: number | null;
}

export default function HistoryPage() {
  const { agencyId, units } = usePreferences();
  const [searchParams, setSearchParams] = useSearchParams();

  const targetAgency = searchParams.get("agency") || (agencyId === "all" ? "guelph" : agencyId);
  const routeParam = searchParams.get("route") || "";
  const vehicleParam = searchParams.get("vehicle") || "";
  const todayStr = new Date().toISOString().slice(0, 10);
  const dateParam = searchParams.get("date") || todayStr;

  const [routeInput, setRouteInput] = useState(routeParam);
  const [vehicleInput, setVehicleInput] = useState(vehicleParam);
  const [dateInput, setDateInput] = useState(dateParam);

  const [playing, setPlaying] = useState(false);
  const [speedMultiplier, setSpeedMultiplier] = useState<1 | 5 | 20 | 60>(5);
  const [playIndex, setPlayIndex] = useState(0);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const isVehicleMode = Boolean(vehicleParam);

  const { data, isLoading, error } = useQuery({
    queryKey: ["history", targetAgency, routeParam, vehicleParam, dateParam],
    queryFn: () => {
      if (isVehicleMode) {
        return apiJson<{
          agencyId: string;
          timezone: string;
          serviceDate: string;
          earliestAvailableAt: string | null;
          pointCount: number;
          points: HistoryPoint[];
          gaps?: Array<{ from: string; to: string; durationSec: number }>;
        }>(`/api/v1/agencies/${targetAgency}/vehicles/${encodeURIComponent(vehicleParam)}/history?date=${dateParam}`);
      }
      const qs = new URLSearchParams({ date: dateParam });
      if (routeParam) qs.set("route", routeParam);
      return apiJson<{
        agencyId: string;
        timezone: string;
        serviceDate: string;
        earliestAvailableAt: string | null;
        pointCount: number;
        points: HistoryPoint[];
      }>(`/api/v1/agencies/${targetAgency}/history?${qs.toString()}`);
    },
  });

  const points = data?.points ?? [];

  useEffect(() => {
    setPlayIndex(0);
    setPlaying(false);
  }, [targetAgency, routeParam, vehicleParam, dateParam]);

  useEffect(() => {
    if (!playing || points.length <= 1) return;
    const stepMs = Math.max(80, Math.round(1000 / speedMultiplier));
    const timer = setInterval(() => {
      setPlayIndex((idx) => {
        if (idx >= points.length - 1) {
          setPlaying(false);
          return idx;
        }
        return idx + 1;
      });
    }, stepMs);
    return () => clearInterval(timer);
  }, [playing, speedMultiplier, points.length]);

  const currentPoint = points[playIndex] ?? points[points.length - 1] ?? null;

  const replayTrail = useMemo<[number, number][]>(() => {
    if (points.length < 2) return [];
    return points.slice(0, Math.max(2, playIndex + 1)).map((p) => [p.lon, p.lat]);
  }, [points, playIndex]);

  const replayMarker: LiveVehicle[] = currentPoint
    ? [
        {
          agencyId: targetAgency,
          sourceVehicleId: currentPoint.vehicleId ?? vehicleParam ?? "replay",
          vehicleId: currentPoint.vehicleId ?? vehicleParam ?? "replay",
          fleetNumber: currentPoint.fleetNumber ?? vehicleParam ?? "Replay",
          label: currentPoint.fleetNumber ?? vehicleParam ?? "Replay",
          routeId: currentPoint.routeId,
          tripId: currentPoint.tripId,
          blockId: null,
          directionId: null,
          lat: currentPoint.lat,
          lon: currentPoint.lon,
          bearingDeg: currentPoint.bearingDeg ?? null,
          speedMps: currentPoint.speedMps,
          scheduleDeviationSec: currentPoint.delaySec,
          currentStatus: null,
          stopId: null,
          stopSequence: null,
          occupancyStatus: null,
          observedAt: currentPoint.observedAt,
          receivedAt: currentPoint.observedAt,
          timestampBasis: "vehicle",
          ageSeconds: 0,
          freshness: "fresh",
          qualityFlags: [],
          matchMethod: "replay",
          matchConfidence: 1,
        },
      ]
    : [];

  const chartData = useMemo(
    () =>
      points.slice(0, 300).map((p) => ({
        time: new Date(p.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        speed: p.speedMps !== null ? Number((p.speedMps * (units === "imperial" ? 2.23694 : 3.6)).toFixed(1)) : null,
      })),
    [points, units]
  );

  const applyFilters = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    next.set("agency", targetAgency);
    next.set("date", dateInput);
    if (routeInput.trim()) next.set("route", routeInput.trim());
    if (vehicleInput.trim()) next.set("vehicle", vehicleInput.trim());
    setSearchParams(next);
  };

  const triggerExport = async (format: "csv" | "geojson") => {
    setExportStatus("Preparing export…");
    try {
      const res = await apiJson<{ downloadUrl: string; rowCount: number }>("/api/v1/exports", {
        method: "POST",
        body: JSON.stringify({
          agencyId: targetAgency,
          entityType: "observations",
          routeId: routeParam || undefined,
          vehicleId: vehicleParam || undefined,
          from: `${dateParam}T00:00:00.000Z`,
          to: `${dateParam}T23:59:59.999Z`,
          format,
        }),
      });
      setExportStatus(`Exported ${res.rowCount} observations.`);
      window.location.href = res.downloadUrl;
    } catch (err) {
      setExportStatus(`Export error: ${(err as Error).message}`);
    }
  };

  return (
    <div className="max-w-6xl mx-auto w-full px-3 sm:px-6 py-6 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--primary)" }}>
            {targetAgency.toUpperCase()} Archive &amp; Replay
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight m-0 mt-0.5">Historical Tracking</h1>
          <p className="text-xs m-0 mt-1 tabular-nums" style={{ color: "var(--text-muted)" }}>
            {data?.timezone ?? "America/Toronto"} · Earliest recorded observation:{" "}
            {data?.earliestAvailableAt ? new Date(data.earliestAvailableAt).toLocaleString() : "Collection active"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="sh-btn" onClick={() => triggerExport("csv")}>
            <Download size={14} /> CSV
          </button>
          <button type="button" className="sh-btn" onClick={() => triggerExport("geojson")}>
            <Download size={14} /> GeoJSON
          </button>
        </div>
      </div>

      {exportStatus && (
        <div className="sh-card px-3.5 py-2 text-xs font-medium">{exportStatus}</div>
      )}

      <form onSubmit={applyFilters} className="sh-card p-3.5 flex flex-wrap items-end gap-3 text-sm">
        <div>
          <label className="block text-xs font-semibold mb-1" style={{ color: "var(--text-muted)" }}>Service Date</label>
          <input type="date" value={dateInput} onChange={(e) => setDateInput(e.target.value)} className="sh-input" />
        </div>
        <div>
          <label className="block text-xs font-semibold mb-1" style={{ color: "var(--text-muted)" }}>Vehicle / Fleet #</label>
          <input
            type="text"
            value={vehicleInput}
            onChange={(e) => setVehicleInput(e.target.value)}
            placeholder="e.g. 4401"
            className="sh-input w-40"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold mb-1" style={{ color: "var(--text-muted)" }}>Route ID</label>
          <input
            type="text"
            value={routeInput}
            onChange={(e) => setRouteInput(e.target.value)}
            placeholder="e.g. 504"
            className="sh-input w-36"
          />
        </div>
        <button type="submit" className="sh-btn sh-btn-primary">
          Load Observations
        </button>
      </form>

      {isLoading && <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading observations…</p>}
      {error && <p className="text-sm" style={{ color: "var(--status-err)" }}>{(error as Error).message}</p>}

      {points.length > 0 ? (
        <div className="space-y-4">
          <div className="relative">
            <TransitMap
              center={currentPoint ? [currentPoint.lon, currentPoint.lat] : [-79.3832, 43.6532]}
              zoom={13}
              vehicles={replayMarker}
              selectedVehicleId={replayMarker[0]?.vehicleId ?? null}
              replayTrail={replayTrail}
              heightClass="h-[50vh] min-h-[340px]"
            />

            {/* Floating Media Scrubber Bar */}
            <div className="sh-glass mt-3 rounded-xl p-3.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="sh-btn sh-btn-primary"
                    onClick={() => setPlaying((p) => !p)}
                  >
                    {playing ? <Pause size={14} /> : <Play size={14} />}
                    {playing ? "Pause" : "Play"}
                  </button>
                  {([1, 5, 20, 60] as const).map((spd) => (
                    <button
                      key={spd}
                      type="button"
                      className={`sh-btn px-2.5 text-xs ${speedMultiplier === spd ? "sh-highlight font-bold" : ""}`}
                      onClick={() => setSpeedMultiplier(spd)}
                    >
                      {spd}x
                    </button>
                  ))}
                </div>
                <div className="text-xs font-mono tabular-nums font-semibold">
                  {currentPoint ? new Date(currentPoint.observedAt).toLocaleString() : "—"} · #{playIndex + 1}/{points.length}
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(0, points.length - 1)}
                value={playIndex}
                onChange={(e) => setPlayIndex(Number(e.target.value))}
                aria-label="Replay timeline scrubber"
                className="w-full accent-[#b91c1c]"
              />
            </div>
          </div>

          {chartData.some((d) => d.speed !== null) && (
            <section className="sh-card p-4">
              <h2 className="text-sm font-bold m-0 mb-3">
                Observed Speed ({units === "imperial" ? "mph" : "km/h"})
              </h2>
              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Area type="monotone" dataKey="speed" stroke="#B91C1C" fill="#B91C1C" fillOpacity={0.14} strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          <section className="space-y-2">
            <h2 className="text-base font-bold m-0">Recorded Observations ({points.length})</h2>
            <div className="sh-table-wrap max-h-80 overflow-y-auto">
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>Observed Time</th>
                    <th>Vehicle</th>
                    <th>Route</th>
                    <th>Coordinates</th>
                    <th>Speed</th>
                    <th>Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {points.slice(0, 200).map((p, i) => (
                    <tr key={`${p.observedAt}-${i}`} className={i === playIndex ? "sh-highlight" : ""}>
                      <td className="text-xs font-mono tabular-nums">{new Date(p.observedAt).toLocaleTimeString()}</td>
                      <td className="font-semibold tabular-nums">
                        {p.vehicleId ? (
                          <Link to={`/vehicles/${targetAgency}/${encodeURIComponent(p.vehicleId)}`}>
                            #{p.fleetNumber ?? p.vehicleId}
                          </Link>
                        ) : (
                          vehicleParam || "—"
                        )}
                      </td>
                      <td>{p.routeId ?? "—"}</td>
                      <td className="font-mono text-xs tabular-nums">
                        {p.lat.toFixed(5)}, {p.lon.toFixed(5)}
                      </td>
                      <td className="tabular-nums">{formatSpeed(p.speedMps, units)}</td>
                      <td>
                        {p.gapFromPrevSec && p.gapFromPrevSec >= 300 ? (
                          <span className="sh-pill sh-pill-warn">{Math.round(p.gapFromPrevSec / 60)}m gap</span>
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
        </div>
      ) : (
        !isLoading && (
          <div className="sh-card p-6 text-sm text-center" style={{ color: "var(--text-muted)" }}>
            No recorded observations matched <strong>{dateParam}</strong> with those filters yet. Live observations accumulate every 60 seconds and seal to <code>blitzwolfz/swisshost-data</code> every 12 hours.
          </div>
        )
      )}
    </div>
  );
}
