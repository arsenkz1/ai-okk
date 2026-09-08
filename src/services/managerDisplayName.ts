/**
 * Cleans amoCRM account names for display.
 *
 * Accounts are named for the phone system, not for reports: "Муслима 101 pbx",
 * "Кувонч. 111 pbx", "Ислом 106". The extension and the "pbx" marker are noise
 * in a ranking of people, but they are only stripped when what remains is still
 * a recognisable name — a name is never reduced to nothing or to a number.
 */

/** Markers that describe the phone system rather than the person. */
const SYSTEM_WORDS = "pbx|пбх|onpbx";

/**
 * A trailing token that names the phone system rather than the person. The
 * marker and the extension are often glued together in one token — "100pbx",
 * "пбх-134" — so the number is matched alongside the marker, not separately.
 */
const SYSTEM_TOKEN = new RegExp(`^(?:\\d{2,5}[-\\s]?)?(?:${SYSTEM_WORDS})(?:[-\\s]?\\d{2,5})?$`, "i");

function isExtensionToken(token: string): boolean {
  return /^\d{2,5}$/.test(token);
}

function isSystemToken(token: string): boolean {
  return SYSTEM_TOKEN.test(token.toLocaleLowerCase("ru-RU"));
}

/**
 * Strips trailing extension numbers and phone-system markers. Only trailing
 * tokens are removed: a digit inside a name ("Ali 2 Team") is left alone
 * because it may be what distinguishes two people.
 */
export function formatManagerDisplayName(rawName: string): string {
  const tokens = rawName.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (tokens.length === 0) return rawName.trim();

  const kept = [...tokens];
  while (kept.length > 1) {
    const last = kept[kept.length - 1].replace(/[.,;:]+$/, "");
    if (!last || isExtensionToken(last) || isSystemToken(last)) {
      kept.pop();
      continue;
    }
    break;
  }

  // Trailing punctuation left by a removed token ("Кувонч." → "Кувонч").
  const cleaned = kept.join(" ").replace(/[\s.,;:]+$/, "").trim();
  return cleaned || rawName.trim();
}
