const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WON_STATUS_ID,
  PARTIAL_PAYMENT_STAGES,
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

test("recognizes only the configured part-paid stages", () => {
  for (const { pipelineId, statusId } of PARTIAL_PAYMENT_STAGES) {
    assert.equal(revenueKindForStage(pipelineId, statusId), "partial");
  }
  assert.equal(revenueKindForStage(6909890, 58810350), "partial");
  // A part-paid stage ID is pipeline-scoped, never global like status 142.
  assert.equal(revenueKindForStage(9055778, 58810350), null);
});

test("returns no revenue kind for ordinary or lost stages", () => {
  assert.equal(revenueKindForStage(6909890, 58160726), null);
  assert.equal(revenueKindForStage(6909890, 143), null);
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

test("never falls back to the full budget for a part-paid deal", () => {
  const lead = { price: 2000000, custom_fields_values: [] };

  // Without the payment field there is no honest amount, so none is reported.
  assert.equal(resolveRevenueAmount("partial", lead, null), null);
  assert.equal(resolveRevenueAmount("partial", lead, 222), null);
  assert.equal(resolveRevenueAmount("won", lead, null), 2000000);
});
