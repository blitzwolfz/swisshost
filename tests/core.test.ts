import { describe, expect, it } from "vitest";
import {
  decodeGtfsRtFeed,
  decodeUmoXmlVehicles,
  parseGtfsStaticZip,
  validateFeedUrl,
} from "@swisshost/adapters";
import {
  backtestPredictions,
  computeHeadwayMetrics,
  computeScheduleAdherence,
  predictStopArrival,
} from "@swisshost/analytics";
import {
  detectStopEvent,
  evaluateTripMatch,
  getLocalServiceContext,
  isServiceActiveOnDate,
  parseGtfsTimeToSeconds,
  projectPointOntoPolyline,
  validateObservationQuality,
} from "@swisshost/transit-core";
import {
  buildSampleGtfsRtVehiclesProtobuf,
  buildSampleGtfsStaticZip,
} from "@swisshost/test-fixtures";

describe("Transit Core — Service Dates, DST, After-Midnight, and Matching", () => {
  it("parses after-midnight GTFS times like 25:15:00", () => {
    expect(parseGtfsTimeToSeconds("25:15:00")).toBe(25 * 3600 + 15 * 60);
    expect(parseGtfsTimeToSeconds("00:00:30")).toBe(30);
    expect(parseGtfsTimeToSeconds("bad")).toBeNull();
  });

  it("rolls early-morning instants before 03:00 into previous service date in America/Toronto", () => {
    // 2026-07-15 05:30 UTC = 01:30 EDT in Toronto -> service date 2026-07-14 with serviceSeconds = 25.5h
    const ctx = getLocalServiceContext("2026-07-15T05:30:00Z", "America/Toronto", 3);
    expect(ctx.calendarDate).toBe("2026-07-15");
    expect(ctx.serviceDate).toBe("2026-07-14");
    expect(ctx.serviceSeconds).toBe(25 * 3600 + 30 * 60);
  });

  it("evaluates GTFS calendars and exception overrides", () => {
    const cal = {
      daysMask: 0b0011111, // Mon-Fri
      startDate: "20260101",
      endDate: "20261231",
      exceptions: { "20260701": 2, "20260704": 1 },
    };
    expect(isServiceActiveOnDate(cal, "2026-07-02")).toBe(true); // Thu
    expect(isServiceActiveOnDate(cal, "2026-07-01")).toBe(false); // Holiday removed
    expect(isServiceActiveOnDate(cal, "2026-07-04")).toBe(true); // Saturday added
  });

  it("projects GPS coordinates onto route polyline and scores trip match", () => {
    const shape: Array<[number, number]> = [
      [-80.2482, 43.5448],
      [-80.2262, 43.5327],
    ];
    const proj = projectPointOntoPolyline(43.5387, -80.2372, shape);
    expect(proj).not.toBeNull();
    expect(proj!.distanceMeters).toBeLessThan(25);

    const score = evaluateTripMatch(
      { tripId: "T99-1", routeId: "99", lat: 43.5387, lon: -80.2372, bearingDeg: 125 },
      shape
    );
    expect(score.method).toBe("explicit_trip");
    expect(score.confidence).toBeGreaterThan(0.8);
    expect(score.offRoute).toBe(false);
  });

  it("rejects impossible coordinates and flags improbable jumps", () => {
    const base = {
      sourceId: "guelph-positions",
      agencyId: "guelph",
      sourceVehicleId: "214",
      vehicleId: "214",
      fleetNumber: "214",
      label: "214",
      tripId: "T1",
      routeId: "99",
      blockId: null,
      directionId: 0,
      lat: 43.5448,
      lon: -80.2482,
      bearingDeg: 180,
      speedMps: 10,
      scheduleDeviationSec: 0,
      currentStatus: "IN_TRANSIT_TO",
      stopId: null,
      stopSequence: null,
      occupancyStatus: null,
      observedAt: "2026-11-24T12:00:00.000Z",
      receivedAt: "2026-11-24T12:00:05.000Z",
      timestampBasis: "vehicle" as const,
      qualityFlags: [],
      matchMethod: "explicit_trip",
      matchConfidence: 0.9,
      rawRef: "test",
    };

    expect(validateObservationQuality({ ...base, lat: 0, lon: 0 }, null).valid).toBe(false);

    const jump = validateObservationQuality(
      { ...base, lat: 44.5448, lon: -80.2482, observedAt: "2026-11-24T12:00:30.000Z" },
      base
    );
    expect(jump.valid).toBe(true);
    expect(jump.flags).toContain("improbable_jump");

    const stopEvt = detectStopEvent(base, { ...base, speedMps: 0.4 }, [
      { stopId: "S100", lat: 43.54485, lon: -80.24821 },
    ]);
    expect(stopEvt?.stopId).toBe("S100");
    expect(stopEvt?.eventType).toBe("inferred_dwell");
  });
});

describe("Adapters — GTFS-RT Protobuf, Umo XML, GTFS Static ZIP, and SSRF Guard", () => {
  it("enforces HTTPS and blocks internal/private hosts", () => {
    expect(() => validateFeedUrl("http://glphprdtmgtfs.glphtrpcloud.com/feed.pb")).toThrow();
    expect(() => validateFeedUrl("https://127.0.0.1/feed.pb")).toThrow();
    expect(() => validateFeedUrl("https://localhost/feed.pb")).toThrow();
    expect(() => validateFeedUrl("https://169.254.169.254/latest/meta-data")).toThrow();
    expect(validateFeedUrl("https://bustime.ttc.ca/gtfsrt/vehicles").hostname).toBe("bustime.ttc.ca");
  });

  it("decodes GTFS-RT VehiclePositions protobuf accurately", () => {
    const pb = buildSampleGtfsRtVehiclesProtobuf({
      timestampSec: 1795500000,
      vehicles: [
        {
          entityId: "veh-214",
          vehicleId: "214",
          label: "214",
          routeId: "99",
          tripId: "T99-1",
          lat: 43.5448,
          lon: -80.2482,
          bearing: 165,
          speedMps: 11.5,
          stopId: "S100",
          status: 1,
        },
      ],
    });
    const batch = decodeGtfsRtFeed(pb, {
      sourceId: "guelph-positions",
      agencyId: "guelph",
      feedKind: "vehicle_positions",
      timezone: "America/Toronto",
    });
    expect(batch.incrementality).toBe("FULL_DATASET");
    expect(batch.observations).toHaveLength(1);
    const v = batch.observations[0]!;
    expect(v.fleetNumber).toBe("214");
    expect(v.routeId).toBe("99");
    expect(v.tripId).toBe("T99-1");
    expect(v.currentStatus).toBe("STOPPED_AT");
    expect(v.lat).toBeCloseTo(43.5448, 3);
    expect(v.lon).toBeCloseTo(-80.2482, 3);
  });

  it("decodes Umo XML and rejects XXE DOCTYPE payloads", () => {
    const xml = `<body copyright="TTC"><vehicle id="4401" routeTag="504" lat="43.65" lon="-79.38" secsSinceReport="12" heading="90" speedKmHr="36"/></body>`;
    const batch = decodeUmoXmlVehicles(xml, { sourceId: "ttc-umo", agencyId: "ttc" });
    expect(batch.observations).toHaveLength(1);
    expect(batch.observations[0]!.speedMps).toBeCloseTo(10, 2);

    expect(() =>
      decodeUmoXmlVehicles(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><body/>`, {
        sourceId: "ttc-umo",
        agencyId: "ttc",
      })
    ).toThrow(/DOCTYPE/);
  });

  it("parses GTFS Static ZIP with routes, stops, calendars, trips, stop_times, and shapes", () => {
    const zip = buildSampleGtfsStaticZip();
    const parsed = parseGtfsStaticZip(zip);
    expect(parsed.routes).toHaveLength(2);
    expect(parsed.stops).toHaveLength(3);
    expect(parsed.trips).toHaveLength(1);
    expect(parsed.stopTimes).toHaveLength(3);
    expect(parsed.shapes.get("SH99")).toHaveLength(4);
  });
});

describe("Analytics — Adherence, Headways, ETA Predictions, and Backtesting", () => {
  it("computes adherence using matched observations as denominator", () => {
    const adh = computeScheduleAdherence([-120, 0, 120, 420]);
    expect(adh.sampleCount).toBe(4);
    expect(adh.earlyCount).toBe(1);
    expect(adh.onTimeCount).toBe(2);
    expect(adh.lateCount).toBe(1);
    expect(adh.onTimeRate).toBe(0.5);
  });

  it("detects bunching and gaps in headways", () => {
    const base = Date.UTC(2026, 10, 24, 13, 0, 0);
    const hw = computeHeadwayMetrics([base, base + 90_000, base + 690_000, base + 2_100_000], 600);
    expect(hw.sampleCount).toBe(3);
    expect(hw.bunchedCount).toBe(1);
    expect(hw.gapCount).toBe(1);
  });

  it("follows prediction hierarchy and backtests MAE against schedule baseline", () => {
    const now = Date.UTC(2026, 10, 24, 14, 0, 0);
    const reported = predictStopArrival({
      nowEpochMs: now,
      scheduledEpochMs: now + 600_000,
      agencyPredictedEpochMs: now + 480_000,
    });
    expect(reported.source).toBe("agency_reported");
    expect(reported.etaSeconds).toBe(480);

    const estimated = predictStopArrival({
      nowEpochMs: now,
      scheduledEpochMs: now + 600_000,
      distanceRemainingMeters: 1300,
      historicalSegmentSpeedMps: 6.5,
      historicalSampleCount: 25,
    });
    expect(estimated.source).toBe("swisshost_estimated");
    expect(estimated.etaSeconds).toBe(200);

    const report = backtestPredictions([
      { predictedSec: 310, actualSec: 300, scheduledSec: 240 },
      { predictedSec: 590, actualSec: 610, scheduledSec: 500 },
    ]);
    expect(report.maeSec).toBe(15);
    expect(report.scheduleBaselineMaeSec).toBe(85);
  });
});
