const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCallTaskAutomationLedger,
} = require("../dist/services/callTaskAutomationLedger");

function makeAction(id, input) {
  return {
    id,
    callId: input.callId,
    actionKind: "next_step",
    dealId: input.dealId,
    testMode: input.testMode,
    status: "analyzing",
    decision: null,
    taskText: null,
    evidence: null,
    proposedDueAt: null,
    selectedDueAt: null,
    responsibleUserId: null,
    amoTaskId: null,
    taskRequestId: null,
    noteText: null,
    amoNoteId: null,
    approvalToken: input.approvalToken,
    reviewedByTelegramUserId: null,
    reviewedAt: null,
    failureReason: null,
    analysisLeaseToken: input.analysisLeaseToken,
    analysisLeaseExpiresAt: input.analysisLeaseExpiresAt,
    analysisLeaseGeneration: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function makePersistence() {
  const actions = new Map();
  const byCall = new Map();
  const clone = (action) => ({ ...action });
  const persistence = {
    async getActionByCall(callId) {
      const id = byCall.get(callId);
      return id ? clone(actions.get(id)) : null;
    },
    async createActionIfAbsent(input) {
      const priorId = byCall.get(input.callId);
      if (priorId) return { created: false, action: clone(actions.get(priorId)) };
      const action = makeAction(input.id, input);
      actions.set(action.id, action);
      byCall.set(action.callId, action.id);
      return { created: true, action: clone(action) };
    },
    async reclaimExpiredAnalysis(actionId, now, token, expiresAt) {
      const action = actions.get(actionId);
      if (!action || action.status !== "analyzing" || !action.analysisLeaseExpiresAt || action.analysisLeaseExpiresAt > now) return null;
      action.analysisLeaseToken = token;
      action.analysisLeaseExpiresAt = expiresAt;
      action.analysisLeaseGeneration += 1;
      action.updatedAt = now;
      return clone(action);
    },
    async finalizeAnalysis(actionId, leaseToken, update, now) {
      const action = actions.get(actionId);
      if (!action || action.status !== "analyzing" || action.analysisLeaseToken !== leaseToken) return null;
      Object.assign(action, update, { analysisLeaseToken: null, analysisLeaseExpiresAt: null, updatedAt: now });
      return clone(action);
    },
    async claimTaskCreation(actionId, dueAt, reviewerTelegramUserId, now) {
      const action = actions.get(actionId);
      if (!action || action.status !== "proposed") return null;
      action.status = "creating_task";
      action.selectedDueAt = dueAt;
      action.taskRequestId = `call-task:${action.id}`;
      action.reviewedByTelegramUserId = reviewerTelegramUserId;
      action.reviewedAt = reviewerTelegramUserId ? now : null;
      action.updatedAt = now;
      return clone(action);
    },
    async markTaskConfirmed(actionId, taskId, responsibleUserId, now) {
      const action = actions.get(actionId);
      if (!action || action.status !== "creating_task") return null;
      Object.assign(action, { status: "task_confirmed", amoTaskId: taskId, responsibleUserId, updatedAt: now });
      return clone(action);
    },
    async markActionSkipped(actionId, expectedStatus, reason, now) {
      const action = actions.get(actionId);
      if (!action || action.status !== expectedStatus) return null;
      Object.assign(action, { status: "skipped", failureReason: reason, updatedAt: now });
      return clone(action);
    },
    async markActionUncertain(actionId, expectedStatuses, reason, now) {
      const action = actions.get(actionId);
      if (!action || !expectedStatuses.includes(action.status)) return null;
      Object.assign(action, { status: "uncertain", failureReason: reason, updatedAt: now });
      return clone(action);
    },
  };
  return { persistence, actions };
}

const now = new Date("2026-08-04T07:00:00.000Z");
const autoProposal = {
  decision: "auto",
  taskText: "Klientga kurs dasturini yuborish",
  deadlineAt: new Date("2026-08-05T10:00:00.000Z"),
  evidence: "Menejer ertaga soat 15:00 da yuborishga kelishdi",
};

test("one source call gets one durable analysis lease despite duplicate queue delivery", async () => {
  const { persistence } = makePersistence();
  const ledger = createCallTaskAutomationLedger(persistence, { analysisLeaseMs: 60_000, token: () => "lease-one", id: () => "action-one", approvalToken: () => "approval-one" });

  const first = await ledger.claimAnalysis({ callId: 10, dealId: 100, testMode: true, now });
  const duplicate = await ledger.claimAnalysis({ callId: 10, dealId: 100, testMode: true, now });

  assert.equal(first.kind, "claimed");
  assert.equal(first.action.id, "action-one");
  assert.equal(duplicate.kind, "existing");
  assert.equal(duplicate.action.id, "action-one");
});

test("an expired analysis lease can be reclaimed, but only its current token can finalize the proposal", async () => {
  let tokenNo = 0;
  const { persistence } = makePersistence();
  const ledger = createCallTaskAutomationLedger(persistence, {
    analysisLeaseMs: 60_000,
    token: () => `lease-${++tokenNo}`,
    id: () => "action-one",
    approvalToken: () => "approval-one",
  });
  const first = await ledger.claimAnalysis({ callId: 10, dealId: 100, testMode: false, now });
  const later = new Date(now.getTime() + 60_001);
  const reclaimed = await ledger.claimAnalysis({ callId: 10, dealId: 100, testMode: false, now: later });

  assert.equal(first.kind, "claimed");
  assert.equal(reclaimed.kind, "claimed");
  assert.notEqual(first.leaseToken, reclaimed.leaseToken);
  assert.equal(await ledger.finalizeAnalysis({ actionId: first.action.id, leaseToken: first.leaseToken, proposal: autoProposal, now: later }), null);
  const finalized = await ledger.finalizeAnalysis({ actionId: reclaimed.action.id, leaseToken: reclaimed.leaseToken, proposal: autoProposal, now: later });
  assert.equal(finalized.status, "proposed");
});

test("only one concurrent task claim may leave proposed state, and an ambiguous mutation never becomes retryable", async () => {
  const { persistence } = makePersistence();
  const ledger = createCallTaskAutomationLedger(persistence, { analysisLeaseMs: 60_000, token: () => "lease", id: () => "action-one", approvalToken: () => "approval-one" });
  const claim = await ledger.claimAnalysis({ callId: 10, dealId: 100, testMode: true, now });
  await ledger.finalizeAnalysis({ actionId: claim.action.id, leaseToken: claim.leaseToken, proposal: autoProposal, now });

  const [first, second] = await Promise.all([
    ledger.claimTaskCreation({ actionId: claim.action.id, dueAt: autoProposal.deadlineAt, reviewerTelegramUserId: null, now }),
    ledger.claimTaskCreation({ actionId: claim.action.id, dueAt: autoProposal.deadlineAt, reviewerTelegramUserId: "42", now }),
  ]);
  const winner = first ?? second;
  assert.ok(winner);
  assert.equal(winner.status, "creating_task");
  assert.equal(first === null || second === null, true);

  const uncertain = await ledger.markTaskUncertain(winner.id, "amoCRM task POST outcome is unknown", now);
  assert.equal(uncertain.status, "uncertain");
  assert.equal(await ledger.claimTaskCreation({ actionId: winner.id, dueAt: autoProposal.deadlineAt, reviewerTelegramUserId: null, now }), null);
});
