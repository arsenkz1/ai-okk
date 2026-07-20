const test = require("node:test");
const assert = require("node:assert/strict");

const {
  initializeConfiguredLeadInactivityActivation,
} = require("../dist/services/leadInactivityActivationRuntime");

test("keeps activation initialization absent unless the explicit startup confirmation is set", async () => {
  let created = false;
  const result = await initializeConfiguredLeadInactivityActivation({
    environment: {},
    createStore: () => {
      created = true;
      throw new Error("must not create store");
    },
  });

  assert.equal(result, null);
  assert.equal(created, false);
});

test("initializes the durable no-backfill boundary before startup only with exact confirmation", async () => {
  const boundary = new Date("2026-07-20T08:10:00.000Z");
  let confirmation;
  const result = await initializeConfiguredLeadInactivityActivation({
    environment: { LEAD_INACTIVITY_ACTIVATION_CONFIRM: "initialize" },
    createStore: () => ({
      getOrCreateActivationBoundary: async () => boundary,
    }),
    initialize: async (input) => {
      confirmation = input.confirmation;
      return input.store.getOrCreateActivationBoundary();
    },
  });

  assert.equal(result.toISOString(), boundary.toISOString());
  assert.equal(confirmation, "initialize");
});
