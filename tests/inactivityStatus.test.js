const test = require("node:test");
const assert = require("node:assert/strict");

const { diagnoseInactivity, formatInactivityStatus, readInactivityWorkerEnv } = require("../dist/services/inactivityStatus");

function status(overrides = {}) {
  return {
    workerEnabled: true,
    movementPaused: false,
    testingMode: false,
    activationBoundary: new Date("2026-07-22T05:00:00.000Z"),
    baselineComplete: true,
    operationalStartDate: "2026-08-04",
    watchesByState: { watching: 40 },
    dueNow: 3,
    dailyBucket: "operational:2026-09-08",
    dailyLimit: 100,
    dailyUsed: 12,
    auditsLast24h: { confirmed: 12 },
    testSlotsUsed: 0,
    ...overrides,
  };
}

test("reads the worker switches from the environment", () => {
  assert.deepEqual(readInactivityWorkerEnv({ AMOCRM_INACTIVITY_WORKER_ENABLED: "true", TESTING_LEADS_MOVEMENT: "false" }), { workerEnabled: true, testingMode: false });
  assert.deepEqual(readInactivityWorkerEnv({ AMOCRM_INACTIVITY_WORKER_ENABLED: "TRUE ", TESTING_LEADS_MOVEMENT: "true" }), { workerEnabled: true, testingMode: true });
  // A missing or malformed mode is reported, not guessed.
  assert.deepEqual(readInactivityWorkerEnv({}), { workerEnabled: false, testingMode: null });
  assert.deepEqual(readInactivityWorkerEnv({ TESTING_LEADS_MOVEMENT: "yes" }).testingMode, null);
});

test("reports nothing blocking on a healthy production worker", () => {
  assert.equal(diagnoseInactivity(status()), null);
  assert.equal(formatInactivityStatus(status()).includes("✅ Блокировок нет"), true);
});

test("names the blocker in the order the worker itself checks them", () => {
  assert.match(diagnoseInactivity(status({ workerEnabled: false })), /выключен/);
  // The operator switch outranks every gate except the environment flag.
  assert.match(diagnoseInactivity(status({ movementPaused: true })), /\/inactivity_off/);
  assert.match(diagnoseInactivity(status({ movementPaused: true, testingMode: null })), /\/inactivity_off/);
  assert.match(diagnoseInactivity(status({ testingMode: null })), /TESTING_LEADS_MOVEMENT/);
  assert.match(diagnoseInactivity(status({ testingMode: true, testSlotsUsed: 5 })), /все 5 тестовых слотов/);
  assert.match(diagnoseInactivity(status({ testingMode: true, testSlotsUsed: 2 })), /использовано 2/);
  assert.match(diagnoseInactivity(status({ activationBoundary: null })), /граница активации/);
  assert.match(diagnoseInactivity(status({ baselineComplete: false })), /baseline не завершён/);
  assert.match(diagnoseInactivity(status({ watchesByState: { watching: 40, uncertain: 2 } })), /2 лидов в состоянии uncertain/);
  assert.match(diagnoseInactivity(status({ dailyUsed: 100 })), /лимит исчерпан: 100\/100/);
  assert.match(diagnoseInactivity(status({ watchesByState: {} })), /вебхуки/);
  assert.match(diagnoseInactivity(status({ auditsLast24h: { failed: 7 } })), /7 неудачных/);
});

test("a quiet queue is not a failure", () => {
  // Nothing due yet means the leads simply have not been idle for 72 hours.
  assert.equal(diagnoseInactivity(status({ dueNow: 0, auditsLast24h: {} })), null);
});

test("renders every watch state, the daily cap and the last day's outcomes", () => {
  const text = formatInactivityStatus(status({ watchesByState: { watching: 40, moved: 5 }, auditsLast24h: { confirmed: 5, skipped: 2 } }));
  assert.equal(text.includes("Воркер: включён · боевой"), true);
  assert.equal(text.includes("Переводы: ▶️ разрешены"), true);
  assert.equal(formatInactivityStatus(status({ movementPaused: true })).includes("Переводы: ⏸ остановлены командой"), true);
  assert.equal(text.includes("• watching: 40"), true);
  assert.equal(text.includes("• moved: 5"), true);
  assert.equal(text.includes("• uncertain: 0"), true);
  assert.equal(text.includes("• к переводу прямо сейчас: 3"), true);
  assert.equal(text.includes("Суточный лимит (operational:2026-09-08): 12/100"), true);
  assert.equal(text.includes("• confirmed: 5"), true);
  assert.equal(text.includes("• skipped: 2"), true);
});

test("shows the testing mode and its spent slots in the header", () => {
  const text = formatInactivityStatus(status({ testingMode: true, testSlotsUsed: 3 }));
  assert.equal(text.includes("тестовый (лимит 5, использовано 3)"), true);
});
