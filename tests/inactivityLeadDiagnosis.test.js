const test = require("node:test");
const assert = require("node:assert/strict");

const { diagnoseLead, formatLeadDiagnosis } = require("../dist/services/inactivityLeadDiagnosis");

const now = new Date("2026-09-18T05:00:00.000Z");
const ago = (d) => new Date(now.getTime() - d * 24 * 3600 * 1000);
const boundary = new Date("2026-07-22T05:00:00.000Z");

function input(overrides = {}) {
  return {
    leadId: 26062823,
    now,
    lead: { createdAt: ago(20), updatedAt: ago(8), pipelineId: 6909890, statusId: 58160726 },
    activationBoundary: boundary,
    watch: null,
    hasBaselineEvent: false,
    eventCount: 0,
    lastAudit: null,
    ...overrides,
  };
}
const watch = (o = {}) => ({ state: "watching", lastActivityAt: ago(8), dueAt: ago(5), cycle: 1, stoppedAt: null, lastFailureReason: null, ...o });

test("a lead the worker never heard of is reported as unseen, not as a broken timer", () => {
  const d = diagnoseLead(input());
  assert.equal(d.kind, "never_seen");
  assert.match(d.explanation, /не сканирует amoCRM/);
});

test("a pre-activation lead without a baseline is invisible for good", () => {
  const d = diagnoseLead(input({ lead: { createdAt: new Date("2026-06-01T00:00:00Z"), updatedAt: ago(8), pipelineId: 6909890, statusId: 58160726 } }));
  assert.equal(d.kind, "historical_never_baselined");
  // With a baseline event the same lead is merely unseen.
  const baselined = diagnoseLead(input({ hasBaselineEvent: true, lead: { createdAt: new Date("2026-06-01T00:00:00Z"), updatedAt: ago(8), pipelineId: 6909890, statusId: 58160726 } }));
  assert.equal(baselined.kind, "never_seen");
});

test("names the operator stop as the reason a watch ended", () => {
  const d = diagnoseLead(input({ watch: watch({ state: "skipped", lastFailureReason: "stopped by operator switch", stoppedAt: ago(6) }) }));
  assert.equal(d.kind, "stopped_by_operator");
  assert.match(d.explanation, /\/inactivity_off/);
});

test("distinguishes every terminal watch state", () => {
  assert.equal(diagnoseLead(input({ watch: watch({ state: "uncertain" }) })).kind, "uncertain");
  assert.equal(diagnoseLead(input({ watch: watch({ state: "outside_scope" }) })).kind, "outside_scope");
  assert.equal(diagnoseLead(input({ watch: watch({ state: "moved", cycle: 2 }) })).kind, "moved_and_returned");
  assert.equal(diagnoseLead(input({ watch: watch({ state: "leased" }) })).kind, "in_progress");
  assert.equal(diagnoseLead(input({ watch: watch({ state: "skipped", lastFailureReason: "other" }) })).kind, "skipped_other");
});

test("an overdue watch points at the queue and quotes the last attempt", () => {
  const d = diagnoseLead(input({
    watch: watch(),
    lastAudit: { outcome: "skipped", errorMessage: "daily capacity", createdAt: ago(1) },
  }));
  assert.equal(d.kind, "due_waiting");
  assert.match(d.explanation, /Просрочена на 5\.0 дн/);
  assert.match(d.explanation, /skipped — daily capacity/);
});

test("a watch that is not due explains the updated_at mismatch", () => {
  const d = diagnoseLead(input({ watch: watch({ lastActivityAt: ago(1), dueAt: new Date(now.getTime() + 2 * 24 * 3600 * 1000) }) }));
  assert.equal(d.kind, "not_due_yet");
  assert.match(d.remedy, /через 2\.0 дн/);
});

test("rules out deals that could never move before blaming the worker", () => {
  assert.equal(diagnoseLead(input({ lead: null })).kind, "lead_unavailable");
  assert.equal(diagnoseLead(input({ lead: { createdAt: ago(20), updatedAt: ago(8), pipelineId: 9055770, statusId: 72917546 } })).kind, "already_in_phoenix");
  assert.equal(diagnoseLead(input({ lead: { createdAt: ago(20), updatedAt: ago(8), pipelineId: 6909890, statusId: 58160714 } })).kind, "outside_stages");
});

test("renders the facts alongside the verdict", () => {
  const i = input({ eventCount: 4, watch: watch({ state: "uncertain" }) });
  const text = formatLeadDiagnosis(i, diagnoseLead(i));
  assert.equal(text.includes("Сделка #26062823"), true);
  assert.equal(text.includes("Простой по amoCRM (updated_at): 8.0 дн."), true);
  assert.equal(text.includes("Запись наблюдения: uncertain"), true);
  assert.equal(text.includes("Принято событий по сделке: 4"), true);
});
