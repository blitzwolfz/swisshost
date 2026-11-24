import { z } from "zod";

export const TransitModeSchema = z.enum([
  "bus",
  "streetcar",
  "subway",
  "rail",
  "ferry",
  "unknown",
]);
export type TransitMode = z.infer<typeof TransitModeSchema>;

export const FeedKindSchema = z.enum([
  "gtfs_static",
  "vehicle_positions",
  "trip_updates",
  "service_alerts",
]);
export type FeedKind = z.infer<typeof FeedKindSchema>;

export const FeedAdapterKindSchema = z.enum([
  "gtfs-static",
  "gtfs-rt",
  "umo-xml",
  "json-generic",
]);
export type FeedAdapterKind = z.infer<typeof FeedAdapterKindSchema>;

export const FeedHealthStatusSchema = z.enum([
  "fresh",
  "delayed",
  "stale",
  "unavailable",
  "disabled",
  "missing_key",
  "quarantined",
  "unknown",
]);
export type FeedHealthStatus = z.infer<typeof FeedHealthStatusSchema>;

export const TimestampBasisSchema = z.enum(["vehicle", "feed", "receipt"]);
export type TimestampBasis = z.infer<typeof TimestampBasisSchema>;

export const DataProvenanceSchema = z.enum([
  "reported",
  "scheduled",
  "inferred",
  "unknown",
]);
export type DataProvenance = z.infer<typeof DataProvenanceSchema>;

export const AgencyCapabilitiesSchema = z.object({
  staticSchedule: z.boolean(),
  vehiclePositions: z.boolean(),
  tripUpdates: z.boolean(),
  serviceAlerts: z.boolean(),
  historicalArchive: z.boolean(),
});
export type AgencyCapabilities = z.infer<typeof AgencyCapabilitiesSchema>;

export const FeedConfigSchema = z.object({
  id: z.string().min(2).max(80),
  kind: FeedKindSchema,
  adapter: FeedAdapterKindSchema,
  url: z.string().url(),
  fallbackUrl: z.string().url().nullable().optional(),
  authQueryParam: z.string().nullable().optional(),
  authSecretRef: z.string().nullable().optional(),
  refreshSeconds: z.number().int().min(15).max(86400),
  staleAfterSeconds: z.number().int().min(30).max(604800),
  enabled: z.boolean(),
});
export type FeedConfig = z.infer<typeof FeedConfigSchema>;

export const AgencyConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(2),
  shortName: z.string().min(1).max(20),
  region: z.string(),
  timezone: z.string(),
  modes: z.array(TransitModeSchema),
  center: z.tuple([z.number(), z.number()]),
  defaultZoom: z.number().min(3).max(18),
  enabled: z.boolean(),
  attribution: z.string(),
  licenseUrl: z.string().url().nullable().optional(),
  archivePolicy: z.enum(["permitted", "permitted_with_key", "prohibited"]),
  capabilities: AgencyCapabilitiesSchema,
  feeds: z.array(FeedConfigSchema),
});
export type AgencyConfig = z.infer<typeof AgencyConfigSchema>;

export interface Observation {
  sourceId: string;
  agencyId: string;
  sourceVehicleId: string;
  vehicleId: string;
  fleetNumber: string;
  label: string | null;
  tripId: string | null;
  routeId: string | null;
  blockId: string | null;
  directionId: number | null;
  lat: number;
  lon: number;
  bearingDeg: number | null;
  speedMps: number | null;
  scheduleDeviationSec: number | null;
  currentStatus: string | null;
  stopId: string | null;
  stopSequence: number | null;
  occupancyStatus: string | null;
  observedAt: string | null;
  receivedAt: string;
  timestampBasis: TimestampBasis;
  qualityFlags: string[];
  matchMethod: string;
  matchConfidence: number;
  rawRef: string;
}

export interface StopTimeUpdate {
  stopSequence: number | null;
  stopId: string | null;
  arrivalDelaySec: number | null;
  arrivalTime: string | null;
  departureDelaySec: number | null;
  departureTime: string | null;
  scheduleRelationship: string;
}

export interface NormalizedTripUpdate {
  sourceId: string;
  agencyId: string;
  tripId: string;
  routeId: string | null;
  serviceDate: string;
  vehicleId: string | null;
  scheduleRelationship: string;
  delaySec: number | null;
  stopUpdates: StopTimeUpdate[];
  observedAt: string | null;
  receivedAt: string;
}

export interface NormalizedAlert {
  sourceId: string;
  agencyId: string;
  sourceAlertId: string;
  cause: string;
  effect: string;
  headerText: string;
  descriptionText: string;
  url: string | null;
  activePeriods: Array<{ start: string | null; end: string | null }>;
  informedEntities: Array<{
    agencyId?: string;
    routeId?: string;
    stopId?: string;
    tripId?: string;
    routeType?: number;
  }>;
  receivedAt: string;
}

export interface NormalizedBatch {
  batchId: string;
  sourceId: string;
  agencyId: string;
  feedKind: FeedKind;
  incrementality: "FULL_DATASET" | "DIFFERENTIAL";
  feedTimestamp: string | null;
  receivedAt: string;
  adapterVersion: string;
  observations: Observation[];
  tripUpdates: NormalizedTripUpdate[];
  alerts: NormalizedAlert[];
  qualityFlags: string[];
  rawByteLength: number;
}

export interface LiveVehicleState {
  agencyId: string;
  sourceVehicleId: string;
  vehicleId: string;
  fleetNumber: string;
  label: string | null;
  routeId: string | null;
  routeShortName?: string | null;
  routeColor?: string | null;
  tripId: string | null;
  headsign?: string | null;
  blockId: string | null;
  directionId: number | null;
  lat: number;
  lon: number;
  bearingDeg: number | null;
  speedMps: number | null;
  scheduleDeviationSec: number | null;
  currentStatus: string | null;
  stopId: string | null;
  stopSequence: number | null;
  occupancyStatus: string | null;
  observedAt: string | null;
  receivedAt: string;
  timestampBasis: TimestampBasis;
  ageSeconds: number;
  freshness: "fresh" | "delayed" | "stale";
  qualityFlags: string[];
  matchMethod: string;
  matchConfidence: number;
}

export type LiveWsClientMessage =
  | { type: "subscribe"; agencyId: string; routeId?: string; cursor?: number }
  | { type: "ping"; ts: number };

export type LiveWsServerMessage =
  | {
      type: "snapshot";
      agencyId: string;
      cursor: number;
      serverTime: string;
      feedStatus: FeedHealthStatus;
      lastSuccessAt: string | null;
      vehicles: LiveVehicleState[];
    }
  | {
      type: "delta";
      agencyId: string;
      cursor: number;
      serverTime: string;
      upserts: LiveVehicleState[];
      removed: string[];
    }
  | {
      type: "status";
      agencyId: string;
      feedStatus: FeedHealthStatus;
      lastSuccessAt: string | null;
      message?: string;
    }
  | { type: "pong"; ts: number; serverTime: string }
  | { type: "resync_required"; reason: string; cursor: number };

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  requestId?: string;
}

export function createProblemDetails(
  status: number,
  title: string,
  detail: string,
  requestId?: string,
  instance?: string
): ProblemDetails {
  return {
    type: `https://swisshost.cc/docs/errors/${status}`,
    title,
    status,
    detail,
    ...(requestId ? { requestId } : {}),
    ...(instance ? { instance } : {}),
  };
}

export const ExportRequestSchema = z.object({
  agencyId: z.string().min(1),
  entityType: z.enum(["observations", "assignments", "stop_events", "analytics"]),
  routeId: z.string().optional(),
  vehicleId: z.string().optional(),
  stopId: z.string().optional(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  format: z.enum(["csv", "geojson", "json"]).default("csv"),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

export const FavoriteInputSchema = z.object({
  agencyId: z.string().min(1),
  entityType: z.enum(["route", "stop", "vehicle", "trip"]),
  entityId: z.string().min(1),
  label: z.string().min(1).max(160),
});
export type FavoriteInput = z.infer<typeof FavoriteInputSchema>;

export const SubscriptionInputSchema = z.object({
  agencyId: z.string().min(1),
  targetType: z.enum(["vehicle", "route", "stop", "alert"]),
  targetId: z.string().min(1),
  rule: z.object({
    event: z.enum([
      "vehicle_enters_service",
      "vehicle_on_route",
      "stop_departure_threshold",
      "service_alert",
      "route_disruption",
    ]),
    routeId: z.string().optional(),
    thresholdMinutes: z.number().int().min(1).max(120).optional(),
  }),
  channel: z.enum(["in_app", "web_push"]).default("in_app"),
  pushSubscription: z.record(z.unknown()).nullable().optional(),
  quietHours: z
    .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) })
    .nullable()
    .optional(),
  cooldownSec: z.number().int().min(60).max(86400).default(900),
});
export type SubscriptionInput = z.infer<typeof SubscriptionInputSchema>;

export const FleetCorrectionSchema = z.object({
  fleetNumber: z.string().min(1).max(60).optional(),
  vehicleType: TransitModeSchema.optional(),
  manufacturer: z.string().max(80).nullable().optional(),
  model: z.string().max(80).nullable().optional(),
  year: z.number().int().min(1950).max(2035).nullable().optional(),
  propulsion: z.string().max(60).nullable().optional(),
  accessibility: z.string().max(80).nullable().optional(),
  garage: z.string().max(80).nullable().optional(),
  photoUrl: z.string().url().nullable().optional(),
  photoLicense: z.string().max(120).nullable().optional(),
  metadataSource: z.string().min(2).max(120).default("admin_verified"),
});
export type FleetCorrection = z.infer<typeof FleetCorrectionSchema>;

export const OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Swisshost Transit Intelligence API",
    version: "1.0.0",
    description:
      "Public read-only transit tracking, schedule, historical replay, analytics, and export API for Ontario transit agencies.",
    license: { name: "Agency-specific open data licenses apply; see /api/v1/agencies" },
  },
  servers: [{ url: "https://swisshost.cc/api/v1" }],
  paths: {
    "/agencies": { get: { summary: "List configured agencies, capabilities, and feed freshness" } },
    "/agencies/{id}/status": { get: { summary: "Detailed feed health, coverage, and quota status" } },
    "/agencies/{id}/vehicles": { get: { summary: "Live vehicle snapshot (JSON or GeoJSON)" } },
    "/agencies/{id}/vehicles/{vehicle}": { get: { summary: "Vehicle detail, fleet metadata, aliases, and current assignment" } },
    "/agencies/{id}/vehicles/{vehicle}/history": { get: { summary: "Historical GPS observations and assignment intervals" } },
    "/agencies/{id}/routes": { get: { summary: "Routes with variants, colors, directions, and active vehicle counts" } },
    "/agencies/{id}/routes/{route}": { get: { summary: "Route detail, shapes, stops, timetable, active vehicles, alerts, and performance" } },
    "/agencies/{id}/stops": { get: { summary: "Search stops by text or spatial bounding box" } },
    "/agencies/{id}/stops/{stop}/arrivals": { get: { summary: "Scheduled, agency-predicted, and Swisshost-estimated departures" } },
    "/agencies/{id}/stops/{stop}/history": { get: { summary: "Observed stop arrival/departure events" } },
    "/agencies/{id}/trips/{instance}": { get: { summary: "Service-date trip timeline comparing schedule vs observations" } },
    "/agencies/{id}/blocks/{block}": { get: { summary: "Service-date block itinerary and vehicle transitions" } },
    "/agencies/{id}/alerts": { get: { summary: "Active and historical service alerts" } },
    "/agencies/{id}/analytics/{metric}": { get: { summary: "Adherence, headway, travel time, dwell, service delivered, and coverage" } },
    "/search": { get: { summary: "Cross-agency search across routes, stops, vehicles, trips, and blocks" } },
    "/live": { get: { summary: "WebSocket endpoint for sequenced agency live deltas" } },
    "/exports": { post: { summary: "Create an asynchronous CSV/GeoJSON/JSON export job" } },
    "/exports/{id}": { get: { summary: "Fetch export job status or download completed export" } },
  },
};
