const test = require("node:test");
const assert = require("node:assert/strict");

const {
  UZUM_PIPELINE_ID,
  UZUM_STAGE_IDS,
  evaluateUzumStageRoute,
} = require("../dist/services/callStagePolicy");

function fields(values = {}) {
  return new Map(Object.entries(values).map(([fieldId, value]) => [Number(fieldId), value]));
}

function route(overrides = {}) {
  return evaluateUzumStageRoute({
    pipelineId: UZUM_PIPELINE_ID,
    currentStatusId: UZUM_STAGE_IDS.newLead,
    target: "qualified",
    fieldValues: fields(),
    requiredFields: [],
    ...overrides,
  });
}

test("uses the current amoCRM-required rules supplied by its caller instead of a parallel hard-coded field list", () => {
  const result = route({
    requiredFields: [{ id: 777001, name: "Текущее обязательное поле" }],
    fieldValues: fields({ 777001: "заполнено" }),
  });

  assert.deepEqual(result, {
    kind: "allowed",
    target: { key: "qualified", statusId: 58160726, name: "квалифицирован" },
    checkedFields: ["Текущее обязательное поле"],
  });
});

test("reports the exact current amoCRM-required field when a clear target is blocked", () => {
  const result = route({
    currentStatusId: UZUM_STAGE_IDS.partiallyPaid,
    target: "successful",
    requiredFields: [{ id: 1043357, name: "Способ оплаты" }],
  });

  assert.deepEqual(result, {
    kind: "missing_fields",
    target: { key: "successful", statusId: 142, name: "Успешно реализовано" },
    missingFields: [{ id: 1043357, name: "Способ оплаты" }],
  });
});

test("requires the explicit Yoq duplicate value before moving a substantive call into taken-in-work", () => {
  const requiredFields = [{ id: 1038299, name: "Sdelkani dubl bormi", requiredValue: "Yoq" }];
  const missing = route({
    target: "takenInWork",
    requiredFields,
    fieldValues: fields({ 1038299: "Ha" }),
  });
  assert.deepEqual(missing, {
    kind: "missing_fields",
    target: { key: "takenInWork", statusId: 58160718, name: "взято в работу" },
    missingFields: [{ id: 1038299, name: "Sdelkani dubl bormi" }],
  });

  const allowed = route({
    target: "takenInWork",
    requiredFields,
    fieldValues: fields({ 1038299: "  Yoq  " }),
  });
  assert.equal(allowed.kind, "allowed");
});

test("never treats a direct full payment as successful realization: that target is only valid after partial payment", () => {
  const directFullPayment = route({ target: "successful" });
  assert.deepEqual(directFullPayment, {
    kind: "not_forward",
    target: { key: "successful", statusId: 142, name: "Успешно реализовано" },
  });
});

test("never routes backward from partial payment to OZHOP but allows the agreed final-payment route", () => {
  const backward = route({
    currentStatusId: UZUM_STAGE_IDS.partiallyPaid,
    target: "ozhop",
  });
  assert.deepEqual(backward, {
    kind: "not_forward",
    target: { key: "ozhop", statusId: 58160902, name: "ОЖОП" },
  });

  const finalPayment = route({
    currentStatusId: UZUM_STAGE_IDS.partiallyPaid,
    target: "successful",
    requiredFields: [{ id: 1043357, name: "Способ оплаты" }],
    fieldValues: fields({ 1043357: "Kaspi" }),
  });
  assert.equal(finalPayment.kind, "allowed");
});

test("keeps all non-UZUM pipelines out of stage routing", () => {
  assert.deepEqual(route({ pipelineId: 123 }), { kind: "out_of_scope" });
});
