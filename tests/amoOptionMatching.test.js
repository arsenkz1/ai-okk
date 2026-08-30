const test = require("node:test");
const assert = require("node:assert/strict");

const {
  matchFieldOption,
  normalizeOptionValue,
  normalizeOptionCore,
  typoToleranceFor,
} = require("../dist/services/amoOptionMatching");

const REGIONS = [
  { id: 1, value: "Toshkent" },
  { id: 2, value: "Samarqand" },
  { id: 3, value: "Farg'ona" },
];

test("normalizes case, punctuation and apostrophe styles to one form", () => {
  assert.equal(normalizeOptionValue("  Toshkent  "), "toshkent");
  assert.equal(normalizeOptionValue("FARG'ONA"), "farg'ona");
  assert.equal(normalizeOptionValue("Fargʻona"), "farg'ona");
  assert.equal(normalizeOptionValue("Farg‘ona"), "farg'ona");
  assert.equal(normalizeOptionValue("Toshkent, shahri!"), "toshkent shahri");
});

test("transliterates Cyrillic so one word written in two scripts compares equal", () => {
  assert.equal(normalizeOptionValue("Самарканд"), normalizeOptionValue("Samarqand"));
  assert.equal(normalizeOptionValue("Тошкент"), "toshkent");
  // q/k and x/h are the pairs the two spellings disagree on.
  assert.equal(normalizeOptionValue("Qarshi"), normalizeOptionValue("Карши"));
  assert.equal(normalizeOptionValue("Xiva"), normalizeOptionValue("Ҳiva"));
});

test("strips qualifier words but keeps words that change the referent", () => {
  // The normalized form is a comparison key, not readable text, so equality
  // between two values is what is asserted rather than a literal spelling.
  assert.equal(normalizeOptionCore("Toshkent shahri"), normalizeOptionCore("Toshkent"));
  assert.equal(normalizeOptionCore("Excel kursi"), normalizeOptionCore("Excel"));
  // "viloyati" is a different place from the city, so it must survive.
  assert.notEqual(normalizeOptionCore("Toshkent viloyati"), normalizeOptionCore("Toshkent"));
  assert.equal(normalizeOptionCore("Toshkent viloyati").includes("viloyati"), true);
});

test("never reduces a value made only of qualifiers to nothing", () => {
  assert.equal(normalizeOptionCore("Shahar"), "shahar");
  assert.equal(normalizeOptionCore("kurs"), "kurs");
});

test("matches an existing option regardless of case, script or punctuation", () => {
  assert.deepEqual(matchFieldOption("toshkent", REGIONS), { kind: "exact", option: REGIONS[0] });
  assert.deepEqual(matchFieldOption("  SAMARQAND ", REGIONS), { kind: "exact", option: REGIONS[1] });
  assert.deepEqual(matchFieldOption("Самарканд", REGIONS), { kind: "exact", option: REGIONS[1] });
  assert.deepEqual(matchFieldOption("Fargʻona", REGIONS), { kind: "exact", option: REGIONS[2] });
});

test("matches a qualified synonym onto the plain option", () => {
  const match = matchFieldOption("Toshkent shahri", REGIONS);
  assert.equal(match.kind, "synonym");
  assert.equal(match.rule, "qualifier");
  assert.deepEqual(match.option, REGIONS[0]);
});

test("refuses to choose between a city and a region of the same name", () => {
  const options = [{ id: 1, value: "Toshkent" }, { id: 2, value: "Toshkent shahri" }];
  const match = matchFieldOption("Toshkent shahar", options);

  // Both normalize to the same core: picking either could be wrong.
  assert.equal(match.kind, "ambiguous");
  assert.deepEqual(match.options.map((option) => option.id), [1, 2]);
});

test("keeps a genuinely different place separate from the city", () => {
  const options = [{ id: 1, value: "Toshkent" }, { id: 2, value: "Toshkent viloyati" }];
  assert.deepEqual(matchFieldOption("Toshkent", options), { kind: "exact", option: options[0] });
  assert.deepEqual(matchFieldOption("Toshkent viloyati", options), { kind: "exact", option: options[1] });
});

test("absorbs a typo in a long enough value", () => {
  const match = matchFieldOption("Samarqannd", REGIONS);
  assert.equal(match.kind, "synonym");
  assert.equal(match.rule, "typo");
  assert.deepEqual(match.option, REGIONS[1]);
});

test("never treats short lookalike values as typos of each other", () => {
  const courses = [{ id: 1, value: "SMM" }, { id: 2, value: "SEO" }];
  assert.deepEqual(matchFieldOption("SEM", courses), { kind: "none" });
  assert.equal(typoToleranceFor(3), 0);
  assert.equal(typoToleranceFor(6), 1);
  assert.equal(typoToleranceFor(12), 2);
});

test("reports ambiguity when a typo fits several options equally", () => {
  const options = [{ id: 1, value: "Andijon" }, { id: 2, value: "Andijan" }];
  const match = matchFieldOption("Andijen", options);
  assert.equal(match.kind, "ambiguous");
  assert.equal(match.options.length, 2);
});

test("reports no match for a genuinely new value", () => {
  assert.deepEqual(matchFieldOption("Buxoro", REGIONS), { kind: "none" });
  assert.deepEqual(matchFieldOption("   ", REGIONS), { kind: "none" });
  assert.deepEqual(matchFieldOption("Toshkent", []), { kind: "none" });
});
