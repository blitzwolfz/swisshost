import React, { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bus, History as HistoryIcon, Map as MapIcon, MapPin, Route as RouteIcon, Search, Settings, Star, WifiOff, X } from "lucide-react";
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
          className="flex-1"
        >
          <span>{opt.label}</span>
          {opt.count > 0 && <span className="tabular-nums font-normal opacity-70">{opt.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Layout() {
  const { agencyId, setAgencyId, theme, setTheme, units, setUnits, interpolate, setInterpolate, favorites, online } =
    usePreferences();
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
          ...agencies.map((a) => ({ id: a.id, label: a.shortName, fullName: a.name, count: a.activeVehicleCount })),
          {
            id: "all",
            label: "All",
            fullName: "All agencies",
            count: agencies.reduce((s, a) => s + a.activeVehicleCount, 0),
          },
        ]
      : [
          { id: "guelph", label: "Guelph", fullName: "Guelph Transit", count: 0 },
          { id: "ttc", label: "TTC", fullName: "Toronto Transit Commission", count: 0 },
          { id: "go", label: "GO", fullName: "GO Transit", count: 0 },
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
      className="sh-input w-full pl-9"
    />
  );

  const searchResults = searchOpen && debouncedQuery.length >= 1 && (
    <div role="listbox" className="sh-popover w-[26rem] max-w-[92vw] max-h-[70vh] overflow-y-auto pb-1">
      {!hasSearchHits ? (
        <div className="p-4 text-sm" style={{ color: "var(--text-muted)" }}>
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
                  <span className="font-bold tabular-nums">#{v.fleet_number}</span>
                  <span className="text-xs uppercase opacity-70">{v.agency_id}</span>
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
                    <strong className="tabular-nums w-10 shrink-0">{r.short_name}</strong>
                    <span className="truncate">{r.long_name}</span>
                  </span>
                  <span className="text-xs uppercase opacity-70 shrink-0">{r.agency_id}</span>
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
                  <span className="text-xs uppercase opacity-70 shrink-0">{s.agency_id}</span>
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
                  <span className="truncate font-mono text-xs">Trip {t.trip_id}</span>
                  <span className="text-xs uppercase opacity-70 shrink-0">{t.agency_id}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    <div
      className={`flex flex-col ${isMapView ? "h-dvh overflow-hidden" : "min-h-dvh"}`}
      style={{ background: "var(--bg)", color: "var(--text)" }}
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
          className="px-4 py-2 text-sm font-semibold flex items-center gap-2 shrink-0"
          style={{ background: "var(--signal-yellow)", color: "#000" }}
        >
          <WifiOff size={15} />
          You're offline. Routes and stops come from the last sync; live positions return when you reconnect.
        </div>
      )}

      <header className="sh-header shrink-0">
        <div className="sh-header-inner">
          <Link to="/" className="sh-wordmark" aria-label="Swisshost home">
            <img src="/icons/logo.svg" alt="" width={32} height={32} className="sh-wordmark-mark" />
            <span>Swisshost</span>
          </Link>

          <nav aria-label="Primary" className="sh-nav">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-2 ml-auto">
            <AgencySwitcher
              options={agencyOptions}
              agencyId={agencyId}
              onChange={setAgencyId}
              className="hidden xl:inline-flex"
            />

            {/* Inline search (tablet and up) */}
            <div ref={searchRef} className="relative hidden sm:block w-56 lg:w-64">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              {searchInput()}
              {!mobileSearch && searchResults}
            </div>

            <button
              type="button"
              className="sh-btn sh-btn-icon sm:hidden"
              aria-label={mobileSearch ? "Close search" : "Search"}
              aria-expanded={mobileSearch}
              onClick={() => {
                setMobileSearch((m) => !m);
                setSearchOpen(true);
              }}
            >
              {mobileSearch ? <X size={16} /> : <Search size={16} />}
            </button>

            <Link
              to="/favorites"
              className="sh-btn no-underline px-3"
              aria-label={`Favourites (${favorites.length})`}
              title="Favourites"
            >
              <Star size={16} fill={favorites.length > 0 ? "currentColor" : "none"} />
              {favorites.length > 0 && <span className="tabular-nums">{favorites.length}</span>}
            </Link>

            <div ref={settingsRef} className="relative">
              <button
                type="button"
                className={`sh-btn sh-btn-icon ${settingsOpen ? "sh-highlight" : ""}`}
                onClick={() => setSettingsOpen((o) => !o)}
                aria-expanded={settingsOpen}
                aria-label="Preferences"
              >
                <Settings size={16} />
              </button>
              {settingsOpen && (
                <div className="sh-popover w-80 p-4 space-y-5 text-sm">
                  <div>
                    <div className="font-bold mb-2">Theme</div>
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
                          className="flex-1"
                          aria-pressed={theme === mode}
                          onClick={() => setTheme(mode as ThemeMode)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="font-bold mb-2">Speed</div>
                    <div className="sh-seg w-full">
                      {(
                        [
                          ["metric", "km/h"],
                          ["imperial", "mph"],
                        ] as const
                      ).map(([u, label]) => (
                        <button
                          key={u}
                          type="button"
                          className="flex-1"
                          aria-pressed={units === u}
                          onClick={() => setUnits(u)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={interpolate}
                      onChange={(e) => setInterpolate(e.target.checked)}
                      className="w-4 h-4 accent-[var(--signal)]"
                    />
                    Animate vehicles between updates
                  </label>

                  <nav aria-label="More" className="grid grid-cols-2 border-t pt-3 gap-y-2" style={{ borderColor: "var(--ink)" }}>
                    <Link to="/alerts">Service alerts</Link>
                    <Link to="/status">Feed status</Link>
                    <Link to="/account">Account</Link>
                    <Link to="/admin">Admin</Link>
                  </nav>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Mobile search row */}
        {mobileSearch && (
          <div className="sm:hidden px-[var(--margin)] pb-3 relative" ref={mobileSearchRef}>
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              {searchInput(mobileInputRef)}
            </div>
            {searchResults}
          </div>
        )}

        {/* Agency strip below xl, where the header has no room for it */}
        <div className="xl:hidden px-[var(--margin)] pb-2.5">
          <AgencySwitcher options={agencyOptions} agencyId={agencyId} onChange={setAgencyId} className="w-full" />
        </div>
      </header>

      <main id="main-content" className={`flex-1 w-full flex flex-col ${isMapView ? "min-h-0" : ""}`}>
        <Outlet />
      </main>

      {!isMapView && (
        <footer className="mt-16 border-t-2 text-sm" style={{ borderColor: "var(--ink)" }}>
          <div className="max-w-[1440px] mx-auto px-[var(--margin)] py-6 grid grid-cols-12 gap-x-[var(--gutter)] gap-y-4">
            <div className="col-span-12 md:col-span-6 space-y-1">
              <div className="font-bold">Swisshost</div>
              <p className="m-0" style={{ color: "var(--text-muted)" }}>
                An independent tracker for Ontario public transit. Not affiliated with any agency.
              </p>
              {activeAgency && (
                <p className="m-0" style={{ color: "var(--text-muted)" }}>
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
            <nav aria-label="Footer" className="col-span-12 md:col-span-6 flex flex-wrap gap-x-6 gap-y-2 md:justify-end">
              <Link to="/alerts">Alerts</Link>
              <Link to="/status">Feed status</Link>
              <a href="/openapi.json" target="_blank" rel="noreferrer">
                API
              </a>
              <Link to="/account">Account</Link>
              <Link to="/admin">Admin</Link>
            </nav>
          </div>
        </footer>
      )}

      <div className="sh-tabbar-spacer shrink-0" aria-hidden="true" />
      <nav aria-label="Primary" className="sh-tabbar">
        {NAV_ITEMS.map(({ to, label, end, Icon }) => (
          <NavLink key={to} to={to} end={end}>
            <Icon size={20} strokeWidth={2} />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
