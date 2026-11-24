/** Display order and short labels for the agency switcher. */
export const AGENCY_ORDER = [
  "go",
  "ttc",
  "miway",
  "brampton",
  "yrt",
  "drt",
  "oakville",
  "milton",
  "hsr",
  "guelph",
  "grt",
  "ontarionorthland",
  "thunderbay",
] as const;

const NAMES: Record<string, { short: string; name: string }> = {
  go: { short: "GO", name: "GO Transit" },
  ttc: { short: "TTC", name: "Toronto Transit Commission" },
  miway: { short: "MiWay", name: "MiWay (Mississauga Transit)" },
  brampton: { short: "Brampton", name: "Brampton Transit" },
  yrt: { short: "YRT", name: "York Region Transit (YRT)" },
  drt: { short: "DRT", name: "Durham Region Transit (DRT)" },
  oakville: { short: "Oakville", name: "Oakville Transit" },
  milton: { short: "Milton", name: "Milton Transit" },
  hsr: { short: "HSR", name: "Hamilton Street Railway (HSR)" },
  guelph: { short: "Guelph", name: "Guelph Transit" },
  grt: { short: "GRT", name: "Grand River Transit (GRT)" },
  ontarionorthland: { short: "ONTC", name: "Ontario Northland" },
  thunderbay: { short: "T-Bay", name: "Thunder Bay Transit" },
  all: { short: "All", name: "All agencies" },
};

export function agencyShortName(id: string): string {
  return NAMES[id]?.short ?? id.toUpperCase();
}

/** Name used in running text, e.g. "Thunder Bay stops". */
export function agencyName(id: string): string {
  if (id === "thunderbay") return "Thunder Bay";
  if (id === "ontarionorthland") return "Ontario Northland";
  return NAMES[id]?.short ?? id.toUpperCase();
}

export function agencyFullName(id: string): string {
  return NAMES[id]?.name ?? id.toUpperCase();
}

export function agencyRank(id: string): number {
  const i = (AGENCY_ORDER as readonly string[]).indexOf(id);
  return i === -1 ? AGENCY_ORDER.length : i;
}
