const test = require("node:test");
const assert = require("node:assert/strict");

const { startConfiguredLeadInactivityWorker } = require("../dist/services/leadInactivityWorkerRuntime");

const enabledEnvironment = {
  AMOCRM_INACTIVITY_WORKER_ENABLED: "true",
  TESTING_LEADS_MOVEMENT: "true",
  AMOCRM_INACTIVITY_WEBHOOK_SECRET: "dedicated-secret",
  AMOCRM_BASE_URL: "https://example.amocrm.ru",
  AMOCRM_ACCESS_TOKEN: "test-token",
};

test("keeps the movement worker absent unless its explicit enable flag is true", () => {
  const started = startConfiguredLeadInactivityWorker({ environment: { ...enabledEnvironment, AMOCRM_INACTIVITY_WORKER_ENABLED: undefined } });
  assert.equal(started, null);
});

test("fails closed unless the strict testing movement flag and webhook prerequisites are present", () => {
  assert.throws(
    () => startConfiguredLeadInactivityWorker({ environment: { ...enabledEnvironment, TESTING_LEADS_MOVEMENT: "false" } }),
    /requires TESTING_LEADS_MOVEMENT=true/,
  );
  assert.throws(
    () => startConfiguredLeadInactivityWorker({ environment: { ...enabledEnvironment, AMOCRM_INACTIVITY_WEBHOOK_SECRET: undefined } }),
    /requires AMOCRM_INACTIVITY_WEBHOOK_SECRET/,
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
