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

test("fails closed when the dedicated secret exists but amoCRM credentials are incomplete", () => {
  assert.throws(() => createConfiguredLeadInactivityWebhookRouter({
    AMOCRM_INACTIVITY_WEBHOOK_SECRET: "dedicated-secret",
    AMOCRM_BASE_URL: "https://example.amocrm.ru",
  }), /requires AMOCRM_BASE_URL and AMOCRM_ACCESS_TOKEN/);
});
