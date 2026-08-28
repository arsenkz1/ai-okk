/**
 * Builds the amoCRM recommendations note written after the client-portrait
 * note. Kept free of I/O so the exact CRM-visible text stays unit-testable.
 */

/** amoCRM rejects oversized note text; the analysis is truncated, never split. */
export const CALL_RECOMMENDATIONS_NOTE_MAX_LENGTH = 4000;
export const CALL_RECOMMENDATIONS_NOTE_HEADER = "AI TAVSIYALARI";
export const CLIENT_RECOMMENDATIONS_TITLE = "Mijoz bo'yicha keyingi qadamlar:";
export const MANAGER_RECOMMENDATIONS_TITLE = "Menejerga tavsiyalar:";

export interface CallRecommendationsNoteInput {
  clientRecommendations?: readonly string[] | null;
  managerRecommendations?: readonly string[] | null;
}

/**
 * Gemini occasionally returns blank entries or wraps a single recommendation in
 * stray bullet characters; both are normalized away before the note is built.
 */
function normalizeRecommendations(items: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(items)) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").replace(/^[\s•\-–—*]+/, "").trim();
    if (!text) continue;
    const key = text.toLocaleLowerCase("uz-Latn");
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(text);
  }
  return normalized;
}

function section(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : ["", title, ...items.map((item) => `• ${item}`)];
}

/**
 * Returns the note text, or null when the analysis produced no usable
 * recommendation at all — an empty note is never worth a CRM write.
 */
export function buildCallRecommendationsNote(input: CallRecommendationsNoteInput): string | null {
  const client = normalizeRecommendations(input.clientRecommendations);
  const manager = normalizeRecommendations(input.managerRecommendations);
  if (client.length === 0 && manager.length === 0) return null;

  const note = [
    CALL_RECOMMENDATIONS_NOTE_HEADER,
    ...section(CLIENT_RECOMMENDATIONS_TITLE, client),
    ...section(MANAGER_RECOMMENDATIONS_TITLE, manager),
  ].join("\n");

  return note.length <= CALL_RECOMMENDATIONS_NOTE_MAX_LENGTH
    ? note
    : `${note.slice(0, CALL_RECOMMENDATIONS_NOTE_MAX_LENGTH - 1).trimEnd()}…`;
}
