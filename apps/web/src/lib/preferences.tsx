import React, { createContext, useContext, useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type UnitSystem = "metric" | "imperial";

export interface LocalFavorite {
  agencyId: string;
  entityType: "route" | "stop" | "vehicle" | "trip";
  entityId: string;
  label: string;
  addedAt: string;
}

interface PreferencesContextValue {
  agencyId: string;
  setAgencyId: (id: string) => void;
  theme: ThemeMode;
  resolvedTheme: "light" | "dark";
  setTheme: (mode: ThemeMode) => void;
  units: UnitSystem;
  setUnits: (u: UnitSystem) => void;
  interpolate: boolean;
  setInterpolate: (v: boolean) => void;
  favorites: LocalFavorite[];
  toggleFavorite: (fav: Omit<LocalFavorite, "addedAt">) => void;
  isFavorite: (agencyId: string, entityType: LocalFavorite["entityType"], entityId: string) => boolean;
  online: boolean;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const [agencyId, setAgencyIdState] = useState<string>(
    () => localStorage.getItem("swisshost_agency") || "guelph"
  );
  const [theme, setThemeState] = useState<ThemeMode>(
    () => (localStorage.getItem("swisshost_theme") as ThemeMode) || "system"
  );
  const [units, setUnitsState] = useState<UnitSystem>(
    () => (localStorage.getItem("swisshost_units") as UnitSystem) || "metric"
  );
  const [interpolate, setInterpolateState] = useState<boolean>(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const saved = localStorage.getItem("swisshost_interpolate");
    return saved !== null ? saved === "true" : !reduced;
  });
  const [favorites, setFavorites] = useState<LocalFavorite[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("swisshost_favorites") || "[]") as LocalFavorite[];
    } catch {
      return [];
    }
  });
  const [online, setOnline] = useState<boolean>(() => navigator.onLine);
  const [systemDark, setSystemDark] = useState<boolean>(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: "light" | "dark" =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
    localStorage.setItem("swisshost_theme", theme);
  }, [theme, resolvedTheme]);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const setAgencyId = (id: string) => {
    setAgencyIdState(id);
    localStorage.setItem("swisshost_agency", id);
  };

  const setTheme = (mode: ThemeMode) => setThemeState(mode);
  const setUnits = (u: UnitSystem) => {
    setUnitsState(u);
    localStorage.setItem("swisshost_units", u);
  };
  const setInterpolate = (v: boolean) => {
    setInterpolateState(v);
    localStorage.setItem("swisshost_interpolate", String(v));
  };

  const toggleFavorite = (fav: Omit<LocalFavorite, "addedAt">) => {
    setFavorites((prev) => {
      const exists = prev.some(
        (f) =>
          f.agencyId === fav.agencyId &&
          f.entityType === fav.entityType &&
          f.entityId === fav.entityId
      );
      const next = exists
        ? prev.filter(
            (f) =>
              !(
                f.agencyId === fav.agencyId &&
                f.entityType === fav.entityType &&
                f.entityId === fav.entityId
              )
          )
        : [{ ...fav, addedAt: new Date().toISOString() }, ...prev];
      localStorage.setItem("swisshost_favorites", JSON.stringify(next));
      return next;
    });
  };

  const isFavorite = (agencyId: string, entityType: LocalFavorite["entityType"], entityId: string) =>
    favorites.some(
      (f) => f.agencyId === agencyId && f.entityType === entityType && f.entityId === entityId
    );

  return (
    <PreferencesContext.Provider
      value={{
        agencyId,
        setAgencyId,
        theme,
        resolvedTheme,
        setTheme,
        units,
        setUnits,
        interpolate,
        setInterpolate,
        favorites,
        toggleFavorite,
        isFavorite,
        online,
      }}
    >
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences() {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences must be used within PreferencesProvider");
  return ctx;
}
