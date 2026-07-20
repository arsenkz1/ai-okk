const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createLeadInactivityWebhookProcessor,
  createProtectedLeadInactivityWebhookHandler,
  parseLeadInactivityWebhookEvents,
} = require("../dist/services/leadInactivityWebhook");

const {
  createLeadInactivityWebhookRouter,
} = require("../dist/routes/leadInactivityWebhook");

function freshLead(overrides = {}) {
  return {
    id: 100,
    createdAt: new Date("2026-07-19T10:00:00.000Z"),
    updatedAt: new Date("2026-07-19T12:00:00.000Z"),
    pipelineId: 9055778,
    statusId: 72917586,
    responsibleUserId: 77,
    name: "Fresh lead",
    ...overrides,
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("parses nested amoCRM form payload variants into direct lead activity events only", () => {
  const receivedAt = new Date("2026-07-19T12:00:00.000Z");
  const events = parseLeadInactivityWebhookEvents({
    leads: {
      add: { 0: { id: "100", date: "1784462400" } },
      update: [
        { id: "101", status_id: "72917586", date: "1784462401" },
        { id: "102", responsible_user_id: "77", date: "1784462402" },
      ],
    },
    contacts: { update: [{ id: "900", date: "1784462403" }] },
  }, receivedAt);

  assert.deepEqual(events.map(({ action, leadId }) => ({ action, leadId })), [
    { action: "add_lead", leadId: 100 },
    { action: "status_lead", leadId: 101 },
    { action: "responsible_lead", leadId: 102 },
  ]);
  assert.equal(events[0].eventAt.toISOString(), "2026-07-19T12:00:00.000Z");
  assert.match(events[0].fingerprint, /^amo-inactivity-webhook:/);
});

test("persists only source-pipeline activity after a fresh amoCRM lead read", async () => {
  const recorded = [];
  const processor = createLeadInactivityWebhookProcessor({
    amo: { readLead: async () => freshLead() },
    store: { recordLeadEvent: async (input) => {
      recorded.push(input);
      return { ignored: false, duplicate: false, watch: { leadId: input.leadId } };
    } },
    now: () => new Date("2026-07-19T12:00:10.000Z"),
  });

  const result = await processor.process({
    leads: { update: [{ id: "100", status_id: "72917586", date: "1784462400" }] },
  });

  assert.deepEqual(result, { accepted: 1, ignored: 0, duplicates: 0, requiresFreshRead: 0 });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].eventType, "status_lead");
  assert.equal(recorded[0].pipelineId, 9055778);
  assert.equal(recorded[0].leadCreatedAt.toISOString(), "2026-07-19T10:00:00.000Z");
});

test("does not create a watch when the fresh lead read is outside EXODE and UZUM", async () => {
  let recordCalls = 0;
  const processor = createLeadInactivityWebhookProcessor({
    amo: { readLead: async () => freshLead({ pipelineId: 9055770, statusId: 72917546 }) },
    store: { recordLeadEvent: async () => { recordCalls += 1; } },
    now: () => new Date("2026-07-19T12:00:10.000Z"),
  });

  const result = await processor.process({ leads: { add: [{ id: "100", date: "1784462400" }] } });

  assert.deepEqual(result, { accepted: 0, ignored: 1, duplicates: 0, requiresFreshRead: 0 });
  assert.equal(recordCalls, 0);
});

test("rejects the protected endpoint without processing when its path secret is wrong", async () => {
  let processCalls = 0;
  const handler = createProtectedLeadInactivityWebhookHandler({
    secret: "correct-secret",
    processor: { process: async () => { processCalls += 1; return { accepted: 1, ignored: 0, duplicates: 0, requiresFreshRead: 0 }; } },
  });
  const response = responseRecorder();

  await handler({ params: { secret: "wrong-secret" }, body: {} }, response);

  assert.equal(response.statusCode, 404);
  assert.equal(processCalls, 0);
});

test("mounts the isolated inactivity webhook on a secret-only path", () => {
  const router = createLeadInactivityWebhookRouter({
    secret: "correct-secret",
    processor: { process: async () => ({ accepted: 0, ignored: 0, duplicates: 0, requiresFreshRead: 0 }) },
  });
  const route = router.stack.find((layer) => layer.route)?.route;

  assert.equal(route?.path, "/webhooks/amocrm/inactivity/:secret");
  assert.ok(route?.methods.post);
});

test("acknowledges only after durable processing and returns 503 when persistence fails", async () => {
  const failure = new Error("database unavailable");
  const handler = createProtectedLeadInactivityWebhookHandler({
    secret: "correct-secret",
    processor: { process: async () => { throw failure; } },
  });
  const response = responseRecorder();
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    await handler({ params: { secret: "correct-secret" }, body: {} }, response);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { ok: false, error: "inactivity webhook processing failed" });
  assert.deepEqual(logs, [["[LeadInactivityWebhook] durable processing failed"]]);
});
