const test = require("node:test");
const assert = require("node:assert/strict");

const { createLeadInactivityWorker } = require("../dist/workers/leadInactivityWorker");

const SOURCE = { sourcePipelineIds: [9055778, 6909890], targetPipelineId: 9055770, targetStatusId: 72917546 };
const NOW = new Date("2026-07-19T12:00:00.000Z");

function watch(leadId = 100, overrides = {}) {
  return {
    leadId,
    leadCreatedAt: new Date("2026-07-16T10:00:00.000Z"),
    lastActivityAt: new Date("2026-07-16T12:00:00.000Z"),
    lastActivityReceivedAt: new Date("2026-07-16T12:00:01.000Z"),
    dueAt: NOW,
    pipelineId: 9055778,
    statusId: 72917586,
    cycle: 1,
    state: "leased",
    leaseToken: `lease-${leadId}`,
    leaseGeneration: 1,
    ...overrides,
  };
}

function lead(leadId = 100, overrides = {}) {
  return {
    id: leadId,
    createdAt: new Date("2026-07-16T10:00:00.000Z"),
    updatedAt: new Date("2026-07-16T12:00:00.000Z"),
    pipelineId: 9055778,
    statusId: 72917586,
    responsibleUserId: 77,
    name: "Due lead",
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const calls = {
    releaseLeases: 0,
    ensureSlots: 0,
    ensureDailySlots: [],
    hasDailyCapacity: [],
    reserveDailySlot: [],
    confirmDailySlot: [],
    releaseDailySlot: [],
    uncertainDailySlot: [],
    list: 0,
    claim: [],
    audit: [],
    completeAudit: [],
    reserve: [],
    confirm: [],
    releaseSlot: [],
    uncertainSlot: [],
    finish: [],
    record: [],
    move: [],
    readLead: [],
    readHistory: [],
  };
  const claimed = new Map(overrides.claimed ?? [[100, watch(100)]]);
  let workerRunLeaseToken = null;
  const store = {
    isProductionBaselineComplete: async () => true,
    tryAcquireWorkerRunLease: async (token) => {
      if (workerRunLeaseToken) return false;
      workerRunLeaseToken = token;
      return true;
    },
    renewWorkerRunLease: async (token) => workerRunLeaseToken === token,
    releaseWorkerRunLease: async (token) => {
      if (workerRunLeaseToken !== token) return false;
      workerRunLeaseToken = null;
      return true;
    },
    releaseExpiredWatchLeases: async () => { calls.releaseLeases += 1; },
    getDailyMovementOperationalStartDate: async () => "2026-08-05",
    ensureTestSlots: async () => { calls.ensureSlots += 1; },
    ensureDailyMovementSlots: async (bucketDate, limit) => { calls.ensureDailySlots.push({ bucketDate, limit }); },
    hasDailyMovementCapacity: async (bucketDate, limit) => {
      calls.hasDailyCapacity.push({ bucketDate, limit });
      return true;
    },
    reserveDailyMovementSlot: async (bucketDate, leadId, auditId) => {
      calls.reserveDailySlot.push({ bucketDate, leadId, auditId });
      return { bucketDate, slotNumber: 1, state: "reserved", leadId, auditId };
    },
    confirmDailyMovementSlot: async (bucketDate, slotNumber, auditId) => {
      calls.confirmDailySlot.push({ bucketDate, slotNumber, auditId });
      return { bucketDate, slotNumber, state: "confirmed", auditId };
    },
    releaseDailyMovementSlotAfterKnownNoMove: async (bucketDate, slotNumber, auditId) => {
      calls.releaseDailySlot.push({ bucketDate, slotNumber, auditId });
    },
    markDailyMovementSlotUncertain: async (bucketDate, slotNumber, auditId) => {
      calls.uncertainDailySlot.push({ bucketDate, slotNumber, auditId });
      return { bucketDate, slotNumber, state: "uncertain", auditId };
    },
    listDueWatchLeadIds: async (_now, limit, stagePairs) => {
      calls.list += 1;
      return [...claimed.values()]
        .filter((claimedWatch) => !stagePairs?.length || stagePairs.some((stage) => (
          stage.pipelineId === claimedWatch.pipelineId && stage.statusId === claimedWatch.statusId
        )))
        .slice(0, limit)
        .map((claimedWatch) => claimedWatch.leadId);
    },
    claimDueWatchForWorkerRun: async (leadId, workerRunToken) => {
      if (workerRunToken !== undefined && workerRunLeaseToken !== workerRunToken) return null;
      calls.claim.push(leadId);
      return claimed.get(leadId) ?? null;
    },
    isWatchClaimCurrent: async () => true,
    beginMoveMutation: async () => true,
    isMoveMutationCurrent: async () => true,
    createMoveAudit: async (audit) => { calls.audit.push(audit); },
    completeMoveAudit: async (auditId, outcome) => { calls.completeAudit.push({ auditId, outcome }); },
    reserveTestSlot: async (leadId, auditId) => { calls.reserve.push({ leadId, auditId }); return { slotNumber: 1, state: "reserved", auditId }; },
    confirmTestSlot: async (slotNumber, auditId) => { calls.confirm.push({ slotNumber, auditId }); return { slotNumber, state: "confirmed" }; },
    releaseTestSlotAfterKnownNoMove: async (slotNumber, auditId) => { calls.releaseSlot.push({ slotNumber, auditId }); },
    markTestSlotUncertain: async (slotNumber, auditId) => { calls.uncertainSlot.push({ slotNumber, auditId }); return { slotNumber, state: "uncertain" }; },
    finishWatchClaim: async (claimedWatch, state, reason) => { calls.finish.push({ leadId: claimedWatch.leadId, state, reason }); },
    recordLeadEvent: async (event) => { calls.record.push(event); return { ignored: false, duplicate: false, watch: { leadId: event.leadId } }; },
    ...overrides.store,
  };
  const amo = {
    readLead: async (leadId) => {
      calls.readLead.push(leadId);
      return lead(leadId);
    },
    readLeadHistory: async (leadId) => {
      calls.readHistory.push(leadId);
      return [];
    },
    moveLeadToTarget: async (leadId, _target, hooks) => {
      if (typeof hooks === "function" && !await hooks()) {
        return { kind: "not_moved", reason: "fence_cancelled", lead: lead(leadId) };
      }
      if (hooks && typeof hooks !== "function") {
        if (hooks.isMoveMutationCurrent && !await hooks.isMoveMutationCurrent()) {
          return { kind: "not_moved", reason: "fence_cancelled", lead: lead(leadId) };
        }
        if (hooks.beforeFinalPatch && await hooks.beforeFinalPatch() === "daily_capacity_unavailable") {
          return { kind: "not_moved", reason: "daily_capacity_unavailable", lead: lead(leadId) };
        }
        if (hooks.beforePatchSend && await hooks.beforePatchSend() === "daily_capacity_unavailable") {
          return { kind: "not_moved", reason: "daily_capacity_unavailable", lead: lead(leadId) };
        }
      }
      calls.move.push(leadId);
      return { kind: "confirmed", lead: lead(leadId, { pipelineId: 9055770, statusId: 72917546 }) };
    },
    ...overrides.amo,
  };
  return { calls, store, amo };
}

test("claims one due watch, reserves a durable testing slot, and records a confirmed move", async () => {
  const { store, amo, calls } = fixture();
  const worker = createLeadInactivityWorker({ store, amo, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 1, deferred: 0, uncertain: 0, failed: 0 });
  assert.equal(calls.releaseLeases, 1);
  assert.equal(calls.ensureSlots, 1);
  assert.deepEqual(calls.audit, [{ id: "audit-100", leadId: 100, cycle: 1, sourcePipelineId: 9055778, sourceStatusId: 72917586, targetPipelineId: 9055770, targetStatusId: 72917546, eventCutoffAt: new Date("2026-07-16T12:00:00.000Z") }]);
  assert.deepEqual(calls.confirm, [{ slotNumber: 1, auditId: "audit-100" }]);
  assert.deepEqual(calls.finish, [{ leadId: 100, state: "moved", reason: null }]);
  assert.deepEqual(calls.completeAudit, [{ auditId: "audit-100", outcome: { kind: "confirmed", slotNumber: 1 } }]);
});

test("records a newer direct history event and never reserves or patches the lead", async () => {
  const { store, amo, calls } = fixture({
    amo: {
      readLeadHistory: async () => [{ id: "history-1", entityType: "lead", entityId: 100, createdAt: new Date("2026-07-16T12:01:00.000Z"), type: 1, raw: {} }],
    },
  });
  const worker = createLeadInactivityWorker({ store, amo, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 0, deferred: 1, uncertain: 0, failed: 0 });
  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].fingerprint, "amo-inactivity-history:100:history-1");
  assert.equal(calls.reserve.length, 0);
  assert.equal(calls.move.length, 0);
  assert.deepEqual(calls.finish, []);
  assert.deepEqual(calls.completeAudit, [{ auditId: "audit-100", outcome: { kind: "skipped", slotNumber: null } }]);
});

test("does not reserve or patch when a newer webhook invalidated its lease after final history validation", async () => {
  const { store, amo, calls } = fixture({
    store: { isWatchClaimCurrent: async () => false },
  });
  const worker = createLeadInactivityWorker({ store, amo, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 0, deferred: 1, uncertain: 0, failed: 0 });
  assert.equal(calls.reserve.length, 0);
  assert.equal(calls.move.length, 0);
  assert.deepEqual(calls.completeAudit, [{ auditId: "audit-100", outcome: { kind: "skipped", slotNumber: null } }]);
});

test("cancels the mutation when webhook activity invalidates the durable fence immediately before PATCH", async () => {
  const { store, amo, calls } = fixture({
    store: { isMoveMutationCurrent: async () => false },
    amo: {
      moveLeadToTarget: async (_leadId, _target, hooks) => {
        calls.move.push(100);
        assert.equal(await hooks.isMoveMutationCurrent(), false);
        return { kind: "not_moved", reason: "fence_cancelled", lead: lead() };
      },
    },
  });
  const worker = createLeadInactivityWorker({ store, amo, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 0, deferred: 1, uncertain: 0, failed: 0 });
  assert.deepEqual(calls.releaseSlot, [{ slotNumber: 1, auditId: "audit-100" }]);
  assert.deepEqual(calls.finish, []);
  assert.deepEqual(calls.completeAudit, [{ auditId: "audit-100", outcome: { kind: "skipped", slotNumber: null } }]);
});

test("turns an ambiguous PATCH outcome into durable slot and watch uncertainty", async () => {
  const { store, amo, calls } = fixture({
    amo: {
      moveLeadToTarget: async () => ({ kind: "uncertain", error: { kind: "network", status: null, code: null, message: "unknown" }, readback: null }),
    },
  });
  const worker = createLeadInactivityWorker({ store, amo, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 0, deferred: 0, uncertain: 1, failed: 0 });
  assert.deepEqual(calls.uncertainSlot, [{ slotNumber: 1, auditId: "audit-100" }]);
  assert.deepEqual(calls.finish, [{ leadId: 100, state: "uncertain", reason: "amoCRM mutation outcome is uncertain" }]);
  assert.deepEqual(calls.completeAudit, [{ auditId: "audit-100", outcome: { kind: "uncertain", slotNumber: 1 } }]);
});

test("marks slot, watch, and audit uncertain when amoCRM confirms a move but durable slot confirmation fails", async () => {
  const { store, amo, calls } = fixture({
    store: { confirmTestSlot: async () => { throw new Error("database unavailable"); } },
  });
  const worker = createLeadInactivityWorker({ store, amo, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 0, deferred: 0, uncertain: 0, failed: 1 });
  assert.deepEqual(calls.releaseSlot, []);
  assert.deepEqual(calls.uncertainSlot, [{ slotNumber: 1, auditId: "audit-100" }]);
  assert.deepEqual(calls.finish, [{ leadId: 100, state: "uncertain", reason: "worker could not safely finalize a confirmed amoCRM movement" }]);
  assert.deepEqual(calls.completeAudit, [{ auditId: "audit-100", outcome: { kind: "uncertain", slotNumber: 1 } }]);
});

test("never releases a confirmed capacity slot if only final audit persistence fails", async () => {
  const { store, amo, calls } = fixture({
    store: {
      completeMoveAudit: async (auditId, outcome) => {
        calls.completeAudit.push({ auditId, outcome });
        if (outcome.kind === "confirmed") throw new Error("audit write failed");
      },
    },
  });
  const worker = createLeadInactivityWorker({ store, amo, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 0, deferred: 0, uncertain: 0, failed: 1 });
  assert.deepEqual(calls.releaseSlot, []);
  assert.deepEqual(calls.finish, [{ leadId: 100, state: "moved", reason: null }]);
  assert.deepEqual(calls.completeAudit, [
    { auditId: "audit-100", outcome: { kind: "confirmed", slotNumber: 1 } },
    { auditId: "audit-100", outcome: { kind: "confirmed", slotNumber: 1 } },
  ]);
});

test("returns a failed result and releases only the lease when durable audit creation fails before any mutation", async () => {
  const { store, amo, calls } = fixture({
    store: { createMoveAudit: async () => { throw new Error("database unavailable"); } },
  });
  const worker = createLeadInactivityWorker({ store, amo, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 0, deferred: 0, uncertain: 0, failed: 1 });
  assert.deepEqual(calls.finish, [{ leadId: 100, state: "watching", reason: "worker failed before a confirmed movement" }]);
  assert.equal(calls.reserve.length, 0);
  assert.equal(calls.move.length, 0);
});

test("marks an existing watch outside scope when the fresh amoCRM lead leaves the stage whitelist", async () => {
  const { store, amo, calls } = fixture({
    amo: { readLead: async (leadId) => lead(leadId, { statusId: 87347062 }) },
  });
  const worker = createLeadInactivityWorker({ store, amo, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 0, deferred: 1, uncertain: 0, failed: 0 });
  assert.deepEqual(calls.finish, [{ leadId: 100, state: "outside_scope", reason: "fresh amoCRM lead is no longer eligible" }]);
  assert.equal(calls.reserve.length, 0);
  assert.equal(calls.move.length, 0);
  assert.deepEqual(calls.completeAudit, [{ auditId: "audit-100", outcome: { kind: "skipped", slotNumber: null } }]);
});

test("prioritizes OZHOP, then qualified, then taken-in-work even when lower stages are older", async () => {
  const priorityQueries = [];
  const claimed = new Map([
    [301, watch(301, { pipelineId: 6909890, statusId: 58160902, dueAt: new Date("2026-07-19T11:55:00.000Z") })],
    [302, watch(302, { pipelineId: 9055778, statusId: 72919958, dueAt: new Date("2026-07-19T11:50:00.000Z") })],
    [201, watch(201, { pipelineId: 6909890, statusId: 58160726, dueAt: new Date("2026-07-19T11:40:00.000Z") })],
    [202, watch(202, { pipelineId: 9055778, statusId: 72917586, dueAt: new Date("2026-07-19T11:39:00.000Z") })],
    [101, watch(101, { pipelineId: 6909890, statusId: 58160718, dueAt: new Date("2026-07-19T11:30:00.000Z") })],
    [102, watch(102, { pipelineId: 9055778, statusId: 72917582, dueAt: new Date("2026-07-19T11:29:00.000Z") })],
  ]);
  const { store, amo, calls } = fixture({
    claimed,
    store: {
      listDueWatchLeadIds: async (_now, limit, stagePairs) => {
        priorityQueries.push({ limit, stagePairs });
        return [...claimed.values()]
          .filter((claimedWatch) => stagePairs.some((stage) => (
            stage.pipelineId === claimedWatch.pipelineId && stage.statusId === claimedWatch.statusId
          )))
          .sort((left, right) => left.dueAt - right.dueAt || left.leadId - right.leadId)
          .slice(0, limit)
          .map((claimedWatch) => claimedWatch.leadId);
      },
    },
    amo: {
      readLead: async (leadId) => {
        const claimedWatch = claimed.get(leadId);
        return lead(leadId, { pipelineId: claimedWatch.pipelineId, statusId: claimedWatch.statusId });
      },
    },
  });
  const worker = createLeadInactivityWorker({ store, amo, testingMode: false, clock: () => NOW, randomId: () => "audit" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 5, claimed: 5, moved: 5, deferred: 0, uncertain: 0, failed: 0 });
  assert.deepEqual(calls.claim, [302, 301, 202, 201, 102]);
  assert.deepEqual(priorityQueries, [
    { limit: 5, stagePairs: [
      { pipelineId: 6909890, statusId: 58160902 },
      { pipelineId: 9055778, statusId: 72919958 },
    ] },
    { limit: 3, stagePairs: [
      { pipelineId: 6909890, statusId: 58160726 },
      { pipelineId: 9055778, statusId: 72917586 },
    ] },
    { limit: 1, stagePairs: [
      { pipelineId: 6909890, statusId: 58160718 },
      { pipelineId: 9055778, statusId: 72917582 },
    ] },
  ]);
});

test("falls through to qualified and taken-in-work only when higher priority groups have no due watches", async () => {
  const priorityQueries = [];
  const claimed = new Map([
    [201, watch(201, { pipelineId: 6909890, statusId: 58160726 })],
    [101, watch(101, { pipelineId: 6909890, statusId: 58160718 })],
    [102, watch(102, { pipelineId: 9055778, statusId: 72917582 })],
  ]);
  const idsByStage = new Map([
    ["6909890:58160726", [201]],
    ["6909890:58160718", [101]], ["9055778:72917582", [102]],
  ]);
  const { store, amo, calls } = fixture({
    claimed,
    store: {
      listDueWatchLeadIds: async (_now, limit, stagePairs) => {
        priorityQueries.push({ limit, stagePairs });
        return stagePairs.flatMap((stage) => idsByStage.get(`${stage.pipelineId}:${stage.statusId}`) ?? []).slice(0, limit);
      },
    },
    amo: {
      readLead: async (leadId) => {
        const claimedWatch = claimed.get(leadId);
        return lead(leadId, { pipelineId: claimedWatch.pipelineId, statusId: claimedWatch.statusId });
      },
    },
  });
  const worker = createLeadInactivityWorker({ store, amo, testingMode: false, clock: () => NOW, randomId: () => "audit" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 3, claimed: 3, moved: 3, deferred: 0, uncertain: 0, failed: 0 });
  assert.deepEqual(calls.claim, [201, 101, 102]);
  assert.deepEqual(priorityQueries.map(({ limit, stagePairs }) => ({ limit, statusIds: stagePairs.map((stage) => stage.statusId) })), [
    { limit: 5, statusIds: [58160902, 72919958] },
    { limit: 5, statusIds: [58160726, 72917586] },
    { limit: 4, statusIds: [58160718, 72917582] },
  ]);
});

test("does not let a second replica move a lower-priority watch while the first is processing OZHOP", async () => {
  const claimed = new Map([
    [301, watch(301, { pipelineId: 6909890, statusId: 58160902, dueAt: new Date("2026-07-19T11:58:00.000Z") })],
    [101, watch(101, { pipelineId: 6909890, statusId: 58160718, dueAt: new Date("2026-07-19T11:59:00.000Z") })],
  ]);
  const claimedIds = new Set();
  const workerLease = { token: null };
  let markOzhopReadStarted;
  let allowOzhopRead;
  const ozhopReadStarted = new Promise((resolve) => { markOzhopReadStarted = resolve; });
  const ozhopReadCanFinish = new Promise((resolve) => { allowOzhopRead = resolve; });
  const { store, amo, calls } = fixture({
    claimed,
    store: {
      tryAcquireWorkerRunLease: async (token) => {
        if (workerLease.token) return false;
        workerLease.token = token;
        return true;
      },
      renewWorkerRunLease: async (token) => workerLease.token === token,
      releaseWorkerRunLease: async (token) => {
        if (workerLease.token !== token) return false;
        workerLease.token = null;
        return true;
      },
      listDueWatchLeadIds: async (_now, limit, stagePairs) => [...claimed.values()]
        .filter((claimedWatch) => !claimedIds.has(claimedWatch.leadId))
        .filter((claimedWatch) => !stagePairs?.length || stagePairs.some((stage) => (
          stage.pipelineId === claimedWatch.pipelineId && stage.statusId === claimedWatch.statusId
        )))
        .sort((left, right) => left.dueAt - right.dueAt || left.leadId - right.leadId)
        .slice(0, limit)
        .map((claimedWatch) => claimedWatch.leadId),
      claimDueWatchForWorkerRun: async (leadId, workerRunToken) => {
        if (workerLease.token !== workerRunToken || claimedIds.has(leadId)) return null;
        claimedIds.add(leadId);
        return claimed.get(leadId) ?? null;
      },
    },
    amo: {
      readLead: async (leadId) => {
        const claimedWatch = claimed.get(leadId);
        if (leadId === 301) {
          markOzhopReadStarted();
          await ozhopReadCanFinish;
        }
        return lead(leadId, { pipelineId: claimedWatch.pipelineId, statusId: claimedWatch.statusId });
      },
    },
  });
  let firstId = 0;
  let secondId = 0;
  const first = createLeadInactivityWorker({
    store,
    amo,
    testingMode: false,
    clock: () => NOW,
    randomId: () => `first-${++firstId}`,
  });
  const second = createLeadInactivityWorker({
    store,
    amo,
    testingMode: false,
    clock: () => NOW,
    randomId: () => `second-${++secondId}`,
  });

  const firstRun = first.runOnce();
  await ozhopReadStarted;
  const secondResult = await second.runOnce();

  assert.deepEqual(secondResult, { scanned: 0, claimed: 0, moved: 0, deferred: 0, uncertain: 0, failed: 0 });
  assert.deepEqual(calls.move, []);

  allowOzhopRead();
  const firstResult = await firstRun;
  assert.deepEqual(firstResult, { scanned: 2, claimed: 2, moved: 2, deferred: 0, uncertain: 0, failed: 0 });
});

test("does not claim a preselected lower-priority watch after a replacement owner takes the expired run lease", async () => {
  const claimed = new Map([
    [301, watch(301, { pipelineId: 6909890, statusId: 58160902 })],
    [101, watch(101, { pipelineId: 6909890, statusId: 58160718 })],
  ]);
  const workerLease = { token: null };
  let markOzhopReadStarted;
  let allowOzhopRead;
  const ozhopReadStarted = new Promise((resolve) => { markOzhopReadStarted = resolve; });
  const ozhopReadCanFinish = new Promise((resolve) => { allowOzhopRead = resolve; });
  const { store, amo, calls } = fixture({
    claimed,
    store: {
      tryAcquireWorkerRunLease: async (token) => {
        if (workerLease.token) return false;
        workerLease.token = token;
        return true;
      },
      renewWorkerRunLease: async (token) => workerLease.token === token,
      releaseWorkerRunLease: async (token) => {
        if (workerLease.token !== token) return false;
        workerLease.token = null;
        return true;
      },
      listDueWatchLeadIds: async (_now, limit, stagePairs) => [...claimed.values()]
        .filter((claimedWatch) => stagePairs.some((stage) => (
          stage.pipelineId === claimedWatch.pipelineId && stage.statusId === claimedWatch.statusId
        )))
        .slice(0, limit)
        .map((claimedWatch) => claimedWatch.leadId),
      claimDueWatchForWorkerRun: async (leadId, workerRunToken) => {
        if (workerLease.token !== workerRunToken) return null;
        calls.claim.push(leadId);
        return claimed.get(leadId) ?? null;
      },
    },
    amo: {
      readLead: async (leadId) => {
        const claimedWatch = claimed.get(leadId);
        if (leadId === 301) {
          markOzhopReadStarted();
          await ozhopReadCanFinish;
        }
        return lead(leadId, { pipelineId: claimedWatch.pipelineId, statusId: claimedWatch.statusId });
      },
    },
  });
  let id = 0;
  const worker = createLeadInactivityWorker({
    store,
    amo,
    testingMode: false,
    clock: () => NOW,
    randomId: () => `first-${++id}`,
  });

  const firstRun = worker.runOnce();
  await ozhopReadStarted;
  workerLease.token = "replacement-owner-after-expiry";
  allowOzhopRead();

  assert.deepEqual(await firstRun, { scanned: 2, claimed: 1, moved: 0, deferred: 1, uncertain: 0, failed: 0 });
  assert.deepEqual(calls.claim, [301]);
  assert.deepEqual(calls.move, []);
});

test("caps each one-minute pass before claiming more than five due watches", async () => {
  const { store, amo, calls } = fixture({
    store: {
      listDueWatchLeadIds: async (_now, limit) => {
        calls.list += 1;
        assert.equal(limit, 5);
        return [100, 101, 102, 103, 104];
      },
      claimDueWatchForWorkerRun: async (leadId) => {
        calls.claim.push(leadId);
        return watch(leadId);
      },
    },
  });
  const worker = createLeadInactivityWorker({ store, amo, clock: () => NOW, randomId: () => "audit" });

  const result = await worker.runOnce();

  assert.equal(result.scanned, 5);
  assert.equal(calls.claim.length, 5);
});

test("emits an admin notification after a confirmed testing move", async () => {
  const { store, amo } = fixture();
  const notifications = [];
  const worker = createLeadInactivityWorker({
    store,
    amo,
    clock: () => NOW,
    randomId: () => "audit-100",
    notifyAdmins: async (text) => { notifications.push(text); },
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 1, deferred: 0, uncertain: 0, failed: 0 });
  assert.deepEqual(notifications, [
    "✅ Тестовое перемещение по неактивности\nСделка: #100\nТестовый слот: 1/5",
  ]);
});

test("refuses unrestricted production movement until the durable baseline is complete", async () => {
  const { store, amo, calls } = fixture({
    store: { isProductionBaselineComplete: async () => false },
  });
  const worker = createLeadInactivityWorker({ store, amo, testingMode: false, clock: () => NOW, randomId: () => "audit-100" });

  await assert.rejects(worker.runOnce(), /production baseline is not complete/);

  assert.equal(calls.releaseLeases, 0);
  assert.equal(calls.list, 0);
  assert.deepEqual(calls.claim, []);
});

test("moves an unrestricted production watch without creating or consuming a test slot", async () => {
  const { store, amo, calls } = fixture();
  const notifications = [];
  const worker = createLeadInactivityWorker({
    store,
    amo,
    testingMode: false,
    clock: () => NOW,
    randomId: () => "audit-100",
    notifyAdmins: async (text) => { notifications.push(text); },
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 1, deferred: 0, uncertain: 0, failed: 0 });
  assert.equal(calls.ensureSlots, 0);
  assert.deepEqual(calls.reserve, []);
  assert.deepEqual(calls.confirm, []);
  assert.deepEqual(calls.releaseSlot, []);
  assert.deepEqual(calls.completeAudit, [{ auditId: "audit-100", outcome: { kind: "confirmed", slotNumber: null } }]);
  assert.deepEqual(notifications, ["✅ Перемещение по неактивности\nСделка: #100"]);
});

test("marks an unrestricted production move uncertain without touching test-slot capacity", async () => {
  const { store, amo, calls } = fixture({
    amo: {
      moveLeadToTarget: async () => ({ kind: "uncertain", error: { kind: "network", status: null, code: null, message: "unknown" }, readback: null }),
    },
  });
  const worker = createLeadInactivityWorker({ store, amo, testingMode: false, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 0, deferred: 0, uncertain: 1, failed: 0 });
  assert.equal(calls.ensureSlots, 0);
  assert.deepEqual(calls.reserve, []);
  assert.deepEqual(calls.uncertainSlot, []);
  assert.deepEqual(calls.completeAudit, [{ auditId: "audit-100", outcome: { kind: "uncertain", slotNumber: null } }]);
});

test("never requeues an unrestricted production watch after a confirmed amoCRM move cannot be durably finalized", async () => {
  const { store, amo, calls } = fixture({
    store: {
      finishWatchClaim: async (claimedWatch, state, reason) => {
        calls.finish.push({ leadId: claimedWatch.leadId, state, reason });
        if (state === "moved") throw new Error("simulated finalization failure");
      },
    },
  });
  const worker = createLeadInactivityWorker({ store, amo, testingMode: false, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 0, deferred: 0, uncertain: 1, failed: 0 });
  assert.equal(calls.ensureSlots, 0);
  assert.deepEqual(calls.reserve, []);
  assert.deepEqual(calls.finish.map(({ state }) => state), ["moved", "uncertain"]);
  assert.deepEqual(calls.completeAudit.at(-1).outcome, { kind: "uncertain", slotNumber: null });
});

test("retains a confirmed production audit outcome when its first durable audit write fails", async () => {
  const { store, amo, calls } = fixture({
    store: {
      completeMoveAudit: async (auditId, outcome) => {
        calls.completeAudit.push({ auditId, outcome });
        if (outcome.kind === "confirmed" && calls.completeAudit.filter((entry) => entry.outcome.kind === "confirmed").length === 1) {
          throw new Error("simulated audit failure");
        }
      },
    },
  });
  const worker = createLeadInactivityWorker({ store, amo, testingMode: false, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 1, deferred: 0, uncertain: 0, failed: 0 });
  assert.deepEqual(calls.finish.map(({ state }) => state), ["moved"]);
  assert.deepEqual(calls.completeAudit.map(({ outcome }) => outcome), [
    { kind: "confirmed", slotNumber: null },
    { kind: "confirmed", slotNumber: null },
  ]);
});

test("queues at the cap and rechecks later-day activity", async () => {
  let available = false;
  let now = NOW;
  const fresh = new Date("2026-07-20T12:00:00.000Z");
  const { store, amo, calls } = fixture({
    store: { hasDailyMovementCapacity: async (day, limit) => {
      calls.hasDailyCapacity.push({ bucketDate: day, limit });
      return available;
    } },
    amo: {
      readLead: async (leadId) => {
        calls.readLead.push(leadId);
        return lead(leadId, { updatedAt: fresh });
      },
      readLeadHistory: async (leadId) => {
        calls.readHistory.push(leadId);
        return [{ id: "fresh-touch", entityType: "lead", entityId: leadId, createdAt: fresh, type: 1, raw: {} }];
      },
    },
  });
  const worker = createLeadInactivityWorker({ store, amo, testingMode: false, clock: () => now, randomId: () => "audit-100" });

  assert.deepEqual(await worker.runOnce(), { scanned: 0, claimed: 0, moved: 0, deferred: 0, uncertain: 0, failed: 0 });
  assert.deepEqual(calls.readLead, []);
  available = true;
  now = new Date("2026-07-20T12:00:01.000Z");

  const later = await worker.runOnce();
  assert.equal(later.moved, 0);
  assert.equal(calls.readLead.length, 1);
  assert.equal(calls.readHistory.length, 1);
  assert.deepEqual(calls.move, []);
});

test("requeues a move when its reserved Almaty-day slot crosses midnight before PATCH", async () => {
  let clockCalls = 0;
  const initialNow = new Date("2026-07-19T18:59:59.900Z");
  const reservedAt = new Date("2026-07-19T18:59:59.999Z");
  const crossedMidnight = new Date("2026-07-19T19:00:00.001Z");
  const { store, amo, calls } = fixture();
  const worker = createLeadInactivityWorker({
    store,
    amo,
    testingMode: false,
    clock: () => {
      clockCalls += 1;
      if (clockCalls <= 3) return initialNow;
      return clockCalls === 4 ? reservedAt : crossedMidnight;
    },
    randomId: () => "audit-100",
  });

  const result = await worker.runOnce();
  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 0, deferred: 1, uncertain: 0, failed: 0 });
  assert.deepEqual(calls.move, []);
  assert.deepEqual(calls.reserveDailySlot.map(({ bucketDate }) => bucketDate), ["2026-07-19"]);
  assert.deepEqual(calls.releaseDailySlot.map(({ bucketDate }) => bucketDate), ["2026-07-19"]);
  assert.equal(calls.finish.some(({ state }) => state === "watching"), true);
});

test("reserves a post-midnight Almaty move against the new calendar day", async () => {
  let clockCalls = 0;
  const beforeMidnight = new Date("2026-07-19T18:59:59.900Z");
  const afterMidnight = new Date("2026-07-19T19:00:00.100Z");
  const { store, amo, calls } = fixture();
  const worker = createLeadInactivityWorker({
    store,
    amo,
    testingMode: false,
    clock: () => (++clockCalls === 1 ? beforeMidnight : afterMidnight),
    randomId: () => "audit-100",
  });

  const result = await worker.runOnce();
  assert.equal(result.moved, 1);
  assert.deepEqual(calls.ensureDailySlots, [
    { bucketDate: "2026-07-19", limit: 50 },
    { bucketDate: "2026-07-20", limit: 50 },
  ]);
  assert.deepEqual(calls.reserveDailySlot.map(({ bucketDate }) => bucketDate), ["2026-07-20"]);
});

test("resets production capacity at 14:00 Almaty into a fresh 100-slot operational bucket", async () => {
  const atOperationalBoundary = new Date("2026-08-05T09:00:00.000Z");
  const { store, amo, calls } = fixture();
  const worker = createLeadInactivityWorker({
    store,
    amo,
    testingMode: false,
    clock: () => atOperationalBoundary,
    randomId: () => "audit-100",
  });

  const result = await worker.runOnce();

  assert.equal(result.moved, 1);
  assert.deepEqual(calls.ensureDailySlots, [{ bucketDate: "operational:2026-08-05", limit: 100 }]);
  assert.deepEqual(calls.reserveDailySlot, [{ bucketDate: "operational:2026-08-05", leadId: 100, auditId: "audit-100" }]);
  assert.deepEqual(calls.confirmDailySlot, [{ bucketDate: "operational:2026-08-05", slotNumber: 1, auditId: "audit-100" }]);
});

test("stops claiming the remaining batch as soon as the final daily slot is consumed", async () => {
  let capacityChecks = 0;
  const { store, amo, calls } = fixture({
    claimed: [[100, watch(100)], [101, watch(101)]],
    store: { hasDailyMovementCapacity: async () => ++capacityChecks === 1 },
  });
  const worker = createLeadInactivityWorker({
    store, amo, testingMode: false, maxWatchesPerRun: 2, clock: () => NOW, randomId: () => "audit-100",
  });

  const result = await worker.runOnce();
  assert.equal(result.moved, 1);
  assert.deepEqual(calls.claim, [100]);
  assert.deepEqual(calls.readLead, [100]);
  assert.deepEqual(calls.move, [100]);
});

test("reserves and confirms one durable Almaty-day capacity slot around an unrestricted move", async () => {
  const { store, amo, calls } = fixture();
  const worker = createLeadInactivityWorker({ store, amo, testingMode: false, clock: () => NOW, randomId: () => "audit-100" });

  const result = await worker.runOnce();

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 1, deferred: 0, uncertain: 0, failed: 0 });
  assert.deepEqual(calls.reserveDailySlot, [{ bucketDate: "2026-07-19", leadId: 100, auditId: "audit-100" }]);
  assert.deepEqual(calls.confirmDailySlot, [{ bucketDate: "2026-07-19", slotNumber: 1, auditId: "audit-100" }]);
  assert.deepEqual(calls.releaseDailySlot, []);
  assert.deepEqual(calls.uncertainDailySlot, []);
});

test("does not turn a confirmed move into a failure when admin notification fails", async () => {
  const { store, amo } = fixture();
  let notificationAttempts = 0;
  const worker = createLeadInactivityWorker({
    store,
    amo,
    clock: () => NOW,
    randomId: () => "audit-100",
    notifyAdmins: async () => {
      notificationAttempts += 1;
      throw new Error("telegram unavailable");
    },
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await worker.runOnce();
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(result, { scanned: 1, claimed: 1, moved: 1, deferred: 0, uncertain: 0, failed: 0 });
  assert.equal(notificationAttempts, 1);
});
