const test = require("node:test");
const assert = require("node:assert/strict");

require("../dist/bot/actions");
const fakeRegistrar = { onText: () => {}, on: () => {} };
require("../dist/bot/handlers/performance").registerPerformanceHandlers(fakeRegistrar);
require("../dist/bot/handlers/adminRoles").registerAdminRoleHandlers(fakeRegistrar);
require("../dist/bot/handlers/rop").registerRopHandlers(fakeRegistrar);
require("../dist/bot/handlers/teamlead").registerTeamLeadHandlers(fakeRegistrar);
require("../dist/bot/handlers/callTaskReview").registerCallTaskReviewHandlers(fakeRegistrar);

const menu = require("../dist/bot/keyboards/menuCallbacks");
const registry = require("../dist/bot/actions/registry");
const { rolesOf } = require("../dist/bot/access");

const access = (isAdmin, manager) => ({ telegramUserId: "7", isAdmin, manager, roles: rolesOf(isAdmin, manager) });
const active = (role) => ({ role, isActive: true, id: 7, teamId: null });

test("callback data parses into sections, actions, arguments and decisions", () => {
  assert.deepEqual(menu.parseMenuCallback("m:sec:reports"), { kind: "section", sectionId: "reports" });
  assert.deepEqual(menu.parseMenuCallback("m:report"), { kind: "action", actionId: "report", arg: null, decision: null });
  assert.deepEqual(menu.parseMenuCallback("m:deal:26199367"), { kind: "action", actionId: "deal", arg: "26199367", decision: null });
  assert.deepEqual(menu.parseMenuCallback("m:set_plan:p2"), { kind: "action", actionId: "set_plan", arg: "p2", decision: null });
  assert.deepEqual(menu.parseMenuCallback("m:inactivity_off:yes"), { kind: "action", actionId: "inactivity_off", arg: null, decision: "yes" });
  assert.deepEqual(menu.parseMenuCallback("m:rating_toggle:yes:12695650"), { kind: "action", actionId: "rating_toggle", arg: "12695650", decision: "yes" });
  assert.deepEqual(menu.parseMenuCallback("m:delete_team:no"), { kind: "action", actionId: "delete_team", arg: null, decision: "no" });
  assert.deepEqual(menu.parseMenuCallback("m:cancel"), { kind: "cancel" });
  assert.equal(menu.parseMenuCallback("m:cancel:x"), null);
  assert.deepEqual(menu.cancelKeyboard().inline_keyboard, [[{ text: "Bekor qilish", callback_data: "m:cancel" }]]);
});

test("anything that is not a well-formed menu callback is ignored", () => {
  for (const data of [undefined, "", "m:", "x:report", "phx:abc:yes", "tl_manage:add:select:1", "admin_delete_team_confirm:3",
    "m:sec:unknown", "m:sec:reports:extra", "m:report:a b", "m:report:x:y", "m:delete_team:no:3", "m:" + "a".repeat(70)]) {
    assert.equal(menu.parseMenuCallback(data), null, String(data));
  }
});

test("encoders round-trip and refuse what Telegram would reject", () => {
  assert.equal(menu.sectionCallback("phoenix"), "m:sec:phoenix");
  assert.equal(menu.actionCallback("report"), "m:report");
  assert.equal(menu.actionCallback("deal", "26199367"), "m:deal:26199367");
  assert.equal(menu.confirmCallback("inactivity_off", "yes"), "m:inactivity_off:yes");
  assert.equal(menu.confirmCallback("rating_toggle", "yes", "5"), "m:rating_toggle:yes:5");
  assert.equal(menu.confirmCallback("rating_toggle", "no", "5"), "m:rating_toggle:no");
  assert.throws(() => menu.actionCallback("deal", "a b"), /not a valid/);
  assert.throws(() => menu.actionCallback("deal", "x".repeat(70)), /not a valid/);
  assert.deepEqual(menu.parseMenuCallback(menu.actionCallback("deal", "26199367")), { kind: "action", actionId: "deal", arg: "26199367", decision: null });
});

test("no other callback prefix in the bot starts with the menu prefix", () => {
  for (const prefix of ["tl_manage:", "tl_card:", "tl_ask:", "rop_team:", "rop_card:", "admin_delete_team_confirm:", "phx:"]) {
    assert.equal(prefix.startsWith(menu.MENU_CALLBACK_PREFIX), false, prefix);
  }
});

function fakeBot() {
  const calls = { answers: [], sent: [], edits: [], markups: [] };
  let listener = null;
  const bot = {
    on: (event, handler) => { if (event === "callback_query") listener = handler; },
    answerCallbackQuery: async (id, options) => { calls.answers.push({ id, options }); return true; },
    sendMessage: async (chatId, text, options) => { calls.sent.push({ chatId, text, options }); return {}; },
    editMessageText: async (text, options) => { calls.edits.push({ text, options }); return true; },
    editMessageReplyMarkup: async (markup, options) => { calls.markups.push({ markup, options }); return true; },
  };
  return { bot, calls, tap: (data, from = 7) => listener({ id: `q${calls.answers.length + 1}-${Math.random()}`, data, from: { id: from }, message: { chat: { id: 100 }, message_id: 55 } }) };
}

function registerWith(deps) {
  const fake = fakeBot();
  const actionLocks = new Set();
  menu.registerMenuCallbackHandler(fake.bot, {
    claimCallback: async () => true,
    claimCallbackAction: async (chatId, messageId, data) => { const key = `${chatId}:${messageId}:${data}`; if (actionLocks.has(key)) return false; actionLocks.add(key); return true; },
    resolveAccess: async () => access(true, null),
    cancelPendingInput: async () => true,
    ...deps,
  });
  return fake;
}

const runs = [];
registry.defineAction({ id: "test_cb", section: "reports", roles: [], label: "t-cb", async run(ctx) { runs.push({ id: "test_cb", source: ctx.source, args: ctx.args }); } });
registry.defineAction({ id: "test_cb_admin", section: "reports", roles: ["admin"], label: "t-cb-admin", denyText: "no admin", async run(ctx) { runs.push({ id: "test_cb_admin", source: ctx.source }); } });
registry.defineAction({ id: "test_cb_danger", section: "reports", roles: [], label: "t-cb-danger", dangerous: true, async run(ctx) { runs.push({ id: "test_cb_danger", args: ctx.args }); } });

test("a plain action button runs the action once per tap and answers the query exactly once", async () => {
  const { calls, tap } = registerWith();
  await tap("m:test_cb:26199367");
  assert.deepEqual(runs.filter((r) => r.id === "test_cb"), [{ id: "test_cb", source: "callback", args: ["26199367"] }]);
  assert.equal(calls.answers.length, 1);
  assert.equal(calls.answers[0].options, undefined);
  assert.equal(calls.markups.length, 0, "a section menu keeps its buttons");
});

test("a double tap within the lock window answers 'in progress' and does not run again", async () => {
  const { calls, tap } = registerWith();
  const before = runs.filter((r) => r.id === "test_cb").length;
  await tap("m:test_cb");
  await tap("m:test_cb");
  assert.equal(runs.filter((r) => r.id === "test_cb").length, before + 1);
  assert.equal(calls.answers.length, 2);
  assert.equal(calls.answers[1].options.text, menu.IN_PROGRESS_TEXT);
});

test("a dangerous action asks first, 'no' declines, 'yes' runs and spends the confirmation", async () => {
  const { calls, tap } = registerWith();
  await tap("m:test_cb_danger:9");
  assert.equal(runs.some((r) => r.id === "test_cb_danger"), false);
  assert.equal(calls.sent.length, 1);
  assert.deepEqual(calls.sent[0].options.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["m:test_cb_danger:yes:9", "m:test_cb_danger:no"]);

  await tap("m:test_cb_danger:no");
  assert.equal(calls.edits.at(-1).text, menu.CONFIRM_DECLINED_TEXT);

  await tap("m:test_cb_danger:yes:9");
  assert.deepEqual(runs.filter((r) => r.id === "test_cb_danger"), [{ id: "test_cb_danger", args: ["9"] }]);
  assert.deepEqual(calls.markups.at(-1).markup, { inline_keyboard: [] });
  assert.equal(calls.answers.length, 3);
});

test("a section callback redraws the message as that section's keyboard", async () => {
  const { calls, tap } = registerWith({ resolveAccess: async () => access(false, active("MANAGER")) });
  await tap("m:sec:reports");
  assert.equal(calls.edits.length, 1);
  assert.equal(calls.edits[0].options.reply_markup.inline_keyboard[0][0].callback_data, "m:report");
  assert.equal(calls.answers.length, 1);
});

test("a caller without the role is refused through the dispatcher, with one answer", async () => {
  const { calls, tap } = registerWith({ resolveAccess: async () => access(false, active("MANAGER")) });
  await tap("m:test_cb_admin");
  assert.equal(runs.some((r) => r.id === "test_cb_admin"), false);
  assert.deepEqual(calls.sent.map((s) => s.text), ["no admin"]);
  assert.equal(calls.answers.length, 1);
});

test("unknown or foreign callbacks: foreign ones are left to their own handler, stale ones get a short answer", async () => {
  const { calls, tap } = registerWith();
  await tap("phx:token:yes");
  assert.equal(calls.answers.length, 0);
  await tap("m:no_such_action");
  assert.equal(calls.answers.at(-1).options.text, menu.UNKNOWN_BUTTON_TEXT);
});

test("a redelivered query is answered silently and not run", async () => {
  const { calls, tap } = registerWith({ claimCallback: async () => false });
  const before = runs.length;
  await tap("m:test_cb");
  assert.equal(runs.length, before);
  assert.equal(calls.answers.length, 1);
});

test("a failing action is logged; the query was already answered exactly once", async () => {
  registry.defineAction({ id: "test_cb_boom", section: "reports", roles: [], label: "t-boom", async run() { throw new Error("boom"); } });
  const { calls, tap } = registerWith();
  const originalError = console.error;
  console.error = () => {};
  try { await tap("m:test_cb_boom"); } finally { console.error = originalError; }
  assert.equal(calls.answers.length, 1);
});

test("the cancel button drops the pending question and rewrites the prompt", async () => {
  const cancelled = [];
  const { calls, tap } = registerWith({ cancelPendingInput: async (userId) => { cancelled.push(userId); return true; } });
  await tap("m:cancel");
  assert.deepEqual(cancelled, [7]);
  assert.equal(calls.edits.at(-1).text, menu.CONFIRM_DECLINED_TEXT);
  assert.equal(calls.answers.length, 1);
});

test("a dangerous action that still has to ask is not confirmed up front", async () => {
  const asked = [];
  const dispatchModule = require("../dist/bot/actions/dispatch");
  const pendingModule = require("../dist/bot/pendingInput");
  const rows = new Map();
  const fakePending = pendingModule.createPendingInputService({
    async get(key) { return rows.get(key) ?? null; }, async set(key, value) { rows.set(key, value); asked.push(key); }, async del(key) { rows.delete(key); },
  });
  dispatchModule.configureDispatch({ pendingInput: fakePending });
  registry.defineAction({
    id: "test_cb_danger_input", section: "users", roles: [], label: "t-danger-input", dangerous: true,
    input: { kind: "telegram_id", prompt: "Kimni?" },
    command: { pattern: /\/x (\d+)/, usage: "/x <tg_id>", description: "t" },
    async run() { runs.push({ id: "test_cb_danger_input" }); },
  });
  const { calls, tap } = registerWith();
  await tap("m:test_cb_danger_input");
  assert.equal(calls.sent.at(-1).text, "Kimni?", "the question comes first");
  assert.deepEqual(asked, ["bot:pending:7"]);
  assert.equal(runs.some((r) => r.id === "test_cb_danger_input"), false);
});

test("an action run from a button sees the tapping user as the message author, not the bot", async () => {
  const seen = [];
  registry.defineAction({ id: "test_cb_from", section: "reports", roles: [], label: "t-from", async run(ctx) { seen.push({ from: ctx.message.from.id, chat: ctx.message.chat.id, user: ctx.userId }); } });
  const { tap } = registerWith();
  await tap("m:test_cb_from", 4242);
  assert.deepEqual(seen, [{ from: 4242, chat: 100, user: 4242 }]);
});
