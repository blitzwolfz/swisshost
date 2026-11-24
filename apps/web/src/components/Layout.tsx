import React, { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bus, History as HistoryIcon, Map as MapIcon, MapPin, Menu, Route as RouteIcon, Search, Star, WifiOff, X } from "lucide-react";
import { apiJson, type AgencySummary } from "../lib/api";
import { usePreferences, type ThemeMode } from "../lib/preferences";
import { usePwaInstall } from "../hooks/usePwaInstall";
import { agencyRank, agencyShortName } from "../lib/agencies";

interface SearchResponse {
  query: string;
  results: {
    routes: Array<{ agency_id: string; route_id: string; short_name: string; long_name: string }>;
    stops: Array<{ agency_id: string; stop_id: string; stop_code: string | null; name: string }>;
    vehicles: Array<{ agency_id: string; vehicle_id: string; fleet_number: string }>;
    trips: Array<{ agency_id: string; trip_id: string; route_id: string; block_id: string | null }>;
  };
}

const NAV_ITEMS = [
  { to: "/", label: "Map", end: true, Icon: MapIcon },
  { to: "/routes", label: "Routes", end: false, Icon: RouteIcon },
  { to: "/vehicles", label: "Vehicles", end: false, Icon: Bus },
  { to: "/stops", label: "Stops", end: false, Icon: MapPin },
  { to: "/history", label: "History", end: false, Icon: HistoryIcon },
];

function AgencySwitcher({
  options,
  agencyId,
  onChange,
  className = "",
}: {
  options: Array<{ id: string; label: string; fullName: string; count: number }>;
  agencyId: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label="Transit agency" className={`sh-seg ${className}`}>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          aria-pressed={agencyId === opt.id}
          title={opt.fullName}
          onClick={() => onChange(opt.id)}
        >
          <span>{opt.label}</span>
          {opt.count > 0 && (
            <span className="hidden lg:inline tabular-nums" style={{ fontWeight: 500 }}>
              {opt.count}
              <span className="sr-only"> vehicles reporting</span>
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Layout() {
  const { agencyId, setAgencyId, theme, setTheme, units, setUnits, interpolate, setInterpolate, favorites, online } =
    usePreferences();
  const { isStandalone } = usePwaInstall();
  const [searchText, setSearchText] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const mobileSearchRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);
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
      const t = e.target as Node;
      const inSearch = searchRef.current?.contains(t) || mobileSearchRef.current?.contains(t);
      if (!inSearch) setSearchOpen(false);
      if (settingsRef.current && !settingsRef.current.contains(t)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSearchOpen(false);
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Close transient panels on navigation
  useEffect(() => {
    setSearchOpen(false);
    setSettingsOpen(false);
    setMobileSearch(false);
  }, [location.pathname]);

  useEffect(() => {
    if (mobileSearch) mobileInputRef.current?.focus();
  }, [mobileSearch]);

  const agencies = agenciesData?.agencies ?? [];
  const activeAgency = agencies.find((a) => a.id === agencyId);

  const agencyOptions =
    agencies.length > 0
      ? [
          ...[...agencies]
            .sort((a, b) => agencyRank(a.id) - agencyRank(b.id))
            .map((a) => ({ id: a.id, label: agencyShortName(a.id), fullName: a.name, count: a.activeVehicleCount })),
          {
            id: "all",
            label: "All",
            fullName: "All agencies",
            count: agencies.reduce((s, a) => s + a.activeVehicleCount, 0),
          },
        ]
      : [
          { id: "go", label: "GO", fullName: "GO Transit", count: 0 },
          { id: "guelph", label: "Guelph", fullName: "Guelph Transit", count: 0 },
          { id: "thunderbay", label: "T-Bay", fullName: "Thunder Bay Transit", count: 0 },
          { id: "ttc", label: "TTC", fullName: "Toronto Transit Commission", count: 0 },
          { id: "all", label: "All", fullName: "All agencies", count: 0 },
        ];

  const hasSearchHits =
    searchData &&
    (searchData.results.routes.length > 0 ||
      searchData.results.stops.length > 0 ||
      searchData.results.vehicles.length > 0 ||
      searchData.results.trips.length > 0);

  const go = (path: string) => {
    setSearchOpen(false);
    setMobileSearch(false);
    navigate(path);
  };

  const searchInput = (inputRef?: React.Ref<HTMLInputElement>) => (
    <input
      ref={inputRef}
      type="search"
      value={searchText}
      onFocus={() => setSearchOpen(true)}
      onChange={(e) => {
        setSearchText(e.target.value);
        setSearchOpen(true);
      }}
      placeholder="Fleet number, route, stop or trip"
      aria-label="Search"
      enterKeyHint="search"
      className="sh-input w-full pl-10"
    />
  );

  const searchResults = searchOpen && debouncedQuery.length >= 1 && (
    <div className="sh-popover w-[26rem] max-w-[92vw] max-h-[70vh] overflow-y-auto pb-1">
      {!hasSearchHits ? (
        <div className="p-4 text-sm">
          Nothing matches “{debouncedQuery}”. Try a fleet number like 4401 or a route like 504.
        </div>
      ) : (
        <>
          {searchData.results.vehicles.length > 0 && (
            <div>
              <div className="sh-popover-label">Vehicles</div>
              {searchData.results.vehicles.map((v) => (
                <button
                  key={`${v.agency_id}-${v.vehicle_id}`}
                  type="button"
                  className="sh-popover-item"
                  onClick={() => go(`/vehicles/${v.agency_id}/${encodeURIComponent(v.vehicle_id)}`)}
                >
                  <span className="sh-fleet">{v.fleet_number}</span>
                  <span className="text-sm sh-muted">{agencyShortName(v.agency_id)}</span>
                </button>
              ))}
            </div>
          )}
          {searchData.results.routes.length > 0 && (
            <div>
              <div className="sh-popover-label">Routes</div>
              {searchData.results.routes.map((r) => (
                <button
                  key={`${r.agency_id}-${r.route_id}`}
                  type="button"
                  className="sh-popover-item"
                  onClick={() => go(`/routes/${r.agency_id}/${encodeURIComponent(r.route_id)}`)}
                >
                  <span className="flex items-center gap-3 min-w-0">
                    <strong className="sh-narrow w-10 shrink-0 text-lg">{r.short_name}</strong>
                    <span className="truncate">{r.long_name}</span>
                  </span>
                  <span className="text-sm sh-muted shrink-0">{agencyShortName(r.agency_id)}</span>
                </button>
              ))}
            </div>
          )}
          {searchData.results.stops.length > 0 && (
            <div>
              <div className="sh-popover-label">Stops</div>
              {searchData.results.stops.map((s) => (
                <button
                  key={`${s.agency_id}-${s.stop_id}`}
                  type="button"
                  className="sh-popover-item"
                  onClick={() => go(`/stops/${s.agency_id}/${encodeURIComponent(s.stop_id)}`)}
                >
                  <span className="truncate">{s.name}</span>
                  <span className="text-sm sh-muted shrink-0">{agencyShortName(s.agency_id)}</span>
                </button>
              ))}
            </div>
          )}
          {searchData.results.trips.length > 0 && (
            <div>
              <div className="sh-popover-label">Trips</div>
              {searchData.results.trips.map((t) => (
                <button
                  key={`${t.agency_id}-${t.trip_id}`}
                  type="button"
                  className="sh-popover-item"
                  onClick={() => go(`/trips/${t.agency_id}/${encodeURIComponent(t.trip_id)}`)}
                >
                  <span className="truncate">Trip {t.trip_id}</span>
                  <span className="text-sm sh-muted shrink-0">{agencyShortName(t.agency_id)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );

  const moreLinks = (
    <>
      <Link to="/simple">Simple view</Link>
      <Link to="/plan">Plan a trip</Link>
      <Link to="/alerts">Service alerts</Link>
      <Link to="/status">Feed status</Link>
      {!isStandalone && <Link to="/install">Save as app</Link>}
      <a href="/openapi.json" target="_blank" rel="noreferrer">
        API
      </a>
      <Link to="/account">Account</Link>
      <Link to="/admin">Admin</Link>
    </>
  );

  return (
    <div
      className={`flex flex-col ${isMapView ? "h-dvh overflow-hidden" : "min-h-dvh"}`}
      style={{ background: "var(--paper)", color: "var(--ink)" }}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 sh-btn sh-btn-primary"
      >
        Skip to content
      </a>

      {!online && (
        <div
          role="status"
          className="px-4 py-2 text-sm font-bold flex items-center gap-2 shrink-0"
          style={{ background: "var(--ink)", color: "var(--paper)", paddingTop: "calc(0.5rem + var(--safe-top))" }}
        >
          <WifiOff size={18} aria-hidden="true" />
          You are offline. Routes and stops come from the last sync. Live positions return when you reconnect.
        </div>
      )}

      <header className="sh-header shrink-0">
        <div className="sh-header-inner">
          <Link to="/" className="sh-wordmark" aria-label="Swisshost, live map">
            Swisshost
          </Link>

          <nav aria-label="Primary" className="sh-nav">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* Inline search (desktop) */}
          <div ref={searchRef} className="relative hidden lg:block w-[280px]">
            <Search
              size={18}
              aria-hidden="true"
              className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            />
            {searchInput()}
            {!mobileSearch && searchResults}
          </div>

          <button
            type="button"
            className="sh-btn sh-btn-icon lg:hidden"
            aria-label={mobileSearch ? "Close search" : "Search"}
            aria-expanded={mobileSearch}
            onClick={() => {
              setMobileSearch((m) => !m);
              setSearchOpen(true);
            }}
          >
            {mobileSearch ? <X size={22} aria-hidden="true" /> : <Search size={22} aria-hidden="true" />}
          </button>

          <Link
            to="/simple"
            className="sh-btn hidden lg:inline-flex"
            aria-current={location.pathname === "/simple" ? "page" : undefined}
            style={
              location.pathname === "/simple"
                ? { background: "var(--accent)", borderColor: "var(--accent)", color: "var(--on-accent)" }
                : undefined
            }
          >
            Simple
          </Link>

          <Link
            to="/favorites"
            className="sh-btn sh-btn-icon"
            aria-label={`Saved (${favorites.length})`}
            aria-current={location.pathname === "/favorites" ? "page" : undefined}
          >
            <Star size={22} aria-hidden="true" fill={favorites.length > 0 ? "currentColor" : "none"} />
          </Link>

          <div ref={settingsRef} className="relative">
            <button
              type="button"
              className="sh-btn sh-btn-icon"
              onClick={() => setSettingsOpen((o) => !o)}
              aria-expanded={settingsOpen}
              aria-label="More: theme, settings and links"
              style={settingsOpen ? { background: "var(--accent)", borderColor: "var(--accent)", color: "var(--on-accent)" } : undefined}
            >
              <Menu size={22} aria-hidden="true" />
            </button>
            {settingsOpen && (
              <div className="sh-popover w-80 p-4 space-y-5 text-sm">
                <fieldset className="m-0 p-0 border-0">
                  <legend className="font-bold mb-2">Theme</legend>
                  <div className="sh-seg w-full">
                    {(
                      [
                        ["light", "Light"],
                        ["dark", "Dark"],
                        ["system", "System"],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={theme === mode}
                        onClick={() => setTheme(mode as ThemeMode)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="m-0 p-0 border-0">
                  <legend className="font-bold mb-2">Speed</legend>
                  <div className="sh-seg w-full">
                    {(
                      [
                        ["metric", "km/h"],
                        ["imperial", "mph"],
                      ] as const
                    ).map(([u, label]) => (
                      <button key={u} type="button" aria-pressed={units === u} onClick={() => setUnits(u)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <label className="flex items-center gap-3 cursor-pointer min-h-[44px]">
                  <input
                    type="checkbox"
                    checked={interpolate}
                    onChange={(e) => setInterpolate(e.target.checked)}
                    className="w-5 h-5"
                  />
                  Move vehicles smoothly between updates
                </label>

                <nav
                  aria-label="More"
                  className="grid grid-cols-2 gap-x-4 gap-y-3 pt-3"
                  style={{ borderTop: "1px solid var(--rule)" }}
                >
                  {moreLinks}
                </nav>
              </div>
            )}
          </div>
        </div>

        {/* Search row (below desktop width) */}
        {mobileSearch && (
          <div className="lg:hidden px-[var(--margin)] pb-3 relative" ref={mobileSearchRef}>
            <div className="relative">
              <Search
                size={18}
                aria-hidden="true"
                className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              />
              {searchInput(mobileInputRef)}
            </div>
            {searchResults}
          </div>
        )}

        <div className="sh-agency-row">
          <AgencySwitcher options={agencyOptions} agencyId={agencyId} onChange={setAgencyId} />
        </div>
      </header>

      <main id="main-content" className={`flex-1 w-full flex flex-col ${isMapView ? "min-h-0" : ""}`}>
        <Outlet />
      </main>

      {!isMapView && (
        <footer className="mt-12 text-sm" style={{ borderTop: "var(--border-w) solid var(--line)" }}>
          <div className="max-w-[1280px] mx-auto px-[var(--margin)] py-6 flex flex-wrap justify-between gap-x-8 gap-y-4">
            <div className="space-y-1 max-w-[60ch]">
              <div className="font-bold">Swisshost</div>
              <p className="m-0 sh-muted">
                An independent tracker for Ontario public transit. Not affiliated with any agency.
              </p>
              {activeAgency && (
                <p className="m-0 sh-muted">
                  {activeAgency.attribution}
                  {activeAgency.licenseUrl && (
                    <>
                      {" "}
                      <a href={activeAgency.licenseUrl} target="_blank" rel="noreferrer">
                        Licence
                      </a>
                    </>
                  )}
                </p>
              )}
            </div>
            <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 content-start">
              {moreLinks}
            </nav>
          </div>
        </footer>
      )}

      <div className="sh-tabbar-spacer shrink-0" aria-hidden="true" />
      <nav aria-label="Primary" className="sh-tabbar">
        {NAV_ITEMS.map(({ to, label, end, Icon }) => (
          <NavLink key={to} to={to} end={end}>
            <Icon size={22} strokeWidth={2} aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
