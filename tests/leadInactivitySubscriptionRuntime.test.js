const test = require("node:test");
const assert = require("node:assert/strict");

const {
  subscribeConfiguredLeadInactivityEvents,
} = require("../dist/services/leadInactivitySubscriptionRuntime");

test("keeps amoCRM event subscription absent unless explicit startup confirmation is set", async () => {
  let created = false;
  const result = await subscribeConfiguredLeadInactivityEvents({
    environment: {},
    createClient: () => {
      created = true;
      throw new Error("must not create client");
    },
  });

  assert.equal(result, false);
  assert.equal(created, false);
});

test("creates the dedicated amoCRM subscription only with exact startup confirmation", async () => {
  let confirmation;
  let subscribes = 0;
  const result = await subscribeConfiguredLeadInactivityEvents({
    environment: { LEAD_INACTIVITY_SUBSCRIPTION_CONFIRM: "subscribe" },
    createClient: () => ({ subscribe: async () => { subscribes += 1; } }),
    subscribe: async (input) => {
      confirmation = input.confirmation;
      await input.client.subscribe();
    },
  });

  assert.equal(result, true);
  assert.equal(confirmation, "subscribe");
  assert.equal(subscribes, 1);
});
