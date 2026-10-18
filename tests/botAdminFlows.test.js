const test = require("node:test");
const assert = require("node:assert/strict");

require("../dist/bot/actions");
const fakeRegistrar = { onText: () => {}, on: () => {} };
require("../dist/bot/handlers/performance").registerPerformanceHandlers(fakeRegistrar);
require("../dist/bot/handlers/adminRoles").registerAdminRoleHandlers(fakeRegistrar);
require("../dist/bot/handlers/rop").registerRopHandlers(fakeRegistrar);
require("../dist/bot/handlers/teamlead").registerTeamLeadHandlers(fakeRegistrar);
const callTaskReview = require("../dist/bot/handlers/callTaskReview");
callTaskReview.registerCallTaskReviewHandlers(fakeRegistrar);

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
const active = (role) => ({ role, isActive: true, id: 7, teamId: null });

const loaderCalls = [];
picker.configureManagerPicker({
  loadManagers: async (filter) => { loaderCalls.push(filter); return filter?.role === "TEAMLEAD" ? [{ amoUserId: 2000, name: "Lead One" }] : [{ amoUserId: 1000, name: "Aziza" }, { amoUserId: 1001, name: "Bobur" }]; },
  loadLinkedUsers: async () => [{ value: "295612129", label: "Aziza (MANAGER)" }, { value: "42", label: "Bobur (TEAMLEAD)" }],
  loadTeams: async () => [{ value: "3", label: "Aziza jamoasi" }],
});
const rows = new Map();
const pending = pendingModule.createPendingInputService({
  async get(key) { return rows.get(key) ?? null; }, async set(key, value) { rows.set(key, value); }, async del(key) { rows.delete(key); },
}, () => 1_000_000);
dispatch.configureDispatch({ pendingInput: pending, resolveAccess: async () => admin });

function fakeBot() {
  const sent = [], edits = [];
  return { sent, edits, bot: {
    sendMessage: async (chatId, text, options) => { sent.push({ chatId, text, options }); return { message_id: 1 }; },
    editMessageReplyMarkup: async (markup, options) => { edits.push({ markup, options }); return true; },
  } };
}
const ctxOf = (bot, args) => ({ bot, chatId: 5, userId: 7, telegramUserId: "7", access: admin, args, source: "callback", pending, message: { chat: { id: 5 }, message_id: 55, from: { id: 7 } } });
const data = (markup) => markup.inline_keyboard.map((row) => row.map((b) => b.callback_data));

const runs = [];
registry.defineAction({
  id: "test_two_pick", section: "users", roles: [], label: "t-two", decodeArg: flows.splitPacked,
  collect: flows.createStepsCollect("test_two_pick", [{ kind: "managers", title: "Menejer?" }, { kind: "managers", filter: { role: "TEAMLEAD" }, title: "Tim-lid?" }]),
  command: { pattern: /\/test_two_pick (\d+) (\d+)/, usage: "/test_two_pick <mgr> <tl>", description: "t" },
  async run(ctx) { runs.push({ id: "test_two_pick", args: ctx.args }); },
});
registry.defineAction({
  id: "test_role", section: "users", roles: [], label: "t-role", dangerous: true, decodeArg: flows.splitPacked,
  collect: flows.createStepsCollect("test_role", [{ kind: "linkedUsers", title: "Kim?" }, { kind: "choice", title: "Rol?", options: () => flows.ROLE_OPTIONS }]),
  confirmLabel: ([tg, role]) => `${tg} → ${role}`,
  command: { pattern: /\/test_role (\S+) (\S+)/, usage: "/test_role <tg_id> <role>", description: "t" },
  async run(ctx) { runs.push({ id: "test_role", args: ctx.args }); },
});

test("two picker steps: the second list is filtered and carries the first choice; then both reach run", async () => {
  const { sent, bot } = fakeBot();
  const action = registry.getAction("test_two_pick");
  await dispatch.execute(action, ctxOf(bot, []));
  assert.equal(sent.at(-1).text, "Menejer?");
  assert.deepEqual(data(sent.at(-1).options.reply_markup), [["m:test_two_pick:1000", "m:test_two_pick:1001"]]);

  await dispatch.execute(action, ctxOf(bot, ["1001"]));
  assert.equal(sent.at(-1).text, "Tim-lid?");
  assert.deepEqual(loaderCalls.at(-1), { role: "TEAMLEAD" });
  assert.deepEqual(data(sent.at(-1).options.reply_markup), [["m:test_two_pick:1001_2000"]]);

  await dispatch.execute(action, ctxOf(bot, action.decodeArg("1001_2000")));
  assert.deepEqual(runs.filter((r) => r.id === "test_two_pick"), [{ id: "test_two_pick", args: ["1001", "2000"] }]);
});

test("a linked-user step then a role choice, confirmed with a readable label before running", async () => {
  const calls = { sent: [], answers: [] };
  let listener;
  const bot = {
    on: (event, handler) => { if (event === "callback_query") listener = handler; },
    answerCallbackQuery: async () => { calls.answers.push(1); },
    sendMessage: async (chatId, text, options) => { calls.sent.push({ text, options }); },
    editMessageText: async () => {}, editMessageReplyMarkup: async () => {},
  };
  menu.registerMenuCallbackHandler(bot, { claimCallback: async () => true, claimCallbackAction: async () => true, resolveAccess: async () => admin, cancelPendingInput: async () => true });
  const tap = (d) => listener({ id: Math.random().toString(), data: d, from: { id: 7 }, message: { chat: { id: 5 }, message_id: 55 } });

  await tap("m:test_role");
  assert.equal(calls.sent.at(-1).text, "Kim?");
  assert.deepEqual(data(calls.sent.at(-1).options.reply_markup), [["m:test_role:295612129", "m:test_role:42"]]);
  await tap("m:test_role:42");
  assert.equal(calls.sent.at(-1).text, "Rol?");
  assert.deepEqual(data(calls.sent.at(-1).options.reply_markup), [["m:test_role:42_manager", "m:test_role:42_teamlead"], ["m:test_role:42_rop"]]);
  await tap("m:test_role:42_rop");
  assert.ok(calls.sent.at(-1).text.includes("42 → rop"));
  assert.deepEqual(data(calls.sent.at(-1).options.reply_markup)[0], ["m:test_role:yes:42_rop", "m:test_role:no"]);
  assert.equal(runs.some((r) => r.id === "test_role"), false);
  await tap("m:test_role:yes:42_rop");
  assert.deepEqual(runs.filter((r) => r.id === "test_role"), [{ id: "test_role", args: ["42", "rop"] }]);
});

test("the real admin actions are wired: pickers, confirmations, and delete_team confirming on its own", () => {
  for (const id of ["set_role", "set_teamlead", "add_to_team", "remove_from_team", "delete_team", "reset_code"]) {
    assert.equal(typeof registry.getAction(id).collect, "function", id);
  }
  assert.equal(registry.getAction("delete_team").dangerous, undefined, "its run shows the team details and asks itself");
  assert.equal(registry.getAction("reset_code").dangerous, true);
  assert.equal(registry.getAction("reset_code").confirmLabel(["12695650"]), "amoCRM ID 12695650");
  assert.equal(registry.getAction("set_role").confirmLabel(["42", "rop"]), "Telegram ID 42 → rop");
  assert.deepEqual(registry.getAction("add_to_team").decodeArg("1_2"), ["1", "2"]);
});

test("the users and sync sections list the admin tools in a stable order", () => {
  const { sectionKeyboard } = require("../dist/bot/keyboards/menuCallbacks");
  const section = (id) => registry.SECTIONS.find((s) => s.id === id);
  const labels = (id, a = admin) => sectionKeyboard(a, section(id), 7).inline_keyboard.flat().map((b) => b.callback_data).filter((d) => !d.startsWith("m:test_"));
  assert.deepEqual(labels("users"), [
    "m:managers", "m:manager_ids", "m:admins", "m:teams_list",
    "m:reset_code", "m:add_admin", "m:remove_admin",
    "m:set_role", "m:set_teamlead", "m:add_to_team", "m:remove_from_team", "m:delete_team",
    "m:analyze_deal",
  ]);
  assert.deepEqual(labels("sync"), ["m:sync_managers", "m:sync_history"]);
  assert.deepEqual(labels("users", access(false, active("ROP"))), [], "nothing administrative for a ROP");
});

test("a typed deadline for an AI task is validated before anything is approved", async () => {
  const { sent, bot } = fakeBot();
  await pending.expect(9, "task_due", { token: "abcdefghijkl" });
  const typed = async (text) => inputs.handlePendingInput(bot, { chat: { id: 9 }, from: { id: 9 }, text }, await pending.lookup(9), pending);
  await typed("tomorrow");
  assert.equal(sent.at(-1).text, callTaskReview.TASK_DUE_ERROR_TEXT);
  await typed("2020-01-01 10:00");
  assert.equal(sent.at(-1).text, callTaskReview.TASK_DUE_ERROR_TEXT, "a past date is refused");
  assert.equal((await pending.lookup(9)).state, "pending", "the question stays open");
  assert.equal(inputs.hasInputHandler("task_due"), true);
});

test("the generic picker pages any items and labels linked users and teams", () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ value: String(i), label: `Item ${i}` }));
  const page = picker.pickerKeyboard(items, 2, { pick: (v) => `m:x:${v}`, page: (n) => `m:x:p${n}` });
  assert.equal(page.pages, 2);
  assert.deepEqual(data(page.markup), [["m:x:8"], ["m:x:p1", "m:x:p2"]]);
});
