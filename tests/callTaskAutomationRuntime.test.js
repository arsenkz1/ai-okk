const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCallTaskAutomationRuntimeConfig } = require("../dist/services/callTaskAutomationRuntime");

test("call-task automation is fail-closed by default and requires amoCRM credentials only when explicitly enabled", () => {
  assert.deepEqual(parseCallTaskAutomationRuntimeConfig({}), {
    enabled: false,
    testing: true,
    executionMode: "dry_run",
    taskTypeId: 1,
    baseUrl: null,
    accessToken: null,
  });

  assert.throws(
    () => parseCallTaskAutomationRuntimeConfig({ AMOCRM_CALL_TASK_AUTOMATION_ENABLED: "true" }),
    /AMOCRM_BASE_URL and AMOCRM_ACCESS_TOKEN/,
  );
});

test("test mode is unbounded observation while live writes still require explicit configuration", () => {
  const config = parseCallTaskAutomationRuntimeConfig({
    AMOCRM_CALL_TASK_AUTOMATION_ENABLED: "true",
    AMOCRM_CALL_TASK_AUTOMATION_TESTING: "true",
    AMOCRM_CALL_TASK_AUTOMATION_EXECUTION_MODE: "live",
    AMOCRM_CALL_TASK_AUTOMATION_TASK_TYPE_ID: "2",
    AMOCRM_BASE_URL: "https://tenant.amocrm.ru",
    AMOCRM_ACCESS_TOKEN: "token",
  });
  assert.deepEqual(config, {
    enabled: true,
    testing: true,
    executionMode: "live",
    taskTypeId: 2,
    baseUrl: "https://tenant.amocrm.ru",
    accessToken: "token",
  });
});

test("invalid booleans, execution modes, and task type IDs are rejected before a worker can mutate amoCRM", () => {
  const base = { AMOCRM_CALL_TASK_AUTOMATION_ENABLED: "true", AMOCRM_BASE_URL: "https://tenant.amocrm.ru", AMOCRM_ACCESS_TOKEN: "token" };
  assert.throws(() => parseCallTaskAutomationRuntimeConfig({ ...base, AMOCRM_CALL_TASK_AUTOMATION_TESTING: "maybe" }), /must be true or false/);
  assert.throws(() => parseCallTaskAutomationRuntimeConfig({ ...base, AMOCRM_CALL_TASK_AUTOMATION_EXECUTION_MODE: "fast" }), /live or dry_run/);
  assert.throws(() => parseCallTaskAutomationRuntimeConfig({ ...base, AMOCRM_CALL_TASK_AUTOMATION_TASK_TYPE_ID: "0" }), /positive integer/);
});
