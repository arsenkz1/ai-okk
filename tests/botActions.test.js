const test = require("node:test");
const assert = require("node:assert/strict");

const registry = require("../dist/bot/actions/registry");
const dispatch = require("../dist/bot/actions/dispatch");
require("../dist/bot/actions");
const { presetRange } = require("../dist/bot/actions/reports");
const aiCoach = require("../dist/bot/actions/aiCoach");
const help = require("../dist/bot/actions/help");
const admin = require("../dist/bot/actions/admin");
const { rolesOf } = require("../dist/bot/access");

const access = (isAdmin, manager) => ({ telegramUserId: "1", isAdmin, manager, roles: rolesOf(isAdmin, manager) });
const active = (role) => ({ role, isActive: true, id: 7, teamId: null });
const inactive = (role) => ({ role, isActive: false, id: 7, teamId: null });

test("report actions are registered with their original command patterns", () => {
  const cases = [
    ["report", "/report"], ["week", "/week"], ["month", "/month"], ["period", "/period"],
    ["errors", "/errors"], ["deal", "/deal 26199367"], ["deal_usage", "/deal"],
  ];
  for (const [id, text] of cases) {
    const action = registry.getAction(id);
    assert.equal(action.command.pattern.test(text), true, `${id} matches "${text}"`);
  }
  assert.equal(registry.getAction("deal").command.pattern.test("/deal"), false);
  assert.equal(registry.getAction("deal_usage").command.pattern.test("/deal 1"), false);
  assert.equal(registry.getAction("deal").command.pattern.exec("/deal 26199367")[1], "26199367");
});

test("who may run what: admins and active managers see reports, the usage hint is public", () => {
  const report = registry.getAction("report");
  assert.equal(registry.isAllowed(report, access(true, null)), true);
  assert.equal(registry.isAllowed(report, access(false, active("MANAGER"))), true);
  assert.equal(registry.isAllowed(report, access(false, inactive("ROP"))), false);
  assert.equal(registry.isAllowed(report, access(false, null)), false);
  assert.equal(registry.isAllowed(registry.getAction("deal_usage"), access(false, null)), true);
});

test("denial texts match what the commands always answered", () => {
  const report = registry.getAction("report");
  assert.equal(dispatch.denialText(report, access(false, null)), dispatch.NOT_LINKED_TEXT);
  assert.equal(dispatch.denialText(report, access(false, inactive("MANAGER"))), dispatch.DEACTIVATED_TEXT);
  // /deal never distinguished an inactive account from an unlinked one.
  assert.equal(dispatch.denialText(registry.getAction("deal"), access(false, inactive("MANAGER"))), dispatch.NOT_LINKED_TEXT);
});

test("execute refuses before run and sends exactly one denial", async () => {
  const sent = [];
  let ran = 0;
  const action = registry.defineAction({
    id: "test_only", section: "reports", roles: ["admin"], label: "t",
    async run() { ran += 1; },
  });
  const bot = { sendMessage: async (chatId, text) => { sent.push([chatId, text]); } };
  await dispatch.execute(action, { bot, chatId: 5, userId: 1, telegramUserId: "1", access: access(false, active("MANAGER")), args: [], source: "command" });
  assert.equal(ran, 0);
  assert.deepEqual(sent, [[5, dispatch.NO_RIGHTS_TEXT]]);
  await dispatch.execute(action, { bot, chatId: 5, userId: 1, telegramUserId: "1", access: access(true, null), args: [], source: "command" });
  assert.equal(ran, 1);
  assert.equal(sent.length, 1);
});

test("registerCommandActions wires one onText per action and rejects actions without a command", () => {
  const patterns = [];
  const bot = { onText: (pattern) => { patterns.push(pattern.source); } };
  dispatch.registerCommandActions(bot, ["report", "week", "deal"]);
  assert.deepEqual(patterns, ["\\/report$", "\\/week$", "^\\/deal(?:@\\w+)?\\s+(\\d{4,12})$"]);
  assert.throws(() => dispatch.registerCommandActions(bot, ["test_only"]), /has no command/);
});

test("preset ranges keep their labels and boundaries", () => {
  const now = new Date(2026, 9, 17, 15, 30);
  assert.equal(presetRange("day", now).label, "bugun, 17-oktabr");
  assert.equal(presetRange("week", now).label, "so'nggi 7 kun");
  assert.equal(presetRange("month", now).label, "Oktabr 2026");
  assert.equal(presetRange("week", now).from.getDate(), 11);
  assert.equal(presetRange("month", now).from.getDate(), 1);
  assert.equal(presetRange("day", now).to.getTime(), now.getTime());
});

test("the registry refuses a duplicate id", () => {
  assert.throws(() => registry.defineAction({ id: "report", section: "reports", roles: [], label: "x", async run() {} }), /defined twice/);
});

test("/start, /help, /ask and /stop_ai keep their command patterns", () => {
  assert.equal(registry.getAction("start").command.pattern.test("/start"), true);
  assert.equal(registry.getAction("help").command.pattern.test("/help"), true);
  assert.equal(registry.getAction("stop_ai").command.pattern.test("/stop_ai"), true);
  const ask = registry.getAction("ask").command.pattern;
  assert.equal(ask.exec("/ask")[1], "");
  assert.equal(ask.exec("/ask_kun nega sotolmadim?")[1], "_kun nega sotolmadim?");
  assert.equal(ask.exec("/ask savol")[1], " savol");
  assert.equal(ask.exec("/ask_oy")[1], "_oy");
  assert.equal(ask.exec("/ask ikki\nqator")[1], " ikki\nqator");
  // Anchored: the team-lead command and random prefixes are no longer caught.
  for (const text of ["/ask_manager", "/askanything", "hello /ask", "/ask_kunduz"]) assert.equal(ask.test(text), false, text);
});

test("/ask is for linked active managers only; /start, /help and /stop_ai answer anyone", () => {
  const ask = registry.getAction("ask");
  assert.equal(registry.isAllowed(ask, access(false, active("MANAGER"))), true);
  assert.equal(registry.isAllowed(ask, access(true, null)), false, "an admin without a link has no calls to coach");
  assert.equal(dispatch.denialText(ask, access(true, null)), dispatch.NOT_LINKED_TEXT);
  assert.equal(dispatch.denialText(ask, access(false, inactive("MANAGER"))), dispatch.DEACTIVATED_TEXT);
  for (const id of ["start", "help", "stop_ai"]) {
    assert.equal(registry.isAllowed(registry.getAction(id), access(false, null)), true, id);
  }
});

test("ask arguments resolve to the period and the inline question as before", () => {
  const parse = aiCoach.parseAskArgWithAliases;
  assert.deepEqual(parse(""), { period: "30days", question: "" });
  assert.deepEqual(parse("_kun"), { period: "day", question: "" });
  assert.deepEqual(parse("_hafta nega?"), { period: "week", question: "nega?" });
  assert.deepEqual(parse("_oy"), { period: "month", question: "" });
  assert.deepEqual(parse(" oy"), { period: "month", question: "" });
  assert.deepEqual(parse(" неделя"), { period: "week", question: "" });
  assert.deepEqual(parse(" qanday yaxshilash mumkin?"), { period: "30days", question: "qanday yaxshilash mumkin?" });
  assert.equal(aiCoach.periodLabel("week"), "so'nggi 7 kun");
  assert.equal(aiCoach.periodLabel("30days"), "so'nggi 30 kun");
  const range = aiCoach.periodDateRange("30days", new Date(2026, 9, 17, 12));
  assert.equal(range.from.getDate(), 18);
  assert.equal(range.from.getMonth(), 8);
});

test("help and start pick the same block the commands always picked", () => {
  assert.equal(help.helpTextFor(access(true, null)), help.ADMIN_HELP_TEXT);
  assert.equal(help.helpTextFor(access(true, active("TEAMLEAD"))), help.ADMIN_HELP_TEXT, "admin wins over team lead");
  assert.equal(help.helpTextFor(access(false, active("TEAMLEAD"))), help.TEAMLEAD_HELP_TEXT);
  assert.equal(help.helpTextFor(access(false, inactive("TEAMLEAD"))), help.TEAMLEAD_HELP_TEXT, "help never checked activity");
  assert.equal(help.helpTextFor(access(false, active("ROP"))), help.MANAGER_HELP_TEXT);
  assert.equal(help.helpTextFor(access(false, null)), help.UNLINKED_HELP_TEXT);

  const manager = { ...active("MANAGER"), name: "Aziza" };
  assert.deepEqual(help.startReply(access(false, manager)), { text: help.startManagerText("Aziza"), awaitCode: false });
  assert.deepEqual(help.startReply(access(true, manager)), { text: help.startManagerText("Aziza"), awaitCode: false }, "a linked admin is greeted as a manager");
  assert.deepEqual(help.startReply(access(true, null)), { text: help.START_ADMIN_TEXT, awaitCode: false });
  assert.deepEqual(help.startReply(access(false, null)), { text: help.START_CODE_PROMPT_TEXT, awaitCode: true });
});

test("admin commands keep their patterns and capture their arguments", () => {
  const cases = [
    ["sync_managers", "/sync_managers", []], ["sync_history", "/sync_history", []], ["managers", "/managers", []],
    ["manager_ids", "/manager_ids", []], ["admins", "/admins", []], ["add_admin", "/add_admin 295612129", ["295612129"]],
    ["remove_admin", "/remove_admin 42", ["42"]], ["reset_code", "/reset_code 12695650", ["12695650"]],
    ["analyze_deal", "/analyze_deal 26199367", ["26199367"]], ["check_tg", "/check_tg 42 ", ["42"]],
    ["test_restrict", "/test_restrict 42", ["42"]], ["test_restore", "/test_restore 42", ["42"]],
  ];
  for (const [id, text, args] of cases) {
    const match = registry.getAction(id).command.pattern.exec(text);
    assert.ok(match, `${id} matches "${text}"`);
    assert.deepEqual(match.slice(1).map((part) => part.trim()), args, id);
  }
  // Historical quirk kept: /sync_history is unanchored and also fires with a tail.
  assert.equal(registry.getAction("sync_history").command.pattern.test("/sync_history now"), true);
});

test("admin commands refuse everyone else with the administrator text", () => {
  for (const id of ["sync_managers", "managers", "add_admin", "analyze_deal", "test_restrict"]) {
    const action = registry.getAction(id);
    assert.equal(registry.isAllowed(action, access(true, null)), true, id);
    assert.equal(registry.isAllowed(action, access(false, active("ROP"))), false, id);
    assert.equal(dispatch.denialText(action, access(false, active("ROP"))), admin.ADMIN_DENY_TEXT, id);
    assert.equal(dispatch.denialText(action, access(false, null)), admin.ADMIN_DENY_TEXT, id);
  }
});

test("debug switches stay commands; removing an admin and resetting a code are marked dangerous", () => {
  for (const id of ["check_tg", "test_restrict", "test_restore"]) assert.equal(registry.getAction(id).commandOnly, true, id);
  for (const id of ["remove_admin", "reset_code"]) assert.equal(registry.getAction(id).dangerous, true, id);
  for (const id of ["managers", "admins", "sync_managers"]) assert.equal(registry.getAction(id).commandOnly, undefined, id);
});

test("loading the registry never loads the queue or the PBX history client", () => {
  const loaded = Object.keys(require.cache);
  const heavy = loaded.filter((file) => /\/bullmq\/|\/queues\/callProcessing|\/services\/pbxHistory|\/services\/amocrm\.js$/.test(file));
  assert.deepEqual(heavy, []);
});

test("a denial text may depend on the caller: a function is honoured over the defaults", () => {
  const action = registry.defineAction({
    id: "test_fn_deny", section: "team", roles: ["teamlead"], label: "t-fn",
    denyText: (a) => (a.manager && !a.manager.isActive ? "deactivated" : "no rights"),
    async run() {},
  });
  assert.equal(dispatch.denialText(action, access(false, inactive("TEAMLEAD"))), "deactivated");
  assert.equal(dispatch.denialText(action, access(false, active("MANAGER"))), "no rights");
  assert.equal(dispatch.denialText(action, access(true, null)), "no rights");
});

test("button labels are unique across every registered action and section", () => {
  const labels = [
    ...registry.SECTIONS.map((section) => section.label),
    ...registry.allActions().filter((action) => !action.id.startsWith("test_")).map((action) => action.label),
  ];
  const duplicates = labels.filter((label, index) => labels.indexOf(label) !== index);
  assert.deepEqual(duplicates, []);
  for (const label of labels) {
    assert.equal(/^[\d\s.]+$/.test(label), false, `"${label}" could be mistaken for typed input`);
    assert.equal(/^\d{2}\.\d{2}\.\d{4}$/.test(label), false, label);
  }
});
