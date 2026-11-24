import React from "react";
import { Link } from "react-router-dom";
import { isLiveDeparture, type StopDeparture } from "../lib/api";
import { routeTextColor } from "../lib/routeColors";

/** Coloured route rectangle with the route number in Archivo Narrow. */
export function RouteBadge({
  label,
  color,
  size = "md",
  title,
}: {
  label: string;
  color: string;
  size?: "md" | "lg";
  title?: string;
}) {
  return (
    <span
      className={`sh-badge ${size === "lg" ? "sh-badge-lg" : ""}`}
      style={{ backgroundColor: color, color: routeTextColor(color) }}
      title={title}
    >
      {label || "–"}
    </span>
  );
}

/** Minutes until departure. A changed value ticks over; reduced motion disables it. */
export function Countdown({ etaSeconds }: { etaSeconds: number }) {
  const mins = Math.round(etaSeconds / 60);
  if (mins <= 0) {
    return (
      <span key="due" className="sh-tick">
        Due
      </span>
    );
  }
  return (
    <span>
      <span key={mins} className="sh-tick">
        {mins}
      </span>
      <small> min</small>
    </span>
  );
}

export function LiveLegend({ className = "" }: { className?: string }) {
  return (
    <p className={`sh-legend ${className}`}>
      <b>Bold times</b> are tracked live. <i>Italic times</i> come from the timetable only.
    </p>
  );
}

/** One timetable row: badge, destination, dotted leader, minutes. */
export function DepartureRow({
  agencyId,
  departure,
  routeLabel,
  routeColor,
  vehicleNoun = "Bus",
}: {
  agencyId: string;
  departure: StopDeparture;
  routeLabel: string;
  routeColor: string;
  vehicleNoun?: string;
}) {
  const live = isLiveDeparture(departure);
  const cancelled = departure.scheduleRelationship === "CANCELED" || departure.scheduleRelationship === "SKIPPED";
  const tracked = departure.vehicleId
    ? `${vehicleNoun} ${departure.fleetNumber ?? departure.vehicleId}`
    : live
      ? "Prediction from live data"
      : "Not tracked";
  const to = departure.vehicleId
    ? `/vehicles/${agencyId}/${encodeURIComponent(departure.vehicleId)}`
    : `/trips/${agencyId}/${encodeURIComponent(departure.tripId)}`;

  return (
    <li>
      <Link to={to} className={`sh-dep ${live ? "" : "sh-dep-sched"}`}>
        <RouteBadge label={routeLabel} color={routeColor} size="lg" />
        <span className="sh-dep-main">
          <span className="sh-dep-dest">{departure.headsign || `Route ${routeLabel}`}</span>
          <span className="sh-dep-sub">
            {cancelled ? (
              <span style={{ color: "var(--danger)", fontWeight: 700 }}>
                {departure.scheduleRelationship === "SKIPPED" ? "Skips this stop" : "Cancelled"}
              </span>
            ) : (
              tracked
            )}
            {departure.scheduledTime && departure.scheduledTime !== "—" ? `, timetable ${departure.scheduledTime}` : ""}
            {live && departure.uncertaintySec > 0 ? `, \u00b1${Math.max(1, Math.round(departure.uncertaintySec / 60))} min` : ""}
          </span>
        </span>
        <span className="sh-dep-leader" aria-hidden="true" />
        <span className="sh-dep-time">
          <Countdown etaSeconds={departure.etaSeconds} />
        </span>
      </Link>
    </li>
  );
}

export function EmptyState({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="sh-empty" role="status">
      <p>{children}</p>
      {actions && <div className="sh-empty-actions">{actions}</div>}
    </div>
  );
}

/** "Bus" for bus-only agencies, otherwise the neutral "Vehicle". */
export function vehicleNounFor(modes: string[] | undefined): string {
  if (!modes || modes.length === 0) return "Vehicle";
  return modes.every((m) => m === "bus") ? "Bus" : "Vehicle";
}
