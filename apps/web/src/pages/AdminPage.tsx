import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Lock, Play, RefreshCw, ShieldCheck } from "lucide-react";
import { apiJson, formatRelativeAge } from "../lib/api";

export default function AdminPage() {
  const qc = useQueryClient();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: authStatus, isLoading: authLoading, refetch: refetchAuth } = useQuery({
    queryKey: ["admin-auth-status"],
    queryFn: () =>
      apiJson<{ claimed: boolean; authenticated: boolean; actor: string | null; method: string | null }>(
        "/admin/auth-status"
      ),
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () =>
      apiJson<{
        actor: string;
        quota: { tier: string; maxRatio: number; d1Writes: number; d1WriteBudget: number; doRequests: number; doRequestBudget: number };
        agencies: Array<{ id: string; name: string; enabled: number }>;
        feeds: Array<{
          id: string;
          agency_id: string;
          kind: string;
          status: string;
          enabled: number;
          refresh_seconds: number;
          last_success_at: string | null;
          last_error: string | null;
          last_entity_count: number;
        }>;
        archives: Array<{ agency_id: string; window_key: string; status: string; row_count: number; commit_sha: string | null }>;
        audits: Array<{ id: string; actor: string; action: string; target: string; created_at: string }>;
        secretsStatus: Record<string, boolean>;
      }>("/admin/overview"),
    enabled: Boolean(authStatus?.authenticated),
    retry: false,
  });

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      if (authStatus && !authStatus.claimed) {
        await apiJson("/admin/setup", {
          method: "POST",
          body: JSON.stringify({ setupCode, username, password }),
        });
      } else {
        await apiJson("/admin/login", {
          method: "POST",
          body: JSON.stringify({ username, password }),
        });
      }
      setPassword("");
      setSetupCode("");
      await refetchAuth();
      await qc.invalidateQueries({ queryKey: ["admin-overview"] });
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const runAction = async (label: string, path: string, method = "POST", body?: unknown) => {
    setMessage(`${label}…`);
    try {
      const res = await apiJson(path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      setMessage(`${label} completed: ${JSON.stringify(res).slice(0, 220)}`);
      await qc.invalidateQueries({ queryKey: ["admin-overview"] });
    } catch (err) {
      setMessage(`${label} failed: ${(err as Error).message}`);
    }
  };

  if (authLoading) {
    return <div className="sh-page text-sm">Checking admin session…</div>;
  }

  // Clean Password Setup or Password Login Screen (Zero passkeys, zero Bearer tokens to copy)
  if (!authStatus?.authenticated) {
    const needsSetup = !authStatus?.claimed;
    return (
      <div className="max-w-md mx-auto w-full px-4 py-12">
        <form onSubmit={handleAuthSubmit} className="sh-card p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 flex items-center justify-center" style={{ background: "var(--primary-soft)", color: "var(--primary)" }}>
              <Lock size={18} />
            </div>
            <div>
              <h1 className="sh-title sh-title-sm">
                {needsSetup ? "Create Admin Login" : "Admin Sign In"}
              </h1>
              <p className="text-xs m-0" style={{ color: "var(--text-muted)" }}>
                {needsSetup
                  ? "Enter your one-time setup code and choose a password. Stays signed in for 30 days."
                  : "Sign in with your Swisshost admin password."}
              </p>
            </div>
          </div>

          {message && (
            <div className="p-2.5 text-xs font-medium" style={{ background: "var(--status-err-bg)", color: "var(--status-err)" }}>
              {message}
            </div>
          )}

          <div className="space-y-3">
            {needsSetup && (
              <div>
                <label className="block text-xs font-semibold mb-1">One-Time Setup Code</label>
                <input
                  type="text"
                  required
                  value={setupCode}
                  onChange={(e) => setSetupCode(e.target.value)}
                  placeholder="6-character code"
                  className="sh-input w-full font-mono"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold mb-1">Username</label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="sh-input w-full"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Password</label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={needsSetup ? "Choose a strong password (8+ chars)" : "Enter password"}
                className="sh-input w-full"
              />
            </div>
          </div>

          <button type="submit" disabled={submitting} className="sh-btn sh-btn-primary w-full py-2">
            {submitting ? "Working…" : needsSetup ? "Set Admin Password & Enter" : "Sign In"}
          </button>
        </form>
      </div>
    );
  }

  const d1Pct = data ? Math.min(100, Math.round((data.quota.d1Writes / Math.max(1, data.quota.d1WriteBudget)) * 100)) : 0;

  return (
    <div className="sh-page">
      <div className="sh-page-head">
        <div>
          <div className="sh-kicker flex items-center gap-1.5">
            <ShieldCheck size={14} /> Signed in as {authStatus.actor}
          </div>
          <h1 className="sh-title">Feed Operations &amp; Admin</h1>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" className="sh-btn sh-btn-primary" onClick={() => runAction("Watchdog", "/admin/watchdog")}>
            <RefreshCw size={13} /> Run Watchdog
          </button>
          <button type="button" className="sh-btn" onClick={() => runAction("12h GitHub Archive", "/admin/archive/run")}>
            <Archive size={13} /> Run Archive
          </button>
          <button
            type="button"
            className="sh-btn"
            onClick={async () => {
              await apiJson("/api/v1/auth/logout", { method: "POST" });
              await refetchAuth();
            }}
          >
            Sign Out
          </button>
        </div>
      </div>

      {message && <div className="sh-card px-3.5 py-2.5 text-xs font-mono break-all">{message}</div>}
      {isLoading && <p className="text-sm">Loading diagnostics…</p>}
      {error && <div className="sh-card p-4 text-sm" style={{ color: "var(--status-err)" }}>{(error as Error).message}</div>}

      {data && (
        <div className="space-y-6">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sh-card p-4 space-y-2">
              <div className="flex justify-between text-xs font-bold">
                <span>Daily D1 Quota ({data.quota.tier})</span>
                <span className="tabular-nums">{data.quota.d1Writes.toLocaleString()} / {data.quota.d1WriteBudget.toLocaleString()} ({d1Pct}%)</span>
              </div>
              <div className="h-2 overflow-hidden" style={{ background: "var(--surface)" }}>
                <div className="h-full" style={{ width: `${d1Pct}%`, background: d1Pct >= 85 ? "var(--signal)" : "var(--ink)" }} />
              </div>
            </div>
            <div className="sh-card p-4 space-y-1.5 text-xs">
              <div className="font-bold">Configured Worker Secrets</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.secretsStatus).map(([k, ok]) => (
                  <span key={k} className={`sh-pill ${ok ? "sh-pill-ok" : "sh-pill-warn"}`}>
                    {k}: {ok ? "set" : "missing"}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <section className="space-y-2.5">
            <h2 className="sh-section-title">Feeds ({data.feeds.length})</h2>
            <div className="sh-table-wrap">
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>Feed</th>
                    <th>Agency</th>
                    <th>Status</th>
                    <th>Entities</th>
                    <th>Last Success</th>
                    <th className="text-right">Controls</th>
                  </tr>
                </thead>
                <tbody>
                  {data.feeds.map((f) => (
                    <tr key={f.id}>
                      <td className="font-mono text-xs font-semibold">{f.id}</td>
                      <td className="uppercase text-xs font-bold">{f.agency_id}</td>
                      <td>
                        <span
                          className={`sh-pill ${
                            f.status === "fresh"
                              ? "sh-pill-ok"
                              : f.status === "missing_key"
                                ? "sh-pill-warn"
                                : "sh-pill-muted"
                          }`}
                        >
                          {f.status}
                        </span>
                        {f.last_error && (
                          <div className="text-[11px] mt-0.5 max-w-xs truncate" style={{ color: "var(--text-muted)" }}>
                            {f.last_error}
                          </div>
                        )}
                      </td>
                      <td className="tabular-nums">{f.last_entity_count ?? 0}</td>
                      <td className="text-xs tabular-nums">{formatRelativeAge(f.last_success_at)}</td>
                      <td className="text-right space-x-1.5 whitespace-nowrap">
                        {f.kind === "gtfs_static" ? (
                          <>
                            <button
                              type="button"
                              className="sh-btn py-1 px-2 text-xs"
                              onClick={() => runAction(`Import ${f.agency_id}`, `/admin/agencies/${f.agency_id}/import-static`)}
                            >
                              Import
                            </button>
                            <button
                              type="button"
                              className="sh-btn py-1 px-2 text-xs"
                              onClick={() => runAction(`Rollback ${f.agency_id}`, `/admin/agencies/${f.agency_id}/rollback-static`)}
                            >
                              Rollback
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="sh-btn py-1 px-2 text-xs"
                              onClick={() => runAction(`Poll ${f.id}`, `/admin/feeds/${f.id}/poll`)}
                            >
                              <Play size={11} /> Poll
                            </button>
                            <button
                              type="button"
                              className="sh-btn py-1 px-2 text-xs"
                              onClick={() =>
                                runAction(`Toggle ${f.id}`, `/admin/feeds/${f.id}`, "PATCH", {
                                  enabled: f.enabled !== 1,
                                })
                              }
                            >
                              {f.enabled === 1 ? "Disable" : "Enable"}
                            </button>
                            <button
                              type="button"
                              className="sh-btn py-1 px-2 text-xs"
                              onClick={() => runAction(`Replay DLQ ${f.id}`, `/admin/feeds/${f.id}/replay-dlq`)}
                            >
                              Replay DLQ
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-2.5">
            <h2 className="sh-section-title">Audit Log</h2>
            <div className="sh-table-wrap">
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {data.audits.map((a) => (
                    <tr key={a.id}>
                      <td className="text-xs font-mono tabular-nums">{new Date(a.created_at).toLocaleString()}</td>
                      <td className="text-xs">{a.actor}</td>
                      <td className="font-mono text-xs font-semibold">{a.action}</td>
                      <td className="text-xs">{a.target}</td>
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
