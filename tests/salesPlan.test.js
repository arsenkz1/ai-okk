const test = require("node:test");
const assert = require("node:assert/strict");

const {
  almatyPlanMonth,
  parsePlanMonth,
  parsePlanAmount,
  formatPlanMonth,
  MAX_PLAN_AMOUNT,
} = require("../dist/services/salesPlan");

test("derives the plan month from Almaty local time, not UTC", () => {
  // 31 Aug 20:00 UTC is already 1 Sep in Almaty (UTC+5).
  assert.deepEqual(almatyPlanMonth(new Date("2026-08-31T20:00:00.000Z")), { year: 2026, month: 9 });
  assert.deepEqual(almatyPlanMonth(new Date("2026-08-31T18:00:00.000Z")), { year: 2026, month: 8 });
  assert.deepEqual(almatyPlanMonth(new Date("2026-12-31T19:00:00.000Z")), { year: 2027, month: 1 });
});

test("rejects an invalid clock rather than storing a wrong month", () => {
  assert.throws(() => almatyPlanMonth(new Date("nope")), /plan month time is invalid/);
});

test("parses a YYYY-MM month argument", () => {
  assert.deepEqual(parsePlanMonth("2026-09"), { year: 2026, month: 9 });
  assert.deepEqual(parsePlanMonth("  2026-01  "), { year: 2026, month: 1 });
  assert.equal(parsePlanMonth("2026-13"), null);
  assert.equal(parsePlanMonth("2026-00"), null);
  assert.equal(parsePlanMonth("1999-05"), null);
  assert.equal(parsePlanMonth("2026-9"), null);
  assert.equal(parsePlanMonth("sentabr"), null);
});

test("formats a month back into the argument form", () => {
  assert.equal(formatPlanMonth({ year: 2026, month: 9 }), "2026-09");
  assert.equal(formatPlanMonth({ year: 2026, month: 12 }), "2026-12");
});

test("accepts a target typed with or without digit separators", () => {
  assert.equal(parsePlanAmount("50000000"), 50000000);
  assert.equal(parsePlanAmount("50 000 000"), 50000000);
  assert.equal(parsePlanAmount("  1000  "), 1000);
});

test("rejects targets that are almost certainly a typo", () => {
  assert.equal(parsePlanAmount("0"), null);
  assert.equal(parsePlanAmount("-5000"), null);
  assert.equal(parsePlanAmount("50млн"), null);
  assert.equal(parsePlanAmount("50.5"), null);
  assert.equal(parsePlanAmount(""), null);
  assert.equal(parsePlanAmount(String(MAX_PLAN_AMOUNT + 1)), null);
  assert.equal(parsePlanAmount(String(MAX_PLAN_AMOUNT)), MAX_PLAN_AMOUNT);
});
