const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createLeadInactivityAmoClient,
  AMO_INACTIVITY_REQUEST_TIMEOUT_MS,
} = require("../dist/services/leadInactivityAmoClient");

function lead(overrides = {}) {
  return {
    id: 100,
    created_at: 1_784_203_200,
    updated_at: 1_784_210_400,
    pipeline_id: 9055778,
    status_id: 72917586,
    responsible_user_id: 77,
    name: "Fresh lead",
    ...overrides,
  };
}

function createClient({ responses, now = () => new Date("2026-07-19T12:00:00.000Z"), sleep = async () => {} }) {
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
    client: createLeadInactivityAmoClient({
      baseUrl: "https://example.amocrm.ru",
      accessToken: "test-token",
      http,
      now,
      sleep,
    }),
  };
}

test("reads and normalizes a fresh amoCRM lead with guarded request settings", async () => {
  const { client, requests } = createClient({ responses: [{ status: 200, data: lead(), headers: {} }] });

  const result = await client.readLead(100);

  assert.deepEqual(result, {
    id: 100,
    createdAt: new Date("2026-07-16T12:00:00.000Z"),
    updatedAt: new Date("2026-07-16T14:00:00.000Z"),
    pipelineId: 9055778,
    statusId: 72917586,
    responsibleUserId: 77,
    name: "Fresh lead",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].url, "https://example.amocrm.ru/api/v4/leads/100");
  assert.equal(requests[0].timeout, AMO_INACTIVITY_REQUEST_TIMEOUT_MS);
  assert.equal(requests[0].headers.Authorization, "Bearer test-token");
});

test("retries safe reads after Retry-After without exceeding the retry delay", async () => {
  let currentTime = new Date("2026-07-19T12:00:00.000Z");
  const sleeps = [];
  const rateLimited = Object.assign(new Error("rate limited"), {
    response: { status: 429, headers: { "retry-after": "2" } },
  });
  const { client, requests } = createClient({
    responses: [rateLimited, { status: 200, data: lead(), headers: {} }],
    now: () => currentTime,
    sleep: async (ms) => {
      sleeps.push(ms);
      currentTime = new Date(currentTime.getTime() + ms);
    },
  });

  const result = await client.readLead(100);

  assert.equal(result.id, 100);
  assert.equal(requests.length, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test("applies Retry-After as a shared cooldown to a concurrent safe read", async () => {
  let currentTime = new Date("2026-07-19T12:00:00.000Z");
  let callCount = 0;
  const waits = [];
  const sleepers = [];
  const rateLimited = Object.assign(new Error("rate limited"), {
    response: { status: 429, headers: { "retry-after": "2" } },
  });
  const client = createLeadInactivityAmoClient({
    baseUrl: "https://example.amocrm.ru",
    accessToken: "test-token",
    now: () => currentTime,
    sleep: (ms) => new Promise((resolve) => {
      waits.push(ms);
      sleepers.push({ ms, resolve });
    }),
    http: {
      request: async () => {
        callCount += 1;
        if (callCount === 1) throw rateLimited;
        return { status: 200, data: lead(), headers: {} };
      },
    },
  });
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (predicate()) return;
      await Promise.resolve();
    }
    throw new Error("timed out waiting for scheduled client sleep");
  };

  const first = client.readLead(100);
  await waitFor(() => sleepers.length === 1);
  const sibling = client.readLead(101);
  await waitFor(() => sleepers.length === 2);

  assert.deepEqual(waits, [2_000, 2_000]);

  while (sleepers.length) {
    const batch = sleepers.splice(0);
    currentTime = new Date(currentTime.getTime() + Math.max(...batch.map(({ ms }) => ms)));
    batch.forEach(({ resolve }) => resolve());
    await Promise.resolve();
  }
  await Promise.all([first, sibling]);
});

test("applies PATCH Retry-After as a shared cooldown for the next amoCRM request", async () => {
  let currentTime = new Date("2026-07-19T12:00:00.000Z");
  const sleeps = [];
  const rateLimited = Object.assign(new Error("rate limited"), {
    response: { status: 429, headers: { "retry-after": "2" } },
  });
  const { client } = createClient({
    responses: [
      { status: 200, data: lead(), headers: {} },
      rateLimited,
      { status: 200, data: lead(), headers: {} },
    ],
    now: () => currentTime,
    sleep: async (ms) => {
      sleeps.push(ms);
      currentTime = new Date(currentTime.getTime() + ms);
    },
  });

  const outcome = await client.moveLeadToTarget(100, {
    sourcePipelineIds: [9055778, 6909890],
    targetPipelineId: 9055770,
    targetStatusId: 72917546,
  });
  await client.readLead(101);

  assert.equal(outcome.kind, "not_moved");
  assert.deepEqual(sleeps, [500, 2_000]);
});

test("reads bounded direct-lead history using the documented entity filters", async () => {
  const page = (offset) => Array.from({ length: 100 }, (_, index) => ({
    id: `${offset + index}`,
    entity_type: "lead",
    entity_id: 100,
    created_at: 1_784_160_000 + index,
    type: 1,
  }));
  const { client, requests } = createClient({
    responses: [
      { status: 200, data: { _embedded: { events: page(0) } }, headers: {} },
      { status: 200, data: { _embedded: { events: page(100) } }, headers: {} },
    ],
  });

  const history = await client.readLeadHistory(100, { maxPages: 2, pageSize: 100 });

  assert.equal(history.length, 200);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /filter%5Bentity%5D=lead/);
  assert.match(requests[0].url, /filter%5Bentity_id%5D%5B%5D=100/);
  assert.match(requests[0].url, /limit=100&page=1/);
  assert.match(requests[1].url, /page=2/);
});

test("moves a freshly read lead while preserving its responsible manager and confirms by read-back", async () => {
  const { client, requests } = createClient({
    responses: [
      { status: 200, data: lead(), headers: {} },
      { status: 200, data: [lead({ pipeline_id: 9055770, status_id: 72917546 })], headers: {} },
      { status: 200, data: lead({ pipeline_id: 9055770, status_id: 72917546 }), headers: {} },
    ],
  });

  const outcome = await client.moveLeadToTarget(100, {
    sourcePipelineIds: [9055778, 6909890],
    targetPipelineId: 9055770,
    targetStatusId: 72917546,
  });

  assert.equal(outcome.kind, "confirmed");
  assert.equal(outcome.lead.responsibleUserId, 77);
  assert.equal(requests[1].method, "PATCH");
  assert.deepEqual(requests[1].data, {
    id: 100,
    pipeline_id: 9055770,
    status_id: 72917546,
    responsible_user_id: 77,
  });
  assert.equal(requests[2].method, "GET");
});

test("treats an HTTP 408 PATCH response as uncertain and performs read-back", async () => {
  const timeoutResponse = Object.assign(new Error("request timeout"), {
    response: { status: 408, headers: {} },
  });
  const { client, requests } = createClient({
    responses: [
      { status: 200, data: lead(), headers: {} },
      timeoutResponse,
      { status: 200, data: lead(), headers: {} },
    ],
  });

  const outcome = await client.moveLeadToTarget(100, {
    sourcePipelineIds: [9055778, 6909890],
    targetPipelineId: 9055770,
    targetStatusId: 72917546,
  });

  assert.equal(outcome.kind, "uncertain");
  assert.equal(requests.length, 3);
});

test("treats a resolved HTTP 409 PATCH response as uncertain rather than confirming it", async () => {
  const { client, requests } = createClient({
    responses: [
      { status: 200, data: lead(), headers: {} },
      { status: 409, data: { title: "Conflict" }, headers: {} },
      { status: 200, data: lead({ pipeline_id: 9055770, status_id: 72917546 }), headers: {} },
    ],
  });

  const outcome = await client.moveLeadToTarget(100, {
    sourcePipelineIds: [9055778, 6909890],
    targetPipelineId: 9055770,
    targetStatusId: 72917546,
  });

  assert.equal(outcome.kind, "uncertain");
  assert.equal(requests.length, 3);
});

test("never exposes request credentials in an uncertain movement outcome", async () => {
  const timeout = Object.assign(new Error("timeout"), {
    code: "ECONNABORTED",
    config: { headers: { Authorization: "Bearer very-secret-token" } },
  });
  const { client } = createClient({
    responses: [
      { status: 200, data: lead(), headers: {} },
      timeout,
      { status: 200, data: lead(), headers: {} },
    ],
  });

  const outcome = await client.moveLeadToTarget(100, {
    sourcePipelineIds: [9055778, 6909890],
    targetPipelineId: 9055770,
    targetStatusId: 72917546,
  });

  assert.equal(outcome.kind, "uncertain");
  assert.doesNotMatch(JSON.stringify(outcome), /very-secret-token/);
  assert.equal("config" in outcome.error, false);
});

test("rejects a non-amoCRM base URL before a Bearer token can be sent", () => {
  assert.throws(() => createLeadInactivityAmoClient({
    baseUrl: "https://attacker.example",
    accessToken: "test-token",
    http: { request: async () => ({ status: 200, data: {}, headers: {} }) },
  }), /AMOCRM base URL/);
});

test("never retries an ambiguous PATCH and reports uncertain even if read-back shows target", async () => {
  const timeout = Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
  const { client, requests } = createClient({
    responses: [
      { status: 200, data: lead(), headers: {} },
      timeout,
      { status: 200, data: lead({ pipeline_id: 9055770, status_id: 72917546 }), headers: {} },
    ],
  });

  const outcome = await client.moveLeadToTarget(100, {
    sourcePipelineIds: [9055778, 6909890],
    targetPipelineId: 9055770,
    targetStatusId: 72917546,
  });

  assert.equal(outcome.kind, "uncertain");
  assert.equal(outcome.readback?.pipelineId, 9055770);
  assert.equal(requests.length, 3);
});
