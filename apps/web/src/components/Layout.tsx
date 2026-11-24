import React, { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bus,
  MapPin,
  Monitor,
  Moon,
  Route as RouteIcon,
  Search,
  Settings,
  Star,
  Sun,
  WifiOff,
} from "lucide-react";
import { apiJson, type AgencySummary } from "../lib/api";
import { usePreferences, type ThemeMode } from "../lib/preferences";

interface SearchResponse {
  query: string;
  results: {
    routes: Array<{ agency_id: string; route_id: string; short_name: string; long_name: string }>;
    stops: Array<{ agency_id: string; stop_id: string; stop_code: string | null; name: string }>;
    vehicles: Array<{ agency_id: string; vehicle_id: string; fleet_number: string }>;
    trips: Array<{ agency_id: string; trip_id: string; route_id: string; block_id: string | null }>;
  };
}

export function Layout() {
  const { agencyId, setAgencyId, theme, setTheme, units, setUnits, interpolate, setInterpolate, favorites, online } =
    usePreferences();
  const [searchText, setSearchText] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const isMapView = location.pathname === "/" || location.pathname === "/map";

  const { data: agenciesData } = useQuery({
    queryKey: ["agencies"],
    queryFn: () => apiJson<{ agencies: AgencySummary[] }>("/api/v1/agencies"),
    staleTime: 45_000,
  });

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchText.trim()), 160);
    return () => clearTimeout(t);
  }, [searchText]);

  const { data: searchData } = useQuery({
    queryKey: ["search", debouncedQuery, agencyId],
    queryFn: () => {
      const scope = agencyId === "all" ? "" : `&agency=${encodeURIComponent(agencyId)}`;
      return apiJson<SearchResponse>(`/api/v1/search?q=${encodeURIComponent(debouncedQuery)}${scope}`);
    },
    enabled: debouncedQuery.length >= 1,
    staleTime: 15_000,
  });

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const agencies = agenciesData?.agencies ?? [];
  const activeAgency = agencies.find((a) => a.id === agencyId);

  const navItems = [
    { to: "/", label: "Map", end: true },
    { to: "/routes", label: "Routes", end: false },
    { to: "/vehicles", label: "Vehicles", end: false },
    { to: "/stops", label: "Stops", end: false },
    { to: "/history", label: "History", end: false },
  ];

  const agencyOptions =
    agencies.length > 0
      ? [
          ...agencies.map((a) => ({
            id: a.id,
            label: a.shortName,
            fullName: a.name,
            count: a.activeVehicleCount,
            status: a.liveStatus,
          })),
          {
            id: "all",
            label: "All",
            fullName: "All Agencies",
            count: agencies.reduce((s, a) => s + a.activeVehicleCount, 0),
            status: "fresh",
          },
        ]
      : [
          { id: "guelph", label: "Guelph", fullName: "Guelph Transit", count: 0, status: "unknown" },
          { id: "ttc", label: "TTC", fullName: "Toronto Transit Commission", count: 0, status: "unknown" },
          { id: "go", label: "GO", fullName: "GO Transit", count: 0, status: "unknown" },
          { id: "all", label: "All", fullName: "All Agencies", count: 0, status: "unknown" },
        ];

  const hasSearchHits =
    searchData &&
    (searchData.results.routes.length > 0 ||
      searchData.results.stops.length > 0 ||
      searchData.results.vehicles.length > 0 ||
      searchData.results.trips.length > 0);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 sh-btn sh-btn-primary"
      >
        Skip to content
      </a>

      {/* Signature Swiss Red + Gold top brand hairline */}
      <div className="sh-brand-bar w-full shrink-0" />

      {!online && (
        <div
          role="status"
          className="px-4 py-1.5 text-xs font-medium flex items-center justify-center gap-2 border-b"
          style={{ background: "var(--gold-surface)", borderColor: "var(--border)", color: "var(--text)" }}
        >
          <WifiOff size={14} />
          Offline — showing cached static data where available. Live tracking requires a network connection.
        </div>
      )}

      {/* Sleek single horizontal header */}
      <header
        className="border-b sticky top-0 z-30 shrink-0"
        style={{ background: "var(--bg-elevated)", borderColor: "var(--border)" }}
      >
        <div className="max-w-[1480px] mx-auto px-3 sm:px-4 min-h-[52px] py-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Wordmark + Mascot */}
          <Link
            to="/"
            className="flex items-center gap-2 font-extrabold text-[15px] tracking-tight no-underline hover:no-underline shrink-0"
            style={{ color: "var(--text)" }}
          >
            <img
              src="/icons/favicon-64.png"
              alt=""
              width={28}
              height={28}
              className="rounded-full ring-2 ring-[#b91c1c]/80 bg-white"
            />
            <span className="leading-none">
              Swiss<span style={{ color: "var(--primary)" }}>host</span>
            </span>
          </Link>

          {/* One-click segmented agency switcher (desktop) / compact select (mobile) */}
          <div
            role="group"
            aria-label="Select transit agency"
            className="hidden lg:inline-flex items-center p-0.5 rounded-lg border text-xs shrink-0"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          >
            {agencyOptions.map((opt) => {
              const active = agencyId === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setAgencyId(opt.id)}
                  title={opt.fullName}
                  className="px-2.5 py-1 rounded-md font-semibold transition-all cursor-pointer border-0 flex items-center gap-1.5"
                  style={{
                    background: active ? "var(--bg-elevated)" : "transparent",
                    color: active ? "var(--text)" : "var(--text-muted)",
                    boxShadow: active ? "var(--shadow-sm)" : "none",
                  }}
                >
                  <span>{opt.label}</span>
                  {opt.count > 0 && (
                    <span
                      className="text-[10px] px-1.5 py-0.2 rounded-full tabular-nums"
                      style={{
                        background: active ? "var(--primary-soft)" : "transparent",
                        color: active ? "var(--primary)" : "var(--text-muted)",
                      }}
                    >
                      {opt.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <select
            value={agencyId}
            onChange={(e) => setAgencyId(e.target.value)}
            aria-label="Select transit agency"
            className="sh-input text-xs font-semibold lg:hidden py-1"
          >
            {agencyOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.fullName} {opt.count > 0 ? `(${opt.count})` : ""}
              </option>
            ))}
          </select>

          {/* Five-item primary navigation (PRD §3.1) */}
          <nav aria-label="Primary" className="flex items-center gap-0.5 sm:gap-1 text-[13px] font-semibold">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className="px-2.5 py-1.5 rounded-md no-underline hover:no-underline transition-colors relative"
                style={({ isActive }) => ({
                  color: isActive ? "var(--primary)" : "var(--text-muted)",
                  background: isActive ? "var(--primary-soft)" : "transparent",
                })}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* Search + Favorites + Settings */}
          <div className="flex items-center gap-1.5 ml-auto flex-1 sm:flex-initial justify-end">
            <div ref={searchRef} className="relative flex-1 sm:w-52 md:w-64">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: "var(--text-muted)" }}
              />
              <input
                type="search"
                value={searchText}
                onFocus={() => setSearchOpen(true)}
                onChange={(e) => {
                  setSearchText(e.target.value);
                  setSearchOpen(true);
                }}
                placeholder="Fleet #, route, stop, trip…"
                aria-label="Global search"
                className="sh-input w-full pl-8 pr-2.5 py-1.5 text-xs"
              />
              {searchOpen && debouncedQuery.length >= 1 && (
                <div
                  role="listbox"
                  className="absolute right-0 mt-1.5 w-80 max-w-[92vw] max-h-96 overflow-y-auto rounded-xl p-2 z-50 text-sm"
                  style={{
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border)",
                    boxShadow: "var(--shadow-lg)",
                  }}
                >
                  {!hasSearchHits ? (
                    <div className="p-3 text-xs text-center" style={{ color: "var(--text-muted)" }}>
                      No matches for &ldquo;{debouncedQuery}&rdquo;
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {searchData.results.vehicles.length > 0 && (
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider px-2 py-1" style={{ color: "var(--text-muted)" }}>
                            Vehicles
                          </div>
                          {searchData.results.vehicles.map((v) => (
                            <button
                              key={`${v.agency_id}-${v.vehicle_id}`}
                              type="button"
                              onClick={() => {
                                setSearchOpen(false);
                                navigate(`/vehicles/${v.agency_id}/${encodeURIComponent(v.vehicle_id)}`);
                              }}
                              className="w-full text-left px-2 py-1.5 rounded-lg flex items-center justify-between cursor-pointer bg-transparent border-0 hover:bg-[var(--surface)]"
                              style={{ color: "var(--text)" }}
                            >
                              <span className="flex items-center gap-2 font-semibold tabular-nums">
                                <Bus size={13} style={{ color: "var(--primary)" }} />#{v.fleet_number}
                              </span>
                              <span className="sh-pill sh-pill-muted uppercase">{v.agency_id}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {searchData.results.routes.length > 0 && (
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider px-2 py-1" style={{ color: "var(--text-muted)" }}>
                            Routes
                          </div>
                          {searchData.results.routes.map((r) => (
                            <button
                              key={`${r.agency_id}-${r.route_id}`}
                              type="button"
                              onClick={() => {
                                setSearchOpen(false);
                                navigate(`/routes/${r.agency_id}/${encodeURIComponent(r.route_id)}`);
                              }}
                              className="w-full text-left px-2 py-1.5 rounded-lg flex items-center justify-between gap-2 cursor-pointer bg-transparent border-0 hover:bg-[var(--surface)]"
                              style={{ color: "var(--text)" }}
                            >
                              <span className="flex items-center gap-2 truncate">
                                <RouteIcon size={13} style={{ color: "var(--primary)" }} />
                                <strong className="tabular-nums">{r.short_name}</strong>
                                <span className="truncate text-xs" style={{ color: "var(--text-muted)" }}>
                                  {r.long_name}
                                </span>
                              </span>
                              <span className="sh-pill sh-pill-muted uppercase shrink-0">{r.agency_id}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {searchData.results.stops.length > 0 && (
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider px-2 py-1" style={{ color: "var(--text-muted)" }}>
                            Stops
                          </div>
                          {searchData.results.stops.map((s) => (
                            <button
                              key={`${s.agency_id}-${s.stop_id}`}
                              type="button"
                              onClick={() => {
                                setSearchOpen(false);
                                navigate(`/stops/${s.agency_id}/${encodeURIComponent(s.stop_id)}`);
                              }}
                              className="w-full text-left px-2 py-1.5 rounded-lg flex items-center justify-between gap-2 cursor-pointer bg-transparent border-0 hover:bg-[var(--surface)]"
                              style={{ color: "var(--text)" }}
                            >
                              <span className="flex items-center gap-2 truncate text-xs">
                                <MapPin size={13} style={{ color: "var(--primary)" }} />
                                <span className="truncate font-medium">{s.name}</span>
                              </span>
                              <span className="sh-pill sh-pill-muted uppercase shrink-0">{s.agency_id}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {searchData.results.trips.length > 0 && (
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider px-2 py-1" style={{ color: "var(--text-muted)" }}>
                            Trips
                          </div>
                          {searchData.results.trips.map((t) => (
                            <button
                              key={`${t.agency_id}-${t.trip_id}`}
                              type="button"
                              onClick={() => {
                                setSearchOpen(false);
                                navigate(`/trips/${t.agency_id}/${encodeURIComponent(t.trip_id)}`);
                              }}
                              className="w-full text-left px-2 py-1.5 rounded-lg flex items-center justify-between cursor-pointer bg-transparent border-0 hover:bg-[var(--surface)]"
                              style={{ color: "var(--text)" }}
                            >
                              <span className="truncate text-xs font-mono">Trip {t.trip_id}</span>
                              <span className="sh-pill sh-pill-muted uppercase">{t.agency_id}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <Link
              to="/favorites"
              className="sh-btn px-2.5 py-1.5 no-underline hover:no-underline"
              title="Favorites"
              aria-label={`Favorites (${favorites.length})`}
            >
              <Star size={14} style={{ color: favorites.length > 0 ? "var(--gold-accent)" : "var(--text-muted)" }} />
              {favorites.length > 0 && <span className="text-xs tabular-nums">{favorites.length}</span>}
            </Link>

            <div ref={settingsRef} className="relative">
              <button
                type="button"
                className="sh-btn px-2.5 py-1.5"
                onClick={() => setSettingsOpen((o) => !o)}
                aria-expanded={settingsOpen}
                aria-label="Settings"
              >
                <Settings size={14} />
              </button>
              {settingsOpen && (
                <div
                  className="absolute right-0 mt-1.5 w-68 rounded-xl p-3.5 z-50 space-y-3.5 text-sm"
                  style={{
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border)",
                    boxShadow: "var(--shadow-lg)",
                  }}
                >
                  <div className="font-bold text-xs uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                    Preferences
                  </div>
                  <div>
                    <div className="text-xs font-medium mb-1.5">Theme</div>
                    <div className="grid grid-cols-3 gap-1 p-0.5 rounded-lg border" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
                      {(
                        [
                          ["light", Sun, "Light"],
                          ["dark", Moon, "Dark"],
                          ["system", Monitor, "Auto"],
                        ] as const
                      ).map(([mode, Icon, label]) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setTheme(mode as ThemeMode)}
                          className="py-1.5 rounded-md text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer border-0"
                          style={{
                            background: theme === mode ? "var(--bg-elevated)" : "transparent",
                            color: theme === mode ? "var(--text)" : "var(--text-muted)",
                            boxShadow: theme === mode ? "var(--shadow-sm)" : "none",
                          }}
                        >
                          <Icon size={12} /> {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-medium mb-1.5">Speed units</div>
                    <div className="grid grid-cols-2 gap-1 p-0.5 rounded-lg border" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
                      {(
                        [
                          ["metric", "km/h"],
                          ["imperial", "mph"],
                        ] as const
                      ).map(([u, label]) => (
                        <button
                          key={u}
                          type="button"
                          onClick={() => setUnits(u)}
                          className="py-1 rounded-md text-xs font-semibold cursor-pointer border-0"
                          style={{
                            background: units === u ? "var(--bg-elevated)" : "transparent",
                            color: units === u ? "var(--text)" : "var(--text-muted)",
                            boxShadow: units === u ? "var(--shadow-sm)" : "none",
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={interpolate}
                      onChange={(e) => setInterpolate(e.target.checked)}
                    />
                    Smooth vehicle motion
                  </label>

                  <div className="pt-2.5 border-t grid grid-cols-2 gap-2 text-xs font-medium" style={{ borderColor: "var(--border)" }}>
                    <Link to="/alerts" onClick={() => setSettingsOpen(false)}>Service Alerts</Link>
                    <Link to="/status" onClick={() => setSettingsOpen(false)}>Feed Status</Link>
                    <Link to="/account" onClick={() => setSettingsOpen(false)}>Account & Alerts</Link>
                    <Link to="/admin" onClick={() => setSettingsOpen(false)}>Admin Console</Link>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main id="main-content" className="flex-1 w-full flex flex-col">
        <Outlet />
      </main>

      {!isMapView && (
        <footer
          className="border-t mt-10 text-xs"
          style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-muted)" }}
        >
          <div className="max-w-6xl mx-auto px-4 py-5 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div>
                <strong style={{ color: "var(--text)" }}>Swisshost</strong> — Independent public transit tracker &amp; intelligence reference.
              </div>
              {activeAgency && (
                <div>
                  {activeAgency.attribution}
                  {activeAgency.licenseUrl && (
                    <>
                      {" · "}
                      <a href={activeAgency.licenseUrl} target="_blank" rel="noreferrer">
                        License
                      </a>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-4 font-medium">
              <Link to="/alerts">Alerts</Link>
              <Link to="/status">Status &amp; Quotas</Link>
              <a href="/openapi.json" target="_blank" rel="noreferrer">
                OpenAPI
              </a>
              <Link to="/account">Account</Link>
              <Link to="/admin">Admin</Link>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
