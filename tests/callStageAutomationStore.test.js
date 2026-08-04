const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CALL_STAGE_AUTOMATION_TEST_LIMIT,
  createCallStageAutomationStore,
  isCallStageAutomationEligible,
} = require("../dist/services/callStageAutomationStore");

function makePersistence() {
  const settings = new Map();
  const slots = [];
  const clone = (slot) => ({ ...slot });
  const persistence = {
    async transaction(operation) { return operation(persistence); },
    async getSetting(key) { return settings.get(key) ?? null; },
    async createSettingIfAbsent(key, value) {
      if (!settings.has(key)) settings.set(key, value);
      return settings.get(key);
    },
    async ensureTestSlots(limit) {
      for (let slotNumber = 1; slotNumber <= limit; slotNumber += 1) {
        if (!slots.some((slot) => slot.slotNumber === slotNumber)) {
          slots.push({ slotNumber, state: "free", dealId: null, actionId: null, reservedAt: null, confirmedAt: null, leaseExpiresAt: null });
        }
      }
    },
    async findTestSlotForDeal(dealId) {
      const slot = slots.find((candidate) => candidate.dealId === dealId);
      return slot ? clone(slot) : null;
    },
    async reserveFreeTestSlot(dealId, actionId, now, leaseExpiresAt) {
      const slot = slots.find((candidate) => candidate.state === "free");
      if (!slot) return null;
      Object.assign(slot, { state: "reserved", dealId, actionId, reservedAt: now, leaseExpiresAt, confirmedAt: null });
      return clone(slot);
    },
    async reclaimTestSlotLease(actionId, now, leaseExpiresAt) {
      const slot = slots.find((candidate) => candidate.state === "reserved" && candidate.actionId === actionId);
      if (!slot) return null;
      Object.assign(slot, { reservedAt: now, leaseExpiresAt });
      return clone(slot);
    },
    async markExpiredTestSlotsUncertain(now) {
      let count = 0;
      for (const slot of slots) {
        if (slot.state === "reserved" && slot.leaseExpiresAt && slot.leaseExpiresAt <= now) {
          Object.assign(slot, { state: "uncertain", confirmedAt: now, leaseExpiresAt: null });
          count += 1;
        }
      }
      return count;
    },
    async confirmTestSlot(actionId, now) {
      const slot = slots.find((candidate) => candidate.state === "reserved" && candidate.actionId === actionId);
      if (!slot) return null;
      Object.assign(slot, { state: "confirmed", confirmedAt: now, leaseExpiresAt: null });
      return clone(slot);
    },
    async releaseTestSlotBeforePatch(actionId) {
      const slot = slots.find((candidate) => candidate.state === "reserved" && candidate.actionId === actionId);
      if (!slot) return false;
      Object.assign(slot, { state: "free", dealId: null, actionId: null, reservedAt: null, confirmedAt: null, leaseExpiresAt: null });
      return true;
    },
    async markTestSlotUncertain(actionId, now) {
      const slot = slots.find((candidate) => candidate.state === "reserved" && candidate.actionId === actionId);
      if (!slot) return null;
      Object.assign(slot, { state: "uncertain", confirmedAt: now, leaseExpiresAt: null });
      return clone(slot);
    },
  };
  return { persistence, slots };
}

const now = new Date("2026-08-04T10:00:00.000Z");

test("stage routing has a durable no-backfill boundary for both lead and call", () => {
  assert.equal(isCallStageAutomationEligible({
    activationBoundary: now,
    leadCreatedAt: new Date("2026-08-04T10:00:00.001Z"),
    callCreatedAt: new Date("2026-08-04T10:00:00.001Z"),
  }), true);
  assert.equal(isCallStageAutomationEligible({
    activationBoundary: now,
    leadCreatedAt: now,
    callCreatedAt: new Date("2026-08-04T10:00:00.001Z"),
  }), false);
  assert.equal(isCallStageAutomationEligible({
    activationBoundary: now,
    leadCreatedAt: new Date("2026-08-04T10:00:00.001Z"),
    callCreatedAt: now,
  }), false);
  assert.equal(isCallStageAutomationEligible({
    activationBoundary: now,
    leadCreatedAt: new Date("2026-08-04T10:00:00.001Z"),
    callCreatedAt: new Date("2026-08-04T09:59:59.999Z"),
  }), false);
});

test("testing mode has exactly three durable slots and rejects a fourth deal", async () => {
  const { persistence } = makePersistence();
  const store = createCallStageAutomationStore(persistence, { leaseMs: 60_000 });

  await assert.rejects(store.ensureTestSlots(4), /exactly 3/);
  await store.ensureTestSlots(CALL_STAGE_AUTOMATION_TEST_LIMIT);
  const reservations = await Promise.all([1, 2, 3].map((dealId) => store.reserveTestMove({ dealId, actionId: `action-${dealId}`, now })));
  assert.deepEqual(reservations.map(({ kind }) => kind), ["reserved", "reserved", "reserved"]);
  assert.deepEqual(reservations.map(({ slot }) => slot.slotNumber), [1, 2, 3]);
  assert.deepEqual(await store.reserveTestMove({ dealId: 4, actionId: "action-4", now }), { kind: "limit_reached" });
});

test("only a proven pre-PATCH cancellation frees a slot; confirmed and uncertain moves consume it", async () => {
  const { persistence } = makePersistence();
  const store = createCallStageAutomationStore(persistence, { leaseMs: 60_000 });
  await store.ensureTestSlots(CALL_STAGE_AUTOMATION_TEST_LIMIT);

  await store.reserveTestMove({ dealId: 1, actionId: "released", now });
  assert.equal(await store.releaseTestMoveBeforePatch("released"), true);
  assert.equal((await store.reserveTestMove({ dealId: 4, actionId: "replacement", now })).kind, "reserved");
  assert.equal((await store.confirmTestMove("replacement", now)).state, "confirmed");
  assert.equal(await store.releaseTestMoveBeforePatch("replacement"), false);

  await store.reserveTestMove({ dealId: 2, actionId: "uncertain", now });
  assert.equal((await store.markTestMoveUncertain("uncertain", now)).state, "uncertain");
  assert.equal(await store.releaseTestMoveBeforePatch("uncertain"), false);
});
