const test = require("node:test");
const assert = require("node:assert/strict");

const {
  amoUserIdMap,
  applyAmoRevenueToMembers,
  loadPhoenixArrivalsFromAmo,
  loadRevenueFromAmo,
  revenueSectionFromFact,
  summarizePhoenixArrivals,
  summarizeRevenue,
} = require("../dist/services/amoDailyFacts");

const PHOENIX = 9055770;
const PHOENIX_ENTRY = 72917546;
const range = { from: new Date("2026-09-20T19:00:00Z"), to: new Date("2026-09-21T19:00:00Z") };

const at = (minutes) => new Date(range.from.getTime() + minutes * 60_000);
const change = (leadId, before, after, minutes = 0) => ({
  leadId,
  createdAt: at(minutes),
  before: before ? { pipelineId: before[0], statusId: before[1] } : null,
  after: { pipelineId: after[0], statusId: after[1] },
});
const lead = (id, statusId, price, responsibleUserId = 10, pipelineId = 6909890) => ({
  id, name: null, pipelineId, statusId, price, responsibleUserId, updatedAt: at(0), closedAt: null,
});

test("counts each arriving deal once, by the pipeline it came from", () => {
  const fact = summarizePhoenixArrivals([
    change(1, [6909890, 58160902], [PHOENIX, PHOENIX_ENTRY], 5),
    change(2, [9055778, 72919958], [PHOENIX, PHOENIX_ENTRY], 6),
    change(3, [6909890, 58160726], [PHOENIX, PHOENIX_ENTRY], 7),
    // Same deal bounced back and returned: still one arrival, first origin wins.
    change(1, [9888398, 78631754], [PHOENIX, PHOENIX_ENTRY], 60),
  ]);
  assert.equal(fact.total, 3);
  assert.deepEqual(fact.byPipeline, [{ pipelineId: 6909890, count: 2 }, { pipelineId: 9055778, count: 1 }]);
  assert.equal(fact.unknownOrigin, 0);
});

test("a stage change inside Phoenix is not an arrival", () => {
  const fact = summarizePhoenixArrivals([
    change(1, [PHOENIX, PHOENIX_ENTRY], [PHOENIX, 142], 5),
    change(2, [PHOENIX, PHOENIX_ENTRY], [PHOENIX, 72917550], 6),
  ]);
  assert.equal(fact.total, 0);
});

test("an event without a previous stage is counted but reported as unknown origin", () => {
  const fact = summarizePhoenixArrivals([change(1, null, [PHOENIX, PHOENIX_ENTRY])]);
  assert.equal(fact.total, 1);
  assert.equal(fact.unknownOrigin, 1);
  assert.deepEqual(fact.byPipeline, []);
});

test("arrivals are read for every Phoenix stage, falling back to the entry stage", async () => {
  const calls = [];
  const client = {
    fetchPipelineStageRefs: async () => [{ pipelineId: PHOENIX, statusId: PHOENIX_ENTRY }, { pipelineId: PHOENIX, statusId: 142 }],
    fetchLeadStatusChangesInto: async (stages, r) => { calls.push({ stages, r }); return [change(7, [6909890, 58160902], [PHOENIX, 142])]; },
    fetchLeadsClosedInRange: async () => [],
    fetchLeadFactsByIds: async () => [],
  };
  const fact = await loadPhoenixArrivalsFromAmo(range, client);
  assert.equal(fact.total, 1);
  assert.equal(calls[0].stages.length, 2);
  assert.equal(calls[0].r, range);

  const fallback = await loadPhoenixArrivalsFromAmo(range, {
    ...client,
    fetchPipelineStageRefs: async () => { throw new Error("pipelines down"); },
  });
  assert.equal(fallback.total, 1);
  assert.deepEqual(calls[1].stages, [{ pipelineId: PHOENIX, statusId: PHOENIX_ENTRY }]);
});

test("revenue sums budgets of won and part-paid deals and splits them by responsible user", () => {
  const fact = summarizeRevenue(
    [lead(1, 142, "1500000", 10), lead(2, 142, 2500000, 11), lead(3, 143, 999, 10), lead(1, 142, "1500000", 10)],
    [lead(4, 58160730, 300000, 10), lead(4, 58160730, 300000, 10), lead(2, 58160730, 1, 11), lead(5, 143, 100, 12), lead(6, 58160730, null, 12)],
    true,
  );
  assert.equal(fact.wonCount, 2);
  assert.equal(fact.wonAmount, 4000000);
  // 4 counted; 2 was won so it is not "part-paid"; 5 is lost; 6 has no budget.
  assert.equal(fact.partialCount, 2);
  assert.equal(fact.partialAmount, 300000);
  assert.equal(fact.withoutBudget, 1);
  assert.equal(fact.stagesSynced, true);
  assert.deepEqual(fact.byResponsible.get(10), { wonCount: 1, wonAmount: 1500000, partialCount: 1, partialAmount: 300000, withoutBudget: 0 });
  assert.deepEqual(fact.byResponsible.get(12), { wonCount: 0, wonAmount: 0, partialCount: 1, partialAmount: 0, withoutBudget: 1 });
});

test("part-paid deals come from the stage-change events of every synced stage, then are read for budget", async () => {
  const calls = [];
  const client = {
    fetchPipelineStageRefs: async () => [],
    fetchLeadStatusChangesInto: async (stages) => { calls.push(["events", stages]); return [change(4, [6909890, 1], [6909890, 58160730]), change(4, [6909890, 1], [6909890, 58160730])]; },
    fetchLeadsClosedInRange: async () => [lead(1, 142, 100)],
    fetchLeadFactsByIds: async (ids) => { calls.push(["byIds", ids]); return [lead(4, 58160730, 50)]; },
  };
  const stages = [
    { pipelineId: 6909890, statusId: 58160730, kind: "partial" },
    { pipelineId: 9055778, statusId: 72917590, kind: "partial" },
    { pipelineId: 6909890, statusId: 142, kind: "won" },
  ];
  const fact = await loadRevenueFromAmo(range, { client, stages });
  assert.equal(fact.wonAmount, 100);
  assert.equal(fact.partialAmount, 50);
  assert.deepEqual(calls[0], ["events", [{ pipelineId: 6909890, statusId: 58160730 }, { pipelineId: 9055778, statusId: 72917590 }]]);
  assert.deepEqual(calls[1], ["byIds", [4]]);
});

test("without synced part-paid stages no events are requested and the report says so", async () => {
  let eventCalls = 0;
  const client = {
    fetchPipelineStageRefs: async () => [],
    fetchLeadStatusChangesInto: async () => { eventCalls += 1; return []; },
    fetchLeadsClosedInRange: async () => [],
    fetchLeadFactsByIds: async () => [],
  };
  const fact = await loadRevenueFromAmo(range, { client, stages: [] });
  assert.equal(eventCalls, 0);
  assert.equal(fact.stagesSynced, false);
  assert.equal(revenueSectionFromFact(fact).stagesNotSynced, true);
});

test("managers with an amoCRM user get their amoCRM figures; others keep the recorded ones", () => {
  const recorded = { wonCount: 9, wonAmount: 9, partialCount: 9, partialAmount: 9, unknownAmountCount: 0 };
  const performance = new Map([
    [1, { managerName: "A", calls: {}, revenue: { ...recorded }, plan: null }],
    [2, { managerName: "B", calls: {}, revenue: { ...recorded }, plan: null }],
    [3, { managerName: "C", calls: {}, revenue: { ...recorded }, plan: null }],
  ]);
  const fact = summarizeRevenue([lead(1, 142, 700, 100)], [], true);
  applyAmoRevenueToMembers(performance, amoUserIdMap([{ id: 1, amoUserId: 100 }, { id: 2, amoUserId: 200 }, { id: 3, amoUserId: null }]), fact);

  assert.equal(performance.get(1).revenue.wonAmount, 700);
  // Known in amoCRM but sold nothing: zero, not the stale recorded number.
  assert.equal(performance.get(2).revenue.wonAmount, 0);
  assert.deepEqual(performance.get(3).revenue, recorded);
});
