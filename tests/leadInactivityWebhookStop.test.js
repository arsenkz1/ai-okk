const test = require("node:test");
const assert = require("node:assert/strict");

const { createLeadInactivityWebhookProcessor } = require("../dist/services/leadInactivityWebhook");

// The body shape parseLeadInactivityWebhookEvents accepts: amoCRM form-encoded
// nested keys, already parsed by express into nested objects.
const body = { leads: { update: [{ id: "100", pipeline_id: "6909890", status_id: "58160726", updated_at: "1757900000" }] } };

test("a stopped switch drops every event before reading amoCRM or writing a watch", async () => {
  const touched = [];
  const processor = createLeadInactivityWebhookProcessor({
    amo: { async readLead() { touched.push("read"); throw new Error("must not read"); } },
    store: { async recordLeadEvent() { touched.push("record"); throw new Error("must not record"); } },
    isMovementStopped: async () => true,
    now: () => new Date("2026-09-15T05:00:00.000Z"),
  });

  const result = await processor.process(body);

  assert.deepEqual(touched, []);
  assert.equal(result.accepted, 0);
  assert.equal(result.ignored >= 1, true, "the delivery is acknowledged, not errored");
});

test("without a switch wired the processor behaves as before", async () => {
  const touched = [];
  const processor = createLeadInactivityWebhookProcessor({
    amo: { async readLead(id) { touched.push("read"); return { id, createdAt: new Date(), pipelineId: 6909890, statusId: 58160726 }; } },
    store: { async recordLeadEvent() { touched.push("record"); return { ignored: false, duplicate: false, watch: {} }; } },
    now: () => new Date("2026-09-15T05:00:00.000Z"),
  });

  await processor.process(body);
  assert.equal(touched.includes("read"), true);
});
