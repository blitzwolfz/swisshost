export const ANALYTICS_ALGORITHM_VERSION = "swisshost-analytics/1.0.0";

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export interface AdherenceMetrics {
  sampleCount: number;
  earlyCount: number;
  onTimeCount: number;
  lateCount: number;
  onTimeRate: number | null;
  meanDelaySec: number | null;
  medianDelaySec: number | null;
  p90DelaySec: number | null;
  earlyThresholdSec: number;
  lateThresholdSec: number;
  algorithmVersion: string;
}

/**
 * PRD §9.4 Schedule adherence: denominator is matched observations only, not all scheduled stops.
 * Default on-time window: -60s (early) to +300s (5 minutes late).
 */
export function computeScheduleAdherence(
  delaysSec: number[],
  thresholds = { earlySec: -60, lateSec: 300 }
): AdherenceMetrics {
  if (delaysSec.length === 0) {
    return {
      sampleCount: 0,
      earlyCount: 0,
      onTimeCount: 0,
      lateCount: 0,
      onTimeRate: null,
      meanDelaySec: null,
      medianDelaySec: null,
      p90DelaySec: null,
      earlyThresholdSec: thresholds.earlySec,
      lateThresholdSec: thresholds.lateSec,
      algorithmVersion: ANALYTICS_ALGORITHM_VERSION,
    };
  }

  let earlyCount = 0;
  let onTimeCount = 0;
  let lateCount = 0;
  let sum = 0;

  for (const d of delaysSec) {
    sum += d;
    if (d < thresholds.earlySec) earlyCount++;
    else if (d > thresholds.lateSec) lateCount++;
    else onTimeCount++;
  }

  return {
    sampleCount: delaysSec.length,
    earlyCount,
    onTimeCount,
    lateCount,
    onTimeRate: Number((onTimeCount / delaysSec.length).toFixed(4)),
    meanDelaySec: Math.round(sum / delaysSec.length),
    medianDelaySec: Math.round(percentile(delaysSec, 50) ?? 0),
    p90DelaySec: Math.round(percentile(delaysSec, 90) ?? 0),
    earlyThresholdSec: thresholds.earlySec,
    lateThresholdSec: thresholds.lateSec,
    algorithmVersion: ANALYTICS_ALGORITHM_VERSION,
  };
}

export interface HeadwayMetrics {
  sampleCount: number;
  meanHeadwaySec: number | null;
  medianHeadwaySec: number | null;
  p90HeadwaySec: number | null;
  bunchedCount: number;
  gapCount: number;
  bunchingThresholdSec: number;
  gapThresholdSec: number;
  scheduledHeadwaySec: number | null;
  algorithmVersion: string;
}

/**
 * PRD §9.4 Headway, bunching, and gap analysis for successive vehicles at a stop/segment.
 */
export function computeHeadwayMetrics(
  arrivalEpochMs: number[],
  scheduledHeadwaySec: number | null = null
): HeadwayMetrics {
  const sorted = [...arrivalEpochMs].sort((a, b) => a - b);
  const headways: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const diffSec = Math.round((sorted[i]! - sorted[i - 1]!) / 1000);
    if (diffSec >= 0 && diffSec <= 7200) {
      headways.push(diffSec);
    }
  }

  const refHeadway = scheduledHeadwaySec ?? (percentile(headways, 50) ?? 600);
  const bunchingThresholdSec = Math.max(60, Math.round(refHeadway * 0.25));
  const gapThresholdSec = Math.max(300, Math.round(refHeadway * 1.75));

  if (headways.length === 0) {
    return {
      sampleCount: 0,
      meanHeadwaySec: null,
      medianHeadwaySec: null,
      p90HeadwaySec: null,
      bunchedCount: 0,
      gapCount: 0,
      bunchingThresholdSec,
      gapThresholdSec,
      scheduledHeadwaySec,
      algorithmVersion: ANALYTICS_ALGORITHM_VERSION,
    };
  }

  const bunchedCount = headways.filter((h) => h <= bunchingThresholdSec).length;
  const gapCount = headways.filter((h) => h >= gapThresholdSec).length;
  const sum = headways.reduce((a, b) => a + b, 0);

  return {
    sampleCount: headways.length,
    meanHeadwaySec: Math.round(sum / headways.length),
    medianHeadwaySec: Math.round(percentile(headways, 50) ?? 0),
    p90HeadwaySec: Math.round(percentile(headways, 90) ?? 0),
    bunchedCount,
    gapCount,
    bunchingThresholdSec,
    gapThresholdSec,
    scheduledHeadwaySec,
    algorithmVersion: ANALYTICS_ALGORITHM_VERSION,
  };
}

export interface ArrivalPrediction {
  predictedEpochMs: number;
  etaSeconds: number;
  uncertaintySec: number;
  source: "agency_reported" | "swisshost_estimated" | "scheduled" | "unknown";
  confidence: number;
  modelVersion: string;
  basis: string;
}

/**
 * PRD §9.3 Prediction hierarchy:
 * 1. Agency-reported prediction when valid
 * 2. Empirical-Bayes shrunk statistical estimate from live progress + historical segment travel times
 * 3. Scheduled time fallback
 * Enforces nonnegative ETA and exposes explicit uncertainty & model version.
 */
export function predictStopArrival(input: {
  nowEpochMs: number;
  scheduledEpochMs: number | null;
  agencyPredictedEpochMs?: number | null;
  currentDelaySec?: number | null;
  distanceRemainingMeters?: number | null;
  historicalSegmentSpeedMps?: number | null;
  historicalSampleCount?: number;
  routeFallbackSpeedMps?: number;
}): ArrivalPrediction {
  if (input.agencyPredictedEpochMs && input.agencyPredictedEpochMs >= input.nowEpochMs - 60_000) {
    const etaSeconds = Math.max(0, Math.round((input.agencyPredictedEpochMs - input.nowEpochMs) / 1000));
    return {
      predictedEpochMs: input.nowEpochMs + etaSeconds * 1000,
      etaSeconds,
      uncertaintySec: 45,
      source: "agency_reported",
      confidence: 0.9,
      modelVersion: ANALYTICS_ALGORITHM_VERSION,
      basis: "GTFS-RT TripUpdate",
    };
  }

  const priorSpeed = input.routeFallbackSpeedMps ?? 6.5; // ~23.4 km/h urban bus baseline
  if (input.distanceRemainingMeters !== null && input.distanceRemainingMeters !== undefined && input.distanceRemainingMeters >= 0) {
    const n = input.historicalSampleCount ?? 0;
    const shrinkageWeight = n / (n + 10);
    const effectiveSpeed =
      input.historicalSegmentSpeedMps && input.historicalSegmentSpeedMps > 1
        ? shrinkageWeight * input.historicalSegmentSpeedMps + (1 - shrinkageWeight) * priorSpeed
        : priorSpeed;

    const rawTravelSec = input.distanceRemainingMeters / Math.max(1.5, effectiveSpeed);
    const etaSeconds = Math.max(0, Math.round(rawTravelSec));
    const uncertaintySec = Math.max(30, Math.round(etaSeconds * (n >= 10 ? 0.15 : 0.25)));
    return {
      predictedEpochMs: input.nowEpochMs + etaSeconds * 1000,
      etaSeconds,
      uncertaintySec,
      source: "swisshost_estimated",
      confidence: Number((0.55 + 0.3 * shrinkageWeight).toFixed(2)),
      modelVersion: ANALYTICS_ALGORITHM_VERSION,
      basis: n > 0 ? `Shrunk segment speed (n=${n})` : "Route baseline speed + live distance",
    };
  }

  if (input.scheduledEpochMs !== null) {
    const adjustedMs =
      input.currentDelaySec !== null && input.currentDelaySec !== undefined
        ? input.scheduledEpochMs + input.currentDelaySec * 1000
        : input.scheduledEpochMs;
    const etaSeconds = Math.max(0, Math.round((adjustedMs - input.nowEpochMs) / 1000));
    const isAdjusted = input.currentDelaySec !== null && input.currentDelaySec !== undefined;
    return {
      predictedEpochMs: input.nowEpochMs + etaSeconds * 1000,
      etaSeconds,
      uncertaintySec: isAdjusted ? 90 : 180,
      source: isAdjusted ? "swisshost_estimated" : "scheduled",
      confidence: isAdjusted ? 0.68 : 0.5,
      modelVersion: ANALYTICS_ALGORITHM_VERSION,
      basis: isAdjusted ? "Schedule + live trip deviation" : "Static GTFS schedule",
    };
  }

  return {
    predictedEpochMs: input.nowEpochMs,
    etaSeconds: 0,
    uncertaintySec: 0,
    source: "unknown",
    confidence: 0,
    modelVersion: ANALYTICS_ALGORITHM_VERSION,
    basis: "Insufficient schedule or live evidence",
  };
}

export interface BacktestReport {
  sampleCount: number;
  maeSec: number | null;
  medianAbsErrorSec: number | null;
  p90AbsErrorSec: number | null;
  scheduleBaselineMaeSec: number | null;
  modelVersion: string;
}

export function backtestPredictions(
  samples: Array<{ predictedSec: number; actualSec: number; scheduledSec: number }>
): BacktestReport {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      maeSec: null,
      medianAbsErrorSec: null,
      p90AbsErrorSec: null,
      scheduleBaselineMaeSec: null,
      modelVersion: ANALYTICS_ALGORITHM_VERSION,
    };
  }
  const absErrors = samples.map((s) => Math.abs(s.predictedSec - s.actualSec));
  const schedErrors = samples.map((s) => Math.abs(s.scheduledSec - s.actualSec));
  return {
    sampleCount: samples.length,
    maeSec: Math.round(absErrors.reduce((a, b) => a + b, 0) / absErrors.length),
    medianAbsErrorSec: Math.round(percentile(absErrors, 50) ?? 0),
    p90AbsErrorSec: Math.round(percentile(absErrors, 90) ?? 0),
    scheduleBaselineMaeSec: Math.round(schedErrors.reduce((a, b) => a + b, 0) / schedErrors.length),
    modelVersion: ANALYTICS_ALGORITHM_VERSION,
  };
}
