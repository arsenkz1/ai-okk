const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCallRecommendationsNote,
  CALL_RECOMMENDATIONS_NOTE_MAX_LENGTH,
} = require("../dist/services/callRecommendationsNote");

test("builds one note carrying both recommendation blocks in a stable order", () => {
  const note = buildCallRecommendationsNote({
    clientRecommendations: ["Narx e'tirozini bo'lib to'lash bilan yoping", "Juma kuni qayta qo'ng'iroq qiling"],
    managerRecommendations: ["Mijozning og'rig'ini ochib bering", "Keyingi qadamni kelishib oling"],
  });

  assert.equal(note, [
    "AI TAVSIYALARI",
    "",
    "Mijoz bo'yicha keyingi qadamlar:",
    "• Narx e'tirozini bo'lib to'lash bilan yoping",
    "• Juma kuni qayta qo'ng'iroq qiling",
    "",
    "Menejerga tavsiyalar:",
    "• Mijozning og'rig'ini ochib bering",
    "• Keyingi qadamni kelishib oling",
  ].join("\n"));
});

test("omits a block that produced no recommendation instead of leaving an empty heading", () => {
  const clientOnly = buildCallRecommendationsNote({
    clientRecommendations: ["Juma kuni qayta qo'ng'iroq qiling"],
    managerRecommendations: [],
  });
  assert.equal(clientOnly, "AI TAVSIYALARI\n\nMijoz bo'yicha keyingi qadamlar:\n• Juma kuni qayta qo'ng'iroq qiling");
  assert.equal(clientOnly.includes("Menejerga tavsiyalar"), false);

  const managerOnly = buildCallRecommendationsNote({ managerRecommendations: ["Keyingi qadamni kelishib oling"] });
  assert.equal(managerOnly, "AI TAVSIYALARI\n\nMenejerga tavsiyalar:\n• Keyingi qadamni kelishib oling");
  assert.equal(managerOnly.includes("Mijoz bo'yicha"), false);
});

test("never asks amoCRM to store an empty or unusable note", () => {
  assert.equal(buildCallRecommendationsNote({}), null);
  assert.equal(buildCallRecommendationsNote({ clientRecommendations: [], managerRecommendations: [] }), null);
  assert.equal(buildCallRecommendationsNote({ clientRecommendations: ["", "   ", "\n"] }), null);
  assert.equal(buildCallRecommendationsNote({ clientRecommendations: null, managerRecommendations: undefined }), null);
  assert.equal(buildCallRecommendationsNote({ clientRecommendations: "not an array" }), null);
});

test("normalizes model formatting artifacts into plain bullet lines", () => {
  const note = buildCallRecommendationsNote({
    clientRecommendations: [
      "• Narxni tushuntiring",
      "  - Bo'lib to'lashni taklif qiling  ",
      "Ikki\nqatorli   tavsiya",
      42,
      null,
    ],
  });

  assert.equal(note, [
    "AI TAVSIYALARI",
    "",
    "Mijoz bo'yicha keyingi qadamlar:",
    "• Narxni tushuntiring",
    "• Bo'lib to'lashni taklif qiling",
    "• Ikki qatorli tavsiya",
  ].join("\n"));
});

test("drops repeated recommendations regardless of case", () => {
  const note = buildCallRecommendationsNote({
    clientRecommendations: ["Qayta qo'ng'iroq qiling", "qayta qo'ng'iroq qiling", "• Qayta qo'ng'iroq qiling"],
  });

  assert.equal(note, "AI TAVSIYALARI\n\nMijoz bo'yicha keyingi qadamlar:\n• Qayta qo'ng'iroq qiling");
});

test("truncates an oversized note instead of failing the amoCRM write", () => {
  const note = buildCallRecommendationsNote({
    clientRecommendations: Array.from({ length: 200 }, (_, index) => `Tavsiya raqami ${index} juda uzun matn bilan`),
  });

  assert.equal(note.length, CALL_RECOMMENDATIONS_NOTE_MAX_LENGTH);
  assert.equal(note.startsWith("AI TAVSIYALARI\n\nMijoz bo'yicha keyingi qadamlar:\n• Tavsiya raqami 0"), true);
  assert.equal(note.endsWith("…"), true);
});
