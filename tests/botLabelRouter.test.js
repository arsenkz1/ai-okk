const test = require("node:test");
const assert = require("node:assert/strict");

require("../dist/bot/actions");
const fakeRegistrar = { onText: () => {}, on: () => {} };
require("../dist/bot/handlers/performance").registerPerformanceHandlers(fakeRegistrar);
require("../dist/bot/handlers/adminRoles").registerAdminRoleHandlers(fakeRegistrar);
require("../dist/bot/handlers/rop").registerRopHandlers(fakeRegistrar);
require("../dist/bot/handlers/teamlead").registerTeamLeadHandlers(fakeRegistrar);
require("../dist/bot/handlers/callTaskReview").registerCallTaskReviewHandlers(fakeRegistrar);

const router = require("../dist/bot/keyboards/labelRouter");
const registry = require("../dist/bot/actions/registry");
const dispatch = require("../dist/bot/actions/dispatch");
const { rolesOf } = require("../dist/bot/access");

const access = (isAdmin, manager) => ({ telegramUserId: "7", isAdmin, manager, roles: rolesOf(isAdmin, manager) });
const active = (role) => ({ role, isActive: true, id: 7, teamId: null });

test("button text resolves to its section, action or cancel; anything else is left alone", () => {
  assert.deepEqual(router.resolveLabel("Hisobotlar").kind, "section");
  assert.equal(router.resolveLabel("Hisobotlar").section.id, "reports");
  assert.deepEqual(router.resolveLabel("  Bugun "), { kind: "action", id: "report" });
  assert.deepEqual(router.resolveLabel("Feniksni to'xtatish"), { kind: "action", id: "inactivity_off" });
  assert.deepEqual(router.resolveLabel("Bekor qilish"), { kind: "cancel" });
  for (const text of ["bugun", "/report", "123456", "10.03.2026", "26199367", "", "   ", "qanday yaxshilash mumkin?"]) {
    assert.equal(router.resolveLabel(text), null, JSON.stringify(text));
  }
});

test("command-only actions have no routable label", () => {
  for (const id of ["start", "check_tg", "test_restrict", "set_plan_usage", "deal_usage", "call_task_time"]) {
    assert.equal(router.resolveLabel(registry.getAction(id).label), null, id);
  }
});

test("no label can be mistaken for an activation code, a date or a deal id", () => {
  const labels = [registry.CANCEL_LABEL, ...registry.SECTIONS.map((s) => s.label), ...registry.allActions().map((a) => a.label)];
  for (const label of labels) {
    assert.equal(/^\d{6}$/.test(label), false, label);
    assert.equal(/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(label), false, label);
    assert.equal(/^\d{4}-\d{2}-\d{2}$/.test(label), false, label);
    assert.equal(/^[\d\s.]+$/.test(label), false, label);
    assert.equal(label.startsWith("/"), false, label);
  }
  assert.deepEqual(labels.filter((label, index) => labels.indexOf(label) !== index), []);
});

test("a section tap opens an inline keyboard with only what the user may run", async () => {
  const sent = [];
  const bot = { sendMessage: async (chatId, text, options) => { sent.push({ text, options }); } };
  const reports = registry.SECTIONS.find((s) => s.id === "reports");
  const { sectionKeyboard } = require("../dist/bot/keyboards/menuCallbacks");
  const keyboard = await sectionKeyboard(access(false, active("MANAGER")), reports);
  const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
  assert.deepEqual(labels, ["Bugun", "Hafta", "Oy", "Davr", "Xatolar", "Bitim", "Mening statistikam"]);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, "m:report");
  assert.ok(keyboard.inline_keyboard.every((row) => row.length <= 2));

  const company = registry.SECTIONS.find((s) => s.id === "company");
  assert.equal((await sectionKeyboard(access(false, active("MANAGER")), company)).inline_keyboard.length, 0);
  assert.ok((await sectionKeyboard(access(false, active("ROP")), company)).inline_keyboard.flat().some((b) => b.callback_data === "m:set_plan"));
});

test("required arguments are counted from the usage line", () => {
  assert.equal(dispatch.requiredArgCount("/report"), 0);
  assert.equal(dispatch.requiredArgCount("/ask [savol]"), 0);
  assert.equal(dispatch.requiredArgCount("/deal <id>"), 1);
  assert.equal(dispatch.requiredArgCount("/set_plan <amo_id> <summa> [YYYY-MM]"), 2);
});

test("a button tap on an action that needs arguments answers with the usage instead of running", async () => {
  const sent = [];
  let ran = 0;
  const action = registry.defineAction({
    id: "test_needs_arg", section: "reports", roles: [], label: "t-arg",
    command: { pattern: /\/test_needs_arg (\d+)/, usage: "/test_needs_arg <id>", description: "t" },
    async run() { ran += 1; },
  });
  const bot = { sendMessage: async (chatId, text) => { sent.push(text); } };
  const base = { bot, chatId: 1, userId: 1, telegramUserId: "1", access: access(true, null), message: {} };
  await dispatch.execute(action, { ...base, args: [], source: "button" });
  assert.equal(ran, 0);
  assert.deepEqual(sent, ["Foydalanish: /test_needs_arg <id>"]);
  await dispatch.execute(action, { ...base, args: ["5"], source: "button" });
  await dispatch.execute(action, { ...base, args: ["5"], source: "command" });
  assert.equal(ran, 2);
});

test("cancel drops the pending question and says so", async () => {
  const sent = [];
  const cancelled = [];
  const bot = { sendMessage: async (chatId, text, options) => { sent.push({ text, options }); } };
  const msg = { chat: { id: 9 }, from: { id: 9 }, text: "Bekor qilish" };
  await router.handleLabelHit(bot, msg, { kind: "cancel" }, { pendingInput: { cancel: async (userId) => { cancelled.push(userId); return true; } } });
  assert.deepEqual(cancelled, [9]);
  assert.equal(sent[0].text, router.CANCELLED_TEXT);
});
