import { DurableObject } from "cloudflare:workers";
import type { FeedKind } from "@swisshost/contracts";
import { decodeGtfsRtFeed, decodeUmoXmlVehicles, validateFeedUrl } from "@swisshost/adapters";
import { getQuotaStatus } from "@swisshost/database";
import { processNormalizedBatch } from "../../processor/src/index";
import type { Env } from "../../api/src/env";
import { getBudgets } from "../../api/src/env";

export interface SchedulerFeedConfig {
  id: string;
  agencyId: string;
  kind: FeedKind;
  adapter: string;
  url: string;
  fallbackUrl?: string | null;
  authQueryParam?: string | null;
  authSecretRef?: string | null;
  refreshSeconds: number;
  staleAfterSeconds: number;
  timezone: string;
  archivePermitted: boolean;
  enabled: boolean;
}

export class FeedSchedulerDO extends DurableObject<Env> {
  private config: SchedulerFeedConfig | null = null;
  private pollGeneration = 0;
  private consecutiveErrors = 0;
  private inFlight = false;
  private lastEtag: string | null = null;
  private lastModified: string | null = null;
  private lastAlarmLatenessMs = 0;
  private nextDueMs = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS scheduler_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS dlq_batches (
          id TEXT PRIMARY KEY,
          received_at TEXT NOT NULL,
          error TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 1,
          payload_base64 TEXT NOT NULL
        );
      `);
      const rows = this.ctx.storage.sql
        .exec<{ key: string; value: string }>("SELECT key, value FROM scheduler_state")
        .toArray();
      for (const r of rows) {
        if (r.key === "config") this.config = JSON.parse(r.value) as SchedulerFeedConfig;
        if (r.key === "pollGeneration") this.pollGeneration = Number(r.value) || 0;
        if (r.key === "consecutiveErrors") this.consecutiveErrors = Number(r.value) || 0;
        if (r.key === "lastEtag") this.lastEtag = r.value || null;
        if (r.key === "lastModified") this.lastModified = r.value || null;
        if (r.key === "nextDueMs") this.nextDueMs = Number(r.value) || 0;
      }
    });
  }

  private putState(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO scheduler_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value
    );
  }

  private deterministicJitterMs(feedId: string): number {
    let hash = 0;
    for (let i = 0; i < feedId.length; i++) {
      hash = (hash * 31 + feedId.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 5000;
  }

  async ensureScheduled(cfg: SchedulerFeedConfig): Promise<{ scheduled: boolean; nextDueMs: number }> {
    this.config = cfg;
    this.putState("config", JSON.stringify(cfg));

    if (!cfg.enabled || cfg.kind === "gtfs_static") {
      await this.ctx.storage.deleteAlarm();
      this.nextDueMs = 0;
      this.putState("nextDueMs", "0");
      return { scheduled: false, nextDueMs: 0 };
    }

    const existingAlarm = await this.ctx.storage.getAlarm();
    const now = Date.now();
    if (!existingAlarm || existingAlarm < now - 30_000) {
      const next = now + 2000 + this.deterministicJitterMs(cfg.id);
      await this.ctx.storage.setAlarm(next);
      this.nextDueMs = next;
      this.putState("nextDueMs", String(next));
      return { scheduled: true, nextDueMs: next };
    }

    return { scheduled: true, nextDueMs: existingAlarm };
  }

  async getDiagnostics(): Promise<{
    feedId: string | null;
    enabled: boolean;
    pollGeneration: number;
    consecutiveErrors: number;
    nextDueMs: number;
    lastAlarmLatenessMs: number;
    dlqCount: number;
  }> {
    const dlqRow = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT COUNT(*) as c FROM dlq_batches")
      .one();
    return {
      feedId: this.config?.id ?? null,
      enabled: this.config?.enabled ?? false,
      pollGeneration: this.pollGeneration,
      consecutiveErrors: this.consecutiveErrors,
      nextDueMs: this.nextDueMs,
      lastAlarmLatenessMs: this.lastAlarmLatenessMs,
      dlqCount: dlqRow?.c ?? 0,
    };
  }

  async pollNow(force = false): Promise<{
    ok: boolean;
    status: string;
    entities?: number;
    error?: string;
    latencyMs: number;
  }> {
    const startMs = Date.now();
    if (!this.config) {
      return { ok: false, status: "unconfigured", error: "FeedSchedulerDO not configured", latencyMs: 0 };
    }
    if (this.inFlight) {
      return { ok: false, status: "skipped_overlap", latencyMs: 0 };
    }
    if (!this.config.enabled && !force) {
      return { ok: false, status: "disabled", latencyMs: 0 };
    }

    const cfg = this.config;
    this.inFlight = true;
    const nowIso = new Date(startMs).toISOString();

    try {
      // Admission control against free-tier daily quota (PRD §11.1)
      const quota = await getQuotaStatus(this.env.DB, getBudgets(this.env));
      if (quota.tier === "paused_95" && !force) {
        await this.updateFeedRow(cfg.id, {
          status: "unavailable",
          lastFetchAt: nowIso,
          lastError: "Paused at 95% daily free-tier quota guardrail",
        });
        return { ok: false, status: "quota_paused", latencyMs: Date.now() - startMs };
      }

      // Resolve optional API secret (e.g. GO_TRANSIT_API_KEY)
      let requestUrl: URL;
      try {
        requestUrl = validateFeedUrl(cfg.url);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Invalid feed URL";
        await this.updateFeedRow(cfg.id, { status: "quarantined", lastFetchAt: nowIso, lastError: msg });
        return { ok: false, status: "quarantined", error: msg, latencyMs: Date.now() - startMs };
      }

      if (cfg.authSecretRef) {
        const secretVal = this.env[cfg.authSecretRef];
        if (typeof secretVal !== "string" || secretVal.trim().length === 0) {
          await this.updateFeedRow(cfg.id, {
            status: "missing_key",
            lastFetchAt: nowIso,
            lastError: `Awaiting secret binding ${cfg.authSecretRef}`,
          });
          if (cfg.kind === "vehicle_positions") {
            await this.env.AGENCY_LIVE.getByName(cfg.agencyId).updateFeedStatus({
              agencyId: cfg.agencyId,
              feedStatus: "missing_key",
              message: `Configure secret ${cfg.authSecretRef} to activate live feed`,
            });
          }
          return {
            ok: false,
            status: "missing_key",
            error: `Secret ${cfg.authSecretRef} is not configured yet`,
            latencyMs: Date.now() - startMs,
          };
        }
        if (cfg.authQueryParam) {
          requestUrl.searchParams.set(cfg.authQueryParam, secretVal.trim());
        }
      }

      const headers = new Headers({
        "User-Agent": "Swisshost/1.0 (+https://swisshost.cc; public transit reference)",
        Accept: "*/*",
      });
      if (!force && this.lastEtag) headers.set("If-None-Match", this.lastEtag);
      if (!force && this.lastModified) headers.set("If-Modified-Since", this.lastModified);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      let resp: Response;
      try {
        resp = await fetch(requestUrl.toString(), {
          method: "GET",
          headers,
          redirect: "follow",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (resp.status === 304) {
        this.consecutiveErrors = 0;
        this.putState("consecutiveErrors", "0");
        await this.updateFeedRow(cfg.id, { status: "fresh", lastFetchAt: nowIso, lastSuccessAt: nowIso, lastError: null });
        return { ok: true, status: "not_modified", entities: 0, latencyMs: Date.now() - startMs };
      }

      if (!resp.ok) {
        throw new Error(`Upstream HTTP ${resp.status} ${resp.statusText}`);
      }

      // Enforce 12 MB byte cap on realtime payloads
      const contentLength = Number(resp.headers.get("content-length") || "0");
      if (contentLength > 12 * 1024 * 1024) {
        throw new Error(`Realtime feed exceeded 12 MB safety cap (${contentLength} bytes)`);
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.byteLength > 12 * 1024 * 1024) {
        throw new Error(`Realtime feed body exceeded 12 MB safety cap (${bytes.byteLength} bytes)`);
      }

      const etag = resp.headers.get("etag");
      const lastMod = resp.headers.get("last-modified");
      if (etag) {
        this.lastEtag = etag;
        this.putState("lastEtag", etag);
      }
      if (lastMod) {
        this.lastModified = lastMod;
        this.putState("lastModified", lastMod);
      }

      const batch =
        cfg.adapter === "umo-xml"
          ? decodeUmoXmlVehicles(new TextDecoder().decode(bytes), {
              sourceId: cfg.id,
              agencyId: cfg.agencyId,
              receivedAt: nowIso,
            })
          : decodeGtfsRtFeed(bytes, {
              sourceId: cfg.id,
              agencyId: cfg.agencyId,
              feedKind: cfg.kind,
              timezone: cfg.timezone,
              receivedAt: nowIso,
            });

      const result = await processNormalizedBatch(this.env, batch, {
        timezone: cfg.timezone,
        staleAfterSeconds: cfg.staleAfterSeconds,
        archivePermitted: cfg.archivePermitted,
      });

      this.consecutiveErrors = 0;
      this.pollGeneration += 1;
      this.putState("consecutiveErrors", "0");
      this.putState("pollGeneration", String(this.pollGeneration));

      const entityCount =
        result.acceptedObservations + result.tripUpdatesProcessed + result.alertsProcessed;
      const dupRatio =
        result.acceptedObservations > 0
          ? Number((result.duplicateObservations / result.acceptedObservations).toFixed(3))
          : 0;

      await this.updateFeedRow(cfg.id, {
        status: "fresh",
        lastFetchAt: nowIso,
        lastSuccessAt: nowIso,
        lastSourceTs: batch.feedTimestamp,
        lastError: null,
        lastBytes: bytes.byteLength,
        lastEntityCount: entityCount,
        duplicateRatio: dupRatio,
      });

      return {
        ok: true,
        status: "fresh",
        entities: entityCount,
        latencyMs: Date.now() - startMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.consecutiveErrors += 1;
      this.putState("consecutiveErrors", String(this.consecutiveErrors));

      await this.updateFeedRow(cfg.id, {
        status: "unavailable",
        lastFetchAt: nowIso,
        lastError: message.slice(0, 500),
      });

      if (cfg.kind === "vehicle_positions") {
        await this.env.AGENCY_LIVE.getByName(cfg.agencyId).updateFeedStatus({
          agencyId: cfg.agencyId,
          feedStatus: "unavailable",
          message: message.slice(0, 200),
        });
      }

      // Record in bounded DLQ for admin replay/inspection
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO dlq_batches (id, received_at, error, attempts, payload_base64)
         VALUES (?, ?, ?, 1, '')`,
        `${cfg.id}-${Date.now()}`,
        nowIso,
        message.slice(0, 500)
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM dlq_batches WHERE id NOT IN (SELECT id FROM dlq_batches ORDER BY received_at DESC LIMIT 25)`
      );

      return { ok: false, status: "unavailable", error: message, latencyMs: Date.now() - startMs };
    } finally {
      this.inFlight = false;
    }
  }

  async replayDlq(): Promise<{ cleared: number; pollResult: Awaited<ReturnType<FeedSchedulerDO["pollNow"]>> }> {
    const countRow = this.ctx.storage.sql.exec<{ c: number }>("SELECT COUNT(*) as c FROM dlq_batches").one();
    this.ctx.storage.sql.exec("DELETE FROM dlq_batches");
    const pollResult = await this.pollNow(true);
    return { cleared: countRow?.c ?? 0, pollResult };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    if (this.nextDueMs > 0) {
      this.lastAlarmLatenessMs = Math.max(0, now - this.nextDueMs);
    }

    if (!this.config || !this.config.enabled || this.config.kind === "gtfs_static") {
      return;
    }

    await this.pollNow(false);

    // Bounded exponential backoff on repeated failures, plus 85% quota slowdown
    const quota = await getQuotaStatus(this.env.DB, getBudgets(this.env)).catch(() => null);
    const quotaFactor = quota?.tier === "throttle_85" ? 2 : quota?.tier === "paused_95" ? 5 : 1;
    const backoffFactor = Math.min(8, 2 ** Math.min(3, this.consecutiveErrors));
    const intervalMs = Math.max(
      15_000,
      Math.min(900_000, this.config.refreshSeconds * 1000 * backoffFactor * quotaFactor)
    );
    const next = Date.now() + intervalMs + this.deterministicJitterMs(this.config.id);
    this.nextDueMs = next;
    this.putState("nextDueMs", String(next));
    await this.ctx.storage.setAlarm(next);
  }

  private async updateFeedRow(
    feedId: string,
    patch: {
      status: string;
      lastFetchAt: string;
      lastSuccessAt?: string;
      lastSourceTs?: string | null;
      lastError?: string | null;
      lastBytes?: number;
      lastEntityCount?: number;
      duplicateRatio?: number;
    }
  ): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE feeds SET
        status = ?,
        last_fetch_at = ?,
        last_success_at = COALESCE(?, last_success_at),
        last_source_ts = COALESCE(?, last_source_ts),
        last_error = ?,
        last_bytes = COALESCE(?, last_bytes),
        last_entity_count = COALESCE(?, last_entity_count),
        duplicate_ratio = COALESCE(?, duplicate_ratio),
        updated_at = ?
       WHERE id = ?`
    )
      .bind(
        patch.status,
        patch.lastFetchAt,
        patch.lastSuccessAt ?? null,
        patch.lastSourceTs ?? null,
        patch.lastError ?? null,
        patch.lastBytes ?? null,
        patch.lastEntityCount ?? null,
        patch.duplicateRatio ?? null,
        patch.lastFetchAt,
        feedId
      )
      .run();
  }
}
