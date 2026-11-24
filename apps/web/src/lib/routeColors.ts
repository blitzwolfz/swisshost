import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiJson } from "./api";

/**
 * Route colours. Each passes 4.5:1 against white text. A route keeps the same
 * colour everywhere (map line, vehicle marker, list badge). An agency's own
 * GTFS route colour wins when it also passes contrast with white.
 */
export const ROUTE_PALETTE = [
  "#C8102E",
  "#00693E",
  "#005EB8",
  "#3A5FA0",
  "#6B2C91",
  "#0A6C74",
  "#A3195B",
  "#5A6B1F",
  "#8A4B00",
] as const;

export function normalizeHex(color: string | null | undefined): string | null {
  if (!color) return null;
  const raw = color.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  return `#${raw.toUpperCase()}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function contrastWithWhite(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  return 1.05 / (lum + 0.05);
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function paletteColor(agencyId: string, routeId: string): string {
  return ROUTE_PALETTE[hash(`${agencyId}:${routeId}`) % ROUTE_PALETTE.length]!;
}

/** Resolve the colour for a route; null routeId gets the neutral unassigned grey. */
export function routeColor(agencyId: string, routeId: string | null | undefined, brand?: string | null): string {
  if (!routeId) return "#5B574D";
  const own = normalizeHex(brand);
  if (own && contrastWithWhite(own) >= 4.5) return own;
  return paletteColor(agencyId, routeId);
}

interface RouteListRow {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  color?: string | null;
}

/** Route lookup for an agency: colour and display names, shared across pages. */
export function useRouteLookup(agencyId: string) {
  const { data } = useQuery({
    queryKey: ["routes", agencyId],
    queryFn: () => apiJson<{ routes: RouteListRow[] }>(`/api/v1/agencies/${agencyId}/routes`),
    enabled: Boolean(agencyId) && agencyId !== "all",
    staleTime: 60_000,
  });

  return useMemo(() => {
    const byId = new Map<string, RouteListRow>();
    for (const r of data?.routes ?? []) byId.set(r.routeId, r);
    return {
      routes: data?.routes ?? [],
      color: (routeId: string | null | undefined, fallbackBrand?: string | null) =>
        routeColor(agencyId, routeId, (routeId ? byId.get(routeId)?.color : null) ?? fallbackBrand),
      shortName: (routeId: string | null | undefined) =>
        (routeId ? byId.get(routeId)?.shortName : null) || routeId || "",
      longName: (routeId: string | null | undefined) => (routeId ? byId.get(routeId)?.longName : null) || "",
    };
  }, [data, agencyId]);
}
