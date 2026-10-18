/**
 * Text helpers shared by the report builders and the AI-coach prompt.
 * No Telegram, no database: safe to import anywhere.
 */

export const CRITERIA_LABELS: Record<string, string> = {
  contextScore:     "Kontekst",
  needsScore:       "Ehtiyojni aniqlash",
  painScore:        "Og'riqlarni topish",
  summaryScore:     "Rezyume",
  presentationScore:"Taqdimot",
  pointBScore:      "Nuqta B (natija)",
  closingScore:     "Yopish urinishi",
  objectionsScore:  "E'tirozlar",
  urgencyScore:     "Shoshilinchlik",
  agreementScore:   "Kelishuv",
};

export function getWeakAreas(criteria: unknown): string[] {
  if (!criteria || typeof criteria !== "object") return [];
  const c = criteria as Record<string, unknown>;
  return Object.entries(CRITERIA_LABELS)
    .filter(([key]) => typeof c[key] === "number" && (c[key] as number) <= 5)
    .map(([, label]) => label);
}

export function getStrongAreas(criteria: unknown): string[] {
  if (!criteria || typeof criteria !== "object") return [];
  const c = criteria as Record<string, unknown>;
  return Object.entries(CRITERIA_LABELS)
    .filter(([key]) => typeof c[key] === "number" && (c[key] as number) >= 8)
    .map(([, label]) => label);
}

export function criteriaLine(criteria: unknown): string {
  if (!criteria || typeof criteria !== "object") return "";
  const c = criteria as Record<string, unknown>;
  return Object.entries(CRITERIA_LABELS)
    .map(([key, label]) => {
      const score = typeof c[key] === "number" ? c[key] as number : null;
      return score !== null ? `${label}: ${score}` : null;
    })
    .filter(Boolean)
    .join(", ");
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}s ${m}d` : `${m}d`;
}

/** Parses date in DD.MM.YYYY or YYYY-MM-DD format */
export function parseDate(str: string): Date | null {
  str = str.trim();
  let d: Date | null = null;

  const dmyMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dmyMatch) {
    d = new Date(`${dmyMatch[3]}-${dmyMatch[2].padStart(2, "0")}-${dmyMatch[1].padStart(2, "0")}`);
  }

  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    d = new Date(str);
  }

  return d && !isNaN(d.getTime()) ? d : null;
}

export const UZ_MONTHS = [
  "yanvar","fevral","mart","aprel","may","iyun",
  "iyul","avgust","sentabr","oktabr","noyabr","dekabr",
];
export const UZ_MONTHS_CAP = [
  "Yanvar","Fevral","Mart","Aprel","May","Iyun",
  "Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr",
];
