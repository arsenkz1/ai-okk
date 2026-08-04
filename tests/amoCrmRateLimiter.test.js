const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const {
  AMOCRM_GLOBAL_MAX_REQUESTS_PER_SECOND,
  AMOCRM_GLOBAL_MIN_REQUEST_INTERVAL_MS,
  createPrismaAmoCrmRateSlotStore,
  createAmoCrmAxiosRequestGate,
  createAmoCrmGlobalRateLimiter,
  isAmoCrmRequestUrl,
  normalizeAmoCrmTenantBaseUrl,
} = require("../dist/services/amoCrmRateLimiter");

function createSlotStore(initialDelayMs = 0) {
  let nextScheduledAtMs = initialDelayMs;
  return {
    reserveRequestSlot: async () => {
      const scheduledAtMs = nextScheduledAtMs;
      nextScheduledAtMs += AMOCRM_GLOBAL_MIN_REQUEST_INTERVAL_MS;
      return { delayMs: scheduledAtMs, scheduledAtMs };
    },
    readCurrentTimeMs: async () => 0,
    nextScheduledAtMs: () => nextScheduledAtMs,
  };
}

test("reserves the shared request schedule and delay from one database-authoritative clock query", async () => {
  let queryText = "";
  let values = [];
  const store = createPrismaAmoCrmRateSlotStore({
    $queryRaw: async (strings, ...parameters) => {
      queryText = strings.join("?");
      values = parameters;
      return [{ delayMs: 200n, scheduledAtMs: 1_000n }];
    },
  });

  const reservation = await store.reserveRequestSlot();

  assert.deepEqual(reservation, { delayMs: 200, scheduledAtMs: 1_000 });
  assert.match(queryText, /ON CONFLICT/);
  assert.match(queryText, /clock_timestamp\(\)/);
  assert.match(queryText, /RETURNING/);
  assert.match(queryText, /"scheduledAt"/);
  assert.ok(values.includes("amocrm.global_request_rate_limit"));
});

test("serializes six shared amoCRM request slots at no more than five per second", async () => {
  const store = createSlotStore();
  const sleeps = [];
  const limiter = createAmoCrmGlobalRateLimiter({
    store,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  await Promise.all(Array.from({ length: 6 }, () => limiter.waitForRequestSlot()));

  assert.equal(AMOCRM_GLOBAL_MAX_REQUESTS_PER_SECOND, 5);
  assert.equal(AMOCRM_GLOBAL_MIN_REQUEST_INTERVAL_MS, 260);
  assert.deepEqual([...sleeps].sort((left, right) => left - right), [260, 520, 780, 1040, 1300]);
  assert.equal(store.nextScheduledAtMs(), 1560);
});

test("two independently constructed replica limiters share database-issued delays without using local clocks", async () => {
  const store = createSlotStore();
  const waits = [];
  const firstReplica = createAmoCrmGlobalRateLimiter({
    store,
    sleep: async (ms) => { waits.push(["first", ms]); },
  });
  const secondReplica = createAmoCrmGlobalRateLimiter({
    store,
    sleep: async (ms) => { waits.push(["second", ms]); },
  });

  await Promise.all([firstReplica.waitForRequestSlot(), secondReplica.waitForRequestSlot()]);

  assert.deepEqual(waits, [["second", 260]]);
  assert.equal(store.nextScheduledAtMs(), 520);
});

test("fails closed rather than overflowing Node's timer for a far-future database reservation", async () => {
  let slept = false;
  const limiter = createAmoCrmGlobalRateLimiter({
    store: { reserveRequestSlot: async () => ({ delayMs: 3_000_000_000, scheduledAtMs: 3_000_000_000 }), readCurrentTimeMs: async () => 0 },
    sleep: async () => { slept = true; },
  });

  await assert.rejects(limiter.waitForRequestSlot(), /delay exceeds the safe timer range/);
  assert.equal(slept, false);
});

test("abandons an overdue slot and re-reserves from the database clock before dispatch", async () => {
  let reservations = 0;
  const observedDatabaseTimes = [1_000, 1_260];
  const limiter = createAmoCrmGlobalRateLimiter({
    store: {
      reserveRequestSlot: async () => {
        reservations += 1;
        return reservations === 1
          ? { scheduledAtMs: 0, delayMs: 0 }
          : { scheduledAtMs: 1_260, delayMs: 0 };
      },
      readCurrentTimeMs: async () => observedDatabaseTimes.shift(),
    },
  });

  await limiter.waitForRequestSlot();

  assert.equal(reservations, 2);
});

test("limits only HTTPS amoCRM tenant requests and leaves other APIs outside the amoCRM budget", () => {
  assert.equal(isAmoCrmRequestUrl("https://example.amocrm.ru/api/v4/leads"), true);
  assert.equal(isAmoCrmRequestUrl("https://example.amocrm.com/api/v4/leads"), true);
  assert.equal(isAmoCrmRequestUrl("https://api2.onlinepbx.ru/x"), false);
  assert.equal(isAmoCrmRequestUrl("https://example.amocrm.ru.evil.test/x"), false);
});

test("normalizes only an HTTPS amoCRM tenant origin for legacy clients", () => {
  assert.equal(normalizeAmoCrmTenantBaseUrl(" https://tenant.amocrm.ru/ "), "https://tenant.amocrm.ru");
  for (const invalid of [
    "http://tenant.amocrm.ru",
    "https://tenant.amocrm.ru/api/v4",
    "https://api2.onlinepbx.ru",
    "https://user:pass@tenant.amocrm.ru",
  ]) {
    assert.throws(() => normalizeAmoCrmTenantBaseUrl(invalid), /HTTPS amoCRM tenant origin/);
  }
});

test("legacy amoCRM modules reject an HTTP AMOCRM_BASE_URL before they can create credentialed requests", () => {
  const sourceRoot = path.resolve(__dirname, "..");
  for (const entrypoint of ["services/amocrm", "services/amoRights"]) {
    const output = execFileSync(process.execPath, ["-e", [
      "try {",
      `require(${JSON.stringify(path.join(sourceRoot, "dist", entrypoint))});`,
      "process.exit(2);",
      "} catch (error) {",
      "process.stdout.write(String(error.message));",
      "process.exit(0);",
      "}",
    ].join("")], {
      cwd: sourceRoot,
      encoding: "utf8",
      env: { ...process.env, AMOCRM_BASE_URL: "http://tenant.amocrm.ru" },
    });
    assert.match(output, /HTTPS amoCRM tenant origin/, entrypoint);
  }
});

test("the axios gate reserves one shared amoCRM slot unless a caller already reserved it before a PATCH fence", async () => {
  let slots = 0;
  const gate = createAmoCrmAxiosRequestGate({
    waitForRequestSlot: async () => { slots += 1; },
  });

  await gate({ url: "https://example.amocrm.ru/api/v4/leads" });
  await gate({ url: "https://api2.onlinepbx.ru/x" });
  await gate({ url: "https://example.amocrm.ru/api/v4/leads/1", __amoCrmGlobalRateLimitReserved: true });

  assert.equal(slots, 1);
});

test("every amoCRM axios entrypoint installs the shared global rate gate before requests", () => {
  const sourceRoot = path.resolve(__dirname, "..");
  const entrypoints = [
    "services/amocrm",
    "services/amoRights",
    "services/callTaskAmoClient",
    "services/leadInactivityAmoClient",
    "services/leadInactivityAmoSubscription",
  ];

  for (const entrypoint of entrypoints) {
    const output = execFileSync(process.execPath, ["-e", [
      `require(${JSON.stringify(path.join(sourceRoot, "dist", entrypoint))});`,
      "const axios = require('axios');",
      "process.stdout.write(String(axios.interceptors.request.handlers.filter(Boolean).length));",
      "process.exit(0);",
    ].join("")], { cwd: sourceRoot, encoding: "utf8" });
    assert.equal(output.trim().split("\n").at(-1), "1", entrypoint);
  }
});
