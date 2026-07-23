const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PRODUCTION_BASELINE_CONFIRMATION,
  runProductionLeadInactivityBaseline,
} = require("../dist/services/leadInactivityProductionBaseline");

const BASELINE_AT = new Date("2026-07-23T07:30:00.000Z");
const lead = (id, pipelineId, statusId) => ({
  id,
  createdAt: new Date("2026-07-01T12:00:00.000Z"),
  updatedAt: new Date("2026-07-22T12:00:00.000Z"),
  pipelineId,
  statusId,
  responsibleUserId: 77,
  name: `Lead ${id}`,
});

function fixture(overrides = {}) {
  const calls = { begin: [], list: 0, record: [], completed: [] };
  const store = {
    beginProductionBaseline: async (runId, now) => {
      calls.begin.push({ runId, now });
      return { runId, baselineAt: BASELINE_AT, alreadyCompleted: false };
    },
    recordProductionBaseline: async (input, baselineAt) => {
      calls.record.push({ input, baselineAt });
      return { ignored: false, duplicate: false, watch: { leadId: input.leadId } };
    },
    completeProductionBaseline: async (run) => { calls.completed.push(run); },
    ...overrides.store,
  };
  const amo = {
    listAllowedSourceStageLeads: async () => {
      calls.list += 1;
      return [lead(100, 9055778, 72917586), lead(101, 6909890, 58160718)];
    },
    ...overrides.amo,
  };
  return { calls, store, amo };
}

function approvedOptions(store, amo, overrides = {}) {
  return {
    store,
    amo,
    confirmation: PRODUCTION_BASELINE_CONFIRMATION,
    workerEnabled: "false",
    testingMode: "false",
    inactivityMs: 72 * 60 * 60 * 1000,
    now: () => new Date("2026-07-23T07:30:00.000Z"),
    randomId: () => "baseline-run-a",
    ...overrides,
  };
}

test("refuses the one-time baseline unless confirmation, worker stop, unrestricted mode, and 72-hour delay are explicit", async () => {
  const { calls, store, amo } = fixture();

  await assert.rejects(
    runProductionLeadInactivityBaseline(approvedOptions(store, amo, { confirmation: "wrong" })),
    /LEAD_INACTIVITY_PRODUCTION_BASELINE_CONFIRM/,
  );
  await assert.rejects(
    runProductionLeadInactivityBaseline(approvedOptions(store, amo, { workerEnabled: "true" })),
    /worker to be explicitly disabled/,
  );
  await assert.rejects(
    runProductionLeadInactivityBaseline(approvedOptions(store, amo, { testingMode: "true" })),
    /TESTING_LEADS_MOVEMENT=false/,
  );
  await assert.rejects(
    runProductionLeadInactivityBaseline(approvedOptions(store, amo, { inactivityMs: 24 * 60 * 60 * 1000 })),
    /requires a 72-hour delay/,
  );
  assert.deepEqual(calls, { begin: [], list: 0, record: [], completed: [] });
});

test("dry-runs the baseline without a confirmation or any durable write", async () => {
  const { calls, store, amo } = fixture();

  const result = await runProductionLeadInactivityBaseline(approvedOptions(store, amo, {
    confirmation: undefined,
    dryRun: true,
  }));

  assert.deepEqual(result, {
    baselineAt: null,
    discovered: 2,
    enrolled: 0,
    alreadyBaselined: 0,
    alreadyCompleted: false,
    dryRun: true,
  });
  assert.deepEqual(calls, { begin: [], list: 1, record: [], completed: [] });
});

test("does not append newly discovered leads after a completed baseline run", async () => {
  const { calls, store, amo } = fixture({
    store: {
      beginProductionBaseline: async (runId) => {
        calls.begin.push({ runId });
        return { runId: "baseline-run-a", baselineAt: BASELINE_AT, alreadyCompleted: true };
      },
    },
  });

  const result = await runProductionLeadInactivityBaseline(approvedOptions(store, amo));

  assert.deepEqual(result, {
    baselineAt: BASELINE_AT,
    discovered: 0,
    enrolled: 0,
    alreadyBaselined: 0,
    alreadyCompleted: true,
    dryRun: false,
  });
  assert.deepEqual(calls, { begin: [{ runId: "baseline-run-a" }], list: 0, record: [], completed: [] });
});

test("baselines every currently allowed lead from one durable timestamp and reports retry-safe counts", async () => {
  const { calls, store, amo } = fixture({
    store: {
      recordProductionBaseline: async (input, baselineAt) => {
        calls.record.push({ input, baselineAt });
        return { ignored: false, duplicate: input.leadId === 101, watch: { leadId: input.leadId } };
      },
    },
  });

  const result = await runProductionLeadInactivityBaseline(approvedOptions(store, amo));

  assert.deepEqual(result, {
    baselineAt: BASELINE_AT,
    discovered: 2,
    enrolled: 1,
    alreadyBaselined: 1,
    alreadyCompleted: false,
    dryRun: false,
  });
  assert.equal(calls.begin.length, 1);
  assert.equal(calls.list, 1);
  assert.deepEqual(calls.completed, [{ runId: "baseline-run-a", baselineAt: BASELINE_AT, alreadyCompleted: false }]);
  assert.deepEqual(calls.record.map(({ input, baselineAt }) => ({
    leadId: input.leadId,
    pipelineId: input.pipelineId,
    statusId: input.statusId,
    baselineAt,
  })), [
    { leadId: 100, pipelineId: 9055778, statusId: 72917586, baselineAt: BASELINE_AT },
    { leadId: 101, pipelineId: 6909890, statusId: 58160718, baselineAt: BASELINE_AT },
  ]);
});
