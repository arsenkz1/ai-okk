const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCallTaskAmoClient,
  AMO_CALL_TASK_REQUEST_TIMEOUT_MS,
} = require("../dist/services/callTaskAmoClient");

function lead(overrides = {}) {
  return {
    id: 100,
    created_at: 1_785_888_000,
    updated_at: 1_785_895_200,
    pipeline_id: 9055778,
    status_id: 72917586,
    responsible_user_id: 77,
    name: "Fresh lead",
    closed_at: null,
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    id: 991,
    entity_id: 100,
    entity_type: "leads",
    responsible_user_id: 77,
    text: "Klientga kurs dasturini yuborish",
    complete_till: 1_785_977_200,
    task_type_id: 1,
    ...overrides,
  };
}

function createClient({ responses, now = () => new Date("2026-08-04T07:00:00.000Z"), sleep = async () => {} }) {
  const requests = [];
  const queue = [...responses];
  const http = {
    request: async (config) => {
      requests.push(config);
      const response = queue.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return {
    requests,
    client: createCallTaskAmoClient({
      baseUrl: "https://example.amocrm.ru",
      accessToken: "test-token",
      http,
      now,
      sleep,
    }),
  };
}

test("freshly reads and normalizes the amoCRM lead before action analysis", async () => {
  const { client, requests } = createClient({ responses: [{ status: 200, data: lead(), headers: {} }] });
  const result = await client.readLead(100);

  assert.deepEqual(result, {
    id: 100,
    createdAt: new Date("2026-08-05T00:00:00.000Z"),
    updatedAt: new Date("2026-08-05T02:00:00.000Z"),
    responsibleUserId: 77,
    name: "Fresh lead",
    closedAt: null,
  });
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].url, "https://example.amocrm.ru/api/v4/leads/100");
  assert.equal(requests[0].headers.Authorization, "Bearer test-token");
  assert.equal(requests[0].timeout, AMO_CALL_TASK_REQUEST_TIMEOUT_MS);
});

test("creates a task only after fresh read and validates exact entity, owner, text, and deadline by read-back", async () => {
  const dueAt = new Date("2026-08-05T10:00:00.000Z");
  const { client, requests } = createClient({ responses: [
    { status: 200, data: lead(), headers: {} },
    { status: 200, data: { _embedded: { tasks: [{ id: 991, request_id: "cta-100" }] } }, headers: {} },
    { status: 200, data: task({ complete_till: Math.floor(dueAt.getTime() / 1000) }), headers: {} },
  ] });

  const result = await client.createVerifiedTask({
    leadId: 100,
    fallbackResponsibleUserId: 88,
    taskText: "Klientga kurs dasturini yuborish",
    dueAt,
    requestId: "cta-100",
  });

  assert.deepEqual(result, {
    kind: "confirmed",
    lead: {
      id: 100,
      createdAt: new Date("2026-08-05T00:00:00.000Z"),
      updatedAt: new Date("2026-08-05T02:00:00.000Z"),
      responsibleUserId: 77,
      name: "Fresh lead",
      closedAt: null,
    },
    task: {
      id: 991,
      entityId: 100,
      entityType: "leads",
      responsibleUserId: 77,
      text: "Klientga kurs dasturini yuborish",
      completeTill: dueAt,
      taskTypeId: 1,
    },
  });
  assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST", "GET"]);
  assert.deepEqual(requests[1].data, [{
    entity_id: 100,
    entity_type: "leads",
    responsible_user_id: 77,
    task_type_id: 1,
    text: "Klientga kurs dasturini yuborish",
    complete_till: Math.floor(dueAt.getTime() / 1000),
    request_id: "cta-100",
  }]);
  assert.equal(requests[2].url, "https://example.amocrm.ru/api/v4/tasks/991");
});

test("uses the call manager only when amoCRM lead owner is absent", async () => {
  const dueAt = new Date("2026-08-05T10:00:00.000Z");
  const { client, requests } = createClient({ responses: [
    { status: 200, data: lead({ responsible_user_id: null }), headers: {} },
    { status: 200, data: { _embedded: { tasks: [{ id: 992, request_id: "fallback" }] } }, headers: {} },
    { status: 200, data: task({ id: 992, responsible_user_id: 88, complete_till: Math.floor(dueAt.getTime() / 1000) }), headers: {} },
  ] });

  const result = await client.createVerifiedTask({
    leadId: 100,
    fallbackResponsibleUserId: 88,
    taskText: "Klientga kurs dasturini yuborish",
    dueAt,
    requestId: "fallback",
  });

  assert.equal(result.kind, "confirmed");
  assert.equal(requests[1].data[0].responsible_user_id, 88);
});

test("does not mutate a closed lead or a lead with no responsible user", async () => {
  const dueAt = new Date("2026-08-05T10:00:00.000Z");
  const closed = createClient({ responses: [{ status: 200, data: lead({ closed_at: 1_785_900_000 }), headers: {} }] });
  const missingOwner = createClient({ responses: [{ status: 200, data: lead({ responsible_user_id: null }), headers: {} }] });

  assert.deepEqual(await closed.client.createVerifiedTask({
    leadId: 100, fallbackResponsibleUserId: null, taskText: "Klientga kurs dasturini yuborish", dueAt, requestId: "closed",
  }), { kind: "not_created", reason: "lead_closed", lead: {
    id: 100, createdAt: new Date("2026-08-05T00:00:00.000Z"), updatedAt: new Date("2026-08-05T02:00:00.000Z"), responsibleUserId: 77, name: "Fresh lead", closedAt: new Date("2026-08-05T03:20:00.000Z"),
  } });
  assert.equal(closed.requests.length, 1);

  const missingResult = await missingOwner.client.createVerifiedTask({
    leadId: 100, fallbackResponsibleUserId: null, taskText: "Klientga kurs dasturini yuborish", dueAt, requestId: "missing-owner",
  });
  assert.equal(missingResult.kind, "not_created");
  assert.equal(missingResult.reason, "missing_responsible_user");
  assert.equal(missingOwner.requests.length, 1);
});

test("never blindly retries a task POST and performs bounded authoritative read-back after an ambiguous outcome", async () => {
  const dueAt = new Date("2026-08-05T10:00:00.000Z");
  const timeout = Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
  const uncorrelated = createClient({ responses: [
    { status: 200, data: lead(), headers: {} },
    timeout,
    { status: 200, data: { _embedded: { tasks: [task({ id: 994, complete_till: Math.floor(dueAt.getTime() / 1000) })] } }, headers: {} },
  ] });
  const correlated = createClient({ responses: [
    { status: 200, data: lead(), headers: {} },
    timeout,
    { status: 200, data: { _embedded: { tasks: [{ ...task({ id: 995, complete_till: Math.floor(dueAt.getTime() / 1000) }), request_id: "timeout-correlated" }] } }, headers: {} },
  ] });
  const noMatch = createClient({ responses: [
    { status: 200, data: lead(), headers: {} },
    timeout,
    { status: 200, data: { _embedded: { tasks: [] } }, headers: {} },
    { status: 200, data: { _embedded: { tasks: [] } }, headers: {} },
    { status: 200, data: { _embedded: { tasks: [] } }, headers: {} },
  ] });
  const mismatch = createClient({ responses: [
    { status: 200, data: lead(), headers: {} },
    { status: 200, data: { _embedded: { tasks: [{ id: 993, request_id: "mismatch" }] } }, headers: {} },
    { status: 200, data: task({ id: 993, entity_id: 999, complete_till: Math.floor(dueAt.getTime() / 1000) }), headers: {} },
  ] });

  const uncorrelatedResult = await uncorrelated.client.createVerifiedTask({
    leadId: 100, fallbackResponsibleUserId: 88, taskText: "Klientga kurs dasturini yuborish", dueAt, requestId: "timeout",
  });
  assert.equal(uncorrelatedResult.kind, "uncertain");
  assert.deepEqual(uncorrelated.requests.map(({ method }) => method), ["GET", "POST", "GET", "GET", "GET"]);
  assert.match(uncorrelated.requests[2].url, /filter%5Bentity_type%5D=leads/);
  assert.match(uncorrelated.requests[2].url, /filter%5Bentity_id%5D=100/);

  const correlatedResult = await correlated.client.createVerifiedTask({
    leadId: 100, fallbackResponsibleUserId: 88, taskText: "Klientga kurs dasturini yuborish", dueAt, requestId: "timeout-correlated",
  });
  assert.equal(correlatedResult.kind, "confirmed");
  assert.deepEqual(correlated.requests.map(({ method }) => method), ["GET", "POST", "GET"]);

  const noMatchResult = await noMatch.client.createVerifiedTask({
    leadId: 100, fallbackResponsibleUserId: 88, taskText: "Klientga kurs dasturini yuborish", dueAt, requestId: "no-match",
  });
  assert.equal(noMatchResult.kind, "uncertain");
  assert.deepEqual(noMatch.requests.map(({ method }) => method), ["GET", "POST", "GET", "GET", "GET"]);

  const mismatchResult = await mismatch.client.createVerifiedTask({
    leadId: 100, fallbackResponsibleUserId: 88, taskText: "Klientga kurs dasturini yuborish", dueAt, requestId: "mismatch",
  });
  assert.equal(mismatchResult.kind, "uncertain");
  assert.deepEqual(mismatch.requests.map(({ method }) => method), ["GET", "POST", "GET"]);
});

test("adds one common lead note only when explicitly instructed after task confirmation", async () => {
  const { client, requests } = createClient({ responses: [{ status: 200, data: { _embedded: { notes: [{ id: 10 }] } }, headers: {} }] });
  const result = await client.addTaskReasonNote({ leadId: 100, text: "🤖 AI vazifa: kurs dasturini yuborish" });

  assert.deepEqual(result, { kind: "confirmed", noteId: 10 });
  assert.deepEqual(requests[0].data, [{ note_type: "common", params: { text: "🤖 AI vazifa: kurs dasturini yuborish" } }]);
  assert.equal(requests[0].url, "https://example.amocrm.ru/api/v4/leads/100/notes");
});

test("treats a malformed successful note response as uncertain rather than confirmed", async () => {
  const { client } = createClient({ responses: [{ status: 200, data: { _embedded: { notes: [] } }, headers: {} }] });
  const result = await client.addTaskReasonNote({ leadId: 100, text: "🤖 AI vazifa: kurs dasturini yuborish" });
  assert.equal(result.kind, "uncertain");
});

test("rejects a non-amoCRM HTTPS base URL before credentials can be sent", () => {
  assert.throws(() => createCallTaskAmoClient({
    baseUrl: "https://example.invalid",
    accessToken: "test-token",
  }), /valid amoCRM HTTPS tenant URL/);
});
