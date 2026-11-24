/**
 * Ontario One Fare & PRESTO Transit Fare Estimator + Live Transfer Risk Evaluator.
 *
 * Models adult PRESTO / smart-card single-ride fares across Swisshost's 13 Ontario agencies
 * and applies Ontario's One Fare Program (free 2-hour transfers between TTC, GO Transit,
 * MiWay, Brampton Transit, YRT, and DRT) plus GO Transit Local Co-Fare discounts (free local
 * connections to/from GO for Oakville, Milton, HSR, and Guelph Transit).
 */

export interface FareLegInput {
  agencyId: string;
  routeShortName?: string | null;
  distanceMeters: number;
}

export interface FareBreakdownItem {
  agencyId: string;
  regularCad: number;
  chargedCad: number;
  note: string | null;
}

export interface TripFareEstimate {
  totalCad: number;
  regularCad: number;
  savingsCad: number;
  oneFareApplied: boolean;
  programLabel: string | null;
  summary: string;
  breakdown: FareBreakdownItem[];
}

const LOCAL_BASE_FARES_CAD: Record<string, number> = {
  ttc: 3.3,
  miway: 3.3,
  brampton: 3.4,
  yrt: 3.88,
  drt: 3.35,
  oakville: 3.4,
  milton: 3.25,
  hsr: 2.8,
  guelph: 3.25,
  grt: 3.5,
  thunderbay: 3.25,
};

/** Agencies participating in Ontario's One Fare program (free transfers with TTC & each other). */
const ONE_FARE_LOCAL = new Set(["ttc", "miway", "brampton", "yrt", "drt"]);

/** Local agencies with free GO Transit co-fare connections on PRESTO / transfer pass. */
const GO_CO_FARE_LOCAL = new Set(["ttc", "miway", "brampton", "yrt", "drt", "oakville", "milton", "hsr", "guelph"]);

function estimateGoFareCad(distanceMeters: number, routeShortName?: string | null): number {
  const code = (routeShortName ?? "").trim().toUpperCase();
  const km = Math.max(1, distanceMeters / 1000);
  if (code === "UP") {
    return km > 15 ? 9.25 : 5.3;
  }
  // Approximate PRESTO GO fare zones by corridor distance
  if (km <= 10) return 3.7;
  if (km <= 22) return 5.65;
  if (km <= 35) return 7.4;
  if (km <= 50) return 9.3;
  if (km <= 70) return 11.45;
  if (km <= 95) return 13.75;
  return 15.8;
}

function estimateOntcFareCad(distanceMeters: number): number {
  const km = Math.max(10, distanceMeters / 1000);
  return Math.round((12 + km * 0.21) * 100) / 100;
}

function baseLegFare(leg: FareLegInput): number {
  if (leg.agencyId === "go") return estimateGoFareCad(leg.distanceMeters, leg.routeShortName);
  if (leg.agencyId === "ontarionorthland") return estimateOntcFareCad(leg.distanceMeters);
  return LOCAL_BASE_FARES_CAD[leg.agencyId] ?? 3.3;
}

export function estimateOntarioTripFare(transitLegs: FareLegInput[]): TripFareEstimate {
  if (transitLegs.length === 0) {
    return {
      totalCad: 0,
      regularCad: 0,
      savingsCad: 0,
      oneFareApplied: false,
      programLabel: null,
      summary: "$0.00",
      breakdown: [],
    };
  }

  const hasGo = transitLegs.some((l) => l.agencyId === "go");
  const breakdown: FareBreakdownItem[] = [];
  const seenSameAgency = new Set<string>();
  let oneFarePaidLocal = false;
  let oneFareApplied = false;
  let goCoFareApplied = false;

  for (const leg of transitLegs) {
    const reg = baseLegFare(leg);

    // Same-agency transfer within 2 hours is free (except intercity ONTC)
    if (seenSameAgency.has(leg.agencyId) && leg.agencyId !== "ontarionorthland") {
      breakdown.push({
        agencyId: leg.agencyId,
        regularCad: 0,
        chargedCad: 0,
        note: "Free 2-hour transfer",
      });
      continue;
    }
    seenSameAgency.add(leg.agencyId);

    if (leg.agencyId === "go") {
      breakdown.push({
        agencyId: leg.agencyId,
        regularCad: reg,
        chargedCad: reg,
        note: "PRESTO distance fare (est.)",
      });
      continue;
    }

    if (hasGo && GO_CO_FARE_LOCAL.has(leg.agencyId)) {
      const isOneFare = ONE_FARE_LOCAL.has(leg.agencyId);
      if (isOneFare) oneFareApplied = true;
      else goCoFareApplied = true;
      breakdown.push({
        agencyId: leg.agencyId,
        regularCad: reg,
        chargedCad: 0,
        note: isOneFare ? "Free with GO (Ontario One Fare)" : "Free with GO co-fare",
      });
      continue;
    }

    if (ONE_FARE_LOCAL.has(leg.agencyId)) {
      if (oneFarePaidLocal) {
        oneFareApplied = true;
        breakdown.push({
          agencyId: leg.agencyId,
          regularCad: reg,
          chargedCad: 0,
          note: "Free transfer (Ontario One Fare)",
        });
      } else {
        oneFarePaidLocal = true;
        breakdown.push({
          agencyId: leg.agencyId,
          regularCad: reg,
          chargedCad: reg,
          note: "PRESTO adult fare",
        });
      }
      continue;
    }

    breakdown.push({
      agencyId: leg.agencyId,
      regularCad: reg,
      chargedCad: reg,
      note: leg.agencyId === "ontarionorthland" ? "Intercity fare (est.)" : "Standard adult fare",
    });
  }

  const totalCad = Math.round(breakdown.reduce((s, b) => s + b.chargedCad, 0) * 100) / 100;
  const regularCad = Math.round(breakdown.reduce((s, b) => s + b.regularCad, 0) * 100) / 100;
  const savingsCad = Math.max(0, Math.round((regularCad - totalCad) * 100) / 100);

  const programLabel = oneFareApplied
    ? "Ontario One Fare"
    : goCoFareApplied
      ? "GO Co-Fare"
      : null;

  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const summary =
    savingsCad > 0 && programLabel
      ? `~${fmt(totalCad)} · ${programLabel} saves ${fmt(savingsCad)}`
      : `~${fmt(totalCad)} PRESTO / adult`;

  return {
    totalCad,
    regularCad,
    savingsCad,
    oneFareApplied: oneFareApplied || goCoFareApplied,
    programLabel,
    summary,
    breakdown,
  };
}

// ---------------------------------------------------------------------------
// Live Transfer Connection Risk Indicator
// ---------------------------------------------------------------------------

export type TransferRiskLevel = "safe" | "tight" | "likely_missed" | "unknown";

export interface TransferRiskAssessment {
  fromLegIndex: number;
  toLegIndex: number;
  level: TransferRiskLevel;
  slackMinutes: number | null;
  walkMinutes: number;
  message: string;
  backupDepartureTime: string | null;
}

export function evaluateTransferRisk(input: {
  fromLegIndex: number;
  toLegIndex: number;
  leg1ArrivalTime: string | null | undefined;
  leg1DelaySec?: number | null;
  walkMinutes: number;
  leg2DepartureTime: string | null | undefined;
  leg2UpcomingDepartures?: Array<{ departureTime: string; isLive?: boolean }>;
}): TransferRiskAssessment {
  const {
    fromLegIndex,
    toLegIndex,
    leg1ArrivalTime,
    leg1DelaySec = 0,
    walkMinutes,
    leg2DepartureTime,
    leg2UpcomingDepartures = [],
  } = input;

  if (!leg1ArrivalTime || !leg2DepartureTime) {
    return {
      fromLegIndex,
      toLegIndex,
      level: "unknown",
      slackMinutes: null,
      walkMinutes,
      message: "Schedule-based transfer timing",
      backupDepartureTime: leg2UpcomingDepartures[1]?.departureTime ?? null,
    };
  }

  const arrMs = Date.parse(leg1ArrivalTime) + Math.max(0, leg1DelaySec ?? 0) * 1000;
  const depMs = Date.parse(leg2DepartureTime);
  if (!Number.isFinite(arrMs) || !Number.isFinite(depMs)) {
    return {
      fromLegIndex,
      toLegIndex,
      level: "unknown",
      slackMinutes: null,
      walkMinutes,
      message: "Transfer timing unavailable",
      backupDepartureTime: null,
    };
  }

  const readyMs = arrMs + Math.max(0, walkMinutes) * 60_000;
  const slackMinutes = Math.round((depMs - readyMs) / 60_000);
  const backup =
    leg2UpcomingDepartures.find((u) => Date.parse(u.departureTime) > depMs && Date.parse(u.departureTime) >= readyMs + 60_000)
      ?.departureTime ??
    leg2UpcomingDepartures[1]?.departureTime ??
    null;

  if (slackMinutes < 1) {
    return {
      fromLegIndex,
      toLegIndex,
      level: "likely_missed",
      slackMinutes,
      walkMinutes,
      message:
        slackMinutes <= -1
          ? `Likely missed (${Math.abs(slackMinutes)} min short after walk)`
          : "Very high risk of missing connection",
      backupDepartureTime: backup,
    };
  }

  if (slackMinutes <= 3) {
    return {
      fromLegIndex,
      toLegIndex,
      level: "tight",
      slackMinutes,
      walkMinutes,
      message: `Tight transfer · ${slackMinutes} min buffer`,
      backupDepartureTime: backup,
    };
  }

  return {
    fromLegIndex,
    toLegIndex,
    level: "safe",
    slackMinutes,
    walkMinutes,
    message: `Safe connection · ${slackMinutes} min buffer`,
    backupDepartureTime: backup,
  };
}
