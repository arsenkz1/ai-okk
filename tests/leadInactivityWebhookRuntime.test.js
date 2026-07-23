const test = require("node:test");
const assert = require("node:assert/strict");

const { createConfiguredLeadInactivityWebhookRouter } = require("../dist/services/leadInactivityWebhookRuntime");

test("keeps the isolated inactivity webhook disabled until its dedicated secret is configured", () => {
  const router = createConfiguredLeadInactivityWebhookRouter({
    AMOCRM_BASE_URL: "https://example.amocrm.ru",
    AMOCRM_ACCESS_TOKEN: "test-token",
  });

  assert.equal(router, null);
});

test("constructs the route only when all dedicated webhook prerequisites are present", () => {
  const router = createConfiguredLeadInactivityWebhookRouter({
    AMOCRM_INACTIVITY_WEBHOOK_SECRET: "dedicated-secret",
    AMOCRM_BASE_URL: "https://example.amocrm.ru",
    AMOCRM_ACCESS_TOKEN: "test-token",
  });

  assert.equal(router.stack.find((layer) => layer.route)?.route?.path, "/webhooks/amocrm/inactivity/:secret");
});

test("passes the configured inactivity delay into the webhook event store and rejects invalid values", () => {
  let inactivityMs;
  const environment = {
    AMOCRM_INACTIVITY_WEBHOOK_SECRET: "dedicated-secret",
    AMOCRM_BASE_URL: "https://example.amocrm.ru",
    AMOCRM_ACCESS_TOKEN: "test-token",
    AMOCRM_INACTIVITY_DELAY_HOURS: "24",
  };
  const dependencies = {
    createStore: (value) => {
      inactivityMs = value;
      return { recordLeadEvent: async () => ({ ignored: false, duplicate: false, watch: {} }) };
    },
  };

  const router = createConfiguredLeadInactivityWebhookRouter(environment, dependencies);

  assert.equal(router.stack.find((layer) => layer.route)?.route?.path, "/webhooks/amocrm/inactivity/:secret");
  assert.equal(inactivityMs, 24 * 60 * 60 * 1000);
  assert.throws(
    () => createConfiguredLeadInactivityWebhookRouter({
      ...environment,
      TESTING_LEADS_MOVEMENT: "false",
    }),
    /requires AMOCRM_INACTIVITY_DELAY_HOURS=72/,
  );
  assert.throws(
    () => createConfiguredLeadInactivityWebhookRouter({ ...environment, AMOCRM_INACTIVITY_DELAY_HOURS: "0" }),
    /positive whole number of hours/,
  );
});

test("fails closed when the dedicated secret exists but amoCRM credentials are incomplete", () => {
  assert.throws(() => createConfiguredLeadInactivityWebhookRouter({
    AMOCRM_INACTIVITY_WEBHOOK_SECRET: "dedicated-secret",
    AMOCRM_BASE_URL: "https://example.amocrm.ru",
  }), /requires AMOCRM_BASE_URL and AMOCRM_ACCESS_TOKEN/);
});
