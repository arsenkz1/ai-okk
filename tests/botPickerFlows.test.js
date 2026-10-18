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
const flows = require("../dist/bot/actions/pickerFlows");
const picker = require("../dist/bot/keyboards/managerPicker");
const menu = require("../dist/bot/keyboards/menuCallbacks");
const inputs = require("../dist/bot/inputHandlers");
const pendingModule = require("../dist/bot/pendingInput");
const { rolesOf } = require("../dist/bot/access");

const access = (isAdmin, manager) => ({ telegramUserId: "7", isAdmin, manager, roles: rolesOf(isAdmin, manager) });
const admin = access(true, null);

const managers = Array.from({ length: 19 }, (_, i) => ({ amoUserId: 1000 + i, name: `Manager ${String(i + 1).padStart(2, "0")}` }));
picker.configureManagerPicker({ loadManagers: async () => managers });

const rows = new Map();
const pending = pendingModule.createPendingInputService({
  async get(key) { return rows.get(key) ?? null; }, async set(key, value) { rows.set(key, value); }, async del(key) { rows.delete(key); },
}, () => 1_000_000);
dispatch.configureDispatch({ pendingInput: pending, resolveAccess: async () => admin });
require("../dist/bot/actions/inputFlows").configureInputFlows({ resolveAccess: async () => admin });

function fakeBot() {
  const sent = [], edits = [];
  return { sent, edits, bot: {
    sendMessage: async (chatId, text, options) => { sent.push({ chatId, text, options }); return { message_id: 1 }; },
    editMessageReplyMarkup: async (markup, options) => { edits.push({ markup, options }); return true; },
    answerCallbackQuery: async () => true,
    editMessageText: async () => true,
    on: () => {},
  } };
}
const ctxOf = (bot, args, extra = {}) => ({ bot, chatId: 5, userId: 7, telegramUserId: "7", access: admin, args, source: "callback", pending, message: { chat: { id: 5 }, message_id: 55, from: { id: 7 } }, ...extra });
const data = (markup) => markup.inline_keyboard.map((row) => row.map((b) => b.callback_data));

test("the manager list is paged by eight, two per row, with page controls only when needed", () => {
  const callbacks = { pick: (id) => `m:x:${id}`, page: (n) => `m:x:p${n}` };
  const first = picker.managerPickerKeyboard(managers, 1, callbacks);
  assert.equal(first.pages, 3);
  assert.equal(first.markup.inline_keyboard.length, 5, "four rows of picks plus navigation");
  assert.deepEqual(first.markup.inline_keyboard[0].map((b) => b.callback_data), ["m:x:1000", "m:x:1001"]);
  assert.deepEqual(first.markup.inline_keyboard.at(-1).map((b) => b.text), ["1/3", "›"]);

  const last = picker.managerPickerKeyboard(managers, 9, callbacks);
  assert.equal(last.page, 3, "an out-of-range page is clamped");
  assert.equal(last.markup.inline_keyboard.flat().filter((b) => b.callback_data.startsWith("m:x:1")).length, 3);
  assert.deepEqual(last.markup.inline_keyboard.at(-1).map((b) => b.text), ["‹", "3/3"]);

  const single = picker.managerPickerKeyboard(managers.slice(0, 5), 1, callbacks);
  assert.equal(single.markup.inline_keyboard.length, 3, "no navigation row for one page");
  assert.deepEqual(flows.parsePageToken("p2"), 2);
  assert.deepEqual([flows.parsePageToken("12"), flows.parsePageToken(undefined), flows.parsePageToken("page2")], [null, null, null]);
});

const runs = [];
registry.defineAction({
  id: "test_rate", section: "company", roles: [], label: "t-rate", dangerous: true,
  variants: [{ label: "Off", arg: "off" }, { label: "On", arg: "on" }],
  decodeArg: flows.splitPacked,
  collect: flows.createPickManagerCollect("test_rate", { position: 1, title: "Kimni?" }),
  confirmLabel: ([dir, id]) => `${dir} ${id}`,
  command: { pattern: /\/test_rate (off|on) (\d+)/, usage: "/test_rate <dir> <amo_id>", description: "t" },
  async run(ctx) { runs.push({ id: "test_rate", args: ctx.args }); },
});
registry.defineAction({
  id: "test_plan", section: "company", roles: [], label: "t-plan",
  decodeArg: flows.splitPacked, collect: flows.createSetPlanCollect("test_plan"),
  command: { pattern: /\/test_plan (\d+) (\S+)/, usage: "/test_plan <amo_id> <summa> [YYYY-MM]", description: "t" },
  async run(ctx) { runs.push({ id: "test_plan", args: ctx.args }); },
});
registry.defineAction({
  id: "test_days", section: "company", roles: [], label: "t-days",
  collect: flows.createChoiceCollect("test_days", { position: 0, title: "Necha kun?", options: () => flows.DAY_OPTIONS }),
  command: { pattern: /\/test_days(?: (\d+))?/, usage: "/test_days [kun]", description: "t" },
  async run(ctx) { runs.push({ id: "test_days", args: ctx.args }); },
});

test("a variant tap opens the manager list carrying the variant; a page tap redraws in place", async () => {
  const { sent, edits, bot } = fakeBot();
  await dispatch.execute(registry.getAction("test_rate"), ctxOf(bot, ["off"]));
  assert.equal(sent.at(-1).text, "Kimni?");
  assert.equal(data(sent.at(-1).options.reply_markup)[0][0], "m:test_rate:off_1000");
  assert.equal(data(sent.at(-1).options.reply_markup).at(-1).at(-1), "m:test_rate:off_p2");

  await dispatch.execute(registry.getAction("test_rate"), ctxOf(bot, ["off", "p2"]));
  assert.equal(edits.length, 1);
  assert.equal(edits[0].options.message_id, 55);
  assert.equal(data(edits[0].markup)[0][0], "m:test_rate:off_1008");
  assert.equal(runs.length, 0);
});

test("a chosen manager on a dangerous action is confirmed with a readable label, then run with both arguments", async () => {
  const calls = { sent: [], answers: [], edits: [], markups: [] };
  let listener;
  const bot = {
    on: (event, handler) => { if (event === "callback_query") listener = handler; },
    answerCallbackQuery: async (id, options) => { calls.answers.push(options); },
    sendMessage: async (chatId, text, options) => { calls.sent.push({ text, options }); },
    editMessageText: async (text, options) => { calls.edits.push({ text, options }); },
    editMessageReplyMarkup: async (markup, options) => { calls.markups.push({ markup, options }); },
  };
  menu.registerMenuCallbackHandler(bot, { claimCallback: async () => true, claimCallbackAction: async () => true, resolveAccess: async () => admin, cancelPendingInput: async () => true });
  const tap = (d) => listener({ id: Math.random().toString(), data: d, from: { id: 7 }, message: { chat: { id: 5 }, message_id: 55 } });

  await tap("m:test_rate:off_1003");
  assert.ok(calls.sent.at(-1).text.includes("off 1003"), "the confirmation names the choice");
  assert.deepEqual(data(calls.sent.at(-1).options.reply_markup)[0], ["m:test_rate:yes:off_1003", "m:test_rate:no"]);
  assert.equal(runs.length, 0);

  await tap("m:test_rate:yes:off_1003");
  assert.deepEqual(runs, [{ id: "test_rate", args: ["off", "1003"] }]);
});

test("the plan chain: list, typed amount, month buttons, then one callback with all three arguments", async () => {
  const { sent, bot } = fakeBot();
  const plan = registry.getAction("test_plan");

  await dispatch.execute(plan, ctxOf(bot, []));
  assert.equal(sent.at(-1).text, "Reja: menejerni tanlang");

  await dispatch.execute(plan, ctxOf(bot, ["1003"]));
  assert.equal(sent.at(-1).text, flows.PLAN_AMOUNT_PROMPT);
  assert.equal(data(sent.at(-1).options.reply_markup)[0][0], "m:cancel");
  const asked = await pending.lookup(7);
  assert.deepEqual([asked.input.kind, asked.input.payload], ["plan_amount", { action: "test_plan", amoUserId: "1003" }]);

  const typed = async (text) => inputs.handlePendingInput(bot, { chat: { id: 5 }, from: { id: 7 }, text }, await pending.lookup(7), pending);
  await typed("ko'p");
  assert.equal(sent.at(-1).text, flows.PLAN_AMOUNT_ERROR_TEXT);
  assert.equal((await pending.lookup(7)).state, "pending");

  await typed("50 000 000");
  assert.equal(sent.at(-1).text, flows.PLAN_MONTH_PROMPT);
  const months = data(sent.at(-1).options.reply_markup).flat();
  assert.equal(months.length, 2);
  assert.match(months[0], /^m:test_plan:1003_50000000_\d{4}-\d{2}$/);
  assert.deepEqual(await pending.lookup(7), { state: "none" });

  const packed = months[0].slice("m:test_plan:".length);
  await dispatch.execute(plan, ctxOf(bot, plan.decodeArg(packed)));
  assert.deepEqual(runs.filter((r) => r.id === "test_plan"), [{ id: "test_plan", args: ["1003", "50000000", packed.split("_")[2]] }]);
});

test("a choice collector offers the options and runs once one is picked; the command path is untouched", async () => {
  const { sent, bot } = fakeBot();
  const days = registry.getAction("test_days");
  await dispatch.execute(days, ctxOf(bot, []));
  assert.deepEqual(data(sent.at(-1).options.reply_markup), [["m:test_days:1", "m:test_days:3"], ["m:test_days:7", "m:test_days:14"]]);
  await dispatch.execute(days, ctxOf(bot, ["3"]));
  await dispatch.execute(days, ctxOf(bot, [], { source: "command" }));
  assert.deepEqual(runs.filter((r) => r.id === "test_days").map((r) => r.args), [["3"], []]);
});

test("month options follow the Almaty calendar month", () => {
  const mid = new Date(2026, 9, 15, 12);
  assert.deepEqual(flows.planTargetMonthOptions(mid).map((o) => o.value), ["2026-10", "2026-11"]);
  assert.deepEqual(flows.planViewMonthOptions(mid).map((o) => o.value), ["2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(flows.shiftPlanMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
  assert.deepEqual(flows.shiftPlanMonth({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 });
});

test("the real company actions are wired to the chains", () => {
  assert.equal(typeof registry.getAction("set_plan").collect, "function");
  assert.equal(registry.getAction("set_plan").decodeArg("1_2_3").length, 3);
  assert.deepEqual(registry.getAction("rating_toggle").variants.map((v) => v.arg), ["off", "on"]);
  assert.equal(registry.getAction("rating_toggle").confirmLabel(["off", "12695650"]), "reytingdan chiqarish, amoCRM ID 12695650");
  assert.equal(typeof registry.getAction("call_status").collect, "function");
  assert.equal(typeof registry.getAction("plans").collect, "function");
});
