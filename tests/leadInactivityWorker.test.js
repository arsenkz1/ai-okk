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
  const calls = { releaseLeases: 0, ensureSlots: 0, list: 0, claim: [], audit: [], completeAudit: [], reserve: [], confirm: [], releaseSlot: [], uncertainSlot: [], finish: [], record: [], move: [] };
  const claimed = new Map([[100, watch(100)]]);
  const store = {
    releaseExpiredWatchLeases: async () => { calls.releaseLeases += 1; },
    ensureTestSlots: async () => { calls.ensureSlots += 1; },
    listDueWatchLeadIds: async (_now, limit) => { calls.list += 1; return [...claimed.keys()].slice(0, limit); },
    claimDueWatch: async (leadId) => { calls.claim.push(leadId); return claimed.get(leadId) ?? null; },
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
    readLead: async (leadId) => lead(leadId),
    readLeadHistory: async () => [],
    moveLeadToTarget: async (leadId) => { calls.move.push(leadId); return { kind: "confirmed", lead: lead(leadId, { pipelineId: 9055770, statusId: 72917546 }) }; },
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
      moveLeadToTarget: async (_leadId, _target, beforePatch) => {
        calls.move.push(100);
        assert.equal(await beforePatch(), false);
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
  assert.deepEqual(calls.finish, [{ leadId: 100, state: "uncertain", reason: "worker could not safely release its reserved testing slot" }]);
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

test("caps each one-minute pass before claiming more than five due watches", async () => {
  const { store, amo, calls } = fixture({
    store: {
      listDueWatchLeadIds: async (_now, limit) => {
        calls.list += 1;
        assert.equal(limit, 5);
        return [100, 101, 102, 103, 104];
      },
      claimDueWatch: async (leadId) => {
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
