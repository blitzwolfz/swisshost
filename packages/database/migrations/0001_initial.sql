-- Swisshost D1 Initial Schema (0001_initial.sql)
-- Strict SQLite-compatible DDL for Cloudflare D1

CREATE TABLE IF NOT EXISTS agencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  region TEXT NOT NULL,
  timezone TEXT NOT NULL,
  modes_json TEXT NOT NULL,
  center_lon REAL NOT NULL,
  center_lat REAL NOT NULL,
  default_zoom REAL NOT NULL DEFAULT 12.0,
  enabled INTEGER NOT NULL DEFAULT 1,
  attribution TEXT NOT NULL,
  license_url TEXT,
  archive_policy TEXT NOT NULL DEFAULT 'permitted',
  capabilities_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL REFERENCES agencies(id),
  kind TEXT NOT NULL,
  adapter TEXT NOT NULL,
  url TEXT NOT NULL,
  fallback_url TEXT,
  auth_query_param TEXT,
  auth_secret_ref TEXT,
  refresh_seconds INTEGER NOT NULL DEFAULT 60,
  stale_after_seconds INTEGER NOT NULL DEFAULT 120,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_fetch_at TEXT,
  last_success_at TEXT,
  last_source_ts TEXT,
  last_error TEXT,
  last_etag TEXT,
  last_modified TEXT,
  last_bytes INTEGER DEFAULT 0,
  last_entity_count INTEGER DEFAULT 0,
  duplicate_ratio REAL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  config_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feeds_agency ON feeds(agency_id);

CREATE TABLE IF NOT EXISTS feed_versions (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES feeds(id),
  agency_id TEXT NOT NULL REFERENCES agencies(id),
  content_hash TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'staged',
  route_count INTEGER NOT NULL DEFAULT 0,
  stop_count INTEGER NOT NULL DEFAULT 0,
  trip_count INTEGER NOT NULL DEFAULT 0,
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  activated_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_versions_agency ON feed_versions(agency_id, status);

CREATE TABLE IF NOT EXISTS routes (
  agency_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  short_name TEXT NOT NULL DEFAULT '',
  long_name TEXT NOT NULL DEFAULT '',
  description TEXT,
  route_type INTEGER NOT NULL DEFAULT 3,
  color TEXT,
  text_color TEXT,
  sort_order INTEGER,
  directions_json TEXT NOT NULL DEFAULT '[]',
  shape_geojson TEXT,
  bbox_json TEXT,
  PRIMARY KEY (agency_id, version_id, route_id)
);
CREATE INDEX IF NOT EXISTS idx_routes_agency ON routes(agency_id, version_id);

CREATE TABLE IF NOT EXISTS stops (
  agency_id TEXT NOT NULL,
  stop_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  stop_code TEXT,
  name TEXT NOT NULL,
  description TEXT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  location_type INTEGER NOT NULL DEFAULT 0,
  parent_station TEXT,
  platform_code TEXT,
  wheelchair_boarding INTEGER DEFAULT 0,
  routes_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (agency_id, version_id, stop_id)
);
CREATE INDEX IF NOT EXISTS idx_stops_agency_name ON stops(agency_id, version_id, name);
CREATE INDEX IF NOT EXISTS idx_stops_agency_geo ON stops(agency_id, version_id, lat, lon);

CREATE TABLE IF NOT EXISTS trips (
  agency_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  direction_id INTEGER,
  headsign TEXT,
  short_name TEXT,
  block_id TEXT,
  shape_id TEXT,
  wheelchair_accessible INTEGER DEFAULT 0,
  bikes_allowed INTEGER DEFAULT 0,
  first_departure_sec INTEGER,
  last_arrival_sec INTEGER,
  stop_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agency_id, version_id, trip_id)
);
CREATE INDEX IF NOT EXISTS idx_trips_route ON trips(agency_id, version_id, route_id);
CREATE INDEX IF NOT EXISTS idx_trips_block ON trips(agency_id, version_id, block_id);

CREATE TABLE IF NOT EXISTS stop_times (
  agency_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  stop_sequence INTEGER NOT NULL,
  stop_id TEXT NOT NULL,
  arrival_sec INTEGER,
  departure_sec INTEGER,
  pickup_type INTEGER DEFAULT 0,
  drop_off_type INTEGER DEFAULT 0,
  shape_dist_traveled REAL,
  PRIMARY KEY (agency_id, version_id, trip_id, stop_sequence)
);
CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON stop_times(agency_id, version_id, stop_id, departure_sec);

CREATE TABLE IF NOT EXISTS calendars (
  agency_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  days_mask INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  exceptions_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (agency_id, version_id, service_id)
);

CREATE TABLE IF NOT EXISTS vehicles (
  agency_id TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  source_vehicle_id TEXT NOT NULL,
  fleet_number TEXT NOT NULL,
  label TEXT,
  vehicle_type TEXT NOT NULL DEFAULT 'unknown',
  manufacturer TEXT,
  model TEXT,
  year INTEGER,
  propulsion TEXT,
  accessibility TEXT,
  garage TEXT,
  photo_url TEXT,
  photo_license TEXT,
  metadata_source TEXT NOT NULL DEFAULT 'observed',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agency_id, vehicle_id)
);
CREATE INDEX IF NOT EXISTS idx_vehicles_fleet ON vehicles(agency_id, fleet_number);

CREATE TABLE IF NOT EXISTS vehicle_aliases (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  source TEXT NOT NULL DEFAULT 'observed',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vehicle_aliases_lookup ON vehicle_aliases(agency_id, alias);

CREATE TABLE IF NOT EXISTS vehicle_latest (
  agency_id TEXT NOT NULL,
  source_vehicle_id TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  fleet_number TEXT NOT NULL,
  route_id TEXT,
  trip_id TEXT,
  block_id TEXT,
  direction_id INTEGER,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  bearing_deg REAL,
  speed_mps REAL,
  schedule_deviation_sec INTEGER,
  current_status TEXT,
  stop_id TEXT,
  stop_sequence INTEGER,
  occupancy_status TEXT,
  observed_at TEXT,
  received_at TEXT NOT NULL,
  timestamp_basis TEXT NOT NULL DEFAULT 'receipt',
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  match_method TEXT NOT NULL DEFAULT 'unmatched',
  match_confidence REAL NOT NULL DEFAULT 0,
  raw_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agency_id, source_vehicle_id)
);
CREATE INDEX IF NOT EXISTS idx_vehicle_latest_route ON vehicle_latest(agency_id, route_id);

CREATE TABLE IF NOT EXISTS observation_chunks (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL,
  window_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  vehicle_id TEXT,
  route_id TEXT,
  row_count INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_chunks_agency_window ON observation_chunks(agency_id, window_start, window_end);
CREATE INDEX IF NOT EXISTS idx_obs_chunks_vehicle ON observation_chunks(agency_id, vehicle_id, window_start);
CREATE INDEX IF NOT EXISTS idx_obs_chunks_archive ON observation_chunks(archived, window_key);

CREATE TABLE IF NOT EXISTS vehicle_assignments (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  route_id TEXT,
  trip_id TEXT,
  block_id TEXT,
  service_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'explicit_feed'
);
CREATE INDEX IF NOT EXISTS idx_assignments_vehicle_date ON vehicle_assignments(agency_id, vehicle_id, service_date);
CREATE INDEX IF NOT EXISTS idx_assignments_trip ON vehicle_assignments(agency_id, trip_id, service_date);

CREATE TABLE IF NOT EXISTS trip_updates (
  agency_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  service_date TEXT NOT NULL,
  route_id TEXT,
  vehicle_id TEXT,
  schedule_relationship TEXT NOT NULL DEFAULT 'SCHEDULED',
  delay_sec INTEGER,
  stop_updates_json TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (agency_id, service_date, trip_id)
);
CREATE INDEX IF NOT EXISTS idx_trip_updates_route ON trip_updates(agency_id, route_id, service_date);

CREATE TABLE IF NOT EXISTS service_alerts (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL,
  source_alert_id TEXT NOT NULL,
  cause TEXT NOT NULL DEFAULT 'UNKNOWN_CAUSE',
  effect TEXT NOT NULL DEFAULT 'UNKNOWN_EFFECT',
  header_text TEXT NOT NULL,
  description_text TEXT NOT NULL DEFAULT '',
  url TEXT,
  active_periods_json TEXT NOT NULL DEFAULT '[]',
  informed_entities_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_source ON service_alerts(agency_id, source_alert_id);

CREATE TABLE IF NOT EXISTS stop_events (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL,
  service_date TEXT NOT NULL,
  stop_id TEXT NOT NULL,
  route_id TEXT,
  trip_id TEXT,
  vehicle_id TEXT NOT NULL,
  scheduled_sec INTEGER,
  observed_arrival_at TEXT,
  observed_departure_at TEXT,
  uncertainty_sec INTEGER NOT NULL DEFAULT 30,
  event_type TEXT NOT NULL DEFAULT 'inferred_dwell',
  source TEXT NOT NULL DEFAULT 'inferred',
  confidence REAL NOT NULL DEFAULT 0.5,
  delay_sec INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stop_events_stop ON stop_events(agency_id, stop_id, service_date);
CREATE INDEX IF NOT EXISTS idx_stop_events_route ON stop_events(agency_id, route_id, service_date);

CREATE TABLE IF NOT EXISTS analytics_buckets (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  bucket_granularity TEXT NOT NULL,
  route_id TEXT,
  stop_id TEXT,
  direction_id INTEGER,
  metric_type TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  value_json TEXT NOT NULL,
  coverage_ratio REAL NOT NULL DEFAULT 0,
  algorithm_version TEXT NOT NULL DEFAULT 'v1.0',
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_lookup ON analytics_buckets(agency_id, metric_type, bucket_start);

CREATE TABLE IF NOT EXISTS archive_manifests (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL,
  window_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  file_count INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  commit_sha TEXT,
  repo_path TEXT,
  error_message TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_unique ON archive_manifests(agency_id, window_key);

CREATE TABLE IF NOT EXISTS export_jobs (
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL,
  query_json TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'csv',
  status TEXT NOT NULL DEFAULT 'pending',
  row_count INTEGER NOT NULL DEFAULT 0,
  download_token TEXT NOT NULL,
  result_text TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT UNIQUE NOT NULL,
  public_key_jwk TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'user',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agency_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_unique ON favorites(user_id, agency_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agency_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'in_app',
  push_subscription_json TEXT,
  quiet_hours_json TEXT,
  cooldown_sec INTEGER NOT NULL DEFAULT 900,
  last_notified_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications_inbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT,
  agency_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'delivered',
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_ledger (
  date_key TEXT PRIMARY KEY,
  d1_writes INTEGER NOT NULL DEFAULT 0,
  do_requests INTEGER NOT NULL DEFAULT 0,
  worker_requests INTEGER NOT NULL DEFAULT 0,
  archive_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'normal',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
