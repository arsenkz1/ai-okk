const test = require("node:test");
const assert = require("node:assert/strict");

const { collectRevenueStages, formatRevenueStageSync } = require("../dist/services/revenueStageSync");

function pipelinesPayload() {
  return {
    _embedded: {
      pipelines: [
        {
          id: 6909890,
          name: "UZUM",
          _embedded: {
            statuses: [
              { id: 58160718, name: "Взято в работу", type: 0 },
              { id: 58810350, name: "Часть оплачена", type: 0 },
              { id: 142, name: "Успешно реализовано", type: 1 },
              { id: 143, name: "Закрыто и не реализовано", type: 2 },
            ],
          },
        },
        {
          id: 9055778,
          name: "EXODE",
          _embedded: {
            statuses: [
              { id: 72917582, name: "Взято в работу", type: 0 },
              { id: 72999111, name: "Qisman to'langan", type: 0 },
              { id: 142, name: "Успешно реализовано", type: 1 },
            ],
          },
        },
      ],
    },
  };
}

test("finds the revenue stages of every pipeline", () => {
  const { pipelines, stages } = collectRevenueStages(pipelinesPayload());

  assert.equal(pipelines, 2);
  assert.deepEqual(stages.map((stage) => [stage.pipelineId, stage.statusId, stage.kind]), [
    [6909890, 58810350, "partial"],
    [6909890, 142, "won"],
    [9055778, 72999111, "partial"],
    [9055778, 142, "won"],
  ]);
});

test("matches a part-payment stage written in either language", () => {
  const { stages } = collectRevenueStages(pipelinesPayload());
  const partial = stages.filter((stage) => stage.kind === "partial");
  assert.deepEqual(partial.map((stage) => stage.statusName), ["Часть оплачена", "Qisman to'langan"]);
});

test("never counts the lost stage or an ordinary working stage as revenue", () => {
  const { stages } = collectRevenueStages(pipelinesPayload());
  assert.equal(stages.some((stage) => stage.statusId === 143), false);
  assert.equal(stages.some((stage) => stage.statusId === 58160718), false);
});

test("detects a renamed success stage by amoCRM's own type marker", () => {
  const { stages } = collectRevenueStages({
    _embedded: {
      pipelines: [{
        id: 1,
        name: "P",
        _embedded: { statuses: [{ id: 999, name: "Sotildi", type: 1 }] },
      }],
    },
  });
  assert.deepEqual(stages.map((stage) => stage.kind), ["won"]);
});

test("skips malformed pipelines and statuses instead of failing the whole sync", () => {
  const { stages } = collectRevenueStages({
    _embedded: {
      pipelines: [
        { id: "nope", name: "Bad" },
        { id: 5, name: "Good", _embedded: { statuses: [{ id: 0, name: "X" }, { id: 7, name: "" }] } },
        { id: 6, name: "Ok", _embedded: { statuses: [{ id: 8, name: "Часть оплачена", type: 0 }] } },
      ],
    },
  });
  assert.deepEqual(stages.map((stage) => stage.statusId), [8]);
});

test("rejects a response that is not a pipelines payload", () => {
  assert.throws(() => collectRevenueStages({}), /pipelines response is malformed/);
  assert.throws(() => collectRevenueStages(null), /pipelines response is malformed/);
});

test("reports what was found, naming each part-payment stage", () => {
  const { pipelines, stages } = collectRevenueStages(pipelinesPayload());
  const text = formatRevenueStageSync({ pipelines, stages, removed: 1 });

  assert.equal(text.includes("Воронок просмотрено: 2"), true);
  assert.equal(text.includes("Найдено этапов: 4 (успешно: 2, часть оплачена: 2)"), true);
  assert.equal(text.includes("• UZUM — «Часть оплачена» (58810350)"), true);
  assert.equal(text.includes("🗑 Удалено устаревших этапов: 1"), true);
});

test("warns when no part-payment stage exists anywhere", () => {
  const text = formatRevenueStageSync({
    pipelines: 3,
    stages: [{ pipelineId: 1, statusId: 142, kind: "won", pipelineName: "P", statusName: "Успешно" }],
    removed: 0,
  });

  // Otherwise an empty revenue line looks like a bug instead of a naming issue.
  assert.equal(text.includes("не найден ни в одной воронке"), true);
});
