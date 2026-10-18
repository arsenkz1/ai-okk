const test = require("node:test");
const assert = require("node:assert/strict");

const pending = require("../dist/bot/pendingInput");
const inputs = require("../dist/bot/inputHandlers");
require("../dist/bot/actions");
const reports = require("../dist/bot/actions/reports");

function fakeStore() {
  const rows = new Map();
  return {
    rows,
    async get(key) { return rows.get(key)?.value ?? null; },
    async set(key, value, ttlSeconds) { rows.set(key, { value, ttlSeconds }); },
    async del(key) { rows.delete(key); },
  };
}

function service(startMs = 1_000_000) {
  const clock = { now: startMs };
  const store = fakeStore();
  return { svc: pending.createPendingInputService(store, () => clock.now), clock, store };
}

test("expect, lookup, take and cancel behave as a single slot per user", async () => {
  const { svc, store } = service();
  assert.deepEqual(await svc.lookup(1), { state: "none" });
  await svc.expect(1, "deal_id", { reason: "dossier" });
  const found = await svc.lookup(1);
  assert.equal(found.state, "pending");
  assert.equal(found.input.kind, "deal_id");
  assert.deepEqual(found.input.payload, { reason: "dossier" });
  assert.equal(store.rows.get("bot:pending:1").ttlSeconds, pending.PENDING_INPUT_KEEP_SECONDS);

  await svc.expect(1, "lead_id");
  assert.equal((await svc.lookup(1)).input.kind, "lead_id", "a second question replaces the first");

  const taken = await svc.take(1);
  assert.equal(taken.kind, "lead_id");
  assert.deepEqual(await svc.lookup(1), { state: "none" });
  assert.equal(await svc.take(1), null);

  await svc.expect(2, "telegram_id");
  assert.equal(await svc.cancel(2), true);
  assert.equal(await svc.cancel(2), false);
  assert.deepEqual(await svc.lookup(2), { state: "none" });
});

test("an answer after ten minutes is reported as expired once, then forgotten", async () => {
  const { svc, clock } = service();
  await svc.expect(1, "deal_id");
  clock.now += pending.PENDING_INPUT_TTL_MS;
  assert.equal((await svc.lookup(1)).state, "pending", "exactly ten minutes is still fine");
  clock.now += 1;
  assert.deepEqual(await svc.lookup(1), { state: "expired" });
  assert.deepEqual(await svc.lookup(1), { state: "none" });
  assert.equal(await svc.take(1), null);
});

test("a corrupt record is dropped instead of thrown", async () => {
  const { svc, store } = service();
  store.rows.set("bot:pending:5", { value: "{not json", ttlSeconds: 1 });
  assert.deepEqual(await svc.lookup(5), { state: "none" });
  assert.equal(store.rows.has("bot:pending:5"), false);
});

test("the text handler consumes expired and pending inputs and leaves the rest alone", async () => {
  const sent = [];
  const bot = { sendMessage: async (chatId, text, options) => { sent.push({ text, options }); } };
  const msg = { chat: { id: 9 }, from: { id: 9 }, text: "hello" };
  const { svc } = service();

  assert.equal(await inputs.handlePendingInput(bot, msg, { state: "none" }, svc), false);
  assert.equal(await inputs.handlePendingInput(bot, msg, { state: "expired" }, svc), true);
  assert.equal(sent.at(-1).text, inputs.INPUT_EXPIRED_TEXT);

  await svc.expect(9, "task_due");
  const unknownKind = { state: "pending", input: { kind: "no_such_kind", payload: {}, createdAt: 0 } };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await inputs.handlePendingInput(bot, msg, unknownKind, svc), false);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(await svc.lookup(9), { state: "none" }, "an orphaned question is dropped");
});

test("a handler is defined once per kind", () => {
  assert.equal(inputs.hasInputHandler("period_from"), true);
  assert.equal(inputs.hasInputHandler("period_to"), true);
  assert.throws(() => inputs.defineInputHandler("period_from", async () => {}), /defined twice/);
});

test("/period: a bad date keeps the question, a good one asks for the end date with the start remembered", async () => {
  const sent = [];
  const bot = { sendMessage: async (chatId, text, options) => { sent.push({ text, options }); } };
  const { svc } = service();
  await svc.expect(9, "period_from", { adminMode: true });

  const typed = async (text) => inputs.handlePendingInput(bot, { chat: { id: 9 }, from: { id: 9 }, text }, await svc.lookup(9), svc);

  await typed("yesterday");
  assert.equal(sent.at(-1).text, reports.DATE_FORMAT_ERROR_TEXT);
  assert.equal((await svc.lookup(9)).input.kind, "period_from");

  await typed("01.03.2026");
  const next = await svc.lookup(9);
  assert.equal(next.input.kind, "period_to");
  assert.equal(next.input.payload.adminMode, true);
  assert.equal(new Date(next.input.payload.from).getDate(), 1);
  assert.ok(sent.at(-1).text.includes("Boshi: *01.03.2026*"));
  assert.equal(sent.at(-1).options.reply_markup.inline_keyboard[0][0].callback_data, "m:cancel");

  await typed("28.02.2026");
  assert.equal(sent.at(-1).text, reports.PERIOD_ORDER_ERROR_TEXT);
  assert.deepEqual(await svc.lookup(9), { state: "none" }, "a wrong order ends the dialog, as before");
});
