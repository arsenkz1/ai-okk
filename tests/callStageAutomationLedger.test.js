const test = require("node:test");
const assert = require("node:assert/strict");

const { createCallStageAutomationLedger } = require("../dist/services/callStageAutomationLedger");

const now = new Date("2026-08-04T10:00:00.000Z");
const moveProposal = {
  decision: "move",
  target: "qualified",
  evidence: "Mijoz kursga qiziqishini va davom etishga tayyorligini aniq tasdiqladi.",
};

function makeAction(id, input) {
  return {
    id,
    callId: input.callId,
    dealId: input.dealId,
    testMode: input.testMode,
    status: "analyzing",
    decision: null,
    target: null,
    evidence: null,
    checkedFields: null,
    missingFields: null,
    amoNoteId: null,
    failureReason: null,
    analysisLeaseToken: input.analysisLeaseToken,
    analysisLeaseExpiresAt: input.analysisLeaseExpiresAt,
    analysisLeaseGeneration: 1,
    mutationLeaseToken: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function makePersistence() {
  const actions = new Map();
  const byCall = new Map();
  const clone = (action) => ({ ...action, checkedFields: action.checkedFields && [...action.checkedFields], missingFields: action.missingFields && action.missingFields.map((field) => ({ ...field })) });
  const persistence = {
    async getActionByCall(callId) {
      const id = byCall.get(callId);
      return id ? clone(actions.get(id)) : null;
    },
    async createActionIfAbsent(input) {
      const existingId = byCall.get(input.callId);
      if (existingId) return { created: false, action: clone(actions.get(existingId)) };
      const action = makeAction(input.id, input);
      actions.set(action.id, action);
      byCall.set(action.callId, action.id);
      return { created: true, action: clone(action) };
    },
    async reclaimExpiredAnalysis(actionId, nowValue, token, expiresAt) {
      const action = actions.get(actionId);
      if (!action || action.status !== "analyzing" || !action.analysisLeaseExpiresAt || action.analysisLeaseExpiresAt > nowValue) return null;
      Object.assign(action, { analysisLeaseToken: token, analysisLeaseExpiresAt: expiresAt, analysisLeaseGeneration: action.analysisLeaseGeneration + 1, updatedAt: nowValue });
      return clone(action);
    },
    async finalizeAnalysis(actionId, leaseToken, update, nowValue) {
      const action = actions.get(actionId);
      if (!action || action.status !== "analyzing" || action.analysisLeaseToken !== leaseToken) return null;
      Object.assign(action, update, { analysisLeaseToken: null, analysisLeaseExpiresAt: null, updatedAt: nowValue });
      return clone(action);
    },
    async claimMove(actionId, leaseToken, nowValue) {
      const action = actions.get(actionId);
      if (!action || action.status !== "pending_move") return null;
      Object.assign(action, { status: "moving", mutationLeaseToken: leaseToken, updatedAt: nowValue });
      return clone(action);
    },
    async isMoveCurrent(actionId, leaseToken) {
      const action = actions.get(actionId);
      return Boolean(action && action.status === "moving" && action.mutationLeaseToken === leaseToken);
    },
    async markBlockedMissingFields(actionId, leaseToken, missingFields, nowValue) {
      const action = actions.get(actionId);
      if (!action || action.status !== "pending_move" || action.mutationLeaseToken !== leaseToken) return null;
      Object.assign(action, { status: "blocked_missing_fields", missingFields, updatedAt: nowValue });
      return clone(action);
    },
    async markMoveConfirmed(actionId, leaseToken, checkedFields, noteId, nowValue) {
      const action = actions.get(actionId);
      if (!action || action.status !== "moving" || action.mutationLeaseToken !== leaseToken) return null;
      Object.assign(action, { status: "confirmed", checkedFields, amoNoteId: noteId, updatedAt: nowValue });
      return clone(action);
    },
    async markMoveSkipped(actionId, leaseToken, reason, nowValue) {
      const action = actions.get(actionId);
      if (!action || action.status !== "moving" || action.mutationLeaseToken !== leaseToken) return null;
      Object.assign(action, { status: "skipped", failureReason: reason, updatedAt: nowValue });
      return clone(action);
    },
    async markMoveUncertain(actionId, leaseToken, reason, nowValue) {
      const action = actions.get(actionId);
      if (!action || action.status !== "moving" || action.mutationLeaseToken !== leaseToken) return null;
      Object.assign(action, { status: "uncertain", failureReason: reason, updatedAt: nowValue });
      return clone(action);
    },
  };
  return { persistence, actions };
}

test("one completed call receives one durable analysis lease and only the latest lease can finalize it", async () => {
  let tokenNo = 0;
  const { persistence } = makePersistence();
  const ledger = createCallStageAutomationLedger(persistence, {
    id: () => "stage-action-1",
    token: () => `lease-${++tokenNo}`,
    analysisLeaseMs: 60_000,
  });

  const first = await ledger.claimAnalysis({ callId: 10, dealId: 100, testMode: true, now });
  const duplicate = await ledger.claimAnalysis({ callId: 10, dealId: 100, testMode: true, now });
  assert.equal(first.kind, "claimed");
  assert.equal(duplicate.kind, "existing");

  const later = new Date(now.getTime() + 60_001);
  const reclaimed = await ledger.claimAnalysis({ callId: 10, dealId: 100, testMode: true, now: later });
  assert.equal(reclaimed.kind, "claimed");
  assert.equal(await ledger.finalizeAnalysis({ actionId: first.action.id, leaseToken: first.leaseToken, proposal: moveProposal, now: later }), null);
  assert.equal((await ledger.finalizeAnalysis({ actionId: reclaimed.action.id, leaseToken: reclaimed.leaseToken, proposal: moveProposal, now: later })).status, "pending_move");
});

test("an uncertain call is durably reviewable without exposing a target mutation", async () => {
  const { persistence } = makePersistence();
  const ledger = createCallStageAutomationLedger(persistence, { id: () => "stage-action-1", token: () => "lease-1" });
  const claimed = await ledger.claimAnalysis({ callId: 10, dealId: 100, testMode: true, now });
  const finalized = await ledger.finalizeAnalysis({
    actionId: claimed.action.id,
    leaseToken: claimed.leaseToken,
    proposal: { decision: "review", target: null, evidence: "Mijozning niyati aniq emas." },
    now,
  });
  assert.equal(finalized.status, "review");
  assert.equal(await ledger.claimMove({ actionId: finalized.id, now }), null);
});

test("only one move claim can mutate a clear action and uncertainty never becomes retryable", async () => {
  let tokenNo = 0;
  const { persistence } = makePersistence();
  const ledger = createCallStageAutomationLedger(persistence, { id: () => "stage-action-1", token: () => `token-${++tokenNo}` });
  const claimed = await ledger.claimAnalysis({ callId: 10, dealId: 100, testMode: true, now });
  const pending = await ledger.finalizeAnalysis({ actionId: claimed.action.id, leaseToken: claimed.leaseToken, proposal: moveProposal, now });
  const [first, second] = await Promise.all([
    ledger.claimMove({ actionId: pending.id, now }),
    ledger.claimMove({ actionId: pending.id, now }),
  ]);
  const winner = first ?? second;
  assert.ok(winner);
  assert.equal(first === null || second === null, true);
  assert.equal(await ledger.isMoveCurrent({ actionId: winner.id, mutationLeaseToken: winner.mutationLeaseToken }), true);

  const uncertain = await ledger.markMoveUncertain({ actionId: winner.id, mutationLeaseToken: winner.mutationLeaseToken, reason: "amoCRM PATCH outcome is unknown", now });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(await ledger.claimMove({ actionId: winner.id, now }), null);
});
