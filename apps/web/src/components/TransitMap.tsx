import React, { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { formatClock, type LiveVehicle } from "../lib/api";
import { usePreferences } from "../lib/preferences";
import { routeColor } from "../lib/routeColors";

interface TransitMapProps {
  center: [number, number];
  zoom: number;
  vehicles: LiveVehicle[];
  selectedVehicleId: string | null;
  onSelectVehicle?: (vehicle: LiveVehicle) => void;
  routeShape?: { type: "LineString"; coordinates: Array<[number, number]> } | null;
  /** Colour for the route shape line; defaults to the accent. */
  routeShapeColor?: string | null;
  replayTrail?: Array<[number, number]> | null;
  stops?: Array<{ stop_id: string; name: string; lat: number; lon: number }>;
  userLocation?: { lat: number; lon: number } | null;
  selectedStopId?: string | null;
  onSelectStop?: (stop: { stop_id: string; name: string }) => void;
  followSelected?: boolean;
  heightClass?: string;
  rounded?: boolean;
}

/** One basemap (OpenFreeMap positron), recoloured per theme into a printed-map look. */
const BASE_STYLE = "https://tiles.openfreemap.org/styles/positron";

interface MapTheme {
  bg: string;
  water: string;
  waterLabel: string;
  park: string;
  built: string;
  road: string;
  roadMajor: string;
  roadCasing: string;
  rail: string;
  text: string;
  textStrong: string;
  halo: string;
  ink: string;
  paper: string;
  accent: string;
}

const LIGHT: MapTheme = {
  bg: "#E3E0D5",
  water: "#C5CFE4",
  waterLabel: "#3B4F80",
  park: "#D9D9C8",
  built: "#DCD8CC",
  road: "#C6C1B1",
  roadMajor: "#EDEAE2",
  roadCasing: "#ABA591",
  rail: "#ABA591",
  text: "#5B574D",
  textStrong: "#16140F",
  halo: "#E3E0D5",
  ink: "#16140F",
  paper: "#EDEAE2",
  accent: "#1D3E8A",
};

const DARK: MapTheme = {
  bg: "#000000",
  water: "#120D02",
  waterLabel: "#A67200",
  park: "#070500",
  built: "#0D0900",
  road: "#3A2A00",
  roadMajor: "#4D3800",
  roadCasing: "#6B4A00",
  rail: "#6B4A00",
  text: "#A67200",
  textStrong: "#FFB000",
  halo: "#000000",
  ink: "#FFB000",
  paper: "#000000",
  accent: "#FFB000",
};

function restyleBasemap(map: maplibregl.Map, t: MapTheme) {
  const style = map.getStyle();
  for (const layer of style.layers ?? []) {
    const id = layer.id;
    const set = (prop: string, value: unknown) => {
      try {
        map.setPaintProperty(id, prop, value);
      } catch {
        // property not valid for this layer type
      }
    };
    if (layer.type === "background") {
      set("background-color", t.bg);
    } else if (layer.type === "fill") {
      if (id.includes("water")) set("fill-color", t.water);
      else if (id.includes("park") || id.includes("wood")) set("fill-color", t.park);
      else if (id.includes("building") || id.includes("residential")) {
        set("fill-color", t.built);
        set("fill-outline-color", t.built);
      } else set("fill-color", t.bg);
    } else if (layer.type === "line") {
      if (id.includes("water")) set("line-color", t.water);
      else if (id.includes("casing")) set("line-color", t.roadCasing);
      else if (id.includes("dashline")) set("line-color", t.bg);
      else if (id.includes("railway")) set("line-color", t.rail);
      else if (id.includes("boundary")) set("line-color", t.text);
      else if (id.includes("_inner") || id.includes("runway")) set("line-color", t.roadMajor);
      else set("line-color", t.road);
    } else if (layer.type === "symbol") {
      const strong = id.startsWith("label_city") || id.startsWith("label_town") || id.startsWith("label_country");
      set("text-color", id.includes("water") ? t.waterLabel : strong ? t.textStrong : t.text);
      set("text-halo-color", t.halo);
      set("text-halo-width", 1.5);
      set("text-halo-blur", 0);
    }
  }
}

const MARKER_FONT = '700 16px "Archivo Narrow", "Arial Narrow", sans-serif';

/** Route-colour rectangle with the route number inside, drawn at 2x for HiDPI. */
function drawVehicleMarker(color: string, label: string, selected: boolean, t: MapTheme): ImageData {
  const scale = 2;
  const ctx0 = document.createElement("canvas").getContext("2d")!;
  ctx0.font = MARKER_FONT;
  const textW = ctx0.measureText(label).width;
  const ring = selected ? 3 : 1.5;
  const w = Math.ceil(Math.max(28, textW + 12) + ring * 2);
  const h = Math.ceil(22 + ring * 2);
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  // Outline separates the marker from route lines of the same colour
  ctx.fillStyle = selected ? t.ink : t.paper;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(ring, ring, w - ring * 2, h - ring * 2);
  ctx.fillStyle = "#FFFFFF";
  ctx.font = MARKER_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, w / 2, h / 2 + 1);
  return ctx.getImageData(0, 0, w * scale, h * scale);
}

/** Small heading pointer; orbits the marker via icon-offset + icon-rotate. */
function drawHeading(t: MapTheme): ImageData {
  const scale = 2;
  const w = 12;
  const h = 8;
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = t.ink;
  ctx.fill();
  return ctx.getImageData(0, 0, w * scale, h * scale);
}

function markerLabel(v: LiveVehicle): string {
  const raw = v.routeShortName ?? v.routeId ?? v.fleetNumber;
  return raw.length > 5 ? raw.slice(0, 5) : raw;
}

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function TransitMap({
  center,
  zoom,
  vehicles,
  selectedVehicleId,
  onSelectVehicle,
  routeShape,
  routeShapeColor,
  replayTrail,
  stops,
  userLocation = null,
  selectedStopId = null,
  onSelectStop,
  followSelected = false,
  heightClass = "h-[65vh] min-h-[420px]",
  rounded = true,
}: TransitMapProps) {
  const { resolvedTheme, interpolate } = usePreferences();
  const theme = resolvedTheme === "dark" ? DARK : LIGHT;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const vehiclesRef = useRef<LiveVehicle[]>(vehicles);
  const selectedRef = useRef<string | null>(selectedVehicleId);
  const onSelectRef = useRef(onSelectVehicle);
  const onSelectStopRef = useRef(onSelectStop);
  const shownPos = useRef(new Map<string, [number, number]>());
  const animRef = useRef<number | null>(null);
  const stopLabelRef = useRef<maplibregl.Marker | null>(null);

  vehiclesRef.current = vehicles;
  selectedRef.current = selectedVehicleId;
  onSelectRef.current = onSelectVehicle;
  onSelectStopRef.current = onSelectStop;

  const keyOf = (v: LiveVehicle) => `${v.agencyId}:${v.vehicleId}`;

  const toGeoJson = (list: LiveVehicle[], selId: string | null, positions?: Map<string, [number, number]>) => ({
    type: "FeatureCollection" as const,
    features: list.map((v) => {
      const selected = v.vehicleId === selId;
      const hasBearing = v.bearingDeg !== null && Number.isFinite(v.bearingDeg);
      const color = routeColor(v.agencyId, v.routeId, v.routeColor);
      const label = markerLabel(v);
      const stale = v.freshness === "stale";
      const pos = positions?.get(keyOf(v)) ?? [v.lon, v.lat];
      return {
        type: "Feature" as const,
        id: keyOf(v),
        geometry: { type: "Point" as const, coordinates: pos },
        properties: {
          agencyId: v.agencyId,
          vehicleId: v.vehicleId,
          icon: `veh|${color}|${selected ? 1 : 0}|${label}`,
          bearing: hasBearing ? v.bearingDeg : 0,
          hasBearing,
          stale,
          lastSeen: stale ? `Last seen ${formatClock(v.observedAt ?? v.receivedAt)}` : "",
          selected,
        },
      };
    }),
  });

  const pushVehicles = (positions?: Map<string, [number, number]>) => {
    const map = mapRef.current;
    const src = map?.getSource("vehicles") as maplibregl.GeoJSONSource | undefined;
    src?.setData(toGeoJson(vehiclesRef.current, selectedRef.current, positions));
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const t = theme;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE,
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

    // Vehicle marker images are generated on demand, one per colour + label + state
    map.on("styleimagemissing", (e) => {
      const id = e.id;
      if (!id.startsWith("veh|") || map.hasImage(id)) return;
      const [, color, sel, ...rest] = id.split("|");
      map.addImage(id, drawVehicleMarker(color!, rest.join("|"), sel === "1", t), { pixelRatio: 2 });
    });

    const setupLayers = () => {
      restyleBasemap(map, t);
      if (!map.hasImage("veh-heading")) map.addImage("veh-heading", drawHeading(t), { pixelRatio: 2 });

      map.addSource("route-shape", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "route-shape-casing",
        type: "line",
        source: "route-shape",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": t.paper, "line-width": 8 },
      });
      map.addLayer({
        id: "route-shape-line",
        type: "line",
        source: "route-shape",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": t.accent, "line-width": 5 },
      });

      map.addSource("replay-trail", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "replay-trail-line",
        type: "line",
        source: "replay-trail",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": t.ink, "line-width": 4, "line-dasharray": [2, 1.2] },
      });

      map.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "stops-dots",
        type: "circle",
        source: "stops",
        minzoom: 12,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 16, 6],
          "circle-color": t.paper,
          "circle-stroke-color": t.ink,
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "stops-selected",
        type: "circle",
        source: "stops",
        filter: ["==", ["get", "stopId"], ""],
        paint: {
          "circle-radius": 11,
          "circle-color": t.paper,
          "circle-stroke-color": t.ink,
          "circle-stroke-width": 3.5,
        },
      });

      map.addSource("user-location", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "user-location-dot",
        type: "circle",
        source: "user-location",
        paint: {
          "circle-radius": 8,
          "circle-color": t.accent,
          "circle-stroke-color": t.paper,
          "circle-stroke-width": 3,
        },
      });

      map.addSource("vehicles", {
        type: "geojson",
        data: toGeoJson(vehiclesRef.current, selectedRef.current, shownPos.current),
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
          "circle-color": t.ink,
          "circle-radius": ["step", ["get", "point_count"], 16, 25, 20, 100, 24],
          "circle-stroke-width": 2,
          "circle-stroke-color": t.paper,
        },
      });

      map.addLayer({
        id: "vehicle-cluster-count",
        type: "symbol",
        source: "vehicles",
        filter: ["has", "point_count"],
        layout: {
          "text-field": "{point_count_abbreviated}",
          "text-size": 13,
          "text-font": ["Noto Sans Bold"],
        },
        paint: { "text-color": t.paper },
      });

      const vehicleOpacity: maplibregl.ExpressionSpecification = ["case", ["boolean", ["get", "stale"], false], 0.4, 1];

      map.addLayer({
        id: "vehicle-heading",
        type: "symbol",
        source: "vehicles",
        filter: ["all", ["!", ["has", "point_count"]], ["boolean", ["get", "hasBearing"], false]],
        minzoom: 12,
        layout: {
          "icon-image": "veh-heading",
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-offset": [0, -21],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": vehicleOpacity },
      });

      map.addLayer({
        id: "vehicle-points",
        type: "symbol",
        source: "vehicles",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": ["get", "icon"],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "symbol-sort-key": [
            "case",
            ["boolean", ["get", "selected"], false],
            100,
            ["boolean", ["get", "stale"], false],
            0,
            1,
          ],
        },
        paint: { "icon-opacity": vehicleOpacity },
      });

      map.addLayer({
        id: "vehicle-stale-label",
        type: "symbol",
        source: "vehicles",
        filter: ["all", ["!", ["has", "point_count"]], ["boolean", ["get", "stale"], false]],
        minzoom: 12.5,
        layout: {
          "text-field": ["get", "lastSeen"],
          "text-size": 11,
          "text-font": ["Noto Sans Italic"],
          "text-offset": [0, 1.7],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: { "text-color": t.text, "text-halo-color": t.halo, "text-halo-width": 1.5 },
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
        const found = vehiclesRef.current.find((v) => v.vehicleId === vid && (!ag || v.agencyId === ag));
        if (found && onSelectRef.current) onSelectRef.current(found);
      });

      map.on("click", "stops-dots", (e) => {
        if (!onSelectStopRef.current) return;
        // Vehicles sit above stops; a click on a vehicle wins
        const hitVehicle = map.queryRenderedFeatures(e.point, { layers: ["vehicle-points"] }).length > 0;
        if (hitVehicle) return;
        const p = e.features?.[0]?.properties;
        if (p?.stopId) onSelectStopRef.current({ stop_id: String(p.stopId), name: String(p.name ?? "") });
      });

      for (const layer of ["vehicle-points", "vehicle-clusters", "stops-dots"]) {
        map.on("mouseenter", layer, () => {
          if (layer !== "stops-dots" || onSelectStopRef.current) map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
        });
      }

      // Let effects that ran before the style loaded push their data now
      map.fire("sh:ready");
    };

    // Marker labels are canvas-drawn, so wait (briefly) for Archivo Narrow first
    const fontReady = Promise.race([
      document.fonts?.load(MARKER_FONT).catch(() => undefined) ?? Promise.resolve(),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    map.on("load", () => {
      void fontReady.then(() => {
        if (mapRef.current === map) setupLayers();
      });
    });
    mapRef.current = map;

    return () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
      stopLabelRef.current?.remove();
      stopLabelRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ center, zoom, duration: prefersReducedMotion() ? 0 : 450 });
  }, [center[0], center[1], zoom]);

  /** Run now if layers exist, otherwise once the map finishes setting them up. */
  const whenReady = (source: string, fn: () => void) => {
    const map = mapRef.current;
    if (!map) return () => undefined;
    if (map.getSource(source)) {
      fn();
      return () => undefined;
    }
    map.once("sh:ready", fn);
    return () => {
      map.off("sh:ready", fn);
    };
  };

  // Vehicles glide from the shown position to the new one; they snap when motion is off
  useEffect(
    () =>
      whenReady("vehicles", () => {
        const map = mapRef.current!;
        if (animRef.current !== null) cancelAnimationFrame(animRef.current);

        const targets = new Map<string, [number, number]>();
        for (const v of vehicles) targets.set(keyOf(v), [v.lon, v.lat]);

        const glide = interpolate && !prefersReducedMotion() && vehicles.length <= 1500;
        const from = new Map(shownPos.current);
        const moving = glide
          ? [...targets].filter(([k, to]) => {
              const f = from.get(k);
              return f && (f[0] !== to[0] || f[1] !== to[1]);
            })
          : [];

        if (moving.length === 0) {
          shownPos.current = targets;
          pushVehicles(targets);
        } else {
          const start = performance.now();
          const duration = 1200;
          const frame = (now: number) => {
            const k = Math.min(1, (now - start) / duration);
            const e = 1 - (1 - k) ** 3;
            const pos = new Map(targets);
            for (const [key, to] of moving) {
              const f = from.get(key)!;
              pos.set(key, [f[0] + (to[0] - f[0]) * e, f[1] + (to[1] - f[1]) * e]);
            }
            shownPos.current = pos;
            pushVehicles(pos);
            animRef.current = k < 1 ? requestAnimationFrame(frame) : null;
          };
          animRef.current = requestAnimationFrame(frame);
        }

        if (followSelected && selectedVehicleId) {
          const sel = vehicles.find((v) => v.vehicleId === selectedVehicleId);
          if (sel) map.easeTo({ center: [sel.lon, sel.lat], duration: prefersReducedMotion() ? 0 : 350 });
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vehicles, selectedVehicleId, followSelected, interpolate, resolvedTheme]
  );

  useEffect(
    () =>
      whenReady("route-shape", () => {
        const map = mapRef.current!;
        map.setPaintProperty("route-shape-line", "line-color", routeShapeColor || theme.accent);
        (map.getSource("route-shape") as maplibregl.GeoJSONSource).setData(
          routeShape
            ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: routeShape, properties: {} }] }
            : { type: "FeatureCollection", features: [] }
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeShape, routeShapeColor, resolvedTheme]
  );

  useEffect(
    () =>
      whenReady("replay-trail", () => {
        (mapRef.current!.getSource("replay-trail") as maplibregl.GeoJSONSource).setData(
          replayTrail && replayTrail.length >= 2
            ? {
                type: "FeatureCollection",
                features: [
                  { type: "Feature", geometry: { type: "LineString", coordinates: replayTrail }, properties: {} },
                ],
              }
            : { type: "FeatureCollection", features: [] }
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [replayTrail, resolvedTheme]
  );

  useEffect(
    () =>
      whenReady("stops", () => {
        const map = mapRef.current!;
        (map.getSource("stops") as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: (stops ?? []).map((s) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [s.lon, s.lat] },
            properties: { stopId: s.stop_id, name: s.name },
          })),
        });
        map.setFilter("stops-selected", ["==", ["get", "stopId"], selectedStopId ?? ""]);

        stopLabelRef.current?.remove();
        stopLabelRef.current = null;
        const sel = selectedStopId ? (stops ?? []).find((s) => s.stop_id === selectedStopId) : undefined;
        if (sel) {
          const el = document.createElement("div");
          el.className = "sh-map-label";
          el.textContent = sel.name;
          el.setAttribute("aria-hidden", "true");
          stopLabelRef.current = new maplibregl.Marker({ element: el, anchor: "top-left", offset: [14, 10] })
            .setLngLat([sel.lon, sel.lat])
            .addTo(map);
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stops, selectedStopId, resolvedTheme]
  );

  useEffect(
    () =>
      whenReady("user-location", () => {
        (mapRef.current!.getSource("user-location") as maplibregl.GeoJSONSource).setData(
          userLocation
            ? {
                type: "FeatureCollection",
                features: [
                  {
                    type: "Feature",
                    geometry: { type: "Point", coordinates: [userLocation.lon, userLocation.lat] },
                    properties: {},
                  },
                ],
              }
            : { type: "FeatureCollection", features: [] }
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userLocation, resolvedTheme]
  );

  return (
    <div
      ref={containerRef}
      className={`w-full overflow-hidden ${heightClass}`}
      style={{
        background: "var(--paper-sunk)",
        ...(rounded ? { border: "var(--border-w) solid var(--line)", boxSizing: "border-box" } : {}),
      }}
      role="region"
      aria-label="Transit map"
    />
  );
}
