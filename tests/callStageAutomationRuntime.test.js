const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createIsLatestCompletedCall,
  parseCallStageAutomationRuntimeConfig,
} = require("../dist/services/callStageAutomationRuntime");

test("stage routing is disabled and dry-run by default", () => {
  const config = parseCallStageAutomationRuntimeConfig({});
  assert.deepEqual(config, {
    enabled: false,
    testing: true,
    executionMode: "dry_run",
    baseUrl: null,
    accessToken: null,
  });
});

test("live stage routing requires explicit credentials and an explicit live mode", () => {
  assert.throws(
    () => parseCallStageAutomationRuntimeConfig({ AMOCRM_CALL_STAGE_AUTOMATION_ENABLED: "true" }),
    /requires AMOCRM_BASE_URL and AMOCRM_ACCESS_TOKEN/,
  );
  const config = parseCallStageAutomationRuntimeConfig({
    AMOCRM_CALL_STAGE_AUTOMATION_ENABLED: "true",
    AMOCRM_CALL_STAGE_AUTOMATION_TESTING: "true",
    AMOCRM_CALL_STAGE_AUTOMATION_EXECUTION_MODE: "live",
    AMOCRM_BASE_URL: "https://tenant.amocrm.ru",
    AMOCRM_ACCESS_TOKEN: "not-a-real-token",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.testing, true);
  assert.equal(config.executionMode, "live");
});

test("stage-routing cannot silently leave its approved five-move history-fence test mode", () => {
  assert.throws(
    () => parseCallStageAutomationRuntimeConfig({ AMOCRM_CALL_STAGE_AUTOMATION_TESTING: "false" }),
    /must remain true during the approved five-move history-fence rollout/,
  );
});

test("a competing equal-or-newer completed call fences the older call from routing", async () => {
  const calls = [];
  const isLatestCompletedCall = createIsLatestCompletedCall({
    call: {
      async findFirst(query) {
        calls.push(query);
        return { id: 11 };
      },
    },
  });
  const result = await isLatestCompletedCall({
    callId: 10,
    dealId: 42,
    callEndedAt: new Date("2026-08-04T10:00:00.000Z"),
  });
  assert.equal(result, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.dealId, 42);
  assert.equal(calls[0].where.status, "completed");
  assert.equal(calls[0].where.id.not, 10);
  assert.deepEqual(calls[0].where.endedAt.gte, new Date("2026-08-04T10:00:00.000Z"));
});
