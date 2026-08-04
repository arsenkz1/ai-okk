const test = require("node:test");
const assert = require("node:assert/strict");

const {
  executeReviewedCallTaskProposal,
  runCallTaskAutomation,
} = require("../dist/services/callTaskAutomation");

const now = new Date("2026-08-04T07:00:00.000Z");
const boundary = new Date("2026-08-04T06:00:00.000Z");
const dueAt = new Date("2026-08-05T10:00:00.000Z");

function action(overrides = {}) {
  return {
    id: "action-1",
    callId: 10,
    dealId: 100,
    testMode: true,
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
    approvalToken: "approval-1",
    ...overrides,
  };
}

function makeDependencies(overrides = {}) {
  const calls = { analysis: 0, task: 0, note: 0, confirmedSlots: 0, releasedSlots: 0, proposals: 0 };
  const current = action();
  const deps = {
    enabled: true,
    testing: true,
    executionMode: "live",
    now: () => now,
    store: {
      getActivationBoundary: async () => boundary,
      reserveTestLead: async () => ({ kind: "reserved", slot: { slotNumber: 1 } }),
      confirmTestLead: async () => { calls.confirmedSlots += 1; },
      releaseTestLeadBeforeAnalysis: async () => { calls.releasedSlots += 1; },
      markTestLeadUncertain: async () => {},
    },
    ledger: {
      claimAnalysis: async () => ({ kind: "claimed", action: current, leaseToken: "lease-1" }),
      finalizeAnalysis: async ({ proposal }) => Object.assign(current, {
        status: proposal.decision === "none" ? "skipped" : "proposed",
        decision: proposal.decision,
        taskText: proposal.taskText,
        evidence: proposal.evidence,
        proposedDueAt: proposal.deadlineAt,
      }),
      markAnalysisUnavailable: async () => Object.assign(current, { status: "skipped" }),
      claimTaskCreation: async ({ dueAt: selectedDueAt }) => Object.assign(current, {
        status: "creating_task", selectedDueAt, taskRequestId: "call-task:action-1",
      }),
      markTaskConfirmed: async (_actionId, taskId, responsibleUserId) => Object.assign(current, {
        status: "task_confirmed", amoTaskId: taskId, responsibleUserId,
      }),
      markTaskSkipped: async () => Object.assign(current, { status: "skipped" }),
      markTaskUncertain: async () => Object.assign(current, { status: "uncertain" }),
      claimNoteCreation: async (_actionId, noteText) => Object.assign(current, { status: "creating_note", noteText }),
      markNoteConfirmed: async (_actionId, noteId) => Object.assign(current, { status: "confirmed", amoNoteId: noteId }),
      markNoteUncertain: async () => Object.assign(current, { status: "uncertain" }),
      getActionById: async () => current,
    },
    amo: {
      readLead: async () => ({ id: 100, createdAt: new Date("2026-08-04T06:01:00.000Z"), closedAt: null, responsibleUserId: 77 }),
      createVerifiedTask: async (input) => {
        calls.task += 1;
        return {
          kind: "confirmed",
          lead: { id: 100, createdAt: new Date("2026-08-04T06:01:00.000Z"), closedAt: null, responsibleUserId: 77 },
          task: { id: 901, responsibleUserId: 77, text: input.taskText, completeTill: input.dueAt },
        };
      },
      addTaskReasonNote: async () => { calls.note += 1; return { kind: "confirmed", noteId: 902 }; },
    },
    analyze: async () => {
      calls.analysis += 1;
      return {
        decision: "auto",
        taskText: "Klientga kurs dasturini yuborish",
        deadlineAt: dueAt,
        evidence: "Menejer ertaga soat 15:00 da yuborishga kelishdi",
      };
    },
    notifier: { notifyProposal: async () => { calls.proposals += 1; }, notifyTestResult: async () => {} },
    ...overrides,
  };
  return { deps, calls, current };
}

test("does nothing for a feature-disabled pipeline or a lead created before the durable activation boundary", async () => {
  const disabled = makeDependencies({ enabled: false });
  assert.deepEqual(await runCallTaskAutomation({ callId: 10, dealId: 100, callCreatedAt: now, managerAmoUserId: 55, transcript: "text" }, disabled.deps), { kind: "disabled" });
  assert.equal(disabled.calls.analysis, 0);

  const old = makeDependencies({ amo: { ...makeDependencies().deps.amo, readLead: async () => ({ id: 100, createdAt: boundary, closedAt: null, responsibleUserId: 77 }) } });
  assert.deepEqual(await runCallTaskAutomation({ callId: 10, dealId: 100, callCreatedAt: now, managerAmoUserId: 55, transcript: "text" }, old.deps), { kind: "ineligible", reason: "lead_created_before_activation" });
  assert.equal(old.calls.analysis, 0);
});

test("in the five-lead test mode it analyzes exactly an eligible new lead, creates a verified task and one explanatory note", async () => {
  const { deps, calls, current } = makeDependencies();
  const result = await runCallTaskAutomation({
    callId: 10, dealId: 100, callCreatedAt: now, managerAmoUserId: 55, transcript: "Mijozga ertaga soat 15:00 da dastur yuboraman",
  }, deps);

  assert.deepEqual(result, { kind: "confirmed", actionId: "action-1", taskId: 901, noteId: 902 });
  assert.equal(calls.analysis, 1);
  assert.equal(calls.task, 1);
  assert.equal(calls.note, 1);
  assert.equal(calls.confirmedSlots, 1);
  assert.equal(current.status, "confirmed");
});

test("a reclaimed analysis lease resumes its own reserved test slot instead of skipping the action", async () => {
  const { deps, calls, current } = makeDependencies();
  deps.store.reserveTestLead = async () => ({
    kind: "reclaimed",
    slot: { slotNumber: 1, state: "reserved", actionId: "action-1" },
  });

  const result = await runCallTaskAutomation({
    callId: 10, dealId: 100, callCreatedAt: now, managerAmoUserId: 55, transcript: "text",
  }, deps);

  assert.equal(result.kind, "confirmed");
  assert.equal(calls.analysis, 1);
  assert.equal(calls.task, 1);
  assert.equal(calls.confirmedSlots, 1);
  assert.equal(current.status, "confirmed");
});

test("a clear next step without an exact deadline becomes a reviewer proposal rather than an invented amoCRM task", async () => {
  const { deps, calls } = makeDependencies({
    analyze: async () => ({
      decision: "review",
      taskText: "Klientga kurs dasturini yuborish",
      deadlineAt: null,
      evidence: "Menejer dastur yuborishga kelishdi, lekin vaqt aytilmadi",
    }),
  });

  assert.deepEqual(await runCallTaskAutomation({ callId: 10, dealId: 100, callCreatedAt: now, managerAmoUserId: 55, transcript: "text" }, deps), { kind: "review_pending", actionId: "action-1" });
  assert.equal(calls.task, 0);
  assert.equal(calls.note, 0);
  assert.equal(calls.proposals, 1);
  assert.equal(calls.confirmedSlots, 1);
});

test("an invalid/unavailable Gemini action response safely releases an unconsumed test slot and does not touch amoCRM", async () => {
  const { deps, calls } = makeDependencies({ analyze: async () => null });
  assert.deepEqual(await runCallTaskAutomation({ callId: 10, dealId: 100, callCreatedAt: now, managerAmoUserId: 55, transcript: "text" }, deps), { kind: "analysis_unavailable", actionId: "action-1" });
  assert.equal(calls.task, 0);
  assert.equal(calls.releasedSlots, 1);
});

test("an ambiguous amoCRM task POST is never followed by a note or a second task attempt", async () => {
  const { deps, calls, current } = makeDependencies({
    amo: {
      ...makeDependencies().deps.amo,
      createVerifiedTask: async () => { calls.task += 1; return { kind: "uncertain", error: { message: "timeout" }, lead: null }; },
    },
  });
  assert.deepEqual(await runCallTaskAutomation({ callId: 10, dealId: 100, callCreatedAt: now, managerAmoUserId: 55, transcript: "text" }, deps), { kind: "uncertain", actionId: "action-1", phase: "task" });
  assert.equal(calls.task, 1);
  assert.equal(calls.note, 0);
  assert.equal(current.status, "uncertain");
});

test("an authorized reviewer can create a review proposal exactly once after choosing an explicit Almaty due date", async () => {
  const fixture = makeDependencies();
  Object.assign(fixture.current, {
    status: "proposed",
    decision: "review",
    taskText: "Перезвонить клиенту",
    evidence: "Клиент попросил обратный звонок, срок выбран РОП.",
    proposedDueAt: null,
  });
  const result = await executeReviewedCallTaskProposal({
    action: fixture.current,
    dueAt: new Date("2026-08-05T10:00:00.000Z"),
    reviewerTelegramUserId: "777",
    managerAmoUserId: 55,
  }, fixture.deps);

  assert.deepEqual(result, { kind: "confirmed", actionId: "action-1", taskId: 901, noteId: 902 });
  assert.equal(fixture.calls.task, 1);
  assert.equal(fixture.calls.note, 1);

  const duplicate = await executeReviewedCallTaskProposal({
    action: fixture.current,
    dueAt: new Date("2026-08-05T10:00:00.000Z"),
    reviewerTelegramUserId: "777",
    managerAmoUserId: 55,
  }, fixture.deps);
  assert.deepEqual(duplicate, { kind: "existing", actionId: "action-1" });
  assert.equal(fixture.calls.task, 1);
});
