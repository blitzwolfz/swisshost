import React, { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import {
  formatClock,
  formatCompass,
  formatSpeed,
  formatVehicleStatusLine,
  isTrainMode,
  vehicleModeNoun,
  type LiveVehicle,
  type RailCorridorOverlay,
  type VehicleMode,
} from "../lib/api";
import { usePreferences } from "../lib/preferences";
import { routeColor, routeTextColor } from "../lib/routeColors";

export type MapLabelMode = "line" | "line+fleet" | "icons";

interface TransitMapProps {
  center: [number, number];
  zoom: number;
  vehicles: LiveVehicle[];
  selectedVehicleId: string | null;
  onSelectVehicle?: (vehicle: LiveVehicle) => void;
  routeShape?: { type: "LineString"; coordinates: Array<[number, number]> } | null;
  /** Colour for the route shape line; defaults to the accent. */
  routeShapeColor?: string | null;
  /** Rail corridor tracks (TTC Subway / GO Rail) drawn beneath vehicles. */
  railCorridors?: RailCorridorOverlay[];
  replayTrail?: Array<[number, number]> | null;
  stops?: Array<{ stop_id: string; name: string; lat: number; lon: number }>;
  userLocation?: { lat: number; lon: number } | null;
  selectedStopId?: string | null;
  onSelectStop?: (stop: { stop_id: string; name: string; agencyId?: string }) => void;
  followSelected?: boolean;
  /** How vehicles are labelled on the map: line number (default), line + fleet #, or vehicle icons only. */
  labelMode?: MapLabelMode;
  /** Pixels hidden by an overlay at the bottom (e.g. a sheet); centring accounts for it. */
  bottomInset?: number;
  heightClass?: string;
  rounded?: boolean;
}

/** One basemap (OpenFreeMap positron), recoloured per theme into a printed-map look. */
const BASE_STYLE = "https://tiles.openfreemap.org/styles/positron";
const MARKER_FONT = '700 15px "Archivo Narrow", "Arial Narrow", sans-serif';
const MARKER_FONT_SEL = '700 17px "Archivo Narrow", "Arial Narrow", sans-serif';

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

type GlyphKind = "bus" | "train" | "streetcar";

function glyphKindFor(mode: VehicleMode | undefined | null): GlyphKind {
  if (mode === "subway" || mode === "rail") return "train";
  if (mode === "streetcar") return "streetcar";
  return "bus";
}

/** Draw the front-view transit vehicle silhouette (bus, train, or streetcar) centered at (cx, cy). */
function drawVehicleGlyph(
  ctx: CanvasRenderingContext2D,
  kind: GlyphKind,
  cx: number,
  cy: number,
  s: number,
  fgColor: string,
  cutoutColor: string
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);

  if (kind === "train") {
    // Sleek subway / commuter rail train front
    ctx.fillStyle = fgColor;
    ctx.beginPath();
    ctx.roundRect(-5.6, -7.2, 11.2, 11.4, [3.2, 3.2, 1.5, 1.5]);
    ctx.fill();

    // Split cab windshield
    ctx.fillStyle = cutoutColor;
    ctx.beginPath();
    ctx.roundRect(-4.2, -5.0, 3.6, 4.1, 0.8);
    ctx.roundRect(0.6, -5.0, 3.6, 4.1, 0.8);
    ctx.fill();

    // Twin headlights
    ctx.fillStyle = cutoutColor;
    ctx.beginPath();
    ctx.arc(-3.1, 1.7, 1.15, 0, Math.PI * 2);
    ctx.arc(3.1, 1.7, 1.15, 0, Math.PI * 2);
    ctx.fill();

    // Rail tracks underneath
    ctx.strokeStyle = fgColor;
    ctx.lineWidth = 1.45;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-3.4, 4.7);
    ctx.lineTo(-5.2, 7.2);
    ctx.moveTo(3.4, 4.7);
    ctx.lineTo(5.2, 7.2);
    ctx.moveTo(-4.4, 6.2);
    ctx.lineTo(4.4, 6.2);
    ctx.stroke();
  } else if (kind === "streetcar") {
    // Overhead pantograph
    ctx.strokeStyle = fgColor;
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    ctx.moveTo(-3.6, -7.4);
    ctx.lineTo(3.6, -7.4);
    ctx.moveTo(0, -7.4);
    ctx.lineTo(0, -5.4);
    ctx.stroke();

    // Streetcar body
    ctx.fillStyle = fgColor;
    ctx.beginPath();
    ctx.roundRect(-5.6, -5.4, 11.2, 10.2, 2);
    ctx.fill();

    // Wide front window
    ctx.fillStyle = cutoutColor;
    ctx.beginPath();
    ctx.roundRect(-4.2, -3.9, 8.4, 4.2, 0.8);
    ctx.fill();

    // Twin headlights
    ctx.fillStyle = cutoutColor;
    ctx.beginPath();
    ctx.arc(-3.1, 2.3, 1.0, 0, Math.PI * 2);
    ctx.arc(3.1, 2.3, 1.0, 0, Math.PI * 2);
    ctx.fill();

    // Tram tracks
    ctx.strokeStyle = fgColor;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-3.4, 5.2);
    ctx.lineTo(-4.6, 7.0);
    ctx.moveTo(3.4, 5.2);
    ctx.lineTo(4.6, 7.0);
    ctx.stroke();
  } else {
    // Bus body
    ctx.fillStyle = fgColor;
    ctx.beginPath();
    ctx.roundRect(-6, -6.5, 12, 11, 2);
    ctx.fill();

    // Windshield
    ctx.fillStyle = cutoutColor;
    ctx.beginPath();
    ctx.roundRect(-4.4, -4.6, 8.8, 4.4, 0.9);
    ctx.fill();

    // Destination strip
    ctx.fillStyle = cutoutColor;
    ctx.fillRect(-3, -5.8, 6, 0.75);

    // Headlights
    ctx.fillStyle = cutoutColor;
    ctx.beginPath();
    ctx.arc(-3.4, 2.1, 1.05, 0, Math.PI * 2);
    ctx.arc(3.4, 2.1, 1.05, 0, Math.PI * 2);
    ctx.fill();

    // Wheels
    ctx.fillStyle = fgColor;
    ctx.fillRect(-5, 4.2, 2.5, 2);
    ctx.fillRect(2.5, 4.2, 2.5, 2);
  }

  ctx.restore();
}

/**
 * Crisp HiDPI vehicle marker:
 * - Active routes: route-coloured pill containing the vehicle icon (train/streetcar/bus) + line number.
 * - Unassigned or icons-only mode: compact circular vehicle puck.
 * - Timetable-estimated trains get a subtle dashed border so riders distinguish them from live GPS.
 */
function drawVehicleMarker(
  kind: GlyphKind,
  color: string,
  lineLabel: string,
  selected: boolean,
  scheduled: boolean,
  t: MapTheme
): ImageData {
  const scale = 2;
  const ring = selected ? 3 : 1.75;
  const fg = routeTextColor(color);

  if (!lineLabel) {
    const r = selected ? 14 : kind === "train" ? 12 : 11;
    const size = Math.ceil((r + ring + 1) * 2);
    const cx = size / 2;
    const cy = size / 2;
    const canvas = document.createElement("canvas");
    canvas.width = size * scale;
    canvas.height = size * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);

    ctx.beginPath();
    ctx.arc(cx, cy, r + ring, 0, Math.PI * 2);
    ctx.fillStyle = selected ? t.ink : t.paper;
    ctx.fill();

    if (selected) {
      ctx.beginPath();
      ctx.arc(cx, cy, r + 1.2, 0, Math.PI * 2);
      ctx.fillStyle = t.paper;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (scheduled) {
      ctx.save();
      ctx.setLineDash([2.5, 2]);
      ctx.strokeStyle = fg;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 1.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    drawVehicleGlyph(ctx, kind, cx, cy, selected ? 1.05 : 0.85, fg, color);
    return ctx.getImageData(0, 0, size * scale, size * scale);
  }

  const font = selected ? MARKER_FONT_SEL : MARKER_FONT;
  const ctx0 = document.createElement("canvas").getContext("2d")!;
  ctx0.font = font;
  const textW = ctx0.measureText(lineLabel).width;

  const innerH = selected ? 26 : kind === "train" ? 24 : 22;
  const iconSlotW = selected ? 18 : 15;
  const gap = 3;
  const padL = selected ? 6 : 5;
  const padR = selected ? 7 : 6;
  const innerW = Math.ceil(padL + iconSlotW + gap + Math.max(12, textW) + padR);
  const w = Math.ceil(innerW + ring * 2);
  const h = Math.ceil(innerH + ring * 2);
  // Trains get slightly sharper rounded-rectangle silhouette; buses get smooth pills
  const outerRadius = kind === "train" ? 6 : h / 2;
  const innerRadius = kind === "train" ? 4.5 : innerH / 2;

  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  // Outer contrast border separates marker from route tracks & streets
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, outerRadius);
  ctx.fillStyle = selected ? t.ink : t.paper;
  ctx.fill();

  if (selected) {
    ctx.beginPath();
    ctx.roundRect(1.5, 1.5, w - 3, h - 3, Math.max(2, outerRadius - 1.5));
    ctx.fillStyle = t.paper;
    ctx.fill();
  }

  // Route-coloured body
  ctx.beginPath();
  ctx.roundRect(ring, ring, innerW, innerH, innerRadius);
  ctx.fillStyle = color;
  ctx.fill();

  // Subtle dashed inner frame for timetable-estimated trains (honest provenance cue)
  if (scheduled) {
    ctx.save();
    ctx.setLineDash([3, 2]);
    ctx.strokeStyle = fg;
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(ring + 1.2, ring + 1.2, innerW - 2.4, innerH - 2.4, Math.max(2, innerRadius - 1));
    ctx.stroke();
    ctx.restore();
  }

  // Vehicle icon on the left
  const iconCx = ring + padL + iconSlotW / 2;
  const iconCy = h / 2;
  drawVehicleGlyph(ctx, kind, iconCx, iconCy, selected ? 0.92 : 0.82, fg, color);

  // Bold line number on the right (1, 2, 4, LW, KI, 99, 504, etc.)
  const textX = ring + padL + iconSlotW + gap + Math.max(12, textW) / 2;
  ctx.fillStyle = fg;
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(lineLabel, textX, h / 2 + 0.75);

  return ctx.getImageData(0, 0, w * scale, h * scale);
}

/**
 * High-contrast directional heading pointer orbiting the vehicle marker.
 * Uses theme ink (#16140F in light mode, #FFB000 in dark mode) with a crisp paper halo
 * so it stays legible even directly on top of a same-coloured route or rail line.
 */
function drawHeading(selected: boolean, t: MapTheme): ImageData {
  const scale = 2;
  const w = selected ? 18 : 15;
  const h = selected ? 13 : 11;
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  // Crisp paper halo so the dark/amber arrow pops cleanly against coloured route tracks
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w, h);
  ctx.lineTo(w / 2, h - 2.6);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = t.paper;
  ctx.fill();

  // Sharp high-contrast ink chevron
  ctx.beginPath();
  ctx.moveTo(w / 2, 2.2);
  ctx.lineTo(w - 2.4, h - 1.6);
  ctx.lineTo(w / 2, h - 3.8);
  ctx.lineTo(2.4, h - 1.6);
  ctx.closePath();
  ctx.fillStyle = selected ? t.accent : t.ink;
  ctx.fill();

  return ctx.getImageData(0, 0, w * scale, h * scale);
}

function lineNumberOf(v: LiveVehicle): string {
  const raw = (v.routeShortName ?? v.routeId ?? "").trim();
  if (!raw) return "";
  return raw.length > 5 ? raw.slice(0, 5) : raw;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  railCorridors = [],
  replayTrail,
  stops,
  userLocation = null,
  selectedStopId = null,
  onSelectStop,
  followSelected = false,
  labelMode = "line",
  bottomInset = 0,
  heightClass = "h-[65vh] min-h-[420px]",
  rounded = true,
}: TransitMapProps) {
  const { resolvedTheme, interpolate, units } = usePreferences();
  const theme = resolvedTheme === "dark" ? DARK : LIGHT;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const vehiclesRef = useRef<LiveVehicle[]>(vehicles);
  const selectedRef = useRef<string | null>(selectedVehicleId);
  const labelModeRef = useRef<MapLabelMode>(labelMode);
  const unitsRef = useRef(units);
  const onSelectRef = useRef(onSelectVehicle);
  const onSelectStopRef = useRef(onSelectStop);
  const shownPos = useRef(new Map<string, [number, number]>());
  const animRef = useRef<number | null>(null);
  const stopLabelRef = useRef<maplibregl.Marker | null>(null);
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null);

  vehiclesRef.current = vehicles;
  selectedRef.current = selectedVehicleId;
  labelModeRef.current = labelMode;
  unitsRef.current = units;
  onSelectRef.current = onSelectVehicle;
  onSelectStopRef.current = onSelectStop;

  const keyOf = (v: LiveVehicle) => `${v.agencyId}:${v.vehicleId}`;

  const toGeoJson = (list: LiveVehicle[], selId: string | null, positions?: Map<string, [number, number]>) => ({
    type: "FeatureCollection" as const,
    features: list.map((v) => {
      const selected = v.vehicleId === selId;
      const assigned = Boolean(v.routeId || v.tripId);
      const hasBearing = v.bearingDeg !== null && Number.isFinite(v.bearingDeg);
      const color = routeColor(v.agencyId, v.routeShortName ?? v.routeId, v.routeColor);
      const stale = v.freshness === "stale";
      const scheduled = v.positionSource === "scheduled";
      const kind = glyphKindFor(v.vehicleMode);
      const pos = positions?.get(keyOf(v)) ?? [v.lon, v.lat];
      const lineNum = labelModeRef.current === "icons" ? "" : lineNumberOf(v);
      const fleetSubLabel =
        labelModeRef.current === "line+fleet" ? `#${v.fleetNumber || v.vehicleId}` : "";
      const selectedSubLabel = `#${v.fleetNumber || v.vehicleId}`;
      return {
        type: "Feature" as const,
        id: keyOf(v),
        geometry: { type: "Point" as const, coordinates: pos },
        properties: {
          agencyId: v.agencyId,
          vehicleId: v.vehicleId,
          icon: `veh|${kind}|${color}|${selected ? 1 : 0}|${scheduled ? 1 : 0}|${lineNum}`,
          headingIcon: `hdg|${selected ? 1 : 0}`,
          fleetSubLabel,
          selectedSubLabel,
          bearing: hasBearing ? v.bearingDeg : 0,
          hasBearing,
          assigned,
          isTrain: isTrainMode(v.vehicleMode),
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

    // Vehicle badges (bus/train/streetcar + line number) and heading arrows generated on demand
    map.on("styleimagemissing", (e) => {
      const id = e.id;
      if (map.hasImage(id)) return;
      if (id.startsWith("veh|")) {
        const [, kind, color, sel, sched, ...rest] = id.split("|");
        map.addImage(
          id,
          drawVehicleMarker(kind as GlyphKind, color!, rest.join("|"), sel === "1", sched === "1", t),
          { pixelRatio: 2 }
        );
      } else if (id.startsWith("hdg|")) {
        const [, sel] = id.split("|");
        map.addImage(id, drawHeading(sel === "1", t), { pixelRatio: 2 });
      }
    });

    const setupLayers = () => {
      restyleBasemap(map, t);

      // Permanent rail corridors layer (TTC Subway Lines 1/2/4 & GO Rail Lines)
      map.addSource("rail-corridors", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "rail-corridors-casing",
        type: "line",
        source: "rail-corridors",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": t.paper,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4.5, 13, 7.5],
          "line-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "rail-corridors-line",
        type: "line",
        source: "rail-corridors",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 13, 4.5],
          "line-opacity": 0.85,
        },
      });

      map.addSource("rail-stations", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "rail-stations-dots",
        type: "circle",
        source: "rail-stations",
        minzoom: 10.5,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10.5, 3, 14, 5.5],
          "circle-color": t.paper,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 2.2,
        },
      });

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
        clusterMaxZoom: 9.5,
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

      const vehicleOpacity: maplibregl.ExpressionSpecification = [
        "case",
        ["boolean", ["get", "stale"], false],
        0.42,
        ["boolean", ["get", "assigned"], true],
        1,
        0.72,
      ];

      // Directional heading arrow pointing in the vehicle's direction of travel
      map.addLayer({
        id: "vehicle-heading",
        type: "symbol",
        source: "vehicles",
        filter: ["all", ["!", ["has", "point_count"]], ["boolean", ["get", "hasBearing"], false]],
        layout: {
          "icon-image": ["get", "headingIcon"],
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-offset": ["case", ["boolean", ["get", "selected"], false], ["literal", [0, -25]], ["literal", [0, -21]]],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": vehicleOpacity },
      });

      // Vehicle icon + line number pill (trains sit above buses so subway/GO lines stay legible)
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
            ["boolean", ["get", "isTrain"], false],
            10,
            ["boolean", ["get", "stale"], false],
            0,
            ["boolean", ["get", "assigned"], true],
            2,
            1,
          ],
        },
        paint: { "icon-opacity": vehicleOpacity },
      });

      // Optional fleet # sub-label (only populated when labelMode === "line+fleet")
      map.addLayer({
        id: "vehicle-labels",
        type: "symbol",
        source: "vehicles",
        filter: ["all", ["!", ["has", "point_count"]], ["!", ["boolean", ["get", "selected"], false]]],
        minzoom: 12,
        layout: {
          "text-field": ["get", "fleetSubLabel"],
          "text-size": 10.5,
          "text-font": ["Noto Sans Bold"],
          "text-offset": [0, 1.55],
          "text-anchor": "top",
          "text-optional": true,
          "text-padding": 3,
          "symbol-sort-key": ["case", ["boolean", ["get", "isTrain"], false], 10, ["boolean", ["get", "assigned"], true], 2, 1],
        },
        paint: {
          "text-color": t.textStrong,
          "text-halo-color": t.paper,
          "text-halo-width": 2,
          "text-opacity": vehicleOpacity,
        },
      });

      // Always-visible fleet # sub-label under the selected vehicle
      map.addLayer({
        id: "vehicle-selected-label",
        type: "symbol",
        source: "vehicles",
        filter: ["all", ["!", ["has", "point_count"]], ["boolean", ["get", "selected"], false]],
        layout: {
          "text-field": ["get", "selectedSubLabel"],
          "text-size": 11.5,
          "text-font": ["Noto Sans Bold"],
          "text-offset": [0, 1.85],
          "text-anchor": "top",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": t.textStrong,
          "text-halo-color": t.paper,
          "text-halo-width": 2.2,
        },
      });

      map.addLayer({
        id: "vehicle-stale-label",
        type: "symbol",
        source: "vehicles",
        filter: ["all", ["!", ["has", "point_count"]], ["boolean", ["get", "stale"], false]],
        minzoom: 13.5,
        layout: {
          "text-field": ["get", "lastSeen"],
          "text-size": 10,
          "text-font": ["Noto Sans Italic"],
          "text-offset": [0, 2.7],
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

      // Lightweight desktop hover tooltip showing Line #, mode, destination, and vehicle #
      const hoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 18,
        className: "sh-map-popup",
      });
      hoverPopupRef.current = hoverPopup;

      map.on("mousemove", "vehicle-points", (e) => {
        const feat = e.features?.[0];
        if (!feat || feat.geometry.type !== "Point") return;
        const vid = feat.properties?.vehicleId as string | undefined;
        const ag = feat.properties?.agencyId as string | undefined;
        const found = vehiclesRef.current.find((v) => v.vehicleId === vid && (!ag || v.agencyId === ag));
        if (!found) return;
        const line = lineNumberOf(found);
        const modeLabel = vehicleModeNoun(found.vehicleMode, "Bus");
        const title = line
          ? `Line ${escapeHtml(line)} ${escapeHtml(modeLabel)} · #${escapeHtml(found.fleetNumber)}`
          : `${escapeHtml(modeLabel)} #${escapeHtml(found.fleetNumber)}`;
        const subtitle = found.headsign
          ? `Towards ${escapeHtml(found.headsign)}`
          : found.routeLongName
            ? escapeHtml(found.routeLongName)
            : line
              ? `Line ${escapeHtml(line)}`
              : "Not on a line";
        const speedText = found.speedMps !== null ? formatSpeed(found.speedMps, unitsRef.current) : null;
        const compass = found.bearingDeg !== null ? formatCompass(found.bearingDeg) : "";
        const sourceTag =
          found.positionSource === "scheduled"
            ? "Timetable estimate"
            : found.freshness === "stale"
              ? `Last seen ${formatClock(found.observedAt ?? found.receivedAt)}`
              : `Live GPS · ${found.ageSeconds}s ago`;
        const metaParts = [
          found.stopName ? formatVehicleStatusLine(found) : null,
          speedText ? `${speedText}${compass ? ` ${compass}` : ""}` : null,
          sourceTag,
        ].filter(Boolean);
        hoverPopup
          .setLngLat(feat.geometry.coordinates as [number, number])
          .setHTML(
            `<div class="sh-popup-inner">` +
              `<div class="sh-popup-title">${title}</div>` +
              `<div class="sh-popup-route">${subtitle}</div>` +
              `<div class="sh-popup-meta">${escapeHtml(metaParts.join(" · "))}</div>` +
              `</div>`
          )
          .addTo(map);
      });

      map.on("mouseleave", "vehicle-points", () => {
        hoverPopup.remove();
      });

      const handleStopClick = (e: maplibregl.MapLayerMouseEvent) => {
        if (!onSelectStopRef.current) return;
        const hitVehicle = map.queryRenderedFeatures(e.point, { layers: ["vehicle-points"] }).length > 0;
        if (hitVehicle) return;
        const p = e.features?.[0]?.properties;
        if (p?.stopId) {
          onSelectStopRef.current({
            stop_id: String(p.stopId),
            name: String(p.name ?? ""),
            agencyId: p.agencyId ? String(p.agencyId) : undefined,
          });
        }
      };

      map.on("click", "stops-dots", handleStopClick);
      map.on("click", "rail-stations-dots", handleStopClick);

      for (const layer of ["vehicle-points", "vehicle-clusters", "stops-dots", "rail-stations-dots"]) {
        map.on("mouseenter", layer, () => {
          if ((layer !== "stops-dots" && layer !== "rail-stations-dots") || onSelectStopRef.current) {
            map.getCanvas().style.cursor = "pointer";
          }
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
        });
      }

      map.fire("sh:ready");
    };

    const fontReady = Promise.race([
      document.fonts?.load(MARKER_FONT).catch(() => undefined) ?? Promise.resolve(),
      new Promise((r) => setTimeout(r, 1200)),
    ]);
    map.on("load", () => {
      void fontReady.then(() => {
        if (mapRef.current === map) setupLayers();
      });
    });
    mapRef.current = map;

    return () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
      hoverPopupRef.current?.remove();
      hoverPopupRef.current = null;
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
    map.easeTo({
      center,
      zoom,
      padding: { top: 0, left: 0, right: 0, bottom: bottomInset },
      duration: prefersReducedMotion() ? 0 : 450,
    });
  }, [center[0], center[1], zoom, bottomInset]);

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
    [vehicles, selectedVehicleId, followSelected, interpolate, labelMode, resolvedTheme]
  );

  // Rail corridor lines & stations (TTC Subway + GO Rail)
  useEffect(
    () =>
      whenReady("rail-corridors", () => {
        const map = mapRef.current!;
        (map.getSource("rail-corridors") as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: railCorridors.map((c) => ({
            type: "Feature",
            geometry: { type: "LineString", coordinates: c.coordinates },
            properties: {
              agencyId: c.agencyId,
              routeId: c.routeId,
              shortName: c.shortName,
              color: c.color,
            },
          })),
        });

        const seenStation = new Set<string>();
        const stationFeatures = railCorridors.flatMap((c) =>
          c.stations
            .filter((s) => {
              const k = `${c.agencyId}:${s.stopId}`;
              if (seenStation.has(k)) return false;
              seenStation.add(k);
              return true;
            })
            .map((s) => ({
              type: "Feature" as const,
              geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
              properties: {
                agencyId: c.agencyId,
                stopId: s.stopId,
                name: s.name,
                color: c.color,
              },
            }))
        );
        (map.getSource("rail-stations") as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: stationFeatures,
        });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [railCorridors, resolvedTheme]
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
          stopLabelRef.current = new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -14] })
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
