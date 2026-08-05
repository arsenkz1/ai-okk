const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCallTaskAutomationStore,
  isCallTaskAutomationEligible,
} = require("../dist/services/callTaskAutomationStore");

function makePersistence() {
  const settings = new Map();
  return {
    settings,
    persistence: {
      async getSetting(key) { return settings.get(key) ?? null; },
      async createSettingIfAbsent(key, value) {
        if (!settings.has(key)) settings.set(key, value);
        return settings.get(key);
      },
    },
  };
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
