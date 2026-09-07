const test = require("node:test");
const assert = require("node:assert/strict");

const { formatPhoenixMovements, phoenixSourceName } = require("../dist/services/phoenixMovementStats");

test("names each source pipeline the way the policy table does", () => {
  assert.equal(phoenixSourceName(6909890), "UZUM");
  assert.equal(phoenixSourceName(9055778), "EXODE");
  assert.equal(phoenixSourceName(null), "воронка неизвестна");
});

test("lists how many deals came from each pipeline, biggest first", () => {
  const lines = formatPhoenixMovements({
    rows: [
      { pipelineId: 6909890, pipelineName: "UZUM", count: 7 },
      { pipelineId: 9055778, pipelineName: "EXODE", count: 3 },
    ],
    total: 10,
    uncertain: 0,
  });

  assert.deepEqual(lines, [
    "🔥 Феникс (стажёр): 10 сделок",
    "• UZUM: 7",
    "• EXODE: 3",
  ]);
});

test("says plainly when nothing moved", () => {
  assert.deepEqual(
    formatPhoenixMovements({ rows: [], total: 0, uncertain: 0 }),
    ["🔥 Феникс (стажёр): переводов не было"],
  );
});

test("never hides moves whose amoCRM outcome is unconfirmed", () => {
  const lines = formatPhoenixMovements({
    rows: [{ pipelineId: 6909890, pipelineName: "UZUM", count: 2 }],
    total: 2,
    uncertain: 1,
  });

  assert.equal(lines.at(-1), "⚠️ Неподтверждённых переводов: 1 — требуется проверка вручную");
});

test("still reports unconfirmed moves when none were confirmed", () => {
  const lines = formatPhoenixMovements({ rows: [], total: 0, uncertain: 2 });
  assert.equal(lines[0], "🔥 Феникс (стажёр): 0 сделок");
  assert.equal(lines.at(-1).includes("Неподтверждённых переводов: 2"), true);
});
