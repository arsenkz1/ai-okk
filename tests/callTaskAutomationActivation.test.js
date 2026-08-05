const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const activationScriptPath = path.join(__dirname, "../src/scripts/initializeCallTaskAutomationActivation.ts");

const {
  CALL_TASK_AUTOMATION_ACTIVATION_CONFIRMATION,
  initializeCallTaskAutomationActivation,
} = require("../dist/services/callTaskAutomationActivation");

test("call-task activation initializes only the durable boundary and never seeds obsolete five-slot capacity", () => {
  const source = fs.readFileSync(activationScriptPath, "utf8");
  assert.doesNotMatch(source, /ensureTestSlots\s*\(/);
  assert.doesNotMatch(source, /CALL_TASK_AUTOMATION_TEST_LIMIT/);
});

test("refuses to initialize a call-task activation boundary without exact explicit confirmation", async () => {
  let called = false;
  const store = {
    getOrCreateActivationBoundary: async () => {
      called = true;
      return new Date();
    },
  };

  await assert.rejects(
    initializeCallTaskAutomationActivation({ store, confirmation: "true" }),
    /AMOCRM_CALL_TASK_AUTOMATION_ACTIVATION_CONFIRM=initialize/,
  );
  assert.equal(called, false);
});

test("durably initializes and reports the exact call-task activation boundary", async () => {
  const boundary = new Date("2026-08-04T07:00:00.000Z");
  const calls = [];
  const store = {
    getOrCreateActivationBoundary: async (now) => {
      calls.push(now);
      return boundary;
    },
  };

  const result = await initializeCallTaskAutomationActivation({
    store,
    confirmation: CALL_TASK_AUTOMATION_ACTIVATION_CONFIRMATION,
    now: () => new Date("2026-08-04T06:59:59.999Z"),
  });

  assert.equal(result.toISOString(), boundary.toISOString());
  assert.deepEqual(calls.map((date) => date.toISOString()), ["2026-08-04T06:59:59.999Z"]);
});
