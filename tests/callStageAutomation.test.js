const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCallStageReasonNote,
  runCallStageAutomation,
} = require("../dist/services/callStageAutomation");

const now = new Date("2026-08-04T10:00:00.000Z");
const boundary = new Date("2026-08-04T09:00:00.000Z");
const qualificationFields = [
  [936095, "Kursga qiziqishdan maqsad nima?"], [936097, "Jinsi"], [936101, "Yoshi"], [936103, "Kurs"],
  [936105, "Nechanchi murojaat"], [940183, "Qayerdan bizni topdi?"], [967019, "Region"],
  [1026381, "Sotib olish ehtimoli"], [1038305, "Hozir nima ish qiladi?"], [1038307, "Bu yo'nalishda tajribasi bormi?"],
];

function configuredCustomFields() {
  return qualificationFields.map(([id, name]) => ({
    id,
    name,
    requiredStatuses: [{ pipelineId: 6909890, statusId: 58160726 }],
  }));
}

function lead({ statusId = 58160714, fields = new Map() } = {}) {
  return {
    id: 42,
    createdAt: new Date("2026-08-04T09:00:01.000Z"),
    updatedAt: now,
    pipelineId: 6909890,
    statusId,
    responsibleUserId: 99,
    name: "Test",
    fieldValues: fields,
  };
}

function action(overrides = {}) {
  return {
    id: "stage-action-1",
    callId: 10,
    dealId: 42,
    testMode: true,
    status: "analyzing",
    decision: null,
    target: null,
    evidence: null,
    checkedFields: null,
    missingFields: null,
    amoNoteId: null,
    failureReason: null,
    analysisLeaseToken: "analysis-lease",
    analysisLeaseExpiresAt: new Date(now.getTime() + 60_000),
    analysisLeaseGeneration: 1,
    mutationLeaseToken: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function baseDependencies(overrides = {}) {
  const current = action();
  return {
    enabled: true,
    testing: true,
    executionMode: "live",
    now: () => now,
    isLatestCompletedCall: async () => true,
    store: {
      async getActivationBoundary() { return boundary; },
      async getHistoryFenceActivationBoundary() { return boundary; },
      async reserveHistoryFenceTestMove() { return { kind: "reserved", slot: { slotNumber: 1 } }; },
      async confirmTestMove() { return { state: "confirmed" }; },
      async releaseTestMoveBeforePatch() { return true; },
      async markTestMoveUncertain() { return { state: "uncertain" }; },
    },
    ledger: {
      async claimAnalysis() { return { kind: "claimed", action: current, leaseToken: "analysis-lease" }; },
      async finalizeAnalysis(input) {
        return action({
          status: input.proposal.decision === "move" ? "pending_move" : input.proposal.decision === "review" ? "review" : "skipped",
          decision: input.proposal.decision,
          target: input.proposal.target,
          evidence: input.proposal.evidence,
          analysisLeaseToken: null,
          analysisLeaseExpiresAt: null,
        });
      },
      async claimMove() { return action({ status: "moving", decision: "move", target: "qualified", evidence: "Mijoz aniq qiziqdi.", mutationLeaseToken: "move-lease" }); },
      async isMoveCurrent() { return true; },
      async markBlockedMissingFields(input) { return action({ status: "blocked_missing_fields", missingFields: input.missingFields }); },
      async markMoveConfirmed(input) { return action({ status: "confirmed", checkedFields: input.checkedFields, amoNoteId: input.noteId }); },
      async markMoveSkipped(input) { return action({ status: "skipped", failureReason: input.reason }); },
      async markMoveUncertain(input) { return action({ status: "uncertain", failureReason: input.reason }); },
    },
    amo: {
      async readLead() { return lead(); },
      async getLeadCustomFields() { return configuredCustomFields(); },
      async hasRecentStageMovement() { return false; },
      async moveLeadToTarget() { return { kind: "confirmed", lead: lead({ statusId: 58160726 }) }; },
      async addStageReasonNote() { return { kind: "confirmed", noteId: 700 }; },
    },
    async analyze() { return { decision: "move", target: "qualified", evidence: "Mijoz aniq qiziqdi." }; },
    notifier: { async notify() {} },
    ...overrides,
  };
}

const input = {
  callId: 10,
  dealId: 42,
  callCreatedAt: new Date("2026-08-04T09:30:00.000Z"),
  callEndedAt: new Date("2026-08-04T09:29:00.000Z"),
  transcript: "Mijoz: kurs menga mos, davom etamiz.",
};

test("a clear target with missing amoCRM-required fields alerts admins and consumes no test move slot", async () => {
  let reserved = false;
  const alerts = [];
  const dependencies = baseDependencies({
    store: {
      async getActivationBoundary() { return boundary; },
      async getHistoryFenceActivationBoundary() { return boundary; },
      async reserveHistoryFenceTestMove() { reserved = true; return { kind: "reserved", slot: { slotNumber: 1 } }; },
      async confirmTestMove() { throw new Error("not expected"); },
      async releaseTestMoveBeforePatch() { throw new Error("not expected"); },
      async markTestMoveUncertain() { throw new Error("not expected"); },
    },
    amo: {
      async readLead() { return lead({ fields: new Map() }); },
      async getLeadCustomFields() { return configuredCustomFields(); },
      async moveLeadToTarget() { throw new Error("must not PATCH"); },
      async addStageReasonNote() { throw new Error("must not POST note"); },
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  });

  const result = await runCallStageAutomation(input, dependencies);
  assert.deepEqual(result, { kind: "missing_fields", actionId: "stage-action-1" });
  assert.equal(reserved, false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "missing_fields");
  assert.equal(alerts[0].targetName, "квалифицирован");
});

test("a clear eligible UZUM outcome reserves one test slot, moves once, verifies, notes, confirms capacity, and reports its result", async () => {
  const calls = { reserve: 0, confirm: 0, move: 0, note: 0 };
  const alerts = [];
  const allQualificationFields = new Map([
    [936095, ["Maqsad"]], [936097, ["Erkak"]], [936101, ["29"]], [936103, ["Kurs"]], [936105, ["Birinchi"]],
    [940183, ["Instagram"]], [967019, ["Toshkent"]], [1026381, ["yuqori"]], [1038305, ["Dizayner"]], [1038307, ["Ha"]],
  ]);
  const dependencies = baseDependencies({
    store: {
      async getActivationBoundary() { return boundary; },
      async getHistoryFenceActivationBoundary() { return boundary; },
      async reserveHistoryFenceTestMove() { calls.reserve += 1; return { kind: "reserved", slot: { slotNumber: 1 } }; },
      async confirmTestMove() { calls.confirm += 1; return { state: "confirmed" }; },
      async releaseTestMoveBeforePatch() { throw new Error("not expected"); },
      async markTestMoveUncertain() { throw new Error("not expected"); },
    },
    amo: {
      async readLead() { return lead({ fields: allQualificationFields }); },
      async getLeadCustomFields() { return configuredCustomFields(); },
      async hasRecentStageMovement() { return false; },
      async moveLeadToTarget(moveInput) {
        calls.move += 1;
        assert.deepEqual(moveInput.target, { pipelineId: 6909890, statusId: 58160726 });
        assert.equal(await moveInput.isMoveMutationCurrent(), true);
        assert.equal(await moveInput.isLeadEligibleForTarget(lead({ fields: allQualificationFields })), true);
        return { kind: "confirmed", lead: lead({ statusId: 58160726, fields: allQualificationFields }) };
      },
      async addStageReasonNote(noteInput) {
        calls.note += 1;
        assert.match(noteInput.text, /Этап: квалифицирован/);
        assert.match(noteInput.text, /Основание: Mijoz aniq qiziqdi\./);
        return { kind: "confirmed", noteId: 700 };
      },
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  });

  const result = await runCallStageAutomation(input, dependencies);
  assert.deepEqual(result, { kind: "confirmed", actionId: "stage-action-1", noteId: 700 });
  assert.deepEqual(calls, { reserve: 1, confirm: 1, move: 1, note: 1 });
  assert.deepEqual(alerts.map(({ kind, targetName }) => ({ kind, targetName })), [{ kind: "moved", targetName: "квалифицирован" }]);
});

test("a stage change during the prior thirty minutes is durably skipped before capacity or PATCH", async () => {
  let reservationCalled = false;
  let patchCalled = false;
  const alerts = [];
  const dependencies = baseDependencies({
    store: {
      async getActivationBoundary() { return boundary; },
      async getHistoryFenceActivationBoundary() { return boundary; },
      async reserveHistoryFenceTestMove() { reservationCalled = true; throw new Error("must not reserve"); },
      async confirmTestMove() { throw new Error("must not confirm"); },
      async releaseTestMoveBeforePatch() { throw new Error("must not release"); },
      async markTestMoveUncertain() { throw new Error("must not mark"); },
    },
    amo: {
      async readLead() { return lead({ fields: new Map(qualificationFields.map(([id]) => [id, ["filled"]])) }); },
      async getLeadCustomFields() { return configuredCustomFields(); },
      async hasRecentStageMovement(historyInput) {
        assert.equal(historyInput.leadId, 42);
        assert.equal(historyInput.since.getTime(), now.getTime() - 30 * 60 * 1_000);
        return true;
      },
      async moveLeadToTarget() { patchCalled = true; throw new Error("must not PATCH"); },
      async addStageReasonNote() { throw new Error("must not POST note"); },
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  });

  const result = await runCallStageAutomation(input, dependencies);
  assert.deepEqual(result, { kind: "recent_stage_movement", actionId: "stage-action-1" });
  assert.equal(reservationCalled, false);
  assert.equal(patchCalled, false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "recent_stage_movement");
});

test("a stage change discovered by the post-rate final fence cancels the move and frees its new-test slot", async () => {
  const allQualificationFields = new Map(qualificationFields.map(([id]) => [id, ["filled"]]));
  let historyChecks = 0;
  let released = 0;
  let patchSent = false;
  const alerts = [];
  const dependencies = baseDependencies({
    store: {
      async getActivationBoundary() { return boundary; },
      async getHistoryFenceActivationBoundary() { return boundary; },
      async reserveHistoryFenceTestMove() { return { kind: "reserved", slot: { slotNumber: 4 } }; },
      async confirmTestMove() { throw new Error("must not confirm"); },
      async releaseTestMoveBeforePatch() { released += 1; return true; },
      async markTestMoveUncertain() { throw new Error("must not mark uncertain"); },
    },
    amo: {
      async readLead() { return lead({ fields: allQualificationFields }); },
      async getLeadCustomFields() { return configuredCustomFields(); },
      async hasRecentStageMovement() { return ++historyChecks >= 2; },
      async moveLeadToTarget(moveInput) {
        if (!await moveInput.isMoveMutationCurrent()) {
          return { kind: "not_moved", reason: "fence_cancelled", lead: lead({ fields: allQualificationFields }) };
        }
        patchSent = true;
        throw new Error("must not PATCH");
      },
      async addStageReasonNote() { throw new Error("must not add a note"); },
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  });

  const result = await runCallStageAutomation(input, dependencies);
  assert.deepEqual(result, { kind: "recent_stage_movement", actionId: "stage-action-1" });
  assert.equal(historyChecks, 2);
  assert.equal(released, 1);
  assert.equal(patchSent, false);
  assert.deepEqual(alerts.map(({ kind }) => kind), ["recent_stage_movement"]);
});

test("a final stage-history read failure proves no PATCH and releases its new-test slot", async () => {
  const allQualificationFields = new Map(qualificationFields.map(([id]) => [id, ["filled"]]));
  let historyChecks = 0;
  let released = 0;
  let patchSent = false;
  const dependencies = baseDependencies({
    store: {
      async getActivationBoundary() { return boundary; },
      async getHistoryFenceActivationBoundary() { return boundary; },
      async reserveHistoryFenceTestMove() { return { kind: "reserved", slot: { slotNumber: 4 } }; },
      async confirmTestMove() { throw new Error("must not confirm"); },
      async releaseTestMoveBeforePatch() { released += 1; return true; },
      async markTestMoveUncertain() { throw new Error("must not mark uncertain"); },
    },
    amo: {
      async readLead() { return lead({ fields: allQualificationFields }); },
      async getLeadCustomFields() { return configuredCustomFields(); },
      async hasRecentStageMovement() {
        historyChecks += 1;
        if (historyChecks === 2) throw new Error("amoCRM history unavailable");
        return false;
      },
      async moveLeadToTarget(moveInput) {
        if (!await moveInput.isMoveMutationCurrent()) {
          return { kind: "not_moved", reason: "fence_cancelled", lead: lead({ fields: allQualificationFields }) };
        }
        patchSent = true;
        throw new Error("must not PATCH");
      },
      async addStageReasonNote() { throw new Error("must not add a note"); },
    },
  });

  const result = await runCallStageAutomation(input, dependencies);
  assert.deepEqual(result, { kind: "skipped", actionId: "stage-action-1" });
  assert.equal(historyChecks, 2);
  assert.equal(released, 1);
  assert.equal(patchSent, false);
});

test("an ambiguous latest call is a durable no-op and never alerts or claims movement capacity", async () => {
  let reservationCalled = false;
  const alerts = [];
  const dependencies = baseDependencies({
    async analyze() { return { decision: "review", target: null, evidence: "Mijozning niyati aniq emas." }; },
    store: {
      async getActivationBoundary() { return boundary; },
      async getHistoryFenceActivationBoundary() { return boundary; },
      async reserveHistoryFenceTestMove() { reservationCalled = true; throw new Error("must not reserve"); },
      async confirmTestMove() { throw new Error("must not confirm"); },
      async releaseTestMoveBeforePatch() { throw new Error("must not release"); },
      async markTestMoveUncertain() { throw new Error("must not mark"); },
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  });

  const result = await runCallStageAutomation(input, dependencies);
  assert.deepEqual(result, { kind: "review", actionId: "stage-action-1" });
  assert.equal(reservationCalled, false);
  assert.equal(alerts.length, 0);
});

test("only the latest completed call may enter routing", async () => {
  let analyzed = false;
  const dependencies = baseDependencies({
    isLatestCompletedCall: async () => false,
    async analyze() { analyzed = true; return { decision: "move", target: "qualified", evidence: "x" }; },
  });

  const result = await runCallStageAutomation(input, dependencies);
  assert.deepEqual(result, { kind: "not_latest_call" });
  assert.equal(analyzed, false);
});

test("a newly completed call cancels the stale action at the final mutation fence", async () => {
  let latestChecks = 0;
  let patchSent = false;
  const allQualificationFields = new Map(qualificationFields.map(([id]) => [id, ["filled"]]));
  const dependencies = baseDependencies({
    isLatestCompletedCall: async () => ++latestChecks === 1,
    amo: {
      async readLead() { return lead({ fields: allQualificationFields }); },
      async getLeadCustomFields() { return configuredCustomFields(); },
      async hasRecentStageMovement() { return false; },
      async moveLeadToTarget(moveInput) {
        if (!await moveInput.isMoveMutationCurrent()) {
          return { kind: "not_moved", reason: "fence_cancelled", lead: lead({ fields: allQualificationFields }) };
        }
        patchSent = true;
        return { kind: "confirmed", lead: lead({ statusId: 58160726, fields: allQualificationFields }) };
      },
      async addStageReasonNote() { throw new Error("must not add a note"); },
    },
  });

  const result = await runCallStageAutomation(input, dependencies);
  assert.deepEqual(result, { kind: "skipped", actionId: "stage-action-1" });
  assert.equal(latestChecks, 2);
  assert.equal(patchSent, false);
});

test("reason note contains only the selected stage, concise evidence, checked field names, and action id", () => {
  const text = buildCallStageReasonNote({
    id: "stage-action-1",
    targetName: "квалифицирован",
    evidence: "Mijoz aniq qiziqdi.",
    checkedFields: ["Region", "Kurs"],
  });
  assert.match(text, /Автоперевод UZUM по итогам звонка/);
  assert.match(text, /Проверены поля: Region; Kurs/);
  assert.doesNotMatch(text, /<TRANSKRIPT>/);
});
