import { zipSync } from "fflate";

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return bytes;
}

function encodeVarint64(value: number): number[] {
  const bytes: number[] = [];
  let v = Math.floor(value);
  while (v >= 0x80) {
    bytes.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  bytes.push(v);
  return bytes;
}

function encodeFieldBytes(field: number, data: Uint8Array | number[]): number[] {
  const arr = Array.isArray(data) ? data : Array.from(data);
  return [...encodeVarint((field << 3) | 2), ...encodeVarint(arr.length), ...arr];
}

function encodeFieldString(field: number, str: string): number[] {
  return encodeFieldBytes(field, new TextEncoder().encode(str));
}

function encodeFieldFloat(field: number, val: number): number[] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, val, true);
  return [...encodeVarint((field << 3) | 5), ...new Uint8Array(buf)];
}

export function buildSampleGtfsRtVehiclesProtobuf(input: {
  timestampSec: number;
  vehicles: Array<{
    entityId: string;
    vehicleId: string;
    label: string;
    routeId: string;
    tripId: string;
    lat: number;
    lon: number;
    bearing?: number;
    speedMps?: number;
    stopId?: string;
    status?: number;
  }>;
}): Uint8Array {
  const header = [
    ...encodeFieldString(1, "2.0"),
    ...encodeVarint((2 << 3) | 0),
    ...encodeVarint(0),
    ...encodeVarint((3 << 3) | 0),
    ...encodeVarint64(input.timestampSec),
  ];

  const out: number[] = [...encodeFieldBytes(1, header)];

  for (const v of input.vehicles) {
    const trip = [...encodeFieldString(1, v.tripId), ...encodeFieldString(5, v.routeId)];
    const pos = [
      ...encodeFieldFloat(1, v.lat),
      ...encodeFieldFloat(2, v.lon),
      ...(v.bearing !== undefined ? encodeFieldFloat(3, v.bearing) : []),
      ...(v.speedMps !== undefined ? encodeFieldFloat(5, v.speedMps) : []),
    ];
    const vehDesc = [...encodeFieldString(1, v.vehicleId), ...encodeFieldString(2, v.label)];
    const vehPos = [
      ...encodeFieldBytes(1, trip),
      ...encodeFieldBytes(2, pos),
      ...(v.status !== undefined ? [...encodeVarint((4 << 3) | 0), ...encodeVarint(v.status)] : []),
      ...encodeVarint((5 << 3) | 0),
      ...encodeVarint64(input.timestampSec),
      ...(v.stopId ? encodeFieldString(7, v.stopId) : []),
      ...encodeFieldBytes(8, vehDesc),
    ];
    const entity = [...encodeFieldString(1, v.entityId), ...encodeFieldBytes(4, vehPos)];
    out.push(...encodeFieldBytes(2, entity));
  }

  return new Uint8Array(out);
}

export function buildSampleGtfsStaticZip(): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);
  return zipSync({
    "routes.txt": enc(
      [
        "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color",
        "99,99,Mainline,3,B91C1C,FFFFFF",
        "5,5,Goodwin,3,1D4ED8,FFFFFF",
      ].join("\n")
    ),
    "stops.txt": enc(
      [
        "stop_id,stop_code,stop_name,stop_lat,stop_lon,wheelchair_boarding",
        "S100,100,Guelph Central Station,43.5448,-80.2482,1",
        "S101,101,University Centre,43.5327,-80.2262,1",
        "S102,102,Stone Road Mall,43.5162,-80.2361,1",
      ].join("\n")
    ),
    "calendar.txt": enc(
      [
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
        "WKDAY,1,1,1,1,1,0,0,20260101,20271231",
      ].join("\n")
    ),
    "trips.txt": enc(
      [
        "route_id,service_id,trip_id,trip_headsign,direction_id,block_id,shape_id",
        "99,WKDAY,T99-1,Southbound Stone Road Mall,0,B99-A,SH99",
      ].join("\n")
    ),
    "stop_times.txt": enc(
      [
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
        "T99-1,08:00:00,08:00:00,S100,1",
        "T99-1,08:12:00,08:12:00,S101,2",
        "T99-1,08:25:00,08:25:00,S102,3",
      ].join("\n")
    ),
    "shapes.txt": enc(
      [
        "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence",
        "SH99,43.5448,-80.2482,1",
        "SH99,43.5327,-80.2262,2",
        "SH99,43.5162,-80.2361,3",
      ].join("\n")
    ),
  });
}
