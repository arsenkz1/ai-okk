const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CALL_STAGE_AUTOMATION_ACTIVATION_CONFIRMATION,
  CALL_STAGE_AUTOMATION_HISTORY_FENCE_ACTIVATION_CONFIRMATION,
  initializeCallStageAutomationActivation,
  initializeCallStageHistoryFenceActivation,
} = require("../dist/services/callStageAutomationActivation");

test("stage routing activation must be explicit and preserves its first durable boundary", async () => {
  let boundary = null;
  const store = {
    async getOrCreateActivationBoundary(now) {
      if (!boundary) boundary = now;
      return boundary;
    },
  };

  await assert.rejects(
    initializeCallStageAutomationActivation({ store, confirmation: "" }),
    /AMOCRM_CALL_STAGE_AUTOMATION_ACTIVATION_CONFIRM=initialize/,
  );

  const first = await initializeCallStageAutomationActivation({
    store,
    confirmation: CALL_STAGE_AUTOMATION_ACTIVATION_CONFIRMATION,
    now: () => new Date("2026-08-04T10:00:00.000Z"),
  });
  const second = await initializeCallStageAutomationActivation({
    store,
    confirmation: "INITIALIZE",
    now: () => new Date("2026-08-04T11:00:00.000Z"),
  });
  assert.equal(first.toISOString(), "2026-08-04T10:00:00.000Z");
  assert.equal(second.toISOString(), first.toISOString());
});

test("history-fence rollout atomically seeds five slots before publishing its separate durable boundary", async () => {
  let boundary = null;
  let initializations = 0;
  const store = {
    async initializeHistoryFenceRollout(now) {
      initializations += 1;
      if (!boundary) boundary = now;
      return boundary;
    },
  };

  await assert.rejects(
    initializeCallStageHistoryFenceActivation({ store, confirmation: "" }),
    /AMOCRM_CALL_STAGE_AUTOMATION_HISTORY_FENCE_ACTIVATION_CONFIRM=initialize-history-fence/,
  );
  const first = await initializeCallStageHistoryFenceActivation({
    store,
    confirmation: CALL_STAGE_AUTOMATION_HISTORY_FENCE_ACTIVATION_CONFIRMATION,
    now: () => new Date("2026-08-05T10:00:00.000Z"),
  });
  const second = await initializeCallStageHistoryFenceActivation({
    store,
    confirmation: "INITIALIZE-HISTORY-FENCE",
    now: () => new Date("2026-08-05T11:00:00.000Z"),
  });
  assert.equal(first.toISOString(), "2026-08-05T10:00:00.000Z");
  assert.equal(second.toISOString(), first.toISOString());
  assert.equal(initializations, 2);
});
