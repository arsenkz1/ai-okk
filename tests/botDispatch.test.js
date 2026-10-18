const test = require("node:test");
const assert = require("node:assert/strict");

require("../dist/bot/actions");
const registry = require("../dist/bot/actions/registry");
const dispatch = require("../dist/bot/actions/dispatch");
const router = require("../dist/bot/keyboards/labelRouter");
const pendingModule = require("../dist/bot/pendingInput");
const { rolesOf } = require("../dist/bot/access");

const access = (isAdmin, manager) => ({ telegramUserId: "7", isAdmin, manager, roles: rolesOf(isAdmin, manager) });
const active = (role) => ({ role, isActive: true, id: 7, teamId: null });
const pending = pendingModule.createPendingInputService({ async get() { return null; }, async set() {}, async del() {} });

const runs = [];
registry.defineAction({
  id: "test_cmd", section: "reports", roles: ["manager"], label: "t-cmd", denyText: "nope",
  command: { pattern: /^\/test_cmd (\d+)(?:\s+(\S+))?$/, usage: "/test_cmd <id> [x]", description: "t" },
  async run(ctx) { runs.push({ source: ctx.source, args: ctx.args, chatId: ctx.chatId, user: ctx.telegramUserId, hasPending: typeof ctx.pending.expect === "function" }); },
});

const msgOf = (text) => ({ chat: { id: 55 }, message_id: 9, from: { id: 7 }, text });

test("a command goes through dedupe, access and argument capture before running", async () => {
  const claims = [];
  dispatch.configureDispatch({ pendingInput: pending, resolveAccess: async () => access(false, active("MANAGER")), claimUpdate: async (chatId, messageId) => { claims.push([chatId, messageId]); return true; } });
  const bot = { sendMessage: async () => {} };
  const pattern = registry.getAction("test_cmd").command.pattern;
  await dispatch.runCommand(bot, "test_cmd", msgOf("/test_cmd 42  extra"), pattern.exec("/test_cmd 42  extra"));
  assert.deepEqual(claims, [[55, 9]]);
  assert.deepEqual(runs, [{ source: "command", args: ["42", "extra"], chatId: 55, user: "7", hasPending: true }]);
});

test("an optional group that did not match is simply absent from the arguments", async () => {
  const bot = { sendMessage: async () => {} };
  const pattern = registry.getAction("test_cmd").command.pattern;
  await dispatch.runCommand(bot, "test_cmd", msgOf("/test_cmd 1"), pattern.exec("/test_cmd 1"));
  assert.deepEqual(runs.at(-1).args, ["1"]);
});

test("a duplicate delivery is dropped silently; a foreign role gets the action's own refusal", async () => {
  const sent = [];
  const bot = { sendMessage: async (chatId, text) => { sent.push(text); } };
  const before = runs.length;
  dispatch.configureDispatch({ claimUpdate: async () => false });
  await dispatch.runCommand(bot, "test_cmd", msgOf("/test_cmd 1"), ["/test_cmd 1", "1"]);
  assert.equal(runs.length, before);
  assert.deepEqual(sent, []);

  dispatch.configureDispatch({ claimUpdate: async () => true, resolveAccess: async () => access(true, null) });
  await dispatch.runCommand(bot, "test_cmd", msgOf("/test_cmd 1"), ["/test_cmd 1", "1"]);
  assert.equal(runs.length, before);
  assert.deepEqual(sent, ["nope"]);
});

test("a section tap sends that section's keyboard; the help tap sends help with the main menu", async () => {
  const sent = [];
  const bot = { sendMessage: async (chatId, text, options) => { sent.push({ text, options }); } };
  const deps = { pendingInput: { cancel: async () => true }, resolveAccess: async () => access(false, active("MANAGER")) };
  const msg = { chat: { id: 5 }, from: { id: 7 }, text: "Hisobotlar" };

  await router.handleLabelHit(bot, msg, router.resolveLabel("Hisobotlar"), deps);
  assert.equal(sent.at(-1).text, "<b>Hisobotlar</b>");
  assert.ok(sent.at(-1).options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "m:report"));

  await router.handleLabelHit(bot, msg, router.resolveLabel("Yordam"), deps);
  assert.ok(sent.at(-1).text.startsWith("📋 Mavjud buyruqlar"));
  assert.ok("remove_keyboard" in sent.at(-1).options.reply_markup || "keyboard" in sent.at(-1).options.reply_markup);

  await router.handleLabelHit(bot, { ...msg, text: "Kompaniya" }, router.resolveLabel("Kompaniya"), deps);
  assert.ok(sent.at(-1).text.includes("buyruqlar yo'q"), "a manager has nothing in the company section");
});

test("every execution and refusal leaves one log line naming the action, source and roles, never the text", async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => { lines.push(String(line)); };
  try {
    const bot = { sendMessage: async () => {} };
    const action = registry.getAction("test_cmd");
    await dispatch.execute(action, { bot, chatId: 1, userId: 7, telegramUserId: "7", access: access(false, active("MANAGER")), args: ["1"], source: "button", pending, message: { text: "secret words" } });
    await dispatch.execute(action, { bot, chatId: 1, userId: 7, telegramUserId: "7", access: access(true, null), args: ["1"], source: "callback", pending });
  } finally {
    console.log = originalLog;
  }
  const menuLines = lines.filter((l) => l.startsWith("[BotMenu]"));
  assert.deepEqual(menuLines, [
    "[BotMenu] action=test_cmd source=button roles=manager args=1",
    "[BotMenu] denied action=test_cmd source=callback roles=admin",
  ]);
  assert.equal(lines.some((l) => l.includes("secret words")), false);
});
