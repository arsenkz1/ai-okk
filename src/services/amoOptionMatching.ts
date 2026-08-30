/**
 * Matches an AI-produced value against the options a select field already has,
 * so a synonym or a transliteration reuses the existing option instead of
 * adding a near-duplicate to the account-wide list.
 *
 * The rule that matters most here is what happens when several options fit: the
 * matcher reports ambiguity rather than picking one. "Toshkent shahri" is the
 * city and "Toshkent viloyati" is the region — collapsing them would write the
 * wrong place into the CRM, so a human decides instead.
 */

export interface FieldOption {
  id: number;
  value: string;
}

export type OptionMatchRule = "qualifier" | "typo";

export type OptionMatch =
  | { kind: "exact"; option: FieldOption }
  | { kind: "synonym"; option: FieldOption; rule: OptionMatchRule }
  | { kind: "ambiguous"; options: FieldOption[] }
  | { kind: "none" };

/**
 * Cyrillic to Latin in the Uzbek reading. Only ever used to compare values: the
 * option's own amoCRM spelling is what gets stored, never this form.
 */
const CYRILLIC_TO_LATIN: ReadonlyMap<string, string> = new Map(Object.entries({
  а: "a", б: "b", в: "v", г: "g", ғ: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z",
  и: "i", й: "y", к: "k", қ: "q", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ў: "o", ф: "f", х: "x", ҳ: "h", ц: "ts", ч: "ch",
  ш: "sh", щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya",
}));

/**
 * Words that qualify a value without changing which thing it names. Words that
 * DO change the referent — viloyati/область (region), tumani/район (district) —
 * are deliberately absent: stripping them would merge distinct places.
 */
const QUALIFIER_WORDS: ReadonlySet<string> = new Set([
  "shahri", "shahar", "shaxri", "sh",
  "gorod", "g",
  "kursi", "kurs",
]);

function transliterate(value: string): string {
  let result = "";
  for (const char of value) result += CYRILLIC_TO_LATIN.get(char) ?? char;
  return result;
}

/**
 * Letter pairs that the Uzbek and Russian spellings of the same name disagree
 * on: Samarqand/Самарканд differ only in q vs k, Xiva/Ҳiva only in x vs h.
 * Folding them makes the two spellings compare equal. Applied to both sides, so
 * it can only ever merge spellings, never change what gets written to amoCRM.
 */
function foldScriptVariants(value: string): string {
  return value.replace(/q/g, "k").replace(/x/g, "h");
}

/**
 * Lowercase, transliterate, unify apostrophes, drop punctuation, collapse
 * whitespace. Two values equal under this form are the same value written
 * differently — including one in Cyrillic and one in Latin.
 */
export function normalizeOptionValue(value: string): string {
  return foldScriptVariants(transliterate(value.toLocaleLowerCase("uz-Latn")))
    .replace(/[ʻʼ‘’`']/g, "'")
    .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The normalized form with meaning-preserving qualifier words removed. */
export function normalizeOptionCore(value: string): string {
  const tokens = normalizeOptionValue(value).split(" ").filter(Boolean);
  const core = tokens.filter((token) => !QUALIFIER_WORDS.has(token));
  // Never reduce a value to nothing: a value made only of qualifiers keeps them.
  return (core.length > 0 ? core : tokens).join(" ");
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * How far apart two values may be and still count as one of them mistyped.
 * Short values get no tolerance at all: "SMM" and "SEO" are two edits apart and
 * are plainly different things.
 */
export function typoToleranceFor(length: number): number {
  if (length >= 10) return 2;
  if (length >= 6) return 1;
  return 0;
}

function uniqueOptions(options: readonly FieldOption[]): FieldOption[] {
  return [...new Map(options.map((option) => [option.id, option])).values()];
}

/**
 * Resolves a candidate value against the field's current options, strongest
 * match first. Several equally plausible options make the result ambiguous,
 * which callers must treat as "ask a human", never as "pick the first".
 */
export function matchFieldOption(candidate: string, options: readonly FieldOption[]): OptionMatch {
  const normalizedCandidate = normalizeOptionValue(candidate);
  if (!normalizedCandidate) return { kind: "none" };

  // Case, punctuation, apostrophe style and Cyrillic/Latin script all collapse
  // into this comparison, so they never reach the fuzzier rules below.
  const exact = options.filter((option) => normalizeOptionValue(option.value) === normalizedCandidate);
  if (exact.length > 0) return { kind: "exact", option: exact[0] };

  const candidateCore = normalizeOptionCore(candidate);
  const qualifierMatches = uniqueOptions(
    options.filter((option) => normalizeOptionCore(option.value) === candidateCore),
  );
  if (qualifierMatches.length === 1) return { kind: "synonym", option: qualifierMatches[0], rule: "qualifier" };
  if (qualifierMatches.length > 1) return { kind: "ambiguous", options: qualifierMatches };

  const tolerance = typoToleranceFor(candidateCore.length);
  if (tolerance === 0) return { kind: "none" };
  const typoMatches = uniqueOptions(options.filter((option) => (
    levenshtein(normalizeOptionCore(option.value), candidateCore) <= tolerance
  )));
  if (typoMatches.length === 1) return { kind: "synonym", option: typoMatches[0], rule: "typo" };
  if (typoMatches.length > 1) return { kind: "ambiguous", options: typoMatches };

  return { kind: "none" };
}
