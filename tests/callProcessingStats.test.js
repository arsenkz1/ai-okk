const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatCallProcessingBreakdown,
  describeCallStatus,
} = require("../dist/services/callProcessingStats");

test("explains each processing status in the operator's terms", () => {
  assert.equal(describeCallStatus("skipped_no_deal"), "пропущен: сделка по номеру не найдена в amoCRM");
  assert.equal(describeCallStatus("processed"), "проанализирован полностью");
  // An unknown status is shown as-is rather than hidden.
  assert.equal(describeCallStatus("brand_new_status"), "brand_new_status");
});

test("lists every status with its count, biggest first", () => {
  const text = formatCallProcessingBreakdown({
    total: 47,
    byStatus: [
      { status: "processed", count: 30 },
      { status: "skipped_no_deal", count: 12 },
      { status: "failed", count: 5 },
    ],
    analyzedWithoutNote: 0,
    analyzedWithoutRecommendations: 0,
  }, "сегодня");

  assert.equal(text.includes("Всего звонков в базе: 47"), true);
  assert.equal(text.includes("• 30 — проанализирован полностью (processed)"), true);
  assert.equal(text.includes("• 12 — пропущен: сделка по номеру не найдена в amoCRM (skipped_no_deal)"), true);
  assert.equal(text.includes("короче 6 минут в базу не попадают"), true);
});

test("flags analyzed calls whose CRM write never finished", () => {
  const text = formatCallProcessingBreakdown({
    total: 10,
    byStatus: [{ status: "analyzed", count: 3 }, { status: "processed", count: 7 }],
    analyzedWithoutNote: 3,
    analyzedWithoutRecommendations: 2,
  }, "сегодня");

  assert.equal(text.includes("⚠️ Проанализировано, но запись в amoCRM не завершена: 3"), true);
  assert.equal(text.includes("⚠️ Без рекомендаций ИИ: 2"), true);
});

test("says plainly when there is nothing in the period", () => {
  const text = formatCallProcessingBreakdown(
    { total: 0, byStatus: [], analyzedWithoutNote: 0, analyzedWithoutRecommendations: 0 },
    "сегодня",
  );
  assert.equal(text.includes("За период звонков в базе нет."), true);
});
