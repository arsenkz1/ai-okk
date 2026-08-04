const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CALL_TASK_AUTOMATION_TEST_LIMIT,
  createCallTaskAutomationStore,
  isCallTaskAutomationEligible,
} = require("../dist/services/callTaskAutomationStore");

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
          slots.push({
            slotNumber,
            state: "free",
            leadId: null,
            actionId: null,
            reservedAt: null,
            confirmedAt: null,
            leaseExpiresAt: null,
          });
        }
      }
    },
    async findTestSlotForLead(leadId) {
      const slot = slots.find((candidate) => candidate.leadId === leadId);
      return slot ? clone(slot) : null;
    },
    async reserveFreeTestSlot(leadId, actionId, now, leaseExpiresAt) {
      const slot = slots.find((candidate) => candidate.state === "free");
      if (!slot) return null;
      slot.state = "reserved";
      slot.leadId = leadId;
      slot.actionId = actionId;
      slot.reservedAt = now;
      slot.leaseExpiresAt = leaseExpiresAt;
      return clone(slot);
    },
    async reclaimTestSlotLease(actionId, now, leaseExpiresAt) {
      const slot = slots.find((candidate) => candidate.state === "reserved" && candidate.actionId === actionId);
      if (!slot) return null;
      slot.reservedAt = now;
      slot.leaseExpiresAt = leaseExpiresAt;
      return clone(slot);
    },
    async markExpiredTestSlotsUncertain(now) {
      let count = 0;
      for (const slot of slots) {
        if (slot.state === "reserved" && slot.leaseExpiresAt && slot.leaseExpiresAt <= now) {
          slot.state = "uncertain";
          slot.confirmedAt = now;
          slot.leaseExpiresAt = null;
          count += 1;
        }
      }
      return count;
    },
    async confirmTestSlot(actionId, now) {
      const slot = slots.find((candidate) => candidate.state === "reserved" && candidate.actionId === actionId);
      if (!slot) return null;
      slot.state = "confirmed";
      slot.confirmedAt = now;
      slot.leaseExpiresAt = null;
      return clone(slot);
    },
    async releaseTestSlotBeforeAnalysis(actionId) {
      const slot = slots.find((candidate) => candidate.state === "reserved" && candidate.actionId === actionId);
      if (!slot) return false;
      Object.assign(slot, {
        state: "free", leadId: null, actionId: null, reservedAt: null, confirmedAt: null, leaseExpiresAt: null,
      });
      return true;
    },
    async markTestSlotUncertain(actionId, now) {
      const slot = slots.find((candidate) => candidate.state === "reserved" && candidate.actionId === actionId);
      if (!slot) return null;
      slot.state = "uncertain";
      slot.confirmedAt = now;
      slot.leaseExpiresAt = null;
      return clone(slot);
    },
  };
  return { persistence, settings, slots };
}

test("a call-task action is eligible only for a lead and a call after its durable activation boundary", () => {
  const boundary = new Date("2026-08-04T07:00:00.000Z");
  assert.equal(isCallTaskAutomationEligible({
    activationBoundary: boundary,
    leadCreatedAt: new Date("2026-08-04T07:00:00.001Z"),
    callCreatedAt: new Date("2026-08-04T07:00:00.001Z"),
  }), true);
  assert.equal(isCallTaskAutomationEligible({
    activationBoundary: boundary,
    leadCreatedAt: boundary,
    callCreatedAt: new Date("2026-08-04T07:00:00.001Z"),
  }), false);
  assert.equal(isCallTaskAutomationEligible({
    activationBoundary: boundary,
    leadCreatedAt: new Date("2026-08-04T07:00:00.001Z"),
    callCreatedAt: new Date("2026-08-04T06:59:59.999Z"),
  }), false);
});

test("activation boundary is created once and never silently shifted", async () => {
  const { persistence } = makePersistence();
  const store = createCallTaskAutomationStore(persistence);
  const first = await store.getOrCreateActivationBoundary(new Date("2026-08-04T07:00:00.000Z"));
  const second = await store.getOrCreateActivationBoundary(new Date("2026-08-04T08:00:00.000Z"));

  assert.equal(first.toISOString(), "2026-08-04T07:00:00.000Z");
  assert.equal(second.toISOString(), first.toISOString());
});

test("test mode has exactly five durable distinct-lead slots and no environment-shaped expansion", async () => {
  const { persistence } = makePersistence();
  const store = createCallTaskAutomationStore(persistence, { leaseMs: 60_000 });
  const now = new Date("2026-08-04T07:00:00.000Z");

  await assert.rejects(store.ensureTestSlots(4), /exactly 5/);
  await store.ensureTestSlots(CALL_TASK_AUTOMATION_TEST_LIMIT);

  const reservations = [];
  for (let leadId = 1; leadId <= CALL_TASK_AUTOMATION_TEST_LIMIT; leadId += 1) {
    reservations.push(await store.reserveTestLead({ leadId, actionId: `action-${leadId}`, now }));
  }
  assert.deepEqual(reservations.map(({ kind }) => kind), Array(CALL_TASK_AUTOMATION_TEST_LIMIT).fill("reserved"));
  assert.deepEqual(reservations.map(({ slot }) => slot.slotNumber), [1, 2, 3, 4, 5]);

  const exhausted = await store.reserveTestLead({ leadId: 6, actionId: "action-6", now });
  assert.deepEqual(exhausted, { kind: "limit_reached" });

  const sameLead = await store.reserveTestLead({ leadId: 1, actionId: "another-action", now });
  assert.equal(sameLead.kind, "already_claimed");
  assert.equal(sameLead.slot.actionId, "action-1");
});

test("a slot may be released only before analysis; confirmed and uncertain outcomes consume capacity", async () => {
  const { persistence } = makePersistence();
  const store = createCallTaskAutomationStore(persistence, { leaseMs: 60_000 });
  const now = new Date("2026-08-04T07:00:00.000Z");
  await store.ensureTestSlots(CALL_TASK_AUTOMATION_TEST_LIMIT);

  await store.reserveTestLead({ leadId: 1, actionId: "release-me", now });
  assert.equal(await store.releaseTestLeadBeforeAnalysis("release-me"), true);
  const replacement = await store.reserveTestLead({ leadId: 6, actionId: "replacement", now });
  assert.equal(replacement.kind, "reserved");

  await store.confirmTestLead("replacement", now);
  assert.equal(await store.releaseTestLeadBeforeAnalysis("replacement"), false);

  await store.reserveTestLead({ leadId: 2, actionId: "uncertain", now });
  const uncertain = await store.markTestLeadUncertain("uncertain", now);
  assert.equal(uncertain.state, "uncertain");
  assert.equal(await store.releaseTestLeadBeforeAnalysis("uncertain"), false);
});

test("reclaims a slot for the same recovered action and conservatively marks orphaned expired slots uncertain", async () => {
  const { persistence, slots } = makePersistence();
  const store = createCallTaskAutomationStore(persistence, { leaseMs: 60_000 });
  const start = new Date("2026-08-04T07:00:00.000Z");
  const afterExpiry = new Date("2026-08-04T07:02:00.000Z");

  await store.ensureTestSlots(CALL_TASK_AUTOMATION_TEST_LIMIT);
  await store.reserveTestLead({ leadId: 1, actionId: "recoverable", now: start });
  const reclaimed = await store.reserveTestLead({ leadId: 1, actionId: "recoverable", now: afterExpiry });
  assert.equal(reclaimed.kind, "reclaimed");
  assert.equal(reclaimed.slot.leaseExpiresAt.toISOString(), "2026-08-04T07:03:00.000Z");
  assert.equal((await store.confirmTestLead("recoverable", afterExpiry)).state, "confirmed");

  await store.reserveTestLead({ leadId: 2, actionId: "orphaned", now: start });
  const replacement = await store.reserveTestLead({ leadId: 3, actionId: "replacement", now: afterExpiry });
  assert.equal(replacement.kind, "reserved");
  assert.equal(slots.find((slot) => slot.actionId === "orphaned").state, "uncertain");
});
