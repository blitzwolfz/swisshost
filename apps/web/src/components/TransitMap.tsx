import React, { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { LiveVehicle } from "../lib/api";
import { usePreferences } from "../lib/preferences";

interface TransitMapProps {
  center: [number, number];
  zoom: number;
  vehicles: LiveVehicle[];
  selectedVehicleId: string | null;
  onSelectVehicle?: (vehicle: LiveVehicle) => void;
  routeShape?: { type: "LineString"; coordinates: Array<[number, number]> } | null;
  replayTrail?: Array<[number, number]> | null;
  stops?: Array<{ stop_id: string; name: string; lat: number; lon: number }>;
  followSelected?: boolean;
  heightClass?: string;
  rounded?: boolean;
}

const LIGHT_STYLE = "https://tiles.openfreemap.org/styles/positron";
const DARK_STYLE = "https://tiles.openfreemap.org/styles/dark";

/**
 * Generates crisp HiDPI directional transit marker sprites for WebGL MapLibre symbol layers.
 * Zero DOM overhead — handles 1,000+ moving vehicles smoothly at 60fps.
 */
function createVehicleSprite(fill: string, stroke: string, arrow: boolean): ImageData {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2 + 3;

  // Soft drop shadow
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.32)";
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2;

  if (arrow) {
    // Directional teardrop / pointer chevron pointing North (0 deg)
    ctx.beginPath();
    ctx.moveTo(cx, 7);
    ctx.lineTo(cx + 15, cy - 2);
    ctx.arc(cx, cy, 15, -0.15, Math.PI + 0.15, false);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = stroke;
    ctx.stroke();

    // Inner bright heading chevron
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(cx, 17);
    ctx.lineTo(cx + 5.5, 27);
    ctx.lineTo(cx, 24.5);
    ctx.lineTo(cx - 5.5, 27);
    ctx.closePath();
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(cx, size / 2, 14, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, size / 2, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
  }

  return ctx.getImageData(0, 0, size, size);
}

export function TransitMap({
  center,
  zoom,
  vehicles,
  selectedVehicleId,
  onSelectVehicle,
  routeShape,
  replayTrail,
  stops,
  followSelected = false,
  heightClass = "h-[65vh] min-h-[420px]",
  rounded = true,
}: TransitMapProps) {
  const { resolvedTheme } = usePreferences();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const vehiclesRef = useRef<LiveVehicle[]>(vehicles);
  const onSelectRef = useRef(onSelectVehicle);

  vehiclesRef.current = vehicles;
  onSelectRef.current = onSelectVehicle;

  const toGeoJson = (list: LiveVehicle[], selId: string | null) => ({
    type: "FeatureCollection" as const,
    features: list.map((v) => {
      const selected = v.vehicleId === selId;
      const hasBearing = v.bearingDeg !== null && Number.isFinite(v.bearingDeg);
      const sprite = selected
        ? hasBearing
          ? "veh-selected-arrow"
          : "veh-selected-dot"
        : v.freshness === "stale"
          ? hasBearing
            ? "veh-stale-arrow"
            : "veh-stale-dot"
          : hasBearing
            ? "veh-live-arrow"
            : "veh-live-dot";

      return {
        type: "Feature" as const,
        id: `${v.agencyId}:${v.vehicleId}`,
        geometry: { type: "Point" as const, coordinates: [v.lon, v.lat] },
        properties: {
          agencyId: v.agencyId,
          vehicleId: v.vehicleId,
          fleetNumber: v.fleetNumber,
          routeShortName: v.routeShortName ?? v.routeId ?? `#${v.fleetNumber}`,
          bearing: hasBearing ? v.bearingDeg : 0,
          sprite,
          selected,
        },
      };
    }),
  });

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: resolvedTheme === "dark" ? DARK_STYLE : LIGHT_STYLE,
      center,
      zoom,
      attributionControl: { compact: true },
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: false },
        trackUserLocation: false,
      }),
      "bottom-right"
    );

    const setupLayers = () => {
      // Register directional WebGL sprites
      const sprites: Array<[string, string, string, boolean]> = [
        ["veh-live-arrow", "#B91C1C", "#FFFFFF", true],
        ["veh-live-dot", "#B91C1C", "#FFFFFF", false],
        ["veh-stale-arrow", "#64748B", "#E2E8F0", true],
        ["veh-stale-dot", "#64748B", "#E2E8F0", false],
        ["veh-selected-arrow", "#FF0000", "#FACC15", true],
        ["veh-selected-dot", "#FF0000", "#FACC15", false],
      ];
      for (const [name, fill, stroke, arrow] of sprites) {
        if (!map.hasImage(name)) {
          map.addImage(name, createVehicleSprite(fill, stroke, arrow), { pixelRatio: 2 });
        }
      }

      if (!map.getSource("route-shape")) {
        map.addSource("route-shape", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "route-shape-casing",
          type: "line",
          source: "route-shape",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": resolvedTheme === "dark" ? "#0f0f11" : "#ffffff",
            "line-width": 7,
            "line-opacity": 0.75,
          },
        });
        map.addLayer({
          id: "route-shape-line",
          type: "line",
          source: "route-shape",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#B91C1C",
            "line-width": 4,
            "line-opacity": 0.92,
          },
        });
      }

      if (!map.getSource("replay-trail")) {
        map.addSource("replay-trail", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "replay-trail-line",
          type: "line",
          source: "replay-trail",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#D97706",
            "line-width": 4,
            "line-dasharray": [2, 1.2],
          },
        });
      }

      if (!map.getSource("stops")) {
        map.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "stops-dots",
          type: "circle",
          source: "stops",
          minzoom: 12,
          paint: {
            "circle-radius": 4,
            "circle-color": "#FFFFFF",
            "circle-stroke-color": "#18181B",
            "circle-stroke-width": 1.6,
          },
        });
      }

      if (!map.getSource("vehicles")) {
        map.addSource("vehicles", {
          type: "geojson",
          data: toGeoJson(vehiclesRef.current, selectedVehicleId),
          cluster: true,
          clusterMaxZoom: 10,
          clusterRadius: 40,
        });

        map.addLayer({
          id: "vehicle-clusters",
          type: "circle",
          source: "vehicles",
          filter: ["has", "point_count"],
          paint: {
            "circle-color": "#B91C1C",
            "circle-radius": ["step", ["get", "point_count"], 16, 25, 20, 100, 24],
            "circle-stroke-width": 2.5,
            "circle-stroke-color": "#FFFFFF",
          },
        });

        map.addLayer({
          id: "vehicle-cluster-count",
          type: "symbol",
          source: "vehicles",
          filter: ["has", "point_count"],
          layout: {
            "text-field": "{point_count_abbreviated}",
            "text-size": 12,
            "text-font": ["Open Sans Bold", "Noto Sans Bold"],
          },
          paint: { "text-color": "#FFFFFF" },
        });

        map.addLayer({
          id: "vehicle-points",
          type: "symbol",
          source: "vehicles",
          filter: ["!", ["has", "point_count"]],
          layout: {
            "icon-image": ["get", "sprite"],
            "icon-size": ["case", ["boolean", ["get", "selected"], false], 1.15, 0.85],
            "icon-rotate": ["get", "bearing"],
            "icon-rotation-alignment": "map",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "symbol-sort-key": ["case", ["boolean", ["get", "selected"], false], 100, 1],
          },
        });

        map.addLayer({
          id: "vehicle-labels",
          type: "symbol",
          source: "vehicles",
          filter: ["!", ["has", "point_count"]],
          minzoom: 11.2,
          layout: {
            "text-field": ["get", "routeShortName"],
            "text-size": 10.5,
            "text-font": ["Open Sans Bold", "Noto Sans Bold"],
            "text-offset": [0, 1.45],
            "text-allow-overlap": false,
          },
          paint: {
            "text-color": resolvedTheme === "dark" ? "#F4F4F6" : "#141416",
            "text-halo-color": resolvedTheme === "dark" ? "#0F0F11" : "#FFFFFF",
            "text-halo-width": 2,
          },
        });

        map.on("click", "vehicle-clusters", async (e) => {
          const feat = e.features?.[0];
          if (!feat || feat.geometry.type !== "Point") return;
          const clusterId = feat.properties?.cluster_id as number;
          const src = map.getSource("vehicles") as maplibregl.GeoJSONSource;
          const nextZoom = await src.getClusterExpansionZoom(clusterId);
          map.easeTo({ center: feat.geometry.coordinates as [number, number], zoom: nextZoom });
        });

        map.on("click", "vehicle-points", (e) => {
          const feat = e.features?.[0];
          const vid = feat?.properties?.vehicleId as string | undefined;
          const ag = feat?.properties?.agencyId as string | undefined;
          if (!vid) return;
          const found = vehiclesRef.current.find(
            (v) => v.vehicleId === vid && (!ag || v.agencyId === ag)
          );
          if (found && onSelectRef.current) onSelectRef.current(found);
        });

        map.on("mouseenter", "vehicle-points", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "vehicle-points", () => {
          map.getCanvas().style.cursor = "";
        });
      }
    };

    map.on("load", setupLayers);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [resolvedTheme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ center, zoom, duration: 450 });
  }, [center[0], center[1], zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource("vehicles") as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(toGeoJson(vehicles, selectedVehicleId));
    }

    if (followSelected && selectedVehicleId) {
      const sel = vehicles.find((v) => v.vehicleId === selectedVehicleId);
      if (sel) {
        map.easeTo({ center: [sel.lon, sel.lat], duration: 350 });
      }
    }
  }, [vehicles, selectedVehicleId, followSelected]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource("route-shape") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      routeShape
        ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: routeShape, properties: {} }] }
        : { type: "FeatureCollection", features: [] }
    );
  }, [routeShape]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource("replay-trail") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      replayTrail && replayTrail.length >= 2
        ? {
            type: "FeatureCollection",
            features: [{ type: "Feature", geometry: { type: "LineString", coordinates: replayTrail }, properties: {} }],
          }
        : { type: "FeatureCollection", features: [] }
    );
  }, [replayTrail]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource("stops") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: "FeatureCollection",
      features: (stops ?? []).map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { stopId: s.stop_id, name: s.name },
      })),
    });
  }, [stops]);

  return (
    <div
      ref={containerRef}
      className={`w-full overflow-hidden ${rounded ? "rounded-xl border" : ""} ${heightClass}`}
      style={rounded ? { borderColor: "var(--border)" } : undefined}
      aria-label="Interactive transit map"
    />
  );
}
