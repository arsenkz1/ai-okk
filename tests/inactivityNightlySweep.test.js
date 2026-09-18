const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runNightlyInactivitySweep,
  claimNightlySweepDay,
  formatSweepMovedSummary,
  formatNightlySweepReport,
  NIGHTLY_SWEEP_DAY_SETTING_KEY,
} = require("../dist/services/inactivityNightlySweep");

const now = new Date("2026-09-18T17:00:00.000Z"); // 22:00 Almaty
const idle = (id, hours, pipelineId = 6909890) => ({
  id, createdAt: now, updatedAt: new Date(now.getTime() - hours * 3600 * 1000), pipelineId, statusId: 58160726, responsibleUserId: 1, name: null,
});
const PRODUCTION = { AMOCRM_INACTIVITY_WORKER_ENABLED: "true", TESTING_LEADS_MOVEMENT: "false" };

function deps(overrides = {}) {
  const moved = [];
  const claimed = [];
  return {
    moved,
    claimed,
    dependencies: {
      environment: PRODUCTION,
      isStopped: async () => false,
      claimDay: async (day) => { claimed.push(day); return true; },
      listEligibleLeads: async () => [idle(1, 100), idle(2, 10), idle(3, 400, 9055778)],
      moveLeadToTarget: async (leadId) => { moved.push(leadId); return { kind: "confirmed", lead: {} }; },
      now: () => now,
      ...overrides,
    },
  };
}

test("moves every lead idle for 3+ days without asking anyone", async () => {
  const { dependencies, moved, claimed } = deps();
  const result = await runNightlyInactivitySweep(dependencies);

  assert.equal(result.kind, "swept");
  assert.equal(result.scanned, 3);
  assert.equal(result.candidates, 2);
  assert.deepEqual(moved, [3, 1], "longest idle first; the 10-hour lead is untouched");
  assert.deepEqual(claimed, ["2026-09-18"], "the day is the Almaty calendar day");
});

test("refuses to run unless the worker itself would be allowed to", async () => {
  for (const [environment, reason] of [
    [{}, "worker_disabled"],
    [{ AMOCRM_INACTIVITY_WORKER_ENABLED: "false", TESTING_LEADS_MOVEMENT: "false" }, "worker_disabled"],
    // Testing mode caps real moves at five deals; an unattended sweep must not void that.
    [{ AMOCRM_INACTIVITY_WORKER_ENABLED: "true", TESTING_LEADS_MOVEMENT: "true" }, "testing_mode"],
    [{ AMOCRM_INACTIVITY_WORKER_ENABLED: "true" }, "testing_mode"],
  ]) {
    const { dependencies, moved, claimed } = deps({ environment });
    assert.deepEqual(await runNightlyInactivitySweep(dependencies), { kind: "skipped", reason });
    assert.deepEqual(moved, []);
    assert.deepEqual(claimed, [], "a skipped night does not burn the day's claim");
  }
});

test("honours the operator stop", async () => {
  const { dependencies, moved } = deps({ isStopped: async () => true });
  assert.deepEqual(await runNightlyInactivitySweep(dependencies), { kind: "skipped", reason: "stopped" });
  assert.deepEqual(moved, []);
});

test("runs once per day even when two replicas fire the same cron", async () => {
  const { dependencies, moved } = deps({ claimDay: async () => false });
  assert.deepEqual(await runNightlyInactivitySweep(dependencies), { kind: "skipped", reason: "already_ran_today" });
  assert.deepEqual(moved, []);
});

test("reports an empty night instead of pretending nothing happened", async () => {
  const { dependencies } = deps({ listEligibleLeads: async () => [idle(1, 5)] });
  const result = await runNightlyInactivitySweep(dependencies);
  assert.deepEqual(result, { kind: "nothing_to_move", scanned: 1 });
  assert.match(formatNightlySweepReport(result), /лидов без касаний 3\+ дней нет \(проверено: 1\)/);
});

function settingsDatabase() {
  const rows = new Map();
  return {
    rows,
    leadInactivitySetting: {
      async createMany({ data }) {
        let count = 0;
        for (const row of data) if (!rows.has(row.key)) { rows.set(row.key, row.value); count += 1; }
        return { count };
      },
      async updateMany({ where, data }) {
        if (rows.has(where.key) && rows.get(where.key) !== where.value.not) { rows.set(where.key, data.value); return { count: 1 }; }
        return { count: 0 };
      },
    },
  };
}

test("the day claim is won once, lost on repeat, and won again the next day", async () => {
  const database = settingsDatabase();
  assert.equal(await claimNightlySweepDay("2026-09-18", database), true);
  assert.equal(await claimNightlySweepDay("2026-09-18", database), false);
  assert.equal(await claimNightlySweepDay("2026-09-19", database), true);
  assert.equal(database.rows.get(NIGHTLY_SWEEP_DAY_SETTING_KEY), "2026-09-19");
  assert.equal(database.rows.size, 1, "one row, not one per day");
});

test("the admin summary names the deals that moved", () => {
  const text = formatSweepMovedSummary("Сверка неактивности 22:00", [
    { leadId: 11, pipelineId: 6909890 }, { leadId: 12, pipelineId: 9055778 }, { leadId: 13, pipelineId: 6909890 },
  ]);
  assert.equal(text.includes("переведено в Феникс 3 сделок"), true);
  assert.equal(text.includes("• UZUM: 2"), true);
  assert.equal(text.includes("#11 #12 #13"), true);
});

test("the operator report accounts for everything that did not move", () => {
  const text = formatNightlySweepReport({
    kind: "swept", scanned: 900, candidates: 10,
    result: { moved: 5, notMoved: 1, uncertain: 1, skippedRecentTouch: 2, guardFailed: 1, movedCandidates: [], stoppedAt: { index: 9, reason: "uncertain" } },
  });
  assert.equal(text.includes("переведено 5 из 10 (проверено: 900)"), true);
  assert.equal(text.includes("было касание за последние 3 дня: 2"), true);
  assert.equal(text.includes("не удалось проверить историю, сделки не тронуты: 1"), true);
  assert.equal(text.includes("не обработано: 1. Продолжит завтрашняя сверка."), true);
  assert.equal(formatNightlySweepReport({ kind: "skipped", reason: "stopped" }), null, "a skipped night sends nothing");
});
