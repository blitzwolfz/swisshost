/** Display order and short labels for the agency switcher: GO / Guelph / T-Bay / TTC / All. */
export const AGENCY_ORDER = ["go", "guelph", "thunderbay", "ttc"] as const;

const NAMES: Record<string, { short: string; name: string }> = {
  go: { short: "GO", name: "GO Transit" },
  guelph: { short: "Guelph", name: "Guelph Transit" },
  thunderbay: { short: "T-Bay", name: "Thunder Bay Transit" },
  ttc: { short: "TTC", name: "Toronto Transit Commission" },
  all: { short: "All", name: "All agencies" },
};

export function agencyShortName(id: string): string {
  return NAMES[id]?.short ?? id.toUpperCase();
}

/** Name used in running text, e.g. "Thunder Bay stops". */
export function agencyName(id: string): string {
  if (id === "thunderbay") return "Thunder Bay";
  return NAMES[id]?.short ?? id.toUpperCase();
}

export function agencyFullName(id: string): string {
  return NAMES[id]?.name ?? id.toUpperCase();
}

export function agencyRank(id: string): number {
  const i = (AGENCY_ORDER as readonly string[]).indexOf(id);
  return i === -1 ? AGENCY_ORDER.length : i;
}
