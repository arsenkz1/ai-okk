const test = require("node:test");
const assert = require("node:assert/strict");

const calc = require("../dist/services/salaryCalculator");
const { leadMaySetRate } = require("../dist/services/managerRate");

// Rows of the payroll sheet "октябрь 2026", block МОПЫ, 01–05 октябрь.
const SHEET_ROWS = [
  { name: "Одина", rate: 2500000, days: 4, plan: 30000000, fact: 25041000, ratio: 0.83, coefficient: 1, bonusRate: 0.03, total: 1136000 },
  { name: "Муслима", rate: 3000000, days: 4, plan: 30000000, fact: 19815000, ratio: 0.66, coefficient: 0.85, bonusRate: 0.01, total: 590000 },
  { name: "Алишер ст", rate: 2500000, days: 4, plan: 15000000, fact: 6642000, ratio: 0.44, coefficient: 0.75, bonusRate: 0.01, total: 355000 },
  { name: "Абдулазиз ст", rate: 2500000, days: 1, plan: 15000000, fact: 0, ratio: 0, coefficient: 0.6, bonusRate: 0, total: 58000 },
  { name: "Гулхайо", rate: 2500000, days: 4, plan: 30000000, fact: 3240000, ratio: 0.11, coefficient: 0.6, bonusRate: 0, total: 231000 },
];

test("the calculator reproduces the payroll sheet row by row", () => {
  for (const row of SHEET_ROWS) {
    const result = calc.calculateSalary({ fixedMonthlyRate: row.rate, workedDays: row.days, plan: row.plan, fact: row.fact });
    assert.equal(result.planRatio, row.ratio, `${row.name}: ratio`);
    assert.equal(result.shiftCoefficient, row.coefficient, `${row.name}: coefficient`);
    assert.equal(result.bonusRate, row.bonusRate, `${row.name}: bonus rate`);
    assert.equal(result.total, row.total, `${row.name}: total`);
  }
});

test("the bands switch exactly at the sheet's thresholds", () => {
  assert.deepEqual([0.29, 0.3, 0.49, 0.5, 0.69, 0.7].map(calc.shiftCoefficient), [0.6, 0.75, 0.75, 0.85, 0.85, 1]);
  assert.deepEqual([0.29, 0.3, 0.69, 0.7, 0.79, 0.8, 0.89, 0.9, 0.99, 1, 1.19, 1.2].map(calc.bonusRate), [0, 0.01, 0.01, 0.02, 0.02, 0.03, 0.03, 0.04, 0.04, 0.05, 0.05, 0.06]);
  // The ratio is rounded to hundredths before the bands, as in the sheet.
  assert.equal(calc.planRatio(6950000, 10000000), 0.7);
  assert.equal(calc.shiftCoefficient(calc.planRatio(6950000, 10000000)), 1);
});

test("a missing or zero plan is a zero ratio, never a division error", () => {
  assert.equal(calc.planRatio(5000000, 0), 0);
  assert.equal(calc.calculateSalary({ fixedMonthlyRate: 2500000, workedDays: 5, plan: 0, fact: 5000000 }).total, 288000);
});

test("a team lead may set the rate only inside the teams they run", () => {
  assert.equal(leadMaySetRate([3, 8], { teamId: 8 }), true);
  assert.equal(leadMaySetRate([3, 8], { teamId: 9 }), false);
  assert.equal(leadMaySetRate([3, 8], { teamId: null }), false);
  assert.equal(leadMaySetRate([], { teamId: 3 }), false);
});
