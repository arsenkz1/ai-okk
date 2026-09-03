const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatDealSummaryReport,
  summarizeNotes,
  diagnoseNoAnalyzableCall,
  DEAL_SUMMARY_MAX_NOTES,
} = require("../dist/services/dealSummaryReport");

const MIN = 6 * 60;

function note(overrides = {}) {
  return {
    id: 1,
    noteType: "call_in",
    createdAt: new Date("2026-09-01T05:00:00.000Z"), // 10:00 Almaty
    duration: 120,
    recordUrl: "https://pbx/rec.mp3",
    phone: "998901234567",
    uniq: null,
    internalNumber: "101",
    text: "",
    source: "lead",
    ...overrides,
  };
}

const SUMMARY = {
  id: 26199367,
  name: "Target kursi",
  pipelineId: 6909890,
  pipelineName: "UZUM",
  statusId: 58160726,
  statusName: "Квалифицирован",
  price: 1500000,
  responsibleUserId: 12695650,
  createdAt: new Date("2026-08-30T05:00:00.000Z"),
  updatedAt: new Date("2026-09-01T05:00:00.000Z"),
  fields: [
    { name: "Jinsi", values: ["Ayol"] },
    { name: "Yoshi", values: ["31"] },
    { name: "Region", values: ["Ташкент"] },
    { name: "Qayerdan bizni topdi? -", values: ["Target"] },
  ],
  contacts: [{ id: 55, name: "Aziza", phones: ["998901234567"] }],
};

test("counts notes by what actually blocks analysis", () => {
  const breakdown = summarizeNotes([
    note({ id: 1, duration: 400 }),
    note({ id: 2, duration: 120 }),
    note({ id: 3, noteType: "common", recordUrl: null, duration: 0, text: "Mijoz javob bermadi" }),
  ], MIN);

  assert.deepEqual(breakdown, {
    total: 3,
    withRecording: 2,
    longEnough: 1,
    callNotes: 2,
    textNotes: 1,
    longestCallSeconds: 400,
  });
});

test("names the real reason nothing could be analyzed", () => {
  const empty = { total: 0, withRecording: 0, longEnough: 0, callNotes: 0, textNotes: 0, longestCallSeconds: null };
  assert.equal(diagnoseNoAnalyzableCall(empty, MIN).includes("нет ни одного примечания"), true);

  assert.equal(
    diagnoseNoAnalyzableCall({ ...empty, total: 4, textNotes: 4 }, MIN).includes("нет звонков"),
    true,
  );
  assert.equal(
    diagnoseNoAnalyzableCall({ ...empty, total: 4, callNotes: 4 }, MIN).includes("нет ссылки на запись"),
    true,
  );
  assert.equal(
    diagnoseNoAnalyzableCall(
      { total: 4, withRecording: 4, longEnough: 0, callNotes: 4, textNotes: 0, longestCallSeconds: 245 },
      MIN,
    ),
    "Записи есть, но все звонки короче 6 минут (самый длинный — 4 мин 5 с).",
  );
});

test("shows the deal's pipeline, stage, budget and filled fields", () => {
  const text = formatDealSummaryReport({
    summary: SUMMARY,
    notes: [note({ noteType: "common", recordUrl: null, duration: 0, text: "Mijoz qiziqdi" })],
    dealId: 26199367,
    minCallSeconds: MIN,
  });

  assert.equal(text.startsWith("🗂 Сделка #26199367\nTarget kursi"), true);
  assert.equal(text.includes("📂 Воронка: UZUM"), true);
  assert.equal(text.includes("📍 Этап: Квалифицирован"), true);
  assert.equal(text.includes("💰 Бюджет: 1 500 000"), true);
  assert.equal(text.includes("👤 Aziza · 998901234567"), true);
  assert.equal(text.includes("📋 Заполненные поля (4):"), true);
  assert.equal(text.includes("• Jinsi: Ayol"), true);
  assert.equal(text.includes("• Qayerdan bizni topdi? -: Target"), true);
});

test("falls back to IDs when amoCRM gives no pipeline or stage name", () => {
  const text = formatDealSummaryReport({
    summary: { ...SUMMARY, pipelineName: null, statusName: null, price: null },
    notes: [],
    dealId: 1,
    minCallSeconds: MIN,
  });

  assert.equal(text.includes("📂 Воронка: UZUM"), true); // known ID from the local map
  assert.equal(text.includes("📍 Этап: #58160726"), true);
  assert.equal(text.includes("💰 Бюджет: не указан"), true);
});

test("reports the note breakdown rather than a bare zero", () => {
  const text = formatDealSummaryReport({
    summary: SUMMARY,
    notes: [
      note({ id: 1, duration: 400 }),
      note({ id: 2, noteType: "common", recordUrl: null, duration: 0, text: "Qayta qo'ng'iroq" }),
    ],
    dealId: 1,
    minCallSeconds: MIN,
  });

  assert.equal(text.includes("📝 Примечания: 2 (звонков: 1, с записью: 1, подходящих для анализа: 1)"), true);
});

test("shows note text and where the note came from", () => {
  const text = formatDealSummaryReport({
    summary: SUMMARY,
    notes: [note({
      noteType: "common",
      recordUrl: null,
      duration: 0,
      text: "Mijoz  ertaga\n\njavob beradi",
      source: "contact",
    })],
    dealId: 1,
    minCallSeconds: MIN,
  });

  assert.equal(text.includes("— 01.09.2026 10:00 · common · с контакта"), true);
  // Whitespace inside a note is collapsed so it stays readable in Telegram.
  assert.equal(text.includes("Mijoz ertaga javob beradi"), true);
});

test("labels call direction and marks notes that carry a recording", () => {
  const text = formatDealSummaryReport({
    summary: SUMMARY,
    notes: [note({ noteType: "call_out", duration: 425 })],
    dealId: 1,
    minCallSeconds: MIN,
  });

  assert.equal(text.includes("исходящий звонок · 7:05 · 🎧 есть запись"), true);
});

test("caps the note list and says how many were left out", () => {
  const notes = Array.from({ length: DEAL_SUMMARY_MAX_NOTES + 4 }, (_, index) => note({
    id: index,
    createdAt: new Date(Date.UTC(2026, 8, 1, 5, index)),
  }));
  const text = formatDealSummaryReport({ summary: SUMMARY, notes, dealId: 1, minCallSeconds: MIN });

  assert.equal(text.includes(`… ещё 4 примечаний`), true);
  assert.equal(text.split("\n").filter((line) => line.startsWith("— ")).length, DEAL_SUMMARY_MAX_NOTES);
});

test("still reports the notes when the deal itself cannot be read", () => {
  const text = formatDealSummaryReport({
    summary: null,
    notes: [note({ noteType: "common", recordUrl: null, duration: 0, text: "izoh" })],
    dealId: 7,
    minCallSeconds: MIN,
  });

  assert.equal(text.includes("⚠️ Данные сделки из amoCRM получить не удалось."), true);
  assert.equal(text.includes("📝 Примечания: 1"), true);
});

test("says plainly when the deal has no filled fields", () => {
  const text = formatDealSummaryReport({
    summary: { ...SUMMARY, fields: [] },
    notes: [],
    dealId: 1,
    minCallSeconds: MIN,
  });

  assert.equal(text.includes("📋 Заполненных полей нет."), true);
});
