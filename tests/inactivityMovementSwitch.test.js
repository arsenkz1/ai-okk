const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getInactivityMovementSwitch,
  isInactivityMovementPaused,
  setInactivityMovementPaused,
  formatInactivityMovementSwitch,
  INACTIVITY_MOVEMENT_PAUSED_SETTING_KEY,
} = require("../dist/services/inactivityMovementSwitch");
const { createLeadInactivityWorker } = require("../dist/workers/leadInactivityWorker");

function fakeDatabase(initial = null, watches = []) {
  const rows = new Map();
  if (initial !== null) rows.set(INACTIVITY_MOVEMENT_PAUSED_SETTING_KEY, initial);
  return {
    rows,
    watches,
    leadInactivityWatch: {
      async updateMany({ where, data }) {
        let count = 0;
        for (const watch of watches) {
          if (where.state.in.includes(watch.state)) { Object.assign(watch, data); count += 1; }
        }
        return { count };
      },
    },
    leadInactivitySetting: {
      async findUnique({ where }) {
        const value = rows.get(where.key);
        return value === undefined ? null : { value };
      },
      async upsert({ where, update, create }) {
        rows.set(where.key, rows.has(where.key) ? update.value : create.value);
      },
    },
  };
}

test("defaults to running when the switch has never been touched", async () => {
  const database = fakeDatabase();
  assert.deepEqual(await getInactivityMovementSwitch(database), { paused: false, changedBy: null, changedAt: null });
  assert.equal(await isInactivityMovementPaused(database), false);
});

test("records who paused it and when, and reads it back", async () => {
  const database = fakeDatabase();
  const at = new Date("2026-09-15T05:00:00.000Z");
  const state = await setInactivityMovementPaused(true, "295612129", database, at);

  assert.deepEqual(state, { paused: true, changedBy: "295612129", changedAt: at, clearedWatches: 0 });
  // Reading back returns the stored state; the cleared count is per-operation.
  assert.deepEqual(await getInactivityMovementSwitch(database), { paused: true, changedBy: "295612129", changedAt: at });
  assert.equal(await isInactivityMovementPaused(database), true);
});

test("resuming overwrites the pause in place", async () => {
  const database = fakeDatabase();
  await setInactivityMovementPaused(true, "111", database);
  await setInactivityMovementPaused(false, "222", database);

  const state = await getInactivityMovementSwitch(database);
  assert.equal(state.paused, false);
  assert.equal(state.changedBy, "222");
  assert.equal(database.rows.size, 1, "one row, updated rather than duplicated");
});

test("a corrupt stored value fails towards running, never towards stuck-paused", async () => {
  assert.equal(await isInactivityMovementPaused(fakeDatabase("not json")), false);
  assert.equal(await isInactivityMovementPaused(fakeDatabase('{"paused":"yes"}')), false);
});

test("a stop clears every active watch and leaves final ones alone", async () => {
  const watches = [
    { leadId: 1, state: "watching" },
    { leadId: 2, state: "leased", leaseToken: "t" },
    { leadId: 3, state: "moved" },
    { leadId: 4, state: "uncertain" },
  ];
  const database = fakeDatabase(null, watches);
  const at = new Date("2026-09-15T05:00:00.000Z");

  const state = await setInactivityMovementPaused(true, "111", database, at);

  assert.equal(state.clearedWatches, 2);
  // Nothing is left that could still lead to a move; leases are released too.
  assert.equal(watches.filter((w) => ["watching", "leased"].includes(w.state)).length, 0);
  assert.equal(watches[1].leaseToken, null);
  assert.equal(watches[0].lastFailureReason, "stopped by operator switch");
  assert.deepEqual(watches[0].stoppedAt, at);
  // Already-final rows are not rewritten as if the operator had touched them.
  assert.equal(watches[2].state, "moved");
  assert.equal(watches[3].state, "uncertain");
});

test("turning on clears nothing: watches begin only from the next touch", async () => {
  const watches = [{ leadId: 1, state: "watching" }];
  const state = await setInactivityMovementPaused(false, "111", fakeDatabase(null, watches));
  assert.equal(state.clearedWatches, 0);
  assert.equal(watches[0].state, "watching");
});

test("describes the state in the operator's terms", () => {
  const at = new Date("2026-09-15T05:00:00.000Z"); // 10:00 Almaty
  assert.equal(
    formatInactivityMovementSwitch({ paused: true, changedBy: "295612129", changedAt: at, clearedWatches: 40 }),
    "⛔ Переводы в Феникс ОСТАНОВЛЕНЫ (изменил 295612129, 15.09.2026 10:00). Снято с отслеживания лидов: 40. Новые касания не отслеживаются. Включение начнёт отсчёт заново.",
  );
  assert.equal(
    formatInactivityMovementSwitch({ paused: false, changedBy: null, changedAt: null }),
    "▶️ Переводы в Феникс включены. Лиды берутся под наблюдение со следующего касания.",
  );
});

// The worker must honour the switch before it claims or mutates anything.
function trackingStore() {
  const calls = [];
  const track = (name, value) => async () => { calls.push(name); return value; };
  return {
    calls,
    store: {
      isProductionBaselineComplete: track("baseline", true),
      getDailyMovementOperationalStartDate: track("startDate", "2026-08-04"),
      tryAcquireWorkerRunLease: track("acquire", true),
      renewWorkerRunLease: track("renew", true),
      releaseWorkerRunLease: track("release", true),
      releaseExpiredWatchLeases: track("releaseExpired", undefined),
      ensureTestSlots: track("ensureTestSlots", undefined),
      listDueWatchLeadIds: track("listDue", [42]),
      claimDueWatchForWorkerRun: track("claim", null),
      ensureDailyMovementSlots: track("ensureDaily", undefined),
      hasDailyMovementCapacity: track("hasCapacity", true),
    },
  };
}

test("a paused switch stops the pass before any lead is claimed", async () => {
  const { calls, store } = trackingStore();
  const worker = createLeadInactivityWorker({
    store,
    amo: { async readLead() { throw new Error("must not read"); }, async readLeadHistory() { throw new Error("no"); }, async moveLeadToTarget() { throw new Error("must not move"); } },
    isMovementPaused: async () => true,
    testingMode: false,
  });

  const result = await worker.runOnce();

  assert.equal(result.paused, true);
  assert.equal(result.claimed, 0);
  // Only the run lease is touched; durable state is left exactly as found.
  assert.deepEqual(calls, ["acquire", "release"]);
});

test("a running switch lets the pass proceed as before", async () => {
  const { calls, store } = trackingStore();
  const worker = createLeadInactivityWorker({
    store,
    amo: { async readLead() { throw new Error("unused"); }, async readLeadHistory() { throw new Error("unused"); }, async moveLeadToTarget() { throw new Error("unused"); } },
    isMovementPaused: async () => false,
    testingMode: false,
  });

  const result = await worker.runOnce();

  assert.equal(result.paused, undefined);
  assert.equal(calls.includes("listDue"), true, "the queue was actually scanned");
});
