import { Hono } from "hono";
import { AgencyConfigSchema, FleetCorrectionSchema, createProblemDetails } from "@swisshost/contracts";
import { appendAuditLog, ensureAgenciesSeeded, getQuotaStatus } from "@swisshost/database";
import { validateFeedUrl } from "@swisshost/adapters";
import { importStaticGtfsForAgency, runTwelveHourArchive, runWatchdog } from "../../jobs/src/index";
import type { Env } from "../../api/src/env";
import { getBudgets, hashPassword, sha256Hex, timingSafeEqualString, verifyPassword } from "../../api/src/env";

type AdminVars = { actor: string };

export function createAdminApp() {
  const admin = new Hono<{ Bindings: Env; Variables: AdminVars }>();

  // Public auth status check so /admin shows either 1-time password setup, password sign-in, or console
  admin.get("/auth-status", async (c) => {
    const cfAccessEmail = c.req.header("Cf-Access-Authenticated-User-Email");
    const existingAdmin = await c.env.DB.prepare(
      "SELECT COUNT(*) as c FROM users WHERE role = 'admin'"
    ).first<{ c: number }>();
    const claimed = (existingAdmin?.c ?? 0) > 0;

    if (cfAccessEmail) {
      return c.json({ claimed, authenticated: true, actor: `cf-access:${cfAccessEmail}`, method: "cf_access" });
    }

    const sessionToken =
      c.req.header("X-Session-Token") ??
      c.req.header("Cookie")?.match(/swisshost_session=([^;]+)/)?.[1];
    if (sessionToken) {
      const hash = await sha256Hex(sessionToken);
      const sess = await c.env.DB.prepare(
        `SELECT s.role, u.handle FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
        .bind(hash, new Date().toISOString())
        .first<{ role: string; handle: string }>();
      if (sess?.role === "admin") {
        return c.json({ claimed: true, authenticated: true, actor: `admin:${sess.handle}`, method: "password" });
      }
    }

    return c.json({ claimed, authenticated: false, actor: null, method: null });
  });

  // One-time Admin Password Setup (uses single-use setup code stored in KV, deletes code immediately)
  admin.post("/setup", async (c) => {
    const existingAdmin = await c.env.DB.prepare(
      "SELECT COUNT(*) as c FROM users WHERE role = 'admin'"
    ).first<{ c: number }>();
    if ((existingAdmin?.c ?? 0) > 0) {
      return c.json(
        createProblemDetails(409, "Admin already set up", "Sign in with your admin password instead."),
        409
      );
    }

    const body = (await c.req.json()) as { setupCode?: string; username?: string; password?: string };
    if (!body.setupCode || !body.password || body.password.length < 8) {
      return c.json(
        createProblemDetails(400, "Invalid setup input", "Setup code and a password of at least 8 characters are required."),
        400
      );
    }

    const expectedHash = await c.env.CACHE.get("admin:bootstrap_code_hash");
    if (!expectedHash) {
      return c.json(createProblemDetails(403, "No active setup code", "Admin setup code is not active or expired."), 403);
    }
    const providedHash = await sha256Hex(body.setupCode.trim().toUpperCase());
    if (!timingSafeEqualString(providedHash, expectedHash)) {
      return c.json(createProblemDetails(403, "Invalid setup code", "The setup code did not match."), 403);
    }

    await c.env.CACHE.delete("admin:bootstrap_code_hash");

    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const handle = (body.username?.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "") || "admin").slice(0, 32);
    const pwHash = await hashPassword(body.password);
    const sessionToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    const sessionHash = await sha256Hex(sessionToken);
    const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO users (id, handle, display_name, role, password_hash, created_at, last_login_at)
         VALUES (?, ?, ?, 'admin', ?, ?, ?)`
      ).bind(userId, handle, "Swisshost Admin", pwHash, now, now),
      c.env.DB.prepare(
        `INSERT INTO sessions (token_hash, user_id, role, expires_at, created_at) VALUES (?, ?, 'admin', ?, ?)`
      ).bind(sessionHash, userId, expiresAt, now),
    ]);

    await appendAuditLog(c.env.DB, `admin:${handle}`, "admin.setup", userId, { method: "password" });

    c.header(
      "Set-Cookie",
      `swisshost_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${30 * 86400}`
    );
    return c.json({ ok: true, actor: `admin:${handle}` }, 201);
  });

  // Simple Admin Password Sign-In
  admin.post("/login", async (c) => {
    const body = (await c.req.json()) as { username?: string; password?: string };
    if (!body.password) {
      return c.json(createProblemDetails(400, "Missing password", "Enter your admin password."), 400);
    }
    const handle = body.username?.trim().toLowerCase();
    const user = handle
      ? await c.env.DB.prepare("SELECT id, handle, password_hash, role FROM users WHERE handle = ? AND role = 'admin'")
          .bind(handle)
          .first<{ id: string; handle: string; password_hash: string | null; role: string }>()
      : await c.env.DB.prepare("SELECT id, handle, password_hash, role FROM users WHERE role = 'admin' LIMIT 1")
          .first<{ id: string; handle: string; password_hash: string | null; role: string }>();

    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      return c.json(createProblemDetails(401, "Invalid credentials", "Wrong username or password."), 401);
    }

    const now = new Date().toISOString();
    const sessionToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    const sessionHash = await sha256Hex(sessionToken);
    const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();

    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now, user.id),
      c.env.DB.prepare(
        "INSERT INTO sessions (token_hash, user_id, role, expires_at, created_at) VALUES (?, ?, 'admin', ?, ?)"
      ).bind(sessionHash, user.id, expiresAt, now),
    ]);

    c.header(
      "Set-Cookie",
      `swisshost_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${30 * 86400}`
    );
    return c.json({ ok: true, actor: `admin:${user.handle}` });
  });

  // Authorize via Cloudflare Access header, Bearer ADMIN_API_TOKEN, or admin session cookie
  admin.use("*", async (c, next) => {
    const cfAccessEmail = c.req.header("Cf-Access-Authenticated-User-Email");
    if (cfAccessEmail) {
      c.set("actor", `cf-access:${cfAccessEmail}`);
      return next();
    }

    const authHeader = c.req.header("Authorization");
    const adminToken = c.env.ADMIN_API_TOKEN;
    if (authHeader?.startsWith("Bearer ") && adminToken) {
      const provided = authHeader.slice(7).trim();
      if (timingSafeEqualString(provided, adminToken)) {
        c.set("actor", "admin-token");
        return next();
      }
    }

    // Check signed session cookie / header for admin role
    const sessionToken =
      c.req.header("X-Session-Token") ??
      c.req
        .header("Cookie")
        ?.match(/swisshost_session=([^;]+)/)?.[1];
    if (sessionToken) {
      const hash = await sha256Hex(sessionToken);
      const sess = await c.env.DB.prepare(
        `SELECT s.role, u.handle FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
        .bind(hash, new Date().toISOString())
        .first<{ role: string; handle: string }>();
      if (sess?.role === "admin") {
        c.set("actor", `user:${sess.handle}`);
        return next();
      }
    }

    return c.json(
      createProblemDetails(
        401,
        "Admin authorization required",
        "Authenticate with Cloudflare Access, an admin session, or Bearer ADMIN_API_TOKEN."
      ),
      401
    );
  });

  admin.get("/overview", async (c) => {
    const [agencies, feeds, versions, archives, audits, quota] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM agencies ORDER BY name ASC").all(),
      c.env.DB.prepare("SELECT * FROM feeds ORDER BY agency_id, kind").all(),
      c.env.DB.prepare("SELECT * FROM feed_versions ORDER BY created_at DESC LIMIT 20").all(),
      c.env.DB.prepare("SELECT * FROM archive_manifests ORDER BY created_at DESC LIMIT 20").all(),
      c.env.DB.prepare("SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 30").all(),
      getQuotaStatus(c.env.DB, getBudgets(c.env)),
    ]);

    const schedulerDiagnostics = await Promise.all(
      (feeds.results as Array<{ id: string; kind: string }>)
        .filter((f) => f.kind !== "gtfs_static")
        .map(async (f) => {
          const diag = await c.env.FEED_SCHEDULER.getByName(f.id).getDiagnostics();
          return diag;
        })
    );

    return c.json({
      actor: c.get("actor"),
      quota,
      agencies: agencies.results,
      feeds: feeds.results,
      schedulerDiagnostics,
      versions: versions.results,
      archives: archives.results,
      audits: audits.results,
      secretsStatus: {
        GO_TRANSIT_API_KEY: Boolean(c.env.GO_TRANSIT_API_KEY),
        GITHUB_ARCHIVE_TOKEN: Boolean(c.env.GITHUB_ARCHIVE_TOKEN),
        ADMIN_API_TOKEN: Boolean(c.env.ADMIN_API_TOKEN),
        VAPID_PUBLIC_KEY: Boolean(c.env.VAPID_PUBLIC_KEY),
      },
    });
  });

  admin.post("/watchdog", async (c) => {
    const res = await runWatchdog(c.env);
    await appendAuditLog(c.env.DB, c.get("actor"), "watchdog.run", "all", res);
    return c.json(res);
  });

  admin.post("/feeds/:feedId/poll", async (c) => {
    const feedId = c.req.param("feedId");
    const feed = await c.env.DB.prepare(
      `SELECT f.*, a.timezone, a.archive_policy FROM feeds f JOIN agencies a ON a.id = f.agency_id WHERE f.id = ?`
    )
      .bind(feedId)
      .first<Record<string, unknown>>();
    if (!feed) {
      return c.json(createProblemDetails(404, "Feed not found", `No feed with id ${feedId}`), 404);
    }

    const stub = c.env.FEED_SCHEDULER.getByName(feedId);
    await stub.ensureScheduled({
      id: String(feed.id),
      agencyId: String(feed.agency_id),
      kind: feed.kind as "vehicle_positions" | "trip_updates" | "service_alerts" | "gtfs_static",
      adapter: String(feed.adapter),
      url: String(feed.url),
      fallbackUrl: (feed.fallback_url as string | null) ?? null,
      authQueryParam: (feed.auth_query_param as string | null) ?? null,
      authSecretRef: (feed.auth_secret_ref as string | null) ?? null,
      refreshSeconds: Number(feed.refresh_seconds),
      staleAfterSeconds: Number(feed.stale_after_seconds),
      timezone: String(feed.timezone),
      archivePermitted: feed.archive_policy !== "prohibited",
      enabled: Number(feed.enabled) === 1,
    });
    const result = await stub.pollNow(true);
    await appendAuditLog(c.env.DB, c.get("actor"), "feed.poll", feedId, result);
    return c.json(result);
  });

  admin.patch("/feeds/:feedId", async (c) => {
    const feedId = c.req.param("feedId");
    const body = (await c.req.json()) as {
      enabled?: boolean;
      refreshSeconds?: number;
      quarantined?: boolean;
      url?: string;
    };

    if (body.url) {
      try {
        validateFeedUrl(body.url);
      } catch (e) {
        return c.json(
          createProblemDetails(400, "Invalid feed URL", e instanceof Error ? e.message : "URL rejected"),
          400
        );
      }
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE feeds SET
        enabled = COALESCE(?, enabled),
        refresh_seconds = COALESCE(?, refresh_seconds),
        quarantined = COALESCE(?, quarantined),
        url = COALESCE(?, url),
        config_version = config_version + 1,
        updated_at = ?
       WHERE id = ?`
    )
      .bind(
        body.enabled !== undefined ? (body.enabled ? 1 : 0) : null,
        body.refreshSeconds ?? null,
        body.quarantined !== undefined ? (body.quarantined ? 1 : 0) : null,
        body.url ?? null,
        now,
        feedId
      )
      .run();

    await runWatchdog(c.env);
    await appendAuditLog(c.env.DB, c.get("actor"), "feed.update", feedId, body);
    return c.json({ ok: true, feedId });
  });

  admin.post("/feeds/:feedId/replay-dlq", async (c) => {
    const feedId = c.req.param("feedId");
    const res = await c.env.FEED_SCHEDULER.getByName(feedId).replayDlq();
    await appendAuditLog(c.env.DB, c.get("actor"), "feed.replay_dlq", feedId, res);
    return c.json(res);
  });

  // Generic agency/feed onboarding without deploying new frontend code (PRD F14)
  admin.post("/agencies", async (c) => {
    const raw = await c.req.json();
    const parsed = AgencyConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        createProblemDetails(400, "Invalid agency configuration", parsed.error.issues.map((i) => i.message).join("; ")),
        400
      );
    }

    for (const feed of parsed.data.feeds) {
      try {
        validateFeedUrl(feed.url, true);
      } catch (e) {
        return c.json(
          createProblemDetails(400, "Blocked feed URL", e instanceof Error ? e.message : "SSRF check failed"),
          400
        );
      }
    }

    await ensureAgenciesSeeded(c.env.DB, [parsed.data]);
    await appendAuditLog(c.env.DB, c.get("actor"), "agency.onboard", parsed.data.id, {
      feeds: parsed.data.feeds.map((f) => f.id),
    });
    return c.json({ ok: true, agencyId: parsed.data.id }, 201);
  });

  admin.post("/agencies/:agencyId/import-static", async (c) => {
    const agencyId = c.req.param("agencyId");
    try {
      const result = await importStaticGtfsForAgency(c.env, agencyId);
      await appendAuditLog(c.env.DB, c.get("actor"), "static.import", agencyId, result);
      return c.json(result);
    } catch (err) {
      return c.json(
        createProblemDetails(422, "Static GTFS import failed", err instanceof Error ? err.message : String(err)),
        422
      );
    }
  });

  admin.post("/agencies/:agencyId/rollback-static", async (c) => {
    const agencyId = c.req.param("agencyId");
    const prev = await c.env.DB.prepare(
      `SELECT id FROM feed_versions WHERE agency_id = ? AND status = 'archived' ORDER BY created_at DESC LIMIT 1`
    )
      .bind(agencyId)
      .first<{ id: string }>();

    if (!prev) {
      return c.json(createProblemDetails(404, "No previous version", "No archived static version available to roll back to."), 404);
    }

    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE feed_versions SET status = 'rolled_back' WHERE agency_id = ? AND status = 'active'`).bind(agencyId),
      c.env.DB.prepare(`UPDATE feed_versions SET status = 'active', activated_at = ? WHERE id = ?`).bind(now, prev.id),
    ]);
    await c.env.CACHE.delete(`routes:${agencyId}`);
    await appendAuditLog(c.env.DB, c.get("actor"), "static.rollback", agencyId, { versionId: prev.id });
    return c.json({ ok: true, activeVersionId: prev.id });
  });

  admin.post("/archive/run", async (c) => {
    const res = await runTwelveHourArchive(c.env);
    await appendAuditLog(c.env.DB, c.get("actor"), "archive.run", "swisshost-data", {
      committedWindows: res.committedWindows,
      skippedReason: res.skippedReason,
    });
    return c.json(res);
  });

  // Fleet metadata correction with provenance & audit log (PRD F07)
  admin.patch("/agencies/:agencyId/vehicles/:vehicleId", async (c) => {
    const agencyId = c.req.param("agencyId");
    const vehicleId = c.req.param("vehicleId");
    const parsed = FleetCorrectionSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        createProblemDetails(400, "Invalid fleet metadata", parsed.error.issues.map((i) => i.message).join("; ")),
        400
      );
    }

    const d = parsed.data;
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE vehicles SET
        fleet_number = COALESCE(?, fleet_number),
        vehicle_type = COALESCE(?, vehicle_type),
        manufacturer = COALESCE(?, manufacturer),
        model = COALESCE(?, model),
        year = COALESCE(?, year),
        propulsion = COALESCE(?, propulsion),
        accessibility = COALESCE(?, accessibility),
        garage = COALESCE(?, garage),
        photo_url = COALESCE(?, photo_url),
        photo_license = COALESCE(?, photo_license),
        metadata_source = ?,
        updated_at = ?
       WHERE agency_id = ? AND vehicle_id = ?`
    )
      .bind(
        d.fleetNumber ?? null,
        d.vehicleType ?? null,
        d.manufacturer ?? null,
        d.model ?? null,
        d.year ?? null,
        d.propulsion ?? null,
        d.accessibility ?? null,
        d.garage ?? null,
        d.photoUrl ?? null,
        d.photoLicense ?? null,
        d.metadataSource,
        now,
        agencyId,
        vehicleId
      )
      .run();

    await appendAuditLog(c.env.DB, c.get("actor"), "fleet.update", `${agencyId}/${vehicleId}`, d);
    return c.json({ ok: true, agencyId, vehicleId });
  });

  return admin;
}
