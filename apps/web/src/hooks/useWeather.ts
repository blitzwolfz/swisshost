import { useQuery } from "@tanstack/react-query";
import { apiJson, type WeatherSnapshot } from "../lib/api";
import { usePreferences } from "../lib/preferences";

export function useWeather(options: {
  agencyId?: string | null;
  lat?: number | null;
  lon?: number | null;
  enabled?: boolean;
}) {
  const { showWeather } = usePreferences();
  const { agencyId, lat, lon, enabled = true } = options;

  const hasCoords =
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon);

  // Round coordinates to 1 decimal (~11 km) so React Query & browser cache reuse the same hub query
  const roundedLat = hasCoords ? Math.round(lat * 10) / 10 : null;
  const roundedLon = hasCoords ? Math.round(lon * 10) / 10 : null;
  const keyScope = hasCoords ? `coords:${roundedLat},${roundedLon}` : `agency:${agencyId || "ttc"}`;

  return useQuery({
    queryKey: ["eccc-weather", keyScope],
    queryFn: () => {
      const params = new URLSearchParams();
      if (hasCoords) {
        params.set("lat", String(roundedLat));
        params.set("lon", String(roundedLon));
      } else if (agencyId) {
        params.set("agency", agencyId);
      }
      return apiJson<WeatherSnapshot>(`/api/v1/weather?${params.toString()}`);
    },
    enabled: showWeather && enabled && (hasCoords || Boolean(agencyId)),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchInterval: 10 * 60_000,
    retry: 1,
  });
}
