import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, CheckCircle2, Star } from "lucide-react";
import { apiJson, formatRelativeAge } from "../lib/api";
import { usePreferences } from "../lib/preferences";

export function AlertsPage() {
  const { agencyId } = usePreferences();
  const effectiveAgency = agencyId === "all" ? "guelph" : agencyId;
  const [historical, setHistorical] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["alerts", effectiveAgency, historical],
    queryFn: () =>
      apiJson<{
        agencyId: string;
        alerts: Array<{
          id: string;
          cause: string;
          effect: string;
          headerText: string;
          descriptionText: string;
          url: string | null;
          active: boolean;
          lastSeenAt: string;
          informedEntities: Array<{ routeId?: string; stopId?: string }>;
        }>;
      }>(`/api/v1/agencies/${effectiveAgency}/alerts?historical=${historical}`),
  });

  return (
    <div className="sh-page sh-page-narrow">
      <div className="sh-page-head">
        <div>
          <div className="sh-kicker">
            {effectiveAgency.toUpperCase()} Advisories
          </div>
          <h1 className="sh-title">Service Alerts</h1>
        </div>
        <label className="text-xs font-semibold flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={historical} onChange={(e) => setHistorical(e.target.checked)} />
          Include historical alerts
        </label>
      </div>

      {isLoading && <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading alerts…</p>}

      {(data?.alerts ?? []).length === 0 ? (
        <div className="sh-card p-6 text-sm flex items-center gap-3" style={{ color: "var(--text-muted)" }}>
          <CheckCircle2 size={18} style={{ color: "var(--status-ok)" }} />
          No active service alerts reported for {effectiveAgency.toUpperCase()}.
        </div>
      ) : (
        <div className="space-y-3">
          {data!.alerts.map((a) => (
            <article key={a.id} className="sh-card p-4 space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="font-bold text-sm flex items-center gap-2">
                  <AlertTriangle size={15} style={{ color: "var(--status-warn)" }} />
                  {a.headerText}
                </div>
                <span className="sh-pill sh-pill-muted">
                  {a.effect} · {formatRelativeAge(a.lastSeenAt)}
                </span>
              </div>
              {a.descriptionText && <p className="text-sm m-0" style={{ color: "var(--text-muted)" }}>{a.descriptionText}</p>}
              <div className="flex flex-wrap gap-2 pt-1 text-xs font-semibold">
                {a.informedEntities.map((e, i) =>
                  e.routeId ? (
                    <Link key={i} to={`/routes/${effectiveAgency}/${encodeURIComponent(e.routeId)}`}>
                      <span className="sh-route-shield text-white" style={{ backgroundColor: "#E2001A" }}>
                        {e.routeId}
                      </span>
                    </Link>
                  ) : e.stopId ? (
                    <Link key={i} to={`/stops/${effectiveAgency}/${encodeURIComponent(e.stopId)}`}>
                      Stop {e.stopId}
                    </Link>
                  ) : null
                )}
                {a.url && (
                  <a href={a.url} target="_blank" rel="noreferrer">
                    Agency advisory ↗
                  </a>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function StatusPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["public-status"],
    queryFn: () =>
      apiJson<{
        platformStatus: string;
        serverTime: string;
        quota: {
          tier: string;
          maxRatio: number;
          d1Writes: number;
          d1WriteBudget: number;
          doRequests: number;
          doRequestBudget: number;
        };
        feeds: Array<{
          id: string;
          agency_id: string;
          kind: string;
          status: string;
          refresh_seconds: number;
          last_success_at: string | null;
          last_error: string | null;
          last_entity_count: number;
          duplicate_ratio: number;
        }>;
        archives: Array<{
          agency_id: string;
          window_key: string;
          status: string;
          row_count: number;
          commit_sha: string | null;
          verified_at: string | null;
        }>;
      }>("/api/v1/status"),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) return <div className="sh-page text-sm">Loading status…</div>;

  const d1Pct = Math.min(100, Math.round((data.quota.d1Writes / Math.max(1, data.quota.d1WriteBudget)) * 100));
  const doPct = Math.min(100, Math.round((data.quota.doRequests / Math.max(1, data.quota.doRequestBudget)) * 100));

  return (
    <div className="sh-page">
      <div className="sh-page-head">
        <div>
          <div className="sh-kicker">
            Observability &amp; Free-Tier Guardrails
          </div>
          <h1 className="sh-title">Feed Status &amp; Capacity</h1>
        </div>
        <span className={`sh-pill ${data.platformStatus === "operational" ? "sh-pill-ok" : "sh-pill-warn"}`}>
          Platform: {data.platformStatus} · Quota tier: {data.quota.tier}
        </span>
      </div>

      {/* Quota Progress Bars */}
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="sh-card p-4 space-y-2">
          <div className="flex justify-between text-xs font-semibold">
            <span>Daily D1 Writes (Free Budget)</span>
            <span className="tabular-nums">{data.quota.d1Writes.toLocaleString()} / {data.quota.d1WriteBudget.toLocaleString()} ({d1Pct}%)</span>
          </div>
          <div className="h-2 overflow-hidden" style={{ background: "var(--surface)" }}>
            <div className="h-full" style={{ width: `${d1Pct}%`, background: d1Pct >= 85 ? "var(--signal)" : "var(--ink)" }} />
          </div>
        </div>
        <div className="sh-card p-4 space-y-2">
          <div className="flex justify-between text-xs font-semibold">
            <span>Daily Durable Object Requests</span>
            <span className="tabular-nums">{data.quota.doRequests.toLocaleString()} / {data.quota.doRequestBudget.toLocaleString()} ({doPct}%)</span>
          </div>
          <div className="h-2 overflow-hidden" style={{ background: "var(--surface)" }}>
            <div className="h-full" style={{ width: `${doPct}%`, background: doPct >= 85 ? "var(--signal)" : "var(--ink)" }} />
          </div>
        </div>
      </div>

      <section className="space-y-2.5">
        <h2 className="sh-section-title">Upstream Agency Feeds</h2>
        <div className="sh-table-wrap">
          <table className="sh-table">
            <thead>
              <tr>
                <th>Feed</th>
                <th>Agency</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Entities</th>
                <th>Last Success</th>
                <th>Diagnostics</th>
              </tr>
            </thead>
            <tbody>
              {data.feeds.map((f) => (
                <tr key={f.id}>
                  <td className="font-mono text-xs font-semibold">{f.id}</td>
                  <td className="uppercase text-xs font-bold">{f.agency_id}</td>
                  <td className="text-xs">{f.kind}</td>
                  <td>
                    <span
                      className={`sh-pill ${
                        f.status === "fresh"
                          ? "sh-pill-ok"
                          : f.status === "missing_key"
                            ? "sh-pill-warn"
                            : f.status === "unknown"
                              ? "sh-pill-muted"
                              : "sh-pill-err"
                      }`}
                    >
                      {f.status}
                    </span>
                  </td>
                  <td className="tabular-nums">{f.last_entity_count ?? 0}</td>
                  <td className="text-xs tabular-nums">{formatRelativeAge(f.last_success_at)}</td>
                  <td className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {f.last_error || "OK"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2.5">
        <h2 className="sh-section-title">12-Hour GitHub Archive (swisshost-data)</h2>
        <div className="sh-table-wrap">
          <table className="sh-table">
            <thead>
              <tr>
                <th>Agency</th>
                <th>Window (UTC)</th>
                <th>Status</th>
                <th>Rows</th>
                <th>Commit</th>
              </tr>
            </thead>
            <tbody>
              {data.archives.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ color: "var(--text-muted)" }}>
                    First 12-hour archive window seals at the next 00:00 or 12:00 UTC backup cycle.
                  </td>
                </tr>
              ) : (
                data.archives.map((a, i) => (
                  <tr key={i}>
                    <td className="uppercase text-xs font-bold">{a.agency_id}</td>
                    <td className="font-mono text-xs">{a.window_key}</td>
                    <td><span className="sh-pill sh-pill-muted">{a.status}</span></td>
                    <td className="tabular-nums">{a.row_count}</td>
                    <td className="font-mono text-xs">{a.commit_sha ? a.commit_sha.slice(0, 8) : "—"}</td>
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

export function FavoritesPage() {
  const { favorites, toggleFavorite } = usePreferences();

  const entityLink = (f: (typeof favorites)[number]) => {
    if (f.entityType === "route") return `/routes/${f.agencyId}/${encodeURIComponent(f.entityId)}`;
    if (f.entityType === "stop") return `/stops/${f.agencyId}/${encodeURIComponent(f.entityId)}`;
    if (f.entityType === "vehicle") return `/vehicles/${f.agencyId}/${encodeURIComponent(f.entityId)}`;
    return `/trips/${f.agencyId}/${encodeURIComponent(f.entityId)}`;
  };

  return (
    <div className="sh-page sh-page-narrow">
      <div className="flex items-end justify-between">
        <div>
          <div className="sh-kicker">
            Saved Locally &amp; Offline-Ready
          </div>
          <h1 className="sh-title flex items-center gap-2">
            <Star size={20} style={{ color: "var(--gold-accent)" }} /> Favorites ({favorites.length})
          </h1>
        </div>
        <Link to="/account" className="text-xs font-semibold">
          Sync &amp; alerts</Link>
      </div>

      {favorites.length === 0 ? (
        <div className="sh-card p-6 text-sm text-center" style={{ color: "var(--text-muted)" }}>
          No favorites saved yet. Star any route, stop, or vehicle to pin it here.
        </div>
      ) : (
        <div className="sh-table-wrap">
          <table className="sh-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Type</th>
                <th>Agency</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {favorites.map((f) => (
                <tr key={`${f.agencyId}-${f.entityType}-${f.entityId}`}>
                  <td className="font-semibold">
                    <Link to={entityLink(f)}>{f.label}</Link>
                  </td>
                  <td><span className="sh-pill sh-pill-muted uppercase">{f.entityType}</span></td>
                  <td className="text-xs uppercase font-bold">{f.agencyId}</td>
                  <td className="text-right">
                    <button type="button" className="sh-btn text-xs" onClick={() => toggleFavorite(f)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AccountPage() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [subAgency, setSubAgency] = useState("ttc");
  const [subVehicle, setSubVehicle] = useState("");
  const [subRoute, setSubRoute] = useState("");

  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => apiJson<{ user: { id: string; handle: string; displayName: string; role: string } | null }>("/api/v1/me"),
  });

  const { data: subsData } = useQuery({
    queryKey: ["my-subs"],
    queryFn: () =>
      apiJson<{
        subscriptions: Array<{ id: string; agency_id: string; target_type: string; target_id: string; rule_json: string }>;
        notifications: Array<{ id: string; title: string; body: string; link: string | null; created_at: string }>;
      }>("/api/v1/me/subscriptions"),
    enabled: Boolean(me?.user),
  });

  const submitAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg(mode === "register" ? "Creating account…" : "Signing in…");
    try {
      await apiJson(mode === "register" ? "/api/v1/auth/register" : "/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ handle, password }),
      });
      setPassword("");
      setStatusMsg(null);
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setStatusMsg((err as Error).message);
    }
  };

  const addSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subVehicle.trim()) return;
    await apiJson("/api/v1/me/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        agencyId: subAgency,
        targetType: "vehicle",
        targetId: subVehicle.trim(),
        rule: subRoute.trim()
          ? { event: "vehicle_on_route", routeId: subRoute.trim() }
          : { event: "vehicle_enters_service" },
        channel: "in_app",
      }),
    });
    setSubVehicle("");
    setSubRoute("");
    await qc.invalidateQueries({ queryKey: ["my-subs"] });
  };

  return (
    <div className="sh-page sh-page-narrow">
      <div>
        <div className="sh-kicker">
          Optional Sync &amp; Vehicle Alerts
        </div>
        <h1 className="sh-title">Account &amp; Notifications</h1>
        <p className="text-xs m-0 mt-1" style={{ color: "var(--text-muted)" }}>
          Public browsing never requires an account. Create an optional handle &amp; password to watch specific fleet numbers.
        </p>
      </div>

      {statusMsg && <div className="sh-card p-3 text-xs font-medium">{statusMsg}</div>}

      {!me?.user ? (
        <form onSubmit={submitAuth} className="sh-card p-5 max-w-md space-y-4">
          <div className="flex gap-1 p-1 border" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <button
              type="button"
              onClick={() => setMode("login")}
              className="flex-1 py-1.5 text-xs font-bold border-0 cursor-pointer"
              style={{
                background: mode === "login" ? "var(--bg-elevated)" : "transparent",
                color: mode === "login" ? "var(--text)" : "var(--text-muted)",
              }}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => setMode("register")}
              className="flex-1 py-1.5 text-xs font-bold border-0 cursor-pointer"
              style={{
                background: mode === "register" ? "var(--bg-elevated)" : "transparent",
                color: mode === "register" ? "var(--text)" : "var(--text-muted)",
              }}
            >
              Create Account
            </button>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold mb-1">Handle</label>
              <input
                type="text"
                required
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="e.g. railfan"
                className="sh-input w-full"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Password (8+ characters)</label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="sh-input w-full"
              />
            </div>
          </div>
          <button type="submit" className="sh-btn sh-btn-primary w-full">
            {mode === "register" ? "Create Account" : "Sign In"}
          </button>
        </form>
      ) : (
        <div className="space-y-5">
          <div className="sh-card p-4 flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              Signed in as <strong>{me.user.displayName}</strong> (<code>@{me.user.handle}</code>)
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="sh-btn"
                onClick={async () => {
                  await apiJson("/api/v1/auth/logout", { method: "POST" });
                  await qc.invalidateQueries({ queryKey: ["me"] });
                }}
              >
                Sign out
              </button>
              <button
                type="button"
                className="sh-btn"
                onClick={async () => {
                  if (!confirm("Delete your Swisshost account and subscriptions?")) return;
                  await apiJson("/api/v1/me", { method: "DELETE" });
                  await qc.invalidateQueries({ queryKey: ["me"] });
                }}
              >
                Delete Account
              </button>
            </div>
          </div>

          <form onSubmit={addSubscription} className="sh-card p-4 flex flex-wrap items-end gap-3 text-sm">
            <div>
              <label className="block text-xs font-semibold mb-1" style={{ color: "var(--text-muted)" }}>Agency</label>
              <select value={subAgency} onChange={(e) => setSubAgency(e.target.value)} className="sh-input">
                <option value="guelph">Guelph Transit</option>
                <option value="ttc">TTC</option>
                <option value="go">GO Transit</option>
                <option value="thunderbay">Thunder Bay Transit</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1" style={{ color: "var(--text-muted)" }}>Fleet #</label>
              <input
                type="text"
                value={subVehicle}
                onChange={(e) => setSubVehicle(e.target.value)}
                placeholder="e.g. 4401"
                className="sh-input w-36"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1" style={{ color: "var(--text-muted)" }}>Route (optional)</label>
              <input
                type="text"
                value={subRoute}
                onChange={(e) => setSubRoute(e.target.value)}
                placeholder="Any route"
                className="sh-input w-32"
              />
            </div>
            <button type="submit" className="sh-btn sh-btn-primary">
              <Bell size={14} /> Watch Vehicle
            </button>
          </form>

          <section className="space-y-2">
            <h2 className="sh-section-title">Active Watches ({subsData?.subscriptions.length ?? 0})</h2>
            <div className="sh-table-wrap">
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>Agency</th>
                    <th>Target</th>
                    <th>Rule</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(subsData?.subscriptions ?? []).map((s) => (
                    <tr key={s.id}>
                      <td className="uppercase text-xs font-bold">{s.agency_id}</td>
                      <td>{s.target_type} #{s.target_id}</td>
                      <td className="font-mono text-xs">{s.rule_json}</td>
                      <td className="text-right">
                        <button
                          type="button"
                          className="sh-btn text-xs"
                          onClick={async () => {
                            await apiJson(`/api/v1/me/subscriptions/${s.id}`, { method: "DELETE" });
                            await qc.invalidateQueries({ queryKey: ["my-subs"] });
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
