import type { LiveVehicleState, TransitMode } from "@swisshost/contracts";
import { bearingDegrees, getLocalServiceContext, haversineMeters } from "./index";

export interface RailStation {
  stopId: string;
  name: string;
  lat: number;
  lon: number;
  /** Cumulative scheduled minutes from station[0] along the corridor. */
  offsetMin: number;
}

export interface RailCorridor {
  agencyId: "ttc" | "go";
  routeId: string;
  shortName: string;
  longName: string;
  routeType: 0 | 1 | 2;
  mode: "subway" | "rail" | "streetcar";
  color: string;
  textColor: string;
  /** Direction 0 terminus label (index 0 -> last) and Direction 1 terminus label (last -> 0). */
  headsignFwd: string;
  headsignRev: string;
  /** Local service hours (in minutes since midnight; >1440 means after midnight). */
  startMin: number;
  endMin: number;
  /** Typical peak / off-peak headway in minutes. */
  peakHeadwayMin: number;
  offPeakHeadwayMin: number;
  /** Dwell time at each station in seconds. */
  dwellSec: number;
  /** Prefix for synthetic timetable train IDs so they never collide with live GPS fleet IDs. */
  trainPrefix: string;
  stations: RailStation[];
}

export interface RailCorridorGeo {
  agencyId: string;
  routeId: string;
  shortName: string;
  longName: string;
  mode: "subway" | "rail" | "streetcar";
  color: string;
  textColor: string;
  coordinates: Array<[number, number]>;
  stations: Array<{ stopId: string; name: string; lat: number; lon: number }>;
}

/**
 * Official TTC Subway and GO Transit / UP Express rail corridors with real station coordinates
 * and inter-station run times. Used for:
 *  - Rail corridor line rendering on the map
 *  - Authentic line colours and mode classification (subway / rail / streetcar / bus)
 *  - Timetable-estimated train positions & station timelines whenever a live GPS feed is
 *    unavailable (e.g. TTC underground subway or GO Transit before GO_TRANSIT_API_KEY is bound)
 *  - Rail-aware trip planning alongside GTFS bus/streetcar routes
 */
export const RAIL_CORRIDORS: RailCorridor[] = [
  // =========================================================================
  // TTC SUBWAY LINES (1, 2, 4)
  // =========================================================================
  {
    agencyId: "ttc",
    routeId: "1",
    shortName: "1",
    longName: "Line 1 (Yonge-University)",
    routeType: 1,
    mode: "subway",
    color: "#F8C300",
    textColor: "#16140F",
    headsignFwd: "Finch",
    headsignRev: "Vaughan Metropolitan Centre",
    startMin: 360, // 06:00
    endMin: 1545, // 01:45 (+1d)
    peakHeadwayMin: 4,
    offPeakHeadwayMin: 6,
    dwellSec: 25,
    trainPrefix: "T1",
    stations: [
      { stopId: "ttc-l1-vmc", name: "Vaughan Metropolitan Centre", lat: 43.7942, lon: -79.5275, offsetMin: 0 },
      { stopId: "ttc-l1-hwy407", name: "Highway 407 Station", lat: 43.7832, lon: -79.5237, offsetMin: 3 },
      { stopId: "ttc-l1-pioneer", name: "Pioneer Village Station", lat: 43.7771, lon: -79.5095, offsetMin: 6 },
      { stopId: "ttc-l1-yorku", name: "York University Station", lat: 43.7741, lon: -79.4998, offsetMin: 8 },
      { stopId: "ttc-l1-finchwest", name: "Finch West Station", lat: 43.7652, lon: -79.4911, offsetMin: 11 },
      { stopId: "ttc-l1-downsviewpk", name: "Downsview Park Station", lat: 43.7537, lon: -79.4785, offsetMin: 14 },
      { stopId: "ttc-l1-sheppardw", name: "Sheppard West Station", lat: 43.7493, lon: -79.4622, offsetMin: 17 },
      { stopId: "ttc-l1-wilson", name: "Wilson Station", lat: 43.7341, lon: -79.4501, offsetMin: 20 },
      { stopId: "ttc-l1-yorkdale", name: "Yorkdale Station", lat: 43.7247, lon: -79.4475, offsetMin: 22 },
      { stopId: "ttc-l1-lawrencew", name: "Lawrence West Station", lat: 43.7159, lon: -79.4441, offsetMin: 25 },
      { stopId: "ttc-l1-glencairn", name: "Glencairn Station", lat: 43.7088, lon: -79.4408, offsetMin: 27 },
      { stopId: "ttc-l1-eglintonw", name: "Cedarvale (Eglinton West)", lat: 43.6992, lon: -79.4358, offsetMin: 29 },
      { stopId: "ttc-l1-stclairw", name: "St Clair West Station", lat: 43.6839, lon: -79.4151, offsetMin: 33 },
      { stopId: "ttc-l1-dupont", name: "Dupont Station", lat: 43.6746, lon: -79.4068, offsetMin: 35 },
      { stopId: "ttc-l1-spadina", name: "Spadina Station", lat: 43.6673, lon: -79.4038, offsetMin: 37 },
      { stopId: "ttc-l1-stgeorge", name: "St George Station", lat: 43.6682, lon: -79.3998, offsetMin: 39 },
      { stopId: "ttc-l1-museum", name: "Museum Station", lat: 43.6671, lon: -79.3936, offsetMin: 41 },
      { stopId: "ttc-l1-queenspk", name: "Queen's Park Station", lat: 43.6599, lon: -79.3905, offsetMin: 43 },
      { stopId: "ttc-l1-stpatrick", name: "St Patrick Station", lat: 43.6548, lon: -79.3883, offsetMin: 45 },
      { stopId: "ttc-l1-osgoode", name: "Osgoode Station", lat: 43.6507, lon: -79.3866, offsetMin: 46 },
      { stopId: "ttc-l1-standrew", name: "St Andrew Station", lat: 43.6476, lon: -79.3848, offsetMin: 48 },
      { stopId: "ttc-l1-union", name: "Union Station", lat: 43.6456, lon: -79.3806, offsetMin: 50 },
      { stopId: "ttc-l1-king", name: "King Station", lat: 43.6491, lon: -79.3779, offsetMin: 52 },
      { stopId: "ttc-l1-queen", name: "Queen Station", lat: 43.6524, lon: -79.3792, offsetMin: 53 },
      { stopId: "ttc-l1-dundas", name: "TMU (Dundas) Station", lat: 43.6564, lon: -79.3808, offsetMin: 55 },
      { stopId: "ttc-l1-college", name: "College Station", lat: 43.6614, lon: -79.3831, offsetMin: 57 },
      { stopId: "ttc-l1-wellesley", name: "Wellesley Station", lat: 43.6654, lon: -79.3838, offsetMin: 58 },
      { stopId: "ttc-l1-bloor", name: "Bloor-Yonge Station", lat: 43.6709, lon: -79.3857, offsetMin: 60 },
      { stopId: "ttc-l1-rosedale", name: "Rosedale Station", lat: 43.6768, lon: -79.3887, offsetMin: 62 },
      { stopId: "ttc-l1-summerhill", name: "Summerhill Station", lat: 43.6822, lon: -79.3908, offsetMin: 64 },
      { stopId: "ttc-l1-stclair", name: "St Clair Station", lat: 43.6879, lon: -79.3932, offsetMin: 66 },
      { stopId: "ttc-l1-davisville", name: "Davisville Station", lat: 43.6977, lon: -79.3972, offsetMin: 68 },
      { stopId: "ttc-l1-eglinton", name: "Eglinton Station", lat: 43.7059, lon: -79.3987, offsetMin: 71 },
      { stopId: "ttc-l1-lawrence", name: "Lawrence Station", lat: 43.7250, lon: -79.4022, offsetMin: 75 },
      { stopId: "ttc-l1-yorkmills", name: "York Mills Station", lat: 43.7441, lon: -79.4067, offsetMin: 79 },
      { stopId: "ttc-l1-sheppard", name: "Sheppard-Yonge Station", lat: 43.7615, lon: -79.4109, offsetMin: 82 },
      { stopId: "ttc-l1-northyork", name: "North York Centre Station", lat: 43.7681, lon: -79.4128, offsetMin: 84 },
      { stopId: "ttc-l1-finch", name: "Finch Station", lat: 43.7805, lon: -79.4154, offsetMin: 87 },
    ],
  },
  {
    agencyId: "ttc",
    routeId: "2",
    shortName: "2",
    longName: "Line 2 (Bloor-Danforth)",
    routeType: 1,
    mode: "subway",
    color: "#00923F",
    textColor: "#FFFFFF",
    headsignFwd: "Kennedy",
    headsignRev: "Kipling",
    startMin: 360,
    endMin: 1545,
    peakHeadwayMin: 4,
    offPeakHeadwayMin: 6,
    dwellSec: 25,
    trainPrefix: "T2",
    stations: [
      { stopId: "ttc-l2-kipling", name: "Kipling Station", lat: 43.6375, lon: -79.5356, offsetMin: 0 },
      { stopId: "ttc-l2-islington", name: "Islington Station", lat: 43.6454, lon: -79.5245, offsetMin: 3 },
      { stopId: "ttc-l2-royalyork", name: "Royal York Station", lat: 43.6482, lon: -79.5113, offsetMin: 5 },
      { stopId: "ttc-l2-oldmill", name: "Old Mill Station", lat: 43.6498, lon: -79.4946, offsetMin: 8 },
      { stopId: "ttc-l2-jane", name: "Jane Station", lat: 43.6499, lon: -79.4838, offsetMin: 10 },
      { stopId: "ttc-l2-runnymede", name: "Runnymede Station", lat: 43.6517, lon: -79.4758, offsetMin: 12 },
      { stopId: "ttc-l2-highpark", name: "High Park Station", lat: 43.6539, lon: -79.4668, offsetMin: 14 },
      { stopId: "ttc-l2-keele", name: "Keele Station", lat: 43.6556, lon: -79.4596, offsetMin: 16 },
      { stopId: "ttc-l2-dundasw", name: "Dundas West Station", lat: 43.6569, lon: -79.4529, offsetMin: 18 },
      { stopId: "ttc-l2-lansdowne", name: "Lansdowne Station", lat: 43.6592, lon: -79.4426, offsetMin: 20 },
      { stopId: "ttc-l2-dufferin", name: "Dufferin Station", lat: 43.6602, lon: -79.4357, offsetMin: 22 },
      { stopId: "ttc-l2-ossington", name: "Ossington Station", lat: 43.6623, lon: -79.4264, offsetMin: 24 },
      { stopId: "ttc-l2-christie", name: "Christie Station", lat: 43.6641, lon: -79.4184, offsetMin: 26 },
      { stopId: "ttc-l2-bathurst", name: "Bathurst Station", lat: 43.6660, lon: -79.4112, offsetMin: 28 },
      { stopId: "ttc-l2-spadina", name: "Spadina Station", lat: 43.6673, lon: -79.4038, offsetMin: 30 },
      { stopId: "ttc-l2-stgeorge", name: "St George Station", lat: 43.6682, lon: -79.3998, offsetMin: 31 },
      { stopId: "ttc-l2-bay", name: "Bay Station", lat: 43.6701, lon: -79.3900, offsetMin: 33 },
      { stopId: "ttc-l2-bloor", name: "Bloor-Yonge Station", lat: 43.6709, lon: -79.3857, offsetMin: 35 },
      { stopId: "ttc-l2-sherbourne", name: "Sherbourne Station", lat: 43.6722, lon: -79.3764, offsetMin: 37 },
      { stopId: "ttc-l2-castlefrank", name: "Castle Frank Station", lat: 43.6737, lon: -79.3688, offsetMin: 39 },
      { stopId: "ttc-l2-broadview", name: "Broadview Station", lat: 43.6769, lon: -79.3585, offsetMin: 41 },
      { stopId: "ttc-l2-chester", name: "Chester Station", lat: 43.6782, lon: -79.3525, offsetMin: 43 },
      { stopId: "ttc-l2-pape", name: "Pape Station", lat: 43.6799, lon: -79.3449, offsetMin: 45 },
      { stopId: "ttc-l2-donlands", name: "Donlands Station", lat: 43.6810, lon: -79.3377, offsetMin: 47 },
      { stopId: "ttc-l2-greenwood", name: "Greenwood Station", lat: 43.6826, lon: -79.3303, offsetMin: 49 },
      { stopId: "ttc-l2-coxwell", name: "Coxwell Station", lat: 43.6842, lon: -79.3231, offsetMin: 51 },
      { stopId: "ttc-l2-woodbine", name: "Woodbine Station", lat: 43.6864, lon: -79.3128, offsetMin: 53 },
      { stopId: "ttc-l2-mainst", name: "Main Street Station", lat: 43.6890, lon: -79.3016, offsetMin: 55 },
      { stopId: "ttc-l2-vicpark", name: "Victoria Park Station", lat: 43.6949, lon: -79.2886, offsetMin: 58 },
      { stopId: "ttc-l2-warden", name: "Warden Station", lat: 43.7113, lon: -79.2797, offsetMin: 62 },
      { stopId: "ttc-l2-kennedy", name: "Kennedy Station", lat: 43.7324, lon: -79.2636, offsetMin: 66 },
    ],
  },
  {
    agencyId: "ttc",
    routeId: "4",
    shortName: "4",
    longName: "Line 4 (Sheppard)",
    routeType: 1,
    mode: "subway",
    color: "#A21A68",
    textColor: "#FFFFFF",
    headsignFwd: "Don Mills",
    headsignRev: "Sheppard-Yonge",
    startMin: 360,
    endMin: 1560,
    peakHeadwayMin: 6,
    offPeakHeadwayMin: 7,
    dwellSec: 25,
    trainPrefix: "T4",
    stations: [
      { stopId: "ttc-l4-sheppard", name: "Sheppard-Yonge Station", lat: 43.7615, lon: -79.4109, offsetMin: 0 },
      { stopId: "ttc-l4-bayview", name: "Bayview Station", lat: 43.7669, lon: -79.3867, offsetMin: 4 },
      { stopId: "ttc-l4-bessarion", name: "Bessarion Station", lat: 43.7691, lon: -79.3764, offsetMin: 6 },
      { stopId: "ttc-l4-leslie", name: "Leslie Station", lat: 43.7712, lon: -79.3653, offsetMin: 9 },
      { stopId: "ttc-l4-donmills", name: "Don Mills Station", lat: 43.7755, lon: -79.3463, offsetMin: 12 },
    ],
  },

  // =========================================================================
  // GO TRANSIT RAIL LINES & UP EXPRESS
  // =========================================================================
  {
    agencyId: "go",
    routeId: "LW",
    shortName: "LW",
    longName: "Lakeshore West",
    routeType: 2,
    mode: "rail",
    color: "#8D0E3A",
    textColor: "#FFFFFF",
    headsignFwd: "Union Station",
    headsignRev: "Aldershot / West Harbour",
    startMin: 330,
    endMin: 1515,
    peakHeadwayMin: 15,
    offPeakHeadwayMin: 30,
    dwellSec: 45,
    trainPrefix: "GO-LW",
    stations: [
      { stopId: "go-lw-wh", name: "West Harbour GO", lat: 43.2667, lon: -79.8664, offsetMin: 0 },
      { stopId: "go-lw-al", name: "Aldershot GO", lat: 43.3133, lon: -79.8556, offsetMin: 11 },
      { stopId: "go-lw-bu", name: "Burlington GO", lat: 43.3413, lon: -79.8094, offsetMin: 18 },
      { stopId: "go-lw-ap", name: "Appleby GO", lat: 43.3792, lon: -79.7611, offsetMin: 24 },
      { stopId: "go-lw-bo", name: "Bronte GO", lat: 43.4173, lon: -79.7222, offsetMin: 30 },
      { stopId: "go-lw-oa", name: "Oakville GO", lat: 43.4547, lon: -79.6826, offsetMin: 37 },
      { stopId: "go-lw-cl", name: "Clarkson GO", lat: 43.5127, lon: -79.6335, offsetMin: 45 },
      { stopId: "go-lw-po", name: "Port Credit GO", lat: 43.5559, lon: -79.5872, offsetMin: 52 },
      { stopId: "go-lw-lo", name: "Long Branch GO", lat: 43.5919, lon: -79.5457, offsetMin: 58 },
      { stopId: "go-lw-mi", name: "Mimico GO", lat: 43.6164, lon: -79.4969, offsetMin: 64 },
      { stopId: "go-lw-ex", name: "Exhibition GO", lat: 43.6357, lon: -79.4190, offsetMin: 71 },
      { stopId: "go-union", name: "Union Station GO", lat: 43.6452, lon: -79.3806, offsetMin: 78 },
    ],
  },
  {
    agencyId: "go",
    routeId: "LE",
    shortName: "LE",
    longName: "Lakeshore East",
    routeType: 2,
    mode: "rail",
    color: "#C8102E",
    textColor: "#FFFFFF",
    headsignFwd: "Durham College Oshawa GO",
    headsignRev: "Union Station",
    startMin: 330,
    endMin: 1515,
    peakHeadwayMin: 15,
    offPeakHeadwayMin: 30,
    dwellSec: 45,
    trainPrefix: "GO-LE",
    stations: [
      { stopId: "go-union", name: "Union Station GO", lat: 43.6452, lon: -79.3806, offsetMin: 0 },
      { stopId: "go-le-da", name: "Danforth GO", lat: 43.6865, lon: -79.3002, offsetMin: 11 },
      { stopId: "go-le-sc", name: "Scarborough GO", lat: 43.7169, lon: -79.2546, offsetMin: 18 },
      { stopId: "go-le-eg", name: "Eglinton GO", lat: 43.7397, lon: -79.2323, offsetMin: 23 },
      { stopId: "go-le-gu", name: "Guildwood GO", lat: 43.7550, lon: -79.1981, offsetMin: 28 },
      { stopId: "go-le-ro", name: "Rouge Hill GO", lat: 43.7805, lon: -79.1306, offsetMin: 35 },
      { stopId: "go-le-pi", name: "Pickering GO", lat: 43.8313, lon: -79.0850, offsetMin: 43 },
      { stopId: "go-le-aj", name: "Ajax GO", lat: 43.8482, lon: -79.0414, offsetMin: 49 },
      { stopId: "go-le-wh", name: "Whitby GO", lat: 43.8647, lon: -78.9383, offsetMin: 56 },
      { stopId: "go-le-os", name: "Durham College Oshawa GO", lat: 43.8706, lon: -78.8855, offsetMin: 63 },
    ],
  },
  {
    agencyId: "go",
    routeId: "KI",
    shortName: "KI",
    longName: "Kitchener",
    routeType: 2,
    mode: "rail",
    color: "#00693E",
    textColor: "#FFFFFF",
    headsignFwd: "Union Station",
    headsignRev: "Kitchener / Mount Pleasant GO",
    startMin: 345,
    endMin: 1440,
    peakHeadwayMin: 30,
    offPeakHeadwayMin: 60,
    dwellSec: 45,
    trainPrefix: "GO-KI",
    stations: [
      { stopId: "go-ki-ki", name: "Kitchener GO", lat: 43.4557, lon: -80.4932, offsetMin: 0 },
      { stopId: "go-ki-gl", name: "Guelph Central GO", lat: 43.5446, lon: -80.2465, offsetMin: 22 },
      { stopId: "go-ki-ac", name: "Acton GO", lat: 43.6334, lon: -80.0349, offsetMin: 37 },
      { stopId: "go-ki-ge", name: "Georgetown GO", lat: 43.6554, lon: -79.9190, offsetMin: 49 },
      { stopId: "go-ki-mo", name: "Mount Pleasant GO", lat: 43.6752, lon: -79.8226, offsetMin: 59 },
      { stopId: "go-ki-br", name: "Brampton Innovation District GO", lat: 43.6866, lon: -79.7647, offsetMin: 66 },
      { stopId: "go-ki-be", name: "Bramalea GO", lat: 43.7018, lon: -79.6908, offsetMin: 74 },
      { stopId: "go-ki-ma", name: "Malton GO", lat: 43.7052, lon: -79.6382, offsetMin: 80 },
      { stopId: "go-ki-et", name: "Etobicoke North GO", lat: 43.7064, lon: -79.5633, offsetMin: 87 },
      { stopId: "go-ki-we", name: "Weston GO", lat: 43.7003, lon: -79.5146, offsetMin: 93 },
      { stopId: "go-ki-bl", name: "Bloor GO", lat: 43.6568, lon: -79.4504, offsetMin: 101 },
      { stopId: "go-union", name: "Union Station GO", lat: 43.6452, lon: -79.3806, offsetMin: 110 },
    ],
  },
  {
    agencyId: "go",
    routeId: "BR",
    shortName: "BR",
    longName: "Barrie",
    routeType: 2,
    mode: "rail",
    color: "#003767",
    textColor: "#FFFFFF",
    headsignFwd: "Union Station",
    headsignRev: "Allandale Waterfront GO",
    startMin: 360,
    endMin: 1410,
    peakHeadwayMin: 30,
    offPeakHeadwayMin: 60,
    dwellSec: 45,
    trainPrefix: "GO-BR",
    stations: [
      { stopId: "go-br-ba", name: "Allandale Waterfront GO", lat: 44.3742, lon: -79.6873, offsetMin: 0 },
      { stopId: "go-br-bs", name: "Barrie South GO", lat: 44.3514, lon: -79.6277, offsetMin: 8 },
      { stopId: "go-br-bd", name: "Bradford GO", lat: 44.1173, lon: -79.5563, offsetMin: 28 },
      { stopId: "go-br-ea", name: "East Gwillimbury GO", lat: 44.0772, lon: -79.4557, offsetMin: 38 },
      { stopId: "go-br-ne", name: "Newmarket GO", lat: 44.0609, lon: -79.4606, offsetMin: 43 },
      { stopId: "go-br-au", name: "Aurora GO", lat: 44.0010, lon: -79.4596, offsetMin: 50 },
      { stopId: "go-br-kc", name: "King City GO", lat: 43.9200, lon: -79.5269, offsetMin: 59 },
      { stopId: "go-br-ma", name: "Maple GO", lat: 43.8594, lon: -79.5067, offsetMin: 66 },
      { stopId: "go-br-ru", name: "Rutherford GO", lat: 43.8380, lon: -79.4986, offsetMin: 71 },
      { stopId: "go-br-dw", name: "Downsview Park GO", lat: 43.7537, lon: -79.4785, offsetMin: 81 },
      { stopId: "go-union", name: "Union Station GO", lat: 43.6452, lon: -79.3806, offsetMin: 98 },
    ],
  },
  {
    agencyId: "go",
    routeId: "ST",
    shortName: "ST",
    longName: "Stouffville",
    routeType: 2,
    mode: "rail",
    color: "#794500",
    textColor: "#FFFFFF",
    headsignFwd: "Union Station",
    headsignRev: "Old Elm / Mount Joy GO",
    startMin: 360,
    endMin: 1410,
    peakHeadwayMin: 30,
    offPeakHeadwayMin: 60,
    dwellSec: 45,
    trainPrefix: "GO-ST",
    stations: [
      { stopId: "go-st-li", name: "Old Elm GO", lat: 43.9721, lon: -79.2335, offsetMin: 0 },
      { stopId: "go-st-st", name: "Stouffville GO", lat: 43.9711, lon: -79.2501, offsetMin: 4 },
      { stopId: "go-st-mj", name: "Mount Joy GO", lat: 43.9001, lon: -79.2627, offsetMin: 14 },
      { stopId: "go-st-mr", name: "Markham GO", lat: 43.8825, lon: -79.2626, offsetMin: 18 },
      { stopId: "go-st-ce", name: "Centennial GO", lat: 43.8737, lon: -79.2896, offsetMin: 23 },
      { stopId: "go-st-un", name: "Unionville GO", lat: 43.8515, lon: -79.3143, offsetMin: 29 },
      { stopId: "go-st-mi", name: "Milliken GO", lat: 43.8232, lon: -79.3016, offsetMin: 35 },
      { stopId: "go-st-ag", name: "Agincourt GO", lat: 43.7859, lon: -79.2845, offsetMin: 42 },
      { stopId: "go-st-ke", name: "Kennedy GO", lat: 43.7327, lon: -79.2627, offsetMin: 50 },
      { stopId: "go-union", name: "Union Station GO", lat: 43.6452, lon: -79.3806, offsetMin: 68 },
    ],
  },
  {
    agencyId: "go",
    routeId: "MI",
    shortName: "MI",
    longName: "Milton",
    routeType: 2,
    mode: "rail",
    color: "#C45B00",
    textColor: "#FFFFFF",
    headsignFwd: "Union Station",
    headsignRev: "Milton GO",
    startMin: 360,
    endMin: 1185,
    peakHeadwayMin: 30,
    offPeakHeadwayMin: 60,
    dwellSec: 45,
    trainPrefix: "GO-MI",
    stations: [
      { stopId: "go-mi-mi", name: "Milton GO", lat: 43.5233, lon: -79.8669, offsetMin: 0 },
      { stopId: "go-mi-li", name: "Lisgar GO", lat: 43.5906, lon: -79.7885, offsetMin: 12 },
      { stopId: "go-mi-me", name: "Meadowvale GO", lat: 43.5975, lon: -79.7539, offsetMin: 18 },
      { stopId: "go-mi-st", name: "Streetsville GO", lat: 43.5764, lon: -79.7087, offsetMin: 25 },
      { stopId: "go-mi-er", name: "Erindale GO", lat: 43.5691, lon: -79.6689, offsetMin: 31 },
      { stopId: "go-mi-co", name: "Cooksville GO", lat: 43.5830, lon: -79.6238, offsetMin: 38 },
      { stopId: "go-mi-di", name: "Dixie GO", lat: 43.6078, lon: -79.5778, offsetMin: 44 },
      { stopId: "go-mi-ki", name: "Kipling GO", lat: 43.6356, lon: -79.5364, offsetMin: 50 },
      { stopId: "go-union", name: "Union Station GO", lat: 43.6452, lon: -79.3806, offsetMin: 64 },
    ],
  },
  {
    agencyId: "go",
    routeId: "RH",
    shortName: "RH",
    longName: "Richmond Hill",
    routeType: 2,
    mode: "rail",
    color: "#007BA7",
    textColor: "#FFFFFF",
    headsignFwd: "Union Station",
    headsignRev: "Bloomington GO",
    startMin: 360,
    endMin: 1170,
    peakHeadwayMin: 30,
    offPeakHeadwayMin: 60,
    dwellSec: 45,
    trainPrefix: "GO-RH",
    stations: [
      { stopId: "go-rh-bl", name: "Bloomington GO", lat: 43.9562, lon: -79.4193, offsetMin: 0 },
      { stopId: "go-rh-go", name: "Gormley GO", lat: 43.9420, lon: -79.3991, offsetMin: 5 },
      { stopId: "go-rh-rh", name: "Richmond Hill GO", lat: 43.8749, lon: -79.4265, offsetMin: 16 },
      { stopId: "go-rh-la", name: "Langstaff GO", lat: 43.8388, lon: -79.4235, offsetMin: 23 },
      { stopId: "go-rh-oc", name: "Old Cummer GO", lat: 43.7928, lon: -79.3712, offsetMin: 32 },
      { stopId: "go-rh-or", name: "Oriole GO", lat: 43.7652, lon: -79.3645, offsetMin: 38 },
      { stopId: "go-union", name: "Union Station GO", lat: 43.6452, lon: -79.3806, offsetMin: 58 },
    ],
  },
  {
    agencyId: "go",
    routeId: "UP",
    shortName: "UP",
    longName: "UP Express (Union Pearson)",
    routeType: 2,
    mode: "rail",
    color: "#2B4C7E",
    textColor: "#FFFFFF",
    headsignFwd: "Toronto Pearson Airport",
    headsignRev: "Union Station",
    startMin: 300, // 05:00
    endMin: 1500, // 01:00 (+1d)
    peakHeadwayMin: 15,
    offPeakHeadwayMin: 15,
    dwellSec: 35,
    trainPrefix: "UP",
    stations: [
      { stopId: "go-union", name: "Union Station (UP)", lat: 43.6452, lon: -79.3806, offsetMin: 0 },
      { stopId: "go-up-bloor", name: "Bloor (UP Express)", lat: 43.6568, lon: -79.4504, offsetMin: 8 },
      { stopId: "go-up-weston", name: "Weston (UP Express)", lat: 43.7003, lon: -79.5146, offsetMin: 15 },
      { stopId: "go-up-pearson", name: "Pearson Airport Terminal 1", lat: 43.6817, lon: -79.6130, offsetMin: 25 },
    ],
  },
];

const CORRIDOR_BY_AGENCY_ROUTE = new Map<string, RailCorridor>();
for (const c of RAIL_CORRIDORS) {
  CORRIDOR_BY_AGENCY_ROUTE.set(`${c.agencyId}:${c.routeId.toUpperCase()}`, c);
  CORRIDOR_BY_AGENCY_ROUTE.set(`${c.agencyId}:${c.shortName.toUpperCase()}`, c);
}

const GO_RAIL_CODES = new Set(["LW", "LE", "KI", "MI", "RH", "ST", "BR", "UP"]);
const TTC_SUBWAY_CODES = new Set(["1", "2", "4"]);
const TTC_STREETCAR_CODES = new Set([
  "5", "6",
  "501", "503", "504", "505", "506", "507", "508", "509", "510", "511", "512",
  "301", "304", "305", "306", "310", "312",
]);

/**
 * Determine the transit mode ("subway", "rail", "streetcar", "bus") from GTFS route_type
 * and agency-specific line conventions.
 */
export function inferVehicleMode(
  agencyId: string,
  routeId: string | null | undefined,
  routeShortName?: string | null,
  routeType?: number | null
): TransitMode {
  if (routeType === 1) return "subway";
  if (routeType === 2) return "rail";
  if (routeType === 0) return "streetcar";
  if (routeType === 4) return "ferry";
  if (routeType === 3) return "bus";

  const code = (routeShortName ?? routeId ?? "").trim().toUpperCase();
  const baseCode = code.replace(/^[0-9]+-/, ""); // handles GO GTFS IDs like "01241126-LW"
  if (agencyId === "ttc") {
    if (TTC_SUBWAY_CODES.has(code)) return "subway";
    if (TTC_STREETCAR_CODES.has(code)) return "streetcar";
    return "bus";
  }
  if (agencyId === "go") {
    if (GO_RAIL_CODES.has(code) || GO_RAIL_CODES.has(baseCode)) return "rail";
    return "bus";
  }
  return "bus";
}

export function isRailMode(mode: TransitMode | null | undefined): boolean {
  return mode === "subway" || mode === "rail";
}

export function getRailCorridor(agencyId: string, routeIdOrShort: string | null | undefined): RailCorridor | null {
  if (!routeIdOrShort) return null;
  const raw = routeIdOrShort.trim().toUpperCase();
  const base = raw.replace(/^[0-9]+-/, "");
  return (
    CORRIDOR_BY_AGENCY_ROUTE.get(`${agencyId}:${raw}`) ??
    CORRIDOR_BY_AGENCY_ROUTE.get(`${agencyId}:${base}`) ??
    null
  );
}

export function getRailCorridorsForAgency(agencyId: string): RailCorridorGeo[] {
  const list = agencyId === "all" ? RAIL_CORRIDORS : RAIL_CORRIDORS.filter((c) => c.agencyId === agencyId);
  return list.map((c) => ({
    agencyId: c.agencyId,
    routeId: c.routeId,
    shortName: c.shortName,
    longName: c.longName,
    mode: c.mode,
    color: c.color,
    textColor: c.textColor,
    coordinates: c.stations.map((s) => [s.lon, s.lat]),
    stations: c.stations.map((s) => ({ stopId: s.stopId, name: s.name, lat: s.lat, lon: s.lon })),
  }));
}

function isPeakHour(serviceMin: number): boolean {
  const m = serviceMin % 1440;
  return (m >= 420 && m <= 570) || (m >= 930 && m <= 1140); // 7:00-9:30 AM or 3:30-7:00 PM
}

interface ActiveTrainSlot {
  corridor: RailCorridor;
  directionId: 0 | 1;
  departMin: number;
  elapsedSec: number;
  orderedStations: RailStation[];
  totalRunSec: number;
  slotIndex: number;
}

function activeSlotsForCorridor(corridor: RailCorridor, serviceSeconds: number): ActiveTrainSlot[] {
  const serviceMin = serviceSeconds / 60;
  if (serviceMin < corridor.startMin || serviceMin > corridor.endMin) return [];

  const totalRunMin = corridor.stations[corridor.stations.length - 1]!.offsetMin;
  const totalRunSec = totalRunMin * 60;
  const headwayMin = isPeakHour(serviceMin) ? corridor.peakHeadwayMin : corridor.offPeakHeadwayMin;

  const revStations: RailStation[] = [...corridor.stations].reverse().map((s) => ({
    ...s,
    offsetMin: totalRunMin - s.offsetMin,
  }));

  const slots: ActiveTrainSlot[] = [];

  for (const dir of [0, 1] as const) {
    const ordered = dir === 0 ? corridor.stations : revStations;
    // Slight deterministic offset between directions so opposing trains don't overlap identically
    const phaseShift = dir === 1 ? Math.floor(headwayMin / 2) : 0;
    const earliestDep = Math.max(corridor.startMin, Math.floor((serviceMin - totalRunMin) / headwayMin) * headwayMin);
    const latestDep = Math.min(corridor.endMin, Math.floor(serviceMin / headwayMin) * headwayMin + headwayMin);

    let slotIdx = 0;
    for (let dep = earliestDep; dep <= latestDep; dep += headwayMin) {
      const actualDep = dep + phaseShift;
      if (actualDep < corridor.startMin || actualDep > corridor.endMin) continue;
      const elapsedSec = serviceSeconds - actualDep * 60;
      if (elapsedSec < 0 || elapsedSec > totalRunSec) continue;
      slotIdx++;
      slots.push({
        corridor,
        directionId: dir,
        departMin: actualDep,
        elapsedSec,
        orderedStations: ordered,
        totalRunSec,
        slotIndex: Math.floor(actualDep / headwayMin) % 90 + 10,
      });
    }
  }

  return slots;
}

function interpolateSlot(slot: ActiveTrainSlot): {
  lat: number;
  lon: number;
  bearingDeg: number;
  speedMps: number;
  currentStatus: "STOPPED_AT" | "INCOMING_AT" | "IN_TRANSIT_TO";
  stopIndex: number;
  stop: RailStation;
} {
  const { orderedStations, elapsedSec, corridor } = slot;
  let segIdx = 0;
  for (let i = 0; i < orderedStations.length - 1; i++) {
    if (elapsedSec >= orderedStations[i]!.offsetMin * 60) {
      segIdx = i;
    } else {
      break;
    }
  }

  const a = orderedStations[segIdx]!;
  const b = orderedStations[Math.min(segIdx + 1, orderedStations.length - 1)]!;
  const segStartSec = a.offsetMin * 60;
  const segEndSec = b.offsetMin * 60;
  const segDurSec = Math.max(30, segEndSec - segStartSec);
  const inSegSec = Math.max(0, elapsedSec - segStartSec);
  const dwell = Math.min(corridor.dwellSec, Math.floor(segDurSec * 0.35));
  const segDist = haversineMeters(a.lat, a.lon, b.lat, b.lon);
  const bearingDeg = segDist > 5 ? bearingDegrees(a.lat, a.lon, b.lat, b.lon) : 0;

  if (inSegSec <= dwell || a.stopId === b.stopId) {
    return {
      lat: a.lat,
      lon: a.lon,
      bearingDeg,
      speedMps: 0,
      currentStatus: "STOPPED_AT",
      stopIndex: segIdx,
      stop: a,
    };
  }

  const moveDur = Math.max(15, segDurSec - dwell);
  const frac = Math.min(1, (inSegSec - dwell) / moveDur);
  const lat = a.lat + (b.lat - a.lat) * frac;
  const lon = a.lon + (b.lon - a.lon) * frac;
  const speedMps = Number((segDist / moveDur).toFixed(1));
  const currentStatus = frac >= 0.82 ? "INCOMING_AT" : "IN_TRANSIT_TO";
  const targetIdx = Math.min(segIdx + 1, orderedStations.length - 1);

  return {
    lat,
    lon,
    bearingDeg,
    speedMps,
    currentStatus,
    stopIndex: targetIdx,
    stop: orderedStations[targetIdx]!,
  };
}

/**
 * Generate timetable-estimated train positions for TTC Subway (Lines 1, 2, 4) and GO Rail
 * (LW, LE, KI, MI, RH, ST, BR, UP), skipping any route that already has live GPS vehicles.
 */
export function generateScheduledRailVehicles(
  agencyId: string,
  nowMs: number,
  liveRouteIds: Set<string> = new Set(),
  timezone = "America/Toronto"
): LiveVehicleState[] {
  const corridors = RAIL_CORRIDORS.filter((c) => c.agencyId === agencyId);
  if (corridors.length === 0) return [];

  const ctx = getLocalServiceContext(new Date(nowMs), timezone);
  const nowIso = new Date(nowMs).toISOString();
  const out: LiveVehicleState[] = [];

  for (const corridor of corridors) {
    // If real live GTFS-RT vehicles are reporting on this rail corridor, never emit synthetic ones
    if (
      liveRouteIds.has(corridor.routeId) ||
      liveRouteIds.has(corridor.shortName) ||
      liveRouteIds.has(corridor.routeId.toUpperCase())
    ) {
      continue;
    }

    const slots = activeSlotsForCorridor(corridor, ctx.serviceSeconds);
    for (const slot of slots) {
      const pos = interpolateSlot(slot);
      const dirTag = slot.directionId === 0 ? "A" : "B";
      const trainNum = `${corridor.trainPrefix}-${dirTag}${slot.slotIndex}`;
      const vehicleId = `sched:${corridor.agencyId}:${corridor.routeId}:${slot.directionId}:${slot.departMin}`;
      const headsign = slot.directionId === 0 ? corridor.headsignFwd : corridor.headsignRev;

      out.push({
        agencyId: corridor.agencyId,
        sourceVehicleId: vehicleId,
        vehicleId,
        fleetNumber: trainNum,
        label: trainNum,
        routeId: corridor.routeId,
        routeShortName: corridor.shortName,
        routeLongName: corridor.longName,
        routeColor: corridor.color,
        routeType: corridor.routeType,
        vehicleMode: corridor.mode,
        positionSource: "scheduled",
        tripId: `sched-${corridor.routeId}-${slot.directionId}-${slot.departMin}`,
        headsign,
        blockId: null,
        directionId: slot.directionId,
        lat: Number(pos.lat.toFixed(5)),
        lon: Number(pos.lon.toFixed(5)),
        bearingDeg: Math.round(pos.bearingDeg),
        speedMps: pos.speedMps,
        scheduleDeviationSec: 0,
        currentStatus: pos.currentStatus,
        stopId: pos.stop.stopId,
        stopName: pos.stop.name,
        stopSequence: pos.stopIndex + 1,
        occupancyStatus: null,
        observedAt: nowIso,
        receivedAt: nowIso,
        timestampBasis: "receipt",
        ageSeconds: 0,
        freshness: "fresh",
        qualityFlags: ["timetable_position"],
        matchMethod: "scheduled_timetable",
        matchConfidence: 0.65,
      });
    }
  }

  return out;
}

/**
 * Build the station-by-station ride timeline for a timetable-estimated train (vehicleId starting with "sched:").
 */
export function getScheduledRailRideTimeline(
  agencyId: string,
  vehicleId: string,
  nowMs: number,
  timezone = "America/Toronto"
): {
  vehicle: LiveVehicleState;
  routeShape: { type: "LineString"; coordinates: Array<[number, number]> };
  stops: Array<{
    stopId: string;
    stopCode: string | null;
    name: string;
    lat: number;
    lon: number;
    stopSequence: number;
    status: "passed" | "current" | "next" | "upcoming";
    distanceMeters: number;
    etaMinutes: number | null;
  }>;
} | null {
  if (!vehicleId.startsWith("sched:")) return null;
  const parts = vehicleId.split(":");
  if (parts.length !== 5) return null;
  const [, ag, routeId, dirStr, depStr] = parts;
  if (ag !== agencyId) return null;
  const corridor = getRailCorridor(agencyId, routeId);
  if (!corridor) return null;
  const directionId = Number(dirStr) === 1 ? 1 : 0;
  const departMin = Number(depStr);
  if (!Number.isFinite(departMin)) return null;

  const ctx = getLocalServiceContext(new Date(nowMs), timezone);
  const totalRunMin = corridor.stations[corridor.stations.length - 1]!.offsetMin;
  const orderedStations: RailStation[] =
    directionId === 0
      ? corridor.stations
      : [...corridor.stations].reverse().map((s) => ({ ...s, offsetMin: totalRunMin - s.offsetMin }));

  const elapsedSec = Math.max(0, Math.min(totalRunMin * 60, ctx.serviceSeconds - departMin * 60));
  const slot: ActiveTrainSlot = {
    corridor,
    directionId,
    departMin,
    elapsedSec,
    orderedStations,
    totalRunSec: totalRunMin * 60,
    slotIndex: Math.floor(departMin / Math.max(1, corridor.offPeakHeadwayMin)) % 90 + 10,
  };
  const pos = interpolateSlot(slot);
  const nowIso = new Date(nowMs).toISOString();
  const dirTag = directionId === 0 ? "A" : "B";
  const trainNum = `${corridor.trainPrefix}-${dirTag}${slot.slotIndex}`;

  const vehicle: LiveVehicleState = {
    agencyId: corridor.agencyId,
    sourceVehicleId: vehicleId,
    vehicleId,
    fleetNumber: trainNum,
    label: trainNum,
    routeId: corridor.routeId,
    routeShortName: corridor.shortName,
    routeLongName: corridor.longName,
    routeColor: corridor.color,
    routeType: corridor.routeType,
    vehicleMode: corridor.mode,
    positionSource: "scheduled",
    tripId: `sched-${corridor.routeId}-${directionId}-${departMin}`,
    headsign: directionId === 0 ? corridor.headsignFwd : corridor.headsignRev,
    blockId: null,
    directionId,
    lat: Number(pos.lat.toFixed(5)),
    lon: Number(pos.lon.toFixed(5)),
    bearingDeg: Math.round(pos.bearingDeg),
    speedMps: pos.speedMps,
    scheduleDeviationSec: 0,
    currentStatus: pos.currentStatus,
    stopId: pos.stop.stopId,
    stopName: pos.stop.name,
    stopSequence: pos.stopIndex + 1,
    occupancyStatus: null,
    observedAt: nowIso,
    receivedAt: nowIso,
    timestampBasis: "receipt",
    ageSeconds: 0,
    freshness: "fresh",
    qualityFlags: ["timetable_position"],
    matchMethod: "scheduled_timetable",
    matchConfidence: 0.65,
  };

  let cumDist = 0;
  const stops = orderedStations.map((st, idx) => {
    const directDist = Math.round(haversineMeters(pos.lat, pos.lon, st.lat, st.lon));
    let status: "passed" | "current" | "next" | "upcoming";
    let etaMinutes: number | null = null;
    if (idx < pos.stopIndex) {
      status = "passed";
    } else if (idx === pos.stopIndex) {
      status = pos.currentStatus === "STOPPED_AT" ? "current" : "next";
      cumDist = directDist;
      etaMinutes = status === "current" ? 0 : Math.max(1, Math.round((st.offsetMin * 60 - elapsedSec) / 60));
    } else {
      const prev = orderedStations[idx - 1]!;
      cumDist += Math.round(haversineMeters(prev.lat, prev.lon, st.lat, st.lon));
      status = idx === pos.stopIndex + 1 && pos.currentStatus === "STOPPED_AT" ? "next" : "upcoming";
      etaMinutes = Math.max(1, Math.round((st.offsetMin * 60 - elapsedSec) / 60));
    }
    return {
      stopId: st.stopId,
      stopCode: null,
      name: st.name,
      lat: st.lat,
      lon: st.lon,
      stopSequence: idx + 1,
      status,
      distanceMeters: idx >= pos.stopIndex ? cumDist : directDist,
      etaMinutes,
    };
  });

  return {
    vehicle,
    routeShape: {
      type: "LineString",
      coordinates: corridor.stations.map((s) => [s.lon, s.lat]),
    },
    stops,
  };
}

/**
 * Compute upcoming scheduled rail trips between two points along any TTC Subway or GO Rail corridor
 * (for the time-aware trip planner when rail stations are within walking distance).
 */
export function findRailPlanCandidates(input: {
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  departAtMs: number;
  agencyFilter?: string;
  timezone?: string;
}): Array<{
  corridor: RailCorridor;
  originStation: RailStation & { distMeters: number };
  destStation: RailStation & { distMeters: number };
  directionId: 0 | 1;
  headsign: string;
  rideMinutes: number;
  stopsCount: number;
  upcomingDepartures: Array<{
    departureTime: string;
    arrivalTime: string;
    etaMinutes: number;
    waitMinutes: number;
    rideMinutes: number;
    headsign: string;
  }>;
}> {
  const { fromLat, fromLon, toLat, toLon, departAtMs, agencyFilter, timezone = "America/Toronto" } = input;
  const maxWalkM = 1800;
  const ctx = getLocalServiceContext(new Date(departAtMs), timezone);
  const serviceMin = ctx.serviceSeconds / 60;

  const results: ReturnType<typeof findRailPlanCandidates> = [];

  for (const corridor of RAIL_CORRIDORS) {
    if (agencyFilter && corridor.agencyId !== agencyFilter) continue;

    let bestOrig: { st: RailStation; idx: number; dist: number } | null = null;
    let bestDest: { st: RailStation; idx: number; dist: number } | null = null;

    for (let i = 0; i < corridor.stations.length; i++) {
      const st = corridor.stations[i]!;
      const dO = Math.round(haversineMeters(fromLat, fromLon, st.lat, st.lon));
      if (dO <= maxWalkM && (!bestOrig || dO < bestOrig.dist)) {
        bestOrig = { st, idx: i, dist: dO };
      }
      const dD = Math.round(haversineMeters(toLat, toLon, st.lat, st.lon));
      if (dD <= maxWalkM && (!bestDest || dD < bestDest.dist)) {
        bestDest = { st, idx: i, dist: dD };
      }
    }

    if (!bestOrig || !bestDest || bestOrig.idx === bestDest.idx) continue;

    const directionId: 0 | 1 = bestOrig.idx < bestDest.idx ? 0 : 1;
    const totalRunMin = corridor.stations[corridor.stations.length - 1]!.offsetMin;
    const origOffset = directionId === 0 ? bestOrig.st.offsetMin : totalRunMin - bestOrig.st.offsetMin;
    const destOffset = directionId === 0 ? bestDest.st.offsetMin : totalRunMin - bestDest.st.offsetMin;
    const rideMinutes = Math.max(2, destOffset - origOffset);
    const stopsCount = Math.abs(bestDest.idx - bestOrig.idx);
    const headsign = directionId === 0 ? corridor.headsignFwd : corridor.headsignRev;

    const walkStartMin = Math.max(1, Math.round(bestOrig.dist / 78));
    const readyMin = serviceMin + walkStartMin;
    const headway = isPeakHour(readyMin) ? corridor.peakHeadwayMin : corridor.offPeakHeadwayMin;
    const phaseShift = directionId === 1 ? Math.floor(headway / 2) : 0;

    const upcomingDepartures: Array<{
      departureTime: string;
      arrivalTime: string;
      etaMinutes: number;
      waitMinutes: number;
      rideMinutes: number;
      headsign: string;
    }> = [];

    // Find next 4 trains departing originStation on or after readyMin
    const firstOriginDep = Math.max(
      corridor.startMin + origOffset,
      Math.ceil((readyMin - origOffset - phaseShift) / headway) * headway + phaseShift + origOffset
    );

    for (let k = 0; k < 4; k++) {
      const depMinAtStation = firstOriginDep + k * headway;
      const tripStartMin = depMinAtStation - origOffset;
      if (tripStartMin < corridor.startMin || tripStartMin > corridor.endMin) continue;
      if (depMinAtStation > readyMin + 180) break;

      const deltaFromDepartMs = Math.round((depMinAtStation - serviceMin) * 60_000);
      const depMs = departAtMs + deltaFromDepartMs;
      const arrMs = depMs + rideMinutes * 60_000;
      upcomingDepartures.push({
        departureTime: new Date(depMs).toISOString(),
        arrivalTime: new Date(arrMs).toISOString(),
        etaMinutes: Math.max(0, Math.round((depMs - departAtMs) / 60_000)),
        waitMinutes: Math.max(0, Math.round(depMinAtStation - readyMin)),
        rideMinutes,
        headsign,
      });
    }

    results.push({
      corridor,
      originStation: { ...bestOrig.st, distMeters: bestOrig.dist },
      destStation: { ...bestDest.st, distMeters: bestDest.dist },
      directionId,
      headsign,
      rideMinutes,
      stopsCount,
      upcomingDepartures,
    });
  }

  return results;
}
