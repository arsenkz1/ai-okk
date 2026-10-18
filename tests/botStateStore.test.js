const test = require("node:test");
const assert = require("node:assert/strict");

const store = require("../dist/bot/stateStore");

test("the memory store honours TTLs by its clock", async () => {
  const clock = { now: 1_000_000 };
  const memory = store.createMemoryKeyValueStore(() => clock.now);
  await memory.set("k", "v", 60);
  assert.equal(await memory.get("k"), "v");
  clock.now += 59_999;
  assert.equal(await memory.get("k"), "v");
  clock.now += 1;
  assert.equal(await memory.get("k"), null);
  assert.equal(memory.rows.has("k"), false, "an expired row is dropped on read");
});

test("a state map round-trips JSON, restarts the TTL on set and reports deletes", async () => {
  const clock = { now: 0 };
  const memory = store.createMemoryKeyValueStore(() => clock.now);
  store.configureStateStore(memory);
  const sessions = store.createStateMap("test:ai:", 100);

  assert.equal(await sessions.get(7), null);
  await sessions.set(7, { active: true, history: [{ role: "user", parts: [{ text: "salom" }] }], n: 1 });
  assert.deepEqual(await sessions.get(7), { active: true, history: [{ role: "user", parts: [{ text: "salom" }] }], n: 1 });
  assert.equal(memory.rows.get("test:ai:7").expiresAt, 100_000);

  clock.now = 50_000;
  await sessions.set(7, { active: true, history: [], n: 2 });
  assert.equal(memory.rows.get("test:ai:7").expiresAt, 150_000, "every write restarts the clock");

  assert.equal(await sessions.delete(7), true);
  assert.equal(await sessions.delete(7), false);
  assert.equal(await sessions.get(7), null);
});

test("a corrupt record is dropped instead of thrown", async () => {
  const memory = store.createMemoryKeyValueStore();
  store.configureStateStore(memory);
  const flows = store.createStateMap("test:flow:", 10);
  memory.rows.set("test:flow:3", { value: "{oops", expiresAt: Number.MAX_SAFE_INTEGER });
  assert.equal(await flows.get(3), null);
  assert.equal(memory.rows.has("test:flow:3"), false);
});

test("the bot's state maps are Redis-backed definitions with the agreed lifetimes", () => {
  const state = require("../dist/bot/state");
  assert.equal(state.AI_SESSION_TTL_SECONDS, 7200);
  assert.equal(state.FLOW_TTL_SECONDS, 600);
  for (const name of ["aiSessions", "supervisorAiSessions", "roleFlowState", "teamLeadManageFlowState"]) {
    assert.equal(typeof state[name].get, "function", name);
    assert.equal(typeof state[name].set, "function", name);
    assert.equal(typeof state[name].delete, "function", name);
  }
});
