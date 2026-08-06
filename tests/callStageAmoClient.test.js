const test = require("node:test");
const assert = require("node:assert/strict");

const { createCallStageAmoClient } = require("../dist/services/callStageAmoClient");

const sourceStatusId = 58160714;
const targetStatusId = 58160726;

function rawLead({ statusId = sourceStatusId, pipelineId = 6909890, customFields = [] } = {}) {
  return {
    id: 42,
    created_at: 1_754_000_000,
    updated_at: 1_754_000_100,
    pipeline_id: pipelineId,
    status_id: statusId,
    responsible_user_id: 99,
    name: "Test lead",
    custom_fields_values: customFields,
  };
}

function makeClient(responses, requests = []) {
  return createCallStageAmoClient({
    baseUrl: "https://tenant.amocrm.ru",
    accessToken: "test-token",
    globalRateLimiter: { async waitForRequestSlot() {} },
    http: {
      async request(request) {
        requests.push(request);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        if (next && next.throw) throw next.throw;
        return next;
      },
    },
  });
}

test("reads only the live lead stage and field values without changing business fields", async () => {
  const client = makeClient([{
    status: 200,
    data: rawLead({ customFields: [{ field_id: 1043357, values: [{ value: "Kaspi" }] }] }),
  }]);

  const lead = await client.readLead(42);
  assert.equal(lead.pipelineId, 6909890);
  assert.equal(lead.statusId, sourceStatusId);
  assert.deepEqual([...lead.fieldValues.entries()], [[1043357, ["Kaspi"]]]);
});

test("re-reads the exact source stage, checks the final fence, patches once, and confirms by readback", async () => {
  const requests = [];
  const client = makeClient([
    { status: 200, data: rawLead() },
    { status: 200, data: rawLead() },
    { status: 200, data: {} },
    { status: 200, data: rawLead({ statusId: targetStatusId }) },
  ], requests);

  const outcome = await client.moveLeadToTarget({
    leadId: 42,
    source: { pipelineId: 6909890, statusId: sourceStatusId },
    target: { pipelineId: 6909890, statusId: targetStatusId },
    isMoveMutationCurrent: async () => true,
  });

  assert.equal(outcome.kind, "confirmed");
  assert.equal(requests.filter((request) => request.method === "PATCH").length, 1);
  assert.deepEqual(requests[2].data, [{ id: 42, pipeline_id: 6909890, status_id: targetStatusId }]);
  assert.equal(requests.every((request) => request.__amoCrmGlobalRateLimitReserved === true), true);
});

test("refuses a stale manager move before PATCH when the lead has changed stage", async () => {
  const requests = [];
  const client = makeClient([
    { status: 200, data: rawLead() },
    { status: 200, data: rawLead({ statusId: 58160718 }) },
  ], requests);

  const outcome = await client.moveLeadToTarget({
    leadId: 42,
    source: { pipelineId: 6909890, statusId: sourceStatusId },
    target: { pipelineId: 6909890, statusId: targetStatusId },
    isMoveMutationCurrent: async () => true,
  });

  assert.deepEqual(outcome, { kind: "not_moved", reason: "source_changed", lead: outcome.lead });
  assert.equal(requests.some((request) => request.method === "PATCH"), false);
});

test("runs the final eligibility guard on the re-read lead before PATCH", async () => {
  const requests = [];
  const client = makeClient([
    { status: 200, data: rawLead() },
    { status: 200, data: rawLead() },
  ], requests);

  const outcome = await client.moveLeadToTarget({
    leadId: 42,
    source: { pipelineId: 6909890, statusId: sourceStatusId },
    target: { pipelineId: 6909890, statusId: targetStatusId },
    isLeadEligibleForTarget: async () => false,
  });

  assert.equal(outcome.kind, "not_moved");
  assert.equal(outcome.reason, "preconditions_changed");
  assert.equal(requests.some((request) => request.method === "PATCH"), false);
});

test("rechecks the durable mutation fence after its PATCH rate slot and before dispatch", async () => {
  const requests = [];
  const client = makeClient([
    { status: 200, data: rawLead() },
    { status: 200, data: rawLead() },
  ], requests);
  let fenceChecks = 0;

  const outcome = await client.moveLeadToTarget({
    leadId: 42,
    source: { pipelineId: 6909890, statusId: sourceStatusId },
    target: { pipelineId: 6909890, statusId: targetStatusId },
    isMoveMutationCurrent: async () => ++fenceChecks < 3,
  });

  assert.equal(outcome.kind, "not_moved");
  assert.equal(outcome.reason, "fence_cancelled");
  assert.equal(fenceChecks, 3);
  assert.equal(requests.some((request) => request.method === "PATCH"), false);
});

test("never retries an ambiguous PATCH; a single readback may prove the move", async () => {
  const requests = [];
  const client = makeClient([
    { status: 200, data: rawLead() },
    { status: 200, data: rawLead() },
    { throw: Object.assign(new Error("reset"), { code: "ECONNRESET" }) },
    { status: 200, data: rawLead({ statusId: targetStatusId }) },
  ], requests);

  const outcome = await client.moveLeadToTarget({
    leadId: 42,
    source: { pipelineId: 6909890, statusId: sourceStatusId },
    target: { pipelineId: 6909890, statusId: targetStatusId },
  });

  assert.equal(outcome.kind, "confirmed");
  assert.equal(requests.filter((request) => request.method === "PATCH").length, 1);
});

test("reads live amoCRM required_statuses for the exact target stage", async () => {
  const requests = [];
  const client = makeClient([{
    status: 200,
    data: {
      _embedded: {
        custom_fields: [
          { id: 10, name: "Требуется в UZUM", required_statuses: [{ pipeline_id: 6909890, status_id: targetStatusId }] },
          { id: 11, name: "Требуется в другой стадии", required_statuses: [{ pipeline_id: 6909890, status_id: sourceStatusId }] },
        ],
      },
    },
  }], requests);

  const fields = await client.getLeadCustomFields();
  assert.deepEqual(fields, [
    { id: 10, name: "Требуется в UZUM", requiredStatuses: [{ pipelineId: 6909890, statusId: targetStatusId }] },
    { id: 11, name: "Требуется в другой стадии", requiredStatuses: [{ pipelineId: 6909890, statusId: sourceStatusId }] },
  ]);
  assert.equal(requests[0].url, "https://tenant.amocrm.ru/api/v4/leads/custom_fields?limit=250&page=1");
});

test("adds a compact stage note only through amoCRM's notes endpoint", async () => {
  const requests = [];
  const client = makeClient([{ status: 200, data: { _embedded: { notes: [{ id: 777 }] } } }], requests);
  const outcome = await client.addStageReasonNote({ leadId: 42, text: "Автоперевод UZUM: квалифицирован." });

  assert.deepEqual(outcome, { kind: "confirmed", noteId: 777 });
  assert.equal(requests[0].url, "https://tenant.amocrm.ru/api/v4/leads/notes");
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(requests[0].data, [{ entity_id: 42, note_type: "common", params: { text: "Автоперевод UZUM: квалифицирован." } }]);
});

test("finds a recent lead-status event through a bounded read-only amoCRM history query", async () => {
  const requests = [];
  const client = makeClient([{
    status: 200,
    data: {
      _embedded: {
        events: [{
          entity_type: "lead",
          entity_id: 42,
          type: "lead_status_changed",
          created_at: 1_754_000_000,
        }],
      },
    },
  }], requests);

  const changedRecently = await client.hasRecentStageMovement({
    leadId: 42,
    since: new Date("2025-07-31T22:00:00.000Z"),
  });

  assert.equal(changedRecently, true);
  assert.equal(requests[0].method, "GET");
  assert.match(requests[0].url, /\/api\/v4\/events\?/);
  assert.match(requests[0].url, /filter%5Bentity%5D=lead/);
  assert.match(requests[0].url, /filter%5Bentity_id%5D%5B%5D=42/);
});

test("treats amoCRM's empty 204 history response as no recent stage movement", async () => {
  const client = makeClient([{ status: 204, data: null }]);

  const changedRecently = await client.hasRecentStageMovement({
    leadId: 42,
    since: new Date("2025-07-31T22:00:00.000Z"),
  });

  assert.equal(changedRecently, false);
});
