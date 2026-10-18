const test = require("node:test");
const assert = require("node:assert/strict");

require("../dist/bot/actions");
const fakeRegistrar = { onText: () => {}, on: () => {} };
require("../dist/bot/handlers/performance").registerPerformanceHandlers(fakeRegistrar);
require("../dist/bot/handlers/adminRoles").registerAdminRoleHandlers(fakeRegistrar);
require("../dist/bot/handlers/rop").registerRopHandlers(fakeRegistrar);
require("../dist/bot/handlers/teamlead").registerTeamLeadHandlers(fakeRegistrar);
require("../dist/bot/handlers/callTaskReview").registerCallTaskReviewHandlers(fakeRegistrar);

const registry = require("../dist/bot/actions/registry");
const dispatch = require("../dist/bot/actions/dispatch");
const flows = require("../dist/bot/actions/inputFlows");
const inputs = require("../dist/bot/inputHandlers");
const pendingModule = require("../dist/bot/pendingInput");
const { sectionKeyboard } = require("../dist/bot/keyboards/menuCallbacks");
const state = require("../dist/bot/state");
const stateStore = require("../dist/bot/stateStore");
stateStore.configureStateStore(stateStore.createMemoryKeyValueStore());
const { rolesOf } = require("../dist/bot/access");

const access = (isAdmin, manager) => ({ telegramUserId: "7", isAdmin, manager, roles: rolesOf(isAdmin, manager) });
const active = (role) => ({ role, isActive: true, id: 7, teamId: null });

function fakeService() {
  const rows = new Map();
  const store = {
    async get(key) { return rows.get(key) ?? null; },
    async set(key, value) { rows.set(key, value); },
    async del(key) { rows.delete(key); },
  };
  return pendingModule.createPendingInputService(store, () => 1_000_000);
}

const pending = fakeService();
dispatch.configureDispatch({ pendingInput: pending, resolveAccess: async () => access(true, null) });
flows.configureInputFlows({ resolveAccess: async () => access(true, null) });

const runs = [];
registry.defineAction({
  id: "test_needs_deal", section: "reports", roles: [], label: "t-deal",
  input: { kind: "deal_id", prompt: "Qaysi bitim?" },
  command: { pattern: /\/test_needs_deal (\d+)/, usage: "/test_needs_deal <id>", description: "t" },
  async run(ctx) { runs.push({ id: "test_needs_deal", source: ctx.source, args: ctx.args }); },
});
registry.defineAction({
  id: "test_danger_tg", section: "users", roles: [], label: "t-danger-tg", dangerous: true,
  input: { kind: "telegram_id", prompt: "Kimni?" },
  command: { pattern: /\/test_danger_tg (\d+)/, usage: "/test_danger_tg <tg_id>", description: "t" },
  async run(ctx) { runs.push({ id: "test_danger_tg", args: ctx.args }); },
});

function fakeBot() {
  const sent = [];
  return { sent, bot: { sendMessage: async (chatId, text, options) => { sent.push({ chatId, text, options }); } } };
}
const msgOf = (userId, text) => ({ chat: { id: userId }, from: { id: userId }, text });

test("a button on an action that asks for its value opens the question with a cancel button", async () => {
  const { sent, bot } = fakeBot();
  await dispatch.runFromButton(bot, "test_needs_deal", msgOf(11, "t-deal"));
  assert.equal(runs.length, 0);
  assert.equal(sent.at(-1).text, "Qaysi bitim?");
  assert.equal(sent.at(-1).options.reply_markup.inline_keyboard[0][0].callback_data, "m:cancel");
  const found = await pending.lookup(11);
  assert.equal(found.state, "pending");
  assert.deepEqual([found.input.kind, found.input.payload], ["deal_id", { action: "test_needs_deal" }]);
});

test("a wrong answer keeps the question open; a right one runs the action with the value", async () => {
  const { sent, bot } = fakeBot();
  const answer = async (text) => inputs.handlePendingInput(bot, msgOf(11, text), await pending.lookup(11), pending);

  await answer("abc");
  assert.equal(sent.at(-1).text, flows.ID_INPUT_RULES.deal_id.errorText);
  assert.equal((await pending.lookup(11)).state, "pending");

  await answer(" 26199367 ");
  assert.deepEqual(runs, [{ id: "test_needs_deal", source: "input", args: ["26199367"] }]);
  assert.deepEqual(await pending.lookup(11), { state: "none" });
});

test("a dangerous action confirms after the answer, with the value in the button", async () => {
  const { sent, bot } = fakeBot();
  await dispatch.runFromButton(bot, "test_danger_tg", msgOf(12, "t-danger-tg"));
  assert.equal(sent.at(-1).text, "Kimni?");
  await inputs.handlePendingInput(bot, msgOf(12, "295612129"), await pending.lookup(12), pending);
  assert.equal(runs.some((r) => r.id === "test_danger_tg"), false);
  const confirm = sent.at(-1);
  assert.ok(confirm.text.includes("295612129"));
  assert.deepEqual(confirm.options.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["m:test_danger_tg:yes:295612129", "m:test_danger_tg:no"]);
});

test("the real actions declare their questions", () => {
  assert.equal(registry.getAction("deal").input.kind, "deal_id");
  assert.equal(registry.getAction("analyze_deal").input.kind, "deal_id");
  assert.equal(registry.getAction("inactivity_lead").input.kind, "lead_id");
  assert.equal(registry.getAction("add_admin").input.kind, "telegram_id");
  assert.equal(registry.getAction("remove_admin").input.kind, "telegram_id");
  for (const kind of ["deal_id", "lead_id", "telegram_id"]) assert.equal(inputs.hasInputHandler(kind), true, kind);
});

test("the AI section offers the periods, and the stop button only during a session", async () => {
  const ai = registry.SECTIONS.find((s) => s.id === "ai");
  const manager = access(false, active("MANAGER"));
  const idle = (await sectionKeyboard(manager, ai, 77)).inline_keyboard.flat();
  assert.deepEqual(idle.map((b) => [b.text, b.callback_data]), [
    ["Boshlash (30 kun)", "m:ask"], ["Kun", "m:ask:kun"], ["Hafta", "m:ask:hafta"], ["Oy", "m:ask:oy"],
  ]);
  await state.aiSessions.set(77, { active: true, history: [], systemContext: "", managerId: 1, period: "day" });
  try {
    const busy = (await sectionKeyboard(manager, ai, 77)).inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(busy.includes("m:stop_ai"));
  } finally {
    await state.aiSessions.delete(77);
  }
  // Without knowing who is looking, a conditional button stays hidden.
  assert.equal((await sectionKeyboard(manager, ai)).inline_keyboard.flat().some((b) => b.callback_data === "m:stop_ai"), false);
});

test("the reports section lists the report buttons in order, with the deal question and own stats", async () => {
  const reports = registry.SECTIONS.find((s) => s.id === "reports");
  // Actions defined by this test file live in the same section; leave them out.
  const real = (markup) => markup.inline_keyboard.flat().map((b) => b.callback_data).filter((d) => d && !d.startsWith("m:test_"));
  assert.deepEqual(real(await sectionKeyboard(access(false, active("MANAGER")), reports, 1)), ["m:report", "m:week", "m:month", "m:period", "m:errors", "m:deal", "m:my_stats"]);
  assert.deepEqual(real(await sectionKeyboard(access(true, null), reports, 1)), ["m:report", "m:week", "m:month", "m:period", "m:errors", "m:deal", "m:team_stats"]);
});

test("the admin's reports section opens with the dashboard Mini App; nobody else sees it", async () => {
  const reports = registry.SECTIONS.find((s) => s.id === "reports");
  const admin = (await sectionKeyboard(access(true, null), reports, 1)).inline_keyboard;
  assert.deepEqual(admin[0], [{ text: "Dashboard", web_app: { url: "https://qadam-dogovor.uz/reports/tg/" } }]);
  assert.equal(admin[1][0].callback_data, "m:report");
  for (const a of [access(false, active("MANAGER")), access(false, active("TEAMLEAD")), access(false, active("ROP"))]) {
    const rows = (await sectionKeyboard(a, reports, 1)).inline_keyboard;
    assert.equal(rows.flat().some((b) => b.web_app), false);
  }
  const company = registry.SECTIONS.find((s) => s.id === "company");
  assert.equal((await sectionKeyboard(access(true, null), company, 1)).inline_keyboard.flat().some((b) => b.web_app), false, "only the reports section");
});
