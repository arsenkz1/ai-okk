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

test("a clear eligible UZUM outcome reserves one test slot, moves once, verifies, notes, atomically confirms capacity, and reports its result", async () => {
  const calls = { reserve: 0, atomicConfirm: 0, move: 0, note: 0 };
  const alerts = [];
  const allQualificationFields = new Map([
    [936095, ["Maqsad"]], [936097, ["Erkak"]], [936101, ["29"]], [936103, ["Kurs"]], [936105, ["Birinchi"]],
    [940183, ["Instagram"]], [967019, ["Toshkent"]], [1026381, ["yuqori"]], [1038305, ["Dizayner"]], [1038307, ["Ha"]],
  ]);
  const dependencies = baseDependencies({
    store: {
      async getActivationBoundary() { return boundary; },
      async getHistoryFenceActivationBoundary() { return boundary; },
      async reserveHistoryFenceTestMove() { calls.reserve += 1; return { kind: "reserved", slot: { slotNumber: 4 } }; },
      async confirmTestMove() { throw new Error("separate slot confirmation is forbidden"); },
      async releaseTestMoveBeforePatch() { throw new Error("not expected"); },
      async markTestMoveUncertain() { throw new Error("not expected"); },
    },
    ledger: {
      ...baseDependencies().ledger,
      async markMoveConfirmed(confirmInput) {
        calls.atomicConfirm += 1;
        assert.equal(confirmInput.confirmTestSlot, true);
        return action({ status: "confirmed", checkedFields: confirmInput.checkedFields, amoNoteId: confirmInput.noteId });
      },
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
  assert.deepEqual(calls, { reserve: 1, atomicConfirm: 1, move: 1, note: 1 });
  assert.deepEqual(alerts.map(({ kind, targetName }) => ({ kind, targetName })), [{ kind: "moved", targetName: "квалифицирован" }]);
});

test("an atomic terminal persistence failure marks the action and slot uncertain without announcing a move", async () => {
  const allQualificationFields = new Map(qualificationFields.map(([id]) => [id, ["filled"]]));
  let actionUncertain = 0;
  let slotUncertain = 0;
  const alerts = [];
  const dependencies = baseDependencies({
    store: {
      async getActivationBoundary() { return boundary; },
      async getHistoryFenceActivationBoundary() { return boundary; },
      async reserveHistoryFenceTestMove() { return { kind: "reserved", slot: { slotNumber: 4 } }; },
      async confirmTestMove() { throw new Error("separate slot confirmation is forbidden"); },
      async releaseTestMoveBeforePatch() { throw new Error("not expected"); },
      async markTestMoveUncertain() { slotUncertain += 1; return { state: "uncertain" }; },
    },
    ledger: {
      ...baseDependencies().ledger,
      async markMoveConfirmed() { throw new Error("atomic transaction failed"); },
      async markMoveUncertain() { actionUncertain += 1; return action({ status: "uncertain" }); },
    },
    amo: {
      async readLead() { return lead({ fields: allQualificationFields }); },
      async getLeadCustomFields() { return configuredCustomFields(); },
      async hasRecentStageMovement() { return false; },
      async moveLeadToTarget() { return { kind: "confirmed", lead: lead({ statusId: 58160726, fields: allQualificationFields }) }; },
      async addStageReasonNote() { return { kind: "confirmed", noteId: 700 }; },
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  });

  const result = await runCallStageAutomation(input, dependencies);
  assert.deepEqual(result, { kind: "uncertain", actionId: "stage-action-1", phase: "persistence" });
  assert.equal(actionUncertain, 1);
  assert.equal(slotUncertain, 1);
  assert.deepEqual(alerts, []);
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

// ---------------------------------------------------------------------------
// Автозаполнение обязательных полей перед переводом этапа
// ---------------------------------------------------------------------------

const AUTOFILL_TARGET_FIELDS = [
  { id: 936103, name: "Kurs", type: "text", enums: [] },
  { id: 936097, name: "Jinsi", type: "select", enums: [{ id: 71, value: "Ayol", sort: 1 }] },
  { id: 967019, name: "Region", type: "select", enums: [{ id: 81, value: "Toshkent", sort: 1 }] },
];

function autofillCustomFields(overrides = []) {
  const byId = new Map(AUTOFILL_TARGET_FIELDS.map((field) => [field.id, field]));
  for (const override of overrides) byId.set(override.id, override);
  return [...byId.values()].map((field) => ({
    ...field,
    requiredStatuses: [{ pipelineId: 6909890, statusId: 58160726 }],
  }));
}

const FILLED_FIELD_VALUES = new Map([
  [936103, ["Uzum market"]], [936097, ["Ayol"]], [967019, ["Samarqand"]],
]);

/** Records what the snapshot/addition log was asked to store. */
function fakeOptionRegistry(overrides = {}) {
  const calls = { snapshots: [], additions: [] };
  return {
    calls,
    registry: {
      async captureSnapshot(snapshotInput) {
        calls.snapshots.push(snapshotInput);
        if (overrides.captureSnapshot) return overrides.captureSnapshot(snapshotInput);
        return { ...snapshotInput, originalEnums: [...snapshotInput.enums], capturedAt: now };
      },
      async recordAddition(additionInput) {
        calls.additions.push(additionInput);
        if (overrides.recordAddition) return overrides.recordAddition(additionInput);
      },
    },
  };
}

/** Empty lead until the fields are written, filled on every later read. */
function autofillAmo(options = {}) {
  const state = { written: false, reads: 0 };
  return {
    state,
    amo: {
      async readLead() {
        state.reads += 1;
        return lead({ fields: state.written ? FILLED_FIELD_VALUES : new Map() });
      },
      async getLeadCustomFields() { return options.customFields ?? autofillCustomFields(); },
      async hasRecentStageMovement() { return false; },
      async addFieldOption(input) {
        state.createdOption = input;
        return options.addFieldOption
          ? options.addFieldOption(input)
          : { kind: "confirmed", enumId: 91, value: input.value };
      },
      async writeLeadFields(input) {
        state.writeInput = input;
        if (options.writeLeadFields) return options.writeLeadFields(input);
        state.written = true;
        return { kind: "confirmed", lead: lead({ fields: FILLED_FIELD_VALUES }) };
      },
      async moveLeadToTarget() {
        state.moved = true;
        return { kind: "confirmed", lead: lead({ statusId: 58160726, fields: FILLED_FIELD_VALUES }) };
      },
      async addStageReasonNote() { return { kind: "confirmed", noteId: 700 }; },
    },
  };
}

test("fills the blocking fields, moves the deal, and reports every written value to admins", async () => {
  const alerts = [];
  const { state, amo } = autofillAmo();
  const { calls: registryCalls, registry } = fakeOptionRegistry();
  const result = await runCallStageAutomation(input, baseDependencies({
    autofillMissingFields: true,
    amo,
    optionRegistry: registry,
    async analyzeFieldValues(transcript, fields) {
      assert.equal(transcript, input.transcript);
      assert.deepEqual(fields.map((field) => field.id).sort(), [936097, 936103, 967019]);
      return [
        { id: 936103, value: "Uzum market", grounded: true },
        { id: 936097, value: "ayol", grounded: true },
        { id: 967019, value: "Samarqand", grounded: false },
      ];
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  }));

  assert.deepEqual(result, { kind: "confirmed", actionId: "stage-action-1", noteId: 700 });
  assert.equal(state.moved, true);
  // The already-present option is reused; only the unknown one is created.
  assert.deepEqual(state.createdOption, { fieldId: 967019, value: "Samarqand" });
  // The field's original option list is stored before it is modified, and the
  // new option is logged so it can be rolled back later.
  assert.deepEqual(registryCalls.snapshots, [{
    fieldId: 967019,
    fieldName: "Region",
    fieldType: "select",
    enums: [{ id: 81, value: "Toshkent", sort: 1 }],
  }]);
  assert.deepEqual(registryCalls.additions, [{
    fieldId: 967019,
    fieldName: "Region",
    enumId: 91,
    value: "Samarqand",
    actionId: "stage-action-1",
    dealId: 42,
  }]);
  assert.deepEqual(state.writeInput.values.find((value) => value.fieldId === 936097), {
    fieldId: 936097, enumId: 71, value: "Ayol",
  });
  assert.deepEqual(state.writeInput.values.find((value) => value.fieldId === 936103), {
    fieldId: 936103, enumId: null, value: "Uzum market",
  });

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "autofilled");
  assert.equal(alerts[0].moveFailedReason, undefined);
  assert.deepEqual(
    [...alerts[0].filled].sort((left, right) => left.fieldName.localeCompare(right.fieldName)),
    [
      { fieldName: "Jinsi", value: "Ayol", createdOption: false, grounded: true },
      { fieldName: "Kurs", value: "Uzum market", createdOption: false, grounded: true },
      { fieldName: "Region", value: "Samarqand", createdOption: true, grounded: false },
    ],
  );
});

test("keeps the previous blocked behaviour when autofill is switched off", async () => {
  const alerts = [];
  const { state, amo } = autofillAmo();
  const result = await runCallStageAutomation(input, baseDependencies({
    amo,
    async analyzeFieldValues() { throw new Error("must not consult the model"); },
    notifier: { async notify(alert) { alerts.push(alert); } },
  }));

  assert.deepEqual(result, { kind: "missing_fields", actionId: "stage-action-1" });
  assert.equal(state.writeInput, undefined);
  assert.equal(state.moved, undefined);
  assert.equal(alerts[0].kind, "missing_fields");
});

test("writes nothing when even one blocking field cannot be filled", async () => {
  const alerts = [];
  const { state, amo } = autofillAmo({
    customFields: autofillCustomFields([{ id: 967019, name: "Region", type: "date", enums: [] }]),
  });
  const result = await runCallStageAutomation(input, baseDependencies({
    autofillMissingFields: true,
    amo,
    async analyzeFieldValues() {
      return [
        { id: 936103, value: "Uzum market", grounded: true },
        { id: 936097, value: "Ayol", grounded: true },
      ];
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  }));

  assert.deepEqual(result, { kind: "autofill_failed", actionId: "stage-action-1" });
  assert.equal(state.writeInput, undefined);
  assert.equal(state.createdOption, undefined);
  assert.equal(state.moved, undefined);
  assert.equal(alerts[0].kind, "autofill_failed");
  assert.equal(alerts[0].reason.includes("unsupported_type"), true);
});

test("does not move the deal when creating a new option fails", async () => {
  const alerts = [];
  const { state, amo } = autofillAmo({
    addFieldOption: () => ({ kind: "not_created", reason: "patch_rejected" }),
  });
  const result = await runCallStageAutomation(input, baseDependencies({
    autofillMissingFields: true,
    amo,
    optionRegistry: fakeOptionRegistry().registry,
    async analyzeFieldValues() {
      return [
        { id: 936103, value: "Uzum market", grounded: true },
        { id: 936097, value: "Ayol", grounded: true },
        { id: 967019, value: "Samarqand", grounded: true },
      ];
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  }));

  assert.deepEqual(result, { kind: "autofill_failed", actionId: "stage-action-1" });
  assert.equal(state.writeInput, undefined);
  assert.equal(state.moved, undefined);
  assert.equal(alerts[0].reason.includes("вариант списка"), true);
});

test("blocks the move but still reports the values it wrote when amoCRM keeps refusing", async () => {
  const alerts = [];
  const { state, amo } = autofillAmo({
    // amoCRM accepts the PATCH but the lead read back is still empty.
    writeLeadFields: () => ({ kind: "confirmed", lead: lead({ fields: new Map() }) }),
  });
  const result = await runCallStageAutomation(input, baseDependencies({
    autofillMissingFields: true,
    amo,
    optionRegistry: fakeOptionRegistry().registry,
    async analyzeFieldValues() {
      return [
        { id: 936103, value: "Uzum market", grounded: true },
        { id: 936097, value: "Ayol", grounded: true },
        { id: 967019, value: "Samarqand", grounded: false },
      ];
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  }));

  assert.deepEqual(result, { kind: "missing_fields", actionId: "stage-action-1" });
  assert.equal(state.moved, undefined);
  assert.equal(alerts[0].kind, "autofilled");
  assert.equal(alerts[0].moveFailedReason.includes("всё ещё считает поля незаполненными"), true);
  assert.equal(alerts[0].filled.length, 3);
});

test("blocks the move when amoCRM cannot confirm the field write", async () => {
  const alerts = [];
  const { state, amo } = autofillAmo({
    writeLeadFields: () => ({ kind: "uncertain", error: { kind: "network", status: null, code: null, message: "timeout" } }),
  });
  const result = await runCallStageAutomation(input, baseDependencies({
    autofillMissingFields: true,
    amo,
    optionRegistry: fakeOptionRegistry().registry,
    async analyzeFieldValues() {
      return [
        { id: 936103, value: "Uzum market", grounded: true },
        { id: 936097, value: "Ayol", grounded: true },
        { id: 967019, value: "Samarqand", grounded: true },
      ];
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  }));

  assert.deepEqual(result, { kind: "autofill_failed", actionId: "stage-action-1" });
  assert.equal(state.moved, undefined);
  assert.equal(alerts[0].reason.includes("неопределённо"), true);
});

test("never creates an option when the original list cannot be stored", async () => {
  const alerts = [];
  const { state, amo } = autofillAmo();
  const { registry } = fakeOptionRegistry({
    captureSnapshot: () => { throw new Error("database unavailable"); },
  });
  const result = await runCallStageAutomation(input, baseDependencies({
    autofillMissingFields: true,
    amo,
    optionRegistry: registry,
    async analyzeFieldValues() {
      return [
        { id: 936103, value: "Uzum market", grounded: true },
        { id: 936097, value: "Ayol", grounded: true },
        { id: 967019, value: "Samarqand", grounded: true },
      ];
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  }));

  assert.deepEqual(result, { kind: "autofill_failed", actionId: "stage-action-1" });
  assert.equal(state.createdOption, undefined);
  assert.equal(state.writeInput, undefined);
  assert.equal(alerts[0].reason.includes("исходный список"), true);
});

test("refuses to create an option at all when no rollback log is wired up", async () => {
  const { state, amo } = autofillAmo();
  const result = await runCallStageAutomation(input, baseDependencies({
    autofillMissingFields: true,
    amo,
    async analyzeFieldValues() {
      return [
        { id: 936103, value: "Uzum market", grounded: true },
        { id: 936097, value: "Ayol", grounded: true },
        { id: 967019, value: "Samarqand", grounded: true },
      ];
    },
  }));

  assert.deepEqual(result, { kind: "autofill_failed", actionId: "stage-action-1" });
  assert.equal(state.createdOption, undefined);
});

test("reuses an existing option for a synonym instead of creating a duplicate", async () => {
  const alerts = [];
  const { state, amo } = autofillAmo();
  const { calls: registryCalls, registry } = fakeOptionRegistry();
  await runCallStageAutomation(input, baseDependencies({
    autofillMissingFields: true,
    amo,
    optionRegistry: registry,
    async analyzeFieldValues() {
      return [
        { id: 936103, value: "Uzum market", grounded: true },
        { id: 936097, value: "Ayol", grounded: true },
        // "Toshkent shahri" must land on the existing "Toshkent" option.
        { id: 967019, value: "Toshkent shahri", grounded: true },
      ];
    },
    notifier: { async notify(alert) { alerts.push(alert); } },
  }));

  assert.equal(state.createdOption, undefined);
  assert.deepEqual(registryCalls.additions, []);
  assert.deepEqual(state.writeInput.values.find((value) => value.fieldId === 967019), {
    fieldId: 967019, enumId: 81, value: "Toshkent",
  });
  const region = alerts[0].filled.find((field) => field.fieldName === "Region");
  assert.equal(region.createdOption, false);
  assert.equal(region.matchedBy, "qualifier");
  assert.equal(region.modelValue, "Toshkent shahri");
});
