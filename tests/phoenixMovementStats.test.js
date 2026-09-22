const test = require("node:test");
const assert = require("node:assert/strict");

const { formatPhoenixArrivals, formatPhoenixMovements, phoenixSourceName } = require("../dist/services/phoenixMovementStats");

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
    "<b>Феникс (стажёр):</b> 10 сделок",
    "UZUM: 7",
    "EXODE: 3",
  ]);
});

test("says plainly when nothing moved", () => {
  assert.deepEqual(
    formatPhoenixMovements({ rows: [], total: 0, uncertain: 0 }),
    ["<b>Феникс (стажёр):</b> переводов не было"],
  );
});

test("never hides moves whose amoCRM outcome is unconfirmed", () => {
  const lines = formatPhoenixMovements({
    rows: [{ pipelineId: 6909890, pipelineName: "UZUM", count: 2 }],
    total: 2,
    uncertain: 1,
  });

  assert.equal(lines.at(-1), "Неподтверждённых переводов: 1 — требуется проверка вручную");
});

test("still reports unconfirmed moves when none were confirmed", () => {
  const lines = formatPhoenixMovements({ rows: [], total: 0, uncertain: 2 });
  assert.equal(lines[0], "<b>Феникс (стажёр):</b> 0 сделок");
  assert.equal(lines.at(-1).includes("Неподтверждённых переводов: 2"), true);
});

test("renders amoCRM arrivals with every origin pipeline, and names unknown ones", () => {
  const lines = formatPhoenixArrivals({
    total: 6,
    byPipeline: [
      { pipelineId: 6909890, count: 3 },
      { pipelineId: 10734414, count: 2 },
    ],
    unknownOrigin: 1,
  });

  assert.equal(lines[0], "<b>Феникс (стажёр):</b> 6 сделок");
  assert.equal(lines[1], "UZUM: 3");
  // A pipeline outside the inactivity policy still gets a readable label.
  assert.equal(lines[2].endsWith(": 2"), true);
  assert.equal(lines.at(-1), "исходная воронка не определена: 1");
  assert.deepEqual(
    formatPhoenixArrivals({ total: 0, byPipeline: [], unknownOrigin: 0 }),
    ["<b>Феникс (стажёр):</b> переводов не было"],
  );
});
