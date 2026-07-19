const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AMO_INACTIVITY_WEBHOOK_EVENTS,
  buildLeadInactivityWebhookDestination,
  createLeadInactivityAmoSubscriptionClient,
} = require("../dist/services/leadInactivityAmoSubscription");

test("builds a dedicated HTTPS destination without accepting path or query injection", () => {
  assert.equal(
    buildLeadInactivityWebhookDestination("https://ai-okk-production.up.railway.app/", "secret with / characters"),
    "https://ai-okk-production.up.railway.app/webhooks/amocrm/inactivity/secret%20with%20%2F%20characters",
  );
  assert.throws(
    () => buildLeadInactivityWebhookDestination("https://ai-okk-production.up.railway.app/anything", "secret"),
    /public base URL must not include a path/,
  );
});

test("subscribes only the dedicated endpoint to the exact direct-lead event set", async () => {
  const requests = [];
  const client = createLeadInactivityAmoSubscriptionClient({
    baseUrl: "https://example.amocrm.ru",
    accessToken: "test-token",
    publicBaseUrl: "https://ai-okk-production.up.railway.app",
    webhookSecret: "dedicated-secret",
    http: { request: async (request) => {
      requests.push(request);
      return { status: 201, data: { id: 1 }, headers: {} };
    } },
  });

  // Extra JavaScript arguments must not be able to redirect this subscription
  // to the legacy webhook endpoint.
  await client.subscribe("https://ai-okk-production.up.railway.app/webhooks/amocrm");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "https://example.amocrm.ru/api/v4/webhooks");
  assert.deepEqual(requests[0].data, {
    destination: "https://ai-okk-production.up.railway.app/webhooks/amocrm/inactivity/dedicated-secret",
    settings: [
      "add_lead", "update_lead", "status_lead", "responsible_lead", "restore_lead",
      "delete_lead", "add_task", "update_task", "delete_task", "note_lead",
    ],
  });
  assert.equal(requests[0].headers.Authorization, "Bearer test-token");
});

test("does not report a resolved non-2xx subscription response as success", async () => {
  const client = createLeadInactivityAmoSubscriptionClient({
    baseUrl: "https://example.amocrm.ru",
    accessToken: "test-token",
    publicBaseUrl: "https://ai-okk-production.up.railway.app",
    webhookSecret: "dedicated-secret",
    http: { request: async () => ({ status: 409, data: {}, headers: {} }) },
  });

  await assert.rejects(
    client.subscribe(),
    /amoCRM webhook subscription failed with HTTP 409/,
  );
});
