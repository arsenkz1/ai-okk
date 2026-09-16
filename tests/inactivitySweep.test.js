const test = require("node:test");
const assert = require("node:assert/strict");

const { selectSweepCandidates, countByPipeline, moveSweepCandidates, SWEEP_INACTIVITY_MS } = require("../dist/services/inactivitySweep");
const { INACTIVITY_MS } = require("../dist/services/leadInactivityPolicy");

const now = new Date("2026-09-16T05:00:00.000Z");
const h = (hours) => new Date(now.getTime() - hours * 3600 * 1000);
const lead = (id, updatedAt, pipelineId = 6909890) => ({
  id, createdAt: h(500), updatedAt, pipelineId, statusId: 58160726, responsibleUserId: 1, name: null,
});

test("the sweep window is seven days, wider than the worker's three", () => {
  assert.equal(SWEEP_INACTIVITY_MS, 7 * 24 * 3600 * 1000);
  assert.equal(INACTIVITY_MS, 72 * 3600 * 1000, "the worker's own rule is untouched");
});

test("picks only leads idle for the full 7 days, oldest first", () => {
  const candidates = selectSweepCandidates([
    lead(1, h(167.9)),  // just under 7 days
    lead(2, h(168)),    // exactly 7 days
    lead(3, h(400)),
    lead(4, h(200)),
  ], now);

  assert.deepEqual(candidates.map((c) => c.leadId), [3, 4, 2]);
  assert.deepEqual(candidates[0].lastTouchedAt, h(400));
});

test("a lead idle for 3 days is left to the worker, not swept", () => {
  // 3–7 days idle: the worker's 72-hour rule handles it from the next touch.
  assert.deepEqual(selectSweepCandidates([lead(1, h(72)), lead(2, h(120))], now), []);
});

test("ignores pipelines outside the inactivity policy and duplicate rows", () => {
  const candidates = selectSweepCandidates([
    lead(1, h(300), 9055770),   // Phoenix itself
    lead(2, h(300), 99999999),  // unknown pipeline
    lead(3, h(300)),
    lead(3, h(300)),
  ], now);
  assert.deepEqual(candidates.map((c) => c.leadId), [3]);
});

test("counts candidates per source pipeline, biggest first", () => {
  const candidates = selectSweepCandidates([
    lead(1, h(300), 6909890), lead(2, h(300), 9055778), lead(3, h(300), 6909890),
  ], now);
  assert.deepEqual(countByPipeline(candidates), [
    { pipelineId: 6909890, count: 2 },
    { pipelineId: 9055778, count: 1 },
  ]);
});

function candidatesOf(...ids) {
  return ids.map((leadId) => ({ leadId, pipelineId: 6909890, statusId: 58160726, lastTouchedAt: h(100) }));
}

test("moves every candidate and reports the mix of outcomes", async () => {
  const moved = [];
  const outcomes = { 1: "confirmed", 2: "not_moved", 3: "confirmed" };
  const result = await moveSweepCandidates(candidatesOf(1, 2, 3), {
    async moveLeadToTarget(leadId, target) {
      assert.equal(target.targetPipelineId, 9055770);
      return outcomes[leadId] === "confirmed"
        ? { kind: "confirmed", lead: {} }
        : { kind: "not_moved", reason: "not_in_source", lead: {} };
    },
    async onMoved(candidate) { moved.push(candidate.leadId); },
  });

  assert.deepEqual(result, { moved: 2, notMoved: 1, uncertain: 0 });
  assert.deepEqual(moved, [1, 3]);
});

test("halts at the first uncertain outcome, exactly like the worker", async () => {
  const attempted = [];
  const result = await moveSweepCandidates(candidatesOf(1, 2, 3), {
    async moveLeadToTarget(leadId) {
      attempted.push(leadId);
      return leadId === 2
        ? { kind: "uncertain", error: { kind: "network", status: null, code: null, message: "timeout" }, readback: null }
        : { kind: "confirmed", lead: {} };
    },
  });

  assert.deepEqual(attempted, [1, 2], "lead 3 was never attempted");
  assert.equal(result.uncertain, 1);
  assert.deepEqual(result.stoppedAt, { index: 1, reason: "uncertain" });
});

test("a stop issued mid-sweep halts it before the next PATCH", async () => {
  let calls = 0;
  const result = await moveSweepCandidates(candidatesOf(1, 2, 3), {
    async moveLeadToTarget() { calls += 1; return { kind: "confirmed", lead: {} }; },
    async isStopped() { return calls >= 1; },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.stoppedAt, { index: 1, reason: "stopped" });
});
