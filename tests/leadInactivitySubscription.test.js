const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LEAD_INACTIVITY_SUBSCRIPTION_CONFIRMATION,
  subscribeLeadInactivityEvents,
} = require("../dist/services/leadInactivitySubscription");

test("refuses amoCRM event subscription without explicit one-time confirmation", async () => {
  let calls = 0;
  const client = { subscribe: async () => { calls += 1; } };

  await assert.rejects(
    subscribeLeadInactivityEvents({ client, confirmation: "true" }),
    /LEAD_INACTIVITY_SUBSCRIPTION_CONFIRM=subscribe/,
  );
  assert.equal(calls, 0);
});

test("subscribes only after explicit one-time confirmation", async () => {
  let calls = 0;
  const client = { subscribe: async () => { calls += 1; } };

  await subscribeLeadInactivityEvents({
    client,
    confirmation: LEAD_INACTIVITY_SUBSCRIPTION_CONFIRMATION,
  });

  assert.equal(calls, 1);
});
