const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCallStageAdminAlert } = require("../dist/bot/callStageNotifications");

test("builds a compact admin alert for an ambiguous client outcome without raw transcript", () => {
  const text = buildCallStageAdminAlert({
    kind: "review",
    actionId: "stage-action-1",
    dealId: 42,
    evidence: "Mijozning niyati aniq emas.",
  }, "https://tenant.amocrm.ru");

  assert.match(text, /Проверка автоперевода UZUM/);
  assert.match(text, /Сделка: #42 — https:\/\/tenant\.amocrm\.ru\/leads\/detail\/42/);
  assert.match(text, /Итог звонка неоднозначен/);
  assert.match(text, /Основание: Mijozning niyati aniq emas\./);
  assert.doesNotMatch(text, /<TRANSKRIPT>/);
});

test("lists only missing field names when a clear stage is blocked", () => {
  const text = buildCallStageAdminAlert({
    kind: "missing_fields",
    actionId: "stage-action-2",
    dealId: 43,
    targetName: "квалифицирован",
    evidence: "Mijoz qiziqishini aniq tasdiqladi.",
    missingFields: [
      { id: 967019, name: "Region" },
      { id: 1038305, name: "Hozir nima ish qiladi?" },
    ],
  });

  assert.match(text, /Целевой этап: квалифицирован/);
  assert.match(text, /Не заполнены обязательные поля: Region; Hozir nima ish qiladi\?/);
  assert.doesNotMatch(text, /967019/);
  assert.doesNotMatch(text, /транскрипт/i);
});

test("states whether the stage was moved or safely skipped due to recent movement", () => {
  const moved = buildCallStageAdminAlert({
    kind: "moved",
    actionId: "stage-action-3",
    dealId: 44,
    targetName: "квалифицирован",
  });
  const skipped = buildCallStageAdminAlert({
    kind: "recent_stage_movement",
    actionId: "stage-action-4",
    dealId: 45,
    targetName: "взято в работу",
  });

  assert.match(moved, /автоматически передвинута на этап: квалифицирован/i);
  assert.match(skipped, /за последние 30 минут уже было перемещение стадии/i);
  assert.doesNotMatch(`${moved}\n${skipped}`, /транскрипт/i);
});
