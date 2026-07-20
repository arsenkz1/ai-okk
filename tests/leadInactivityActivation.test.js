const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LEAD_INACTIVITY_ACTIVATION_CONFIRMATION,
  initializeLeadInactivityActivation,
} = require("../dist/services/leadInactivityActivation");

test("refuses to initialize an activation boundary without the explicit one-time confirmation", async () => {
  let called = false;
  const store = {
    getOrCreateActivationBoundary: async () => {
      called = true;
      return new Date();
    },
  };

  await assert.rejects(
    initializeLeadInactivityActivation({ store, confirmation: "true" }),
    /LEAD_INACTIVITY_ACTIVATION_CONFIRM=initialize/,
  );
  assert.equal(called, false);
});

test("durably initializes and reports the exact activation boundary after explicit confirmation", async () => {
  const boundary = new Date("2026-07-19T20:00:00.000Z");
  const calls = [];
  const store = {
    getOrCreateActivationBoundary: async (now) => {
      calls.push(now);
      return boundary;
    },
  };

  const result = await initializeLeadInactivityActivation({
    store,
    confirmation: LEAD_INACTIVITY_ACTIVATION_CONFIRMATION,
    now: () => new Date("2026-07-19T19:59:59.999Z"),
  });

  assert.equal(result.toISOString(), boundary.toISOString());
  assert.deepEqual(calls.map((date) => date.toISOString()), ["2026-07-19T19:59:59.999Z"]);
});
