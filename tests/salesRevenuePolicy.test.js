const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WON_STATUS_ID,
  LOST_STATUS_ID,
  classifyRevenueStage,
  revenueKindForStage,
  parseAmount,
  readCustomFieldAmount,
  resolvePaymentAmountFieldId,
  resolveRevenueAmount,
} = require("../dist/services/salesRevenuePolicy");

test("treats the system success status as won revenue in every pipeline", () => {
  assert.equal(WON_STATUS_ID, 142);
  assert.equal(revenueKindForStage(6909890, 142), "won");
  assert.equal(revenueKindForStage(11071910, 142), "won");
  assert.equal(revenueKindForStage(null, 142), "won");
});

const SYNCED_STAGES = [
  { pipelineId: 6909890, statusId: 58810350, kind: "partial" },
  { pipelineId: 9055778, statusId: 72999111, kind: "partial" },
];

test("recognizes the part-paid stages discovered by the sync", () => {
  assert.equal(revenueKindForStage(6909890, 58810350, SYNCED_STAGES), "partial");
  assert.equal(revenueKindForStage(9055778, 72999111, SYNCED_STAGES), "partial");
  // A part-paid stage ID is pipeline-scoped, never global like status 142.
  assert.equal(revenueKindForStage(9055778, 58810350, SYNCED_STAGES), null);
  // Before a sync has ever run only the system won status is known.
  assert.equal(revenueKindForStage(6909890, 58810350), null);
});

test("classifies a pipeline status by amoCRM's type and by its name", () => {
  assert.equal(classifyRevenueStage({ statusId: 142, statusName: "Успешно реализовано", statusType: 1 }), "won");
  assert.equal(classifyRevenueStage({ statusId: 999, statusName: "Sotildi", statusType: 1 }), "won");
  assert.equal(classifyRevenueStage({ statusId: 58810350, statusName: "Часть оплачена", statusType: 0 }), "partial");
  assert.equal(classifyRevenueStage({ statusId: 5, statusName: "  ЧАСТЬ  ОПЛАЧЕНА ", statusType: 0 }), "partial");
  assert.equal(classifyRevenueStage({ statusId: 6, statusName: "Qisman to'langan", statusType: 0 }), "partial");
  assert.equal(classifyRevenueStage({ statusId: 143, statusName: "Закрыто", statusType: 2 }), null);
  assert.equal(classifyRevenueStage({ statusId: 7, statusName: "Взято в работу", statusType: 0 }), null);
  assert.equal(LOST_STATUS_ID, 143);
});

test("returns no revenue kind for ordinary or lost stages", () => {
  assert.equal(revenueKindForStage(6909890, 58160726, SYNCED_STAGES), null);
  assert.equal(revenueKindForStage(6909890, 143, SYNCED_STAGES), null);
  assert.equal(revenueKindForStage(6909890, null), null);
  assert.equal(revenueKindForStage(undefined, undefined), null);
});

test("parses amoCRM money values written as numbers or strings", () => {
  assert.equal(parseAmount(1500000), 1500000);
  assert.equal(parseAmount("1500000"), 1500000);
  assert.equal(parseAmount("1 500 000"), 1500000);
  assert.equal(parseAmount("1500000.49"), 1500000);
  assert.equal(parseAmount("1500000.50"), 1500001);
  assert.equal(parseAmount(0), 0);
});

test("rejects money values that cannot be trusted", () => {
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(undefined), null);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("bepul"), null);
  assert.equal(parseAmount(-100), null);
  assert.equal(parseAmount(Number.NaN), null);
  assert.equal(parseAmount({ value: 100 }), null);
});

test("reads the payment amount out of the configured custom field", () => {
  const lead = {
    custom_fields_values: [
      { field_id: 111, values: [{ value: "ignored" }] },
      { field_id: 222, values: [{ value: "750000" }] },
    ],
  };

  assert.equal(readCustomFieldAmount(lead, 222), 750000);
  assert.equal(readCustomFieldAmount(lead, 111), null);
  assert.equal(readCustomFieldAmount(lead, 999), null);
  assert.equal(readCustomFieldAmount(lead, null), null);
  assert.equal(readCustomFieldAmount({}, 222), null);
});

test("treats an unset or malformed field ID as not configured", () => {
  assert.equal(resolvePaymentAmountFieldId({}), null);
  assert.equal(resolvePaymentAmountFieldId({ AMOCRM_PAYMENT_AMOUNT_FIELD_ID: "" }), null);
  assert.equal(resolvePaymentAmountFieldId({ AMOCRM_PAYMENT_AMOUNT_FIELD_ID: "abc" }), null);
  assert.equal(resolvePaymentAmountFieldId({ AMOCRM_PAYMENT_AMOUNT_FIELD_ID: "0" }), null);
  assert.equal(resolvePaymentAmountFieldId({ AMOCRM_PAYMENT_AMOUNT_FIELD_ID: " 222 " }), 222);
});

test("values a won deal by its budget and a part-paid deal by the payment field", () => {
  const lead = {
    price: 2000000,
    custom_fields_values: [{ field_id: 222, values: [{ value: 500000 }] }],
  };

  assert.equal(resolveRevenueAmount("won", lead, 222), 2000000);
  assert.equal(resolveRevenueAmount("partial", lead, 222), 500000);
});

test("uses the deal budget for a part-paid deal when no payment field is set", () => {
  const lead = { price: 2000000, custom_fields_values: [] };

  assert.equal(resolveRevenueAmount("partial", lead, null), 2000000);
  assert.equal(resolveRevenueAmount("partial", lead, 222), 2000000);
  assert.equal(resolveRevenueAmount("won", lead, null), 2000000);
});

test("reports no amount when the deal has no budget either", () => {
  assert.equal(resolveRevenueAmount("won", { price: null }, null), null);
  assert.equal(resolveRevenueAmount("partial", { price: "" }, 222), null);
});
