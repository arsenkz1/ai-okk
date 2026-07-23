const test = require("node:test");
const assert = require("node:assert/strict");

const {
  startConfiguredLeadInactivityWorker,
  resolveInactivityDelayMs,
  resolveTestingLeadMovementMode,
} = require("../dist/services/leadInactivityWorkerRuntime");

const enabledEnvironment = {
  AMOCRM_INACTIVITY_WORKER_ENABLED: "true",
  TESTING_LEADS_MOVEMENT: "true",
  AMOCRM_INACTIVITY_WEBHOOK_SECRET: "dedicated-secret",
  AMOCRM_BASE_URL: "https://example.amocrm.ru",
  AMOCRM_ACCESS_TOKEN: "test-token",
};

test("uses a whole-hour configured inactivity delay and retains the 72-hour default", () => {
  assert.equal(resolveInactivityDelayMs("24"), 24 * 60 * 60 * 1000);
  assert.equal(resolveInactivityDelayMs(undefined), 72 * 60 * 60 * 1000);
  assert.throws(() => resolveInactivityDelayMs("0"), /positive whole number of hours/);
});

test("keeps the movement worker absent unless its explicit enable flag is true", () => {
  const started = startConfiguredLeadInactivityWorker({ environment: { ...enabledEnvironment, AMOCRM_INACTIVITY_WORKER_ENABLED: undefined } });
  assert.equal(started, null);
});

test("requires an explicit true or false movement mode while retaining webhook prerequisites", () => {
  assert.equal(resolveTestingLeadMovementMode("true"), true);
  assert.equal(resolveTestingLeadMovementMode("false"), false);
  assert.throws(
    () => resolveTestingLeadMovementMode(undefined),
    /TESTING_LEADS_MOVEMENT must be explicitly true or false/,
  );
  assert.throws(
    () => resolveTestingLeadMovementMode("enabled"),
    /TESTING_LEADS_MOVEMENT must be explicitly true or false/,
  );
  assert.throws(
    () => startConfiguredLeadInactivityWorker({ environment: { ...enabledEnvironment, AMOCRM_INACTIVITY_WEBHOOK_SECRET: undefined } }),
    /requires AMOCRM_INACTIVITY_WEBHOOK_SECRET/,
  );
});

test("passes the explicit unrestricted mode to the worker factory and rejects an unrestricted delay below 72 hours", () => {
  const modes = [];
  const started = startConfiguredLeadInactivityWorker({
    environment: { ...enabledEnvironment, TESTING_LEADS_MOVEMENT: "false" },
    dependencies: {
      createWorker: (testingMode) => {
        modes.push(testingMode);
        return { runOnce: async () => ({ scanned: 0, claimed: 0, moved: 0, deferred: 0, uncertain: 0, failed: 0 }) };
      },
      schedule: () => ({ id: 1 }),
      clearSchedule: () => {},
      log: () => {},
    },
  });

  assert.deepEqual(modes, [false]);
  assert.equal(started.testingMode, false);
  started.stop();
  assert.throws(
    () => startConfiguredLeadInactivityWorker({
      environment: { ...enabledEnvironment, TESTING_LEADS_MOVEMENT: "false", AMOCRM_INACTIVITY_DELAY_HOURS: "24" },
      dependencies: {
        createWorker: () => ({ runOnce: async () => ({ scanned: 0, claimed: 0, moved: 0, deferred: 0, uncertain: 0, failed: 0 }) }),
        schedule: () => ({ id: 1 }),
        clearSchedule: () => {},
      },
    }),
    /requires AMOCRM_INACTIVITY_DELAY_HOURS=72/,
  );
});

test("schedules capped worker passes at exactly one minute without an eager movement run", async () => {
  const intervals = [];
  let runs = 0;
  const worker = { runOnce: async () => { runs += 1; return { scanned: 0, claimed: 0, moved: 0, deferred: 0, uncertain: 0, failed: 0 }; } };
  const started = startConfiguredLeadInactivityWorker({
    environment: enabledEnvironment,
    dependencies: {
      createWorker: () => worker,
      schedule: (callback, intervalMs) => { intervals.push({ callback, intervalMs }); return { id: 1 }; },
      clearSchedule: () => {},
      log: () => {},
    },
  });

  assert.equal(runs, 0);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].intervalMs, 60_000);
  await intervals[0].callback();
  assert.equal(runs, 1);
  started.stop();
});

test("serializes overlapping timer callbacks instead of allowing concurrent amoCRM movement passes", async () => {
  const intervals = [];
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  let runs = 0;
  const started = startConfiguredLeadInactivityWorker({
    environment: enabledEnvironment,
    dependencies: {
      createWorker: () => ({ runOnce: async () => { runs += 1; await pending; return { scanned: 0, claimed: 0, moved: 0, deferred: 0, uncertain: 0, failed: 0 }; } }),
      schedule: (callback, intervalMs) => { intervals.push({ callback, intervalMs }); return { id: 1 }; },
      clearSchedule: () => {},
      log: () => {},
    },
  });

  const first = intervals[0].callback();
  await Promise.resolve();
  await intervals[0].callback();
  assert.equal(runs, 1);
  finish();
  await first;
  started.stop();
});
