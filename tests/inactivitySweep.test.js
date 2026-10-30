const test = require("node:test");
const assert = require("node:assert/strict");

const {
  selectSweepCandidates,
  countByPipeline,
  moveSweepCandidates,
  createRecentTouchGuard,
  SWEEP_IDLE_MS,
} = require("../dist/services/inactivitySweep");
const { INACTIVITY_MS } = require("../dist/services/leadInactivityPolicy");

// Each pipeline's own "квалифицирован" stage: a sweep now checks the stage, not just the pipeline.
const QUALIFIED_STATUS_BY_PIPELINE = { 6909890: 58160726, 9055778: 72917586, 9888398: 78631750, 11071910: 86963446 };

const now = new Date("2026-09-16T05:00:00.000Z");
const h = (hours) => new Date(now.getTime() - hours * 3600 * 1000);
const lead = (id, updatedAt, pipelineId = 6909890) => ({
  id, createdAt: h(5000), updatedAt, pipelineId, statusId: QUALIFIED_STATUS_BY_PIPELINE[pipelineId] ?? 58160726, responsibleUserId: 1, name: null,
});

test("the sweep uses the worker's own three-day rule, with no upper bound", () => {
  assert.equal(SWEEP_IDLE_MS, INACTIVITY_MS);
  assert.equal(SWEEP_IDLE_MS, 72 * 3600 * 1000);
});

test("picks every lead idle for 3 days or more, longest-idle first", () => {
  const candidates = selectSweepCandidates([
    lead(1, h(71.9)),   // not yet 3 days
    lead(2, h(72)),     // exactly 3 days
    lead(3, h(200)),    // 8 days
    lead(4, h(2000)),   // months: still swept, there is no ceiling
  ], now);

  assert.deepEqual(candidates.map((c) => c.leadId), [4, 3, 2]);
});

test("ignores pipelines outside the inactivity policy and duplicate rows", () => {
  const candidates = selectSweepCandidates([
    lead(1, h(120), 9055770),   // Phoenix itself
    lead(2, h(120), 99999999),  // unknown pipeline
    lead(3, h(120)),
    lead(3, h(120)),
  ], now);
  assert.deepEqual(candidates.map((c) => c.leadId), [3]);
});

test("counts candidates per source pipeline, biggest first", () => {
  const candidates = selectSweepCandidates([
    lead(1, h(120), 6909890), lead(2, h(120), 9055778), lead(3, h(120), 6909890),
  ], now);
  assert.deepEqual(countByPipeline(candidates), [
    { pipelineId: 6909890, count: 2 },
    { pipelineId: 9055778, count: 1 },
  ]);
});

const candidatesOf = (...ids) => ids.map((leadId) => ({ leadId, pipelineId: 6909890, statusId: 58160726, lastTouchedAt: h(120) }));
const confirmed = { kind: "confirmed", lead: {} };

test("moves every candidate and accounts for each outcome", async () => {
  const audited = [];
  const result = await moveSweepCandidates(candidatesOf(1, 2, 3), {
    async moveLeadToTarget(leadId, target) {
      assert.equal(target.targetPipelineId, 9055770);
      return leadId === 2 ? { kind: "not_moved", reason: "not_in_source", lead: {} } : confirmed;
    },
    async onMoved(candidate) { audited.push(candidate.leadId); },
  });

  assert.equal(result.moved, 2);
  assert.equal(result.notMoved, 1);
  assert.deepEqual(result.movedCandidates.map((c) => c.leadId), [1, 3]);
  assert.deepEqual(audited, [1, 3]);
});

test("a lead touched inside the window is skipped, never PATCHed", async () => {
  const attempted = [];
  const result = await moveSweepCandidates(candidatesOf(1, 2, 3), {
    async moveLeadToTarget(leadId) { attempted.push(leadId); return confirmed; },
    async hasRecentTouch(candidate) { return candidate.leadId === 2; },
  });

  assert.deepEqual(attempted, [1, 3]);
  assert.equal(result.skippedRecentTouch, 1);
  assert.equal(result.moved, 2);
});

test("when the touch check itself fails the lead is left alone, not moved blind", async () => {
  const attempted = [];
  const result = await moveSweepCandidates(candidatesOf(1, 2), {
    async moveLeadToTarget(leadId) { attempted.push(leadId); return confirmed; },
    async hasRecentTouch(candidate) { if (candidate.leadId === 1) throw new Error("amo 502"); return false; },
  });

  assert.deepEqual(attempted, [2]);
  assert.equal(result.guardFailed, 1);
});

test("halts at the first uncertain outcome and audits it", async () => {
  const attempted = [];
  const uncertain = [];
  const result = await moveSweepCandidates(candidatesOf(1, 2, 3), {
    async moveLeadToTarget(leadId) {
      attempted.push(leadId);
      return leadId === 2
        ? { kind: "uncertain", error: { kind: "network", status: null, code: null, message: "timeout" }, readback: null }
        : confirmed;
    },
    async onUncertain(candidate) { uncertain.push(candidate.leadId); },
  });

  assert.deepEqual(attempted, [1, 2], "lead 3 was never attempted");
  assert.deepEqual(uncertain, [2]);
  assert.deepEqual(result.stoppedAt, { index: 1, reason: "uncertain" });
});

test("a stop issued mid-sweep halts it before the next PATCH", async () => {
  let calls = 0;
  const result = await moveSweepCandidates(candidatesOf(1, 2, 3), {
    async moveLeadToTarget() { calls += 1; return confirmed; },
    async isStopped() { return calls >= 1; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.stoppedAt, { index: 1, reason: "stopped" });
});

test("a failing audit hook never turns a confirmed move into a failed sweep", async () => {
  const result = await moveSweepCandidates(candidatesOf(1, 2), {
    async moveLeadToTarget() { return confirmed; },
    async onMoved() { throw new Error("database down"); },
  });
  assert.equal(result.moved, 2);
});

test("the touch guard trusts the worker's record before asking amoCRM", async () => {
  let historyReads = 0;
  const guard = createRecentTouchGuard({
    getWatchLastActivityAt: async (leadId) => (leadId === 1 ? h(10) : leadId === 2 ? h(500) : null),
    readLeadHistory: async (leadId) => {
      historyReads += 1;
      return leadId === 3
        ? [{ entityType: "lead", entityId: 3, createdAt: h(5) }]
        : [{ entityType: "lead", entityId: leadId, createdAt: h(300) }, { entityType: "contact", entityId: leadId, createdAt: h(1) }];
    },
    now: () => now,
  });

  assert.equal(await guard(candidatesOf(1)[0]), true, "the webhook saw a touch 10 hours ago");
  assert.equal(historyReads, 0, "no amoCRM request was needed for that");
  assert.equal(await guard(candidatesOf(2)[0]), false, "old watch, old history; the contact event does not count");
  assert.equal(await guard(candidatesOf(3)[0]), true, "no watch, but the history shows a note 5 hours ago");
});

test("candidates come in stage priority first, longest idle inside a stage, and OZHOP never", () => {
  const at = (id, hours, pipelineId, statusId) => ({ id, createdAt: h(5000), updatedAt: h(hours), pipelineId, statusId, responsibleUserId: 1, name: null });
  const candidates = selectSweepCandidates([
    at(1, 200, 6909890, 58160726),  // qualified, idle longest
    at(2, 90, 6909890, 58160718),   // taken in work
    at(3, 150, 9055778, 72917582),  // taken in work, idle longer
    at(4, 300, 6909890, 58160902),  // OZHOP: out of the rollout
  ], now);
  assert.deepEqual(candidates.map((c) => c.leadId), [3, 2, 1]);
});

test("the daily budget is taken only for a lead about to move, settled by outcome, and stops the sweep when spent", async () => {
  const events = [];
  let places = 2;
  const reserveDailySlot = async (candidate) => {
    if (places === 0) { events.push(`full:${candidate.leadId}`); return null; }
    places -= 1;
    events.push(`take:${candidate.leadId}`);
    return {
      confirm: async () => { events.push(`confirm:${candidate.leadId}`); },
      release: async () => { places += 1; events.push(`release:${candidate.leadId}`); },
      markUncertain: async () => { events.push(`uncertain:${candidate.leadId}`); },
    };
  };
  const outcomes = { 1: confirmed, 2: { kind: "not_moved", reason: "not_in_source" }, 3: confirmed, 4: confirmed };
  const result = await moveSweepCandidates(candidatesOf(1, 5, 2, 3, 4), {
    moveLeadToTarget: async (leadId) => outcomes[leadId] ?? confirmed,
    hasRecentTouch: async (candidate) => candidate.leadId === 5,
    reserveDailySlot,
  });
  assert.deepEqual(events, ["take:1", "confirm:1", "take:2", "release:2", "take:3", "confirm:3", "full:4"]);
  assert.equal(result.moved, 2);
  assert.equal(result.notMoved, 1);
  assert.equal(result.skippedRecentTouch, 1, "a recently touched lead never takes a place");
  assert.deepEqual(result.stoppedAt, { index: 4, reason: "daily_cap" });
});

test("the sweep runtime reserves from the shared day budget, ensures it once, and skips it when the cap is lifted", async () => {
  const { createDailySlotReserver } = require("../dist/services/inactivitySweepRuntime");
  const calls = [];
  let free = 1;
  const store = {
    getDailyMovementOperationalStartDate: async () => "2026-08-05",
    ensureDailyMovementSlots: async (bucket, limit) => { calls.push(["ensure", bucket, limit]); },
    reserveDailyMovementSlot: async (bucket, leadId, auditId) => {
      calls.push(["reserve", bucket, leadId, auditId]);
      if (free === 0) return null;
      free -= 1;
      return { slotNumber: 7 };
    },
    confirmDailyMovementSlot: async (bucket, slotNumber, auditId) => { calls.push(["confirm", bucket, slotNumber, auditId]); },
    releaseDailyMovementSlotAfterKnownNoMove: async () => {},
    markDailyMovementSlotUncertain: async () => {},
  };
  let capDisabled = false;
  const reserve = createDailySlotReserver({
    store,
    isCapDisabled: async () => capDisabled,
    now: () => new Date("2026-08-05T10:00:00.000Z"),
    randomId: () => "r1",
  });

  const ticket = await reserve({ leadId: 42 });
  await ticket.confirm();
  assert.equal(await reserve({ leadId: 43 }), null, "a spent budget returns no ticket");
  assert.deepEqual(calls, [
    ["ensure", "operational:2026-08-05", 50],
    ["reserve", "operational:2026-08-05", 42, "sweep:r1"],
    ["confirm", "operational:2026-08-05", 7, "sweep:r1"],
    ["reserve", "operational:2026-08-05", 43, "sweep:r1"],
  ]);

  capDisabled = true;
  const before = calls.length;
  const free_ticket = await reserve({ leadId: 44 });
  assert.ok(free_ticket);
  assert.equal(calls.length, before, "a lifted cap touches no slots");
});
