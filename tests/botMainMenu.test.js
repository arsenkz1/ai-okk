const test = require("node:test");
const assert = require("node:assert/strict");

require("../dist/bot/actions");
const fakeRegistrar = { onText: () => {}, on: () => {} };
require("../dist/bot/handlers/performance").registerPerformanceHandlers(fakeRegistrar);
require("../dist/bot/handlers/adminRoles").registerAdminRoleHandlers(fakeRegistrar);
require("../dist/bot/handlers/rop").registerRopHandlers(fakeRegistrar);
require("../dist/bot/handlers/teamlead").registerTeamLeadHandlers(fakeRegistrar);
require("../dist/bot/handlers/callTaskReview").registerCallTaskReviewHandlers(fakeRegistrar);

const menu = require("../dist/bot/keyboards/mainMenu");
const { rolesOf } = require("../dist/bot/access");

const access = (isAdmin, manager) => ({ telegramUserId: "7", isAdmin, manager, roles: rolesOf(isAdmin, manager) });
const active = (role) => ({ role, isActive: true, id: 7, teamId: null });
const rows = (markup) => markup.keyboard.map((row) => row.map((button) => button.text));

test("each role gets its own sections, two per row, help last", () => {
  assert.deepEqual(rows(menu.buildMainMenu(access(false, active("MANAGER")))), [["Hisobotlar", "AI-murabbiy"], ["Yordam"]]);
  assert.deepEqual(rows(menu.buildMainMenu(access(false, active("TEAMLEAD")))), [["Hisobotlar", "AI-murabbiy"], ["Jamoa"], ["Yordam"]]);
  assert.deepEqual(rows(menu.buildMainMenu(access(false, active("ROP")))), [["Hisobotlar", "AI-murabbiy"], ["Kompaniya", "Feniks"], ["Yordam"]]);
  assert.deepEqual(rows(menu.buildMainMenu(access(true, null))), [["Hisobotlar", "Kompaniya"], ["Feniks", "Foydalanuvchilar"], ["Sinxronizatsiya"], ["Yordam"]]);
  assert.deepEqual(
    rows(menu.buildMainMenu(access(true, active("TEAMLEAD")))),
    [["Hisobotlar", "AI-murabbiy"], ["Jamoa", "Kompaniya"], ["Feniks", "Foydalanuvchilar"], ["Sinxronizatsiya"], ["Yordam"]],
  );
});

test("the keyboard is persistent and resized, never one-time", () => {
  const markup = menu.buildMainMenu(access(false, active("MANAGER")));
  assert.equal(markup.resize_keyboard, true);
  assert.equal(markup.is_persistent, true);
  assert.equal(markup.one_time_keyboard, undefined);
});

test("without the flag, or without roles, the message removes any old keyboard", () => {
  assert.deepEqual(menu.mainMenuMarkup(access(false, active("MANAGER")), false), { remove_keyboard: true });
  assert.deepEqual(menu.mainMenuMarkup(access(false, null), true), { remove_keyboard: true });
  assert.deepEqual(menu.mainMenuMarkup(access(false, { role: "ROP", isActive: false, id: 1, teamId: null }), true), { remove_keyboard: true });
  assert.ok("keyboard" in menu.mainMenuMarkup(access(false, active("MANAGER")), true));
});

test("the flag accepts the usual spellings of on and nothing else", () => {
  for (const value of ["true", "1", "yes", "on", "TRUE", " True "]) assert.equal(menu.keyboardsEnabled({ BOT_KEYBOARDS_ENABLED: value }), true, value);
  for (const value of ["false", "0", "no", "off", "", "enabled"]) assert.equal(menu.keyboardsEnabled({ BOT_KEYBOARDS_ENABLED: value }), false, value);
  assert.equal(menu.keyboardsEnabled({}), false);
});

test("sendMainMenu attaches the markup and reports Telegram failures as false", async () => {
  const sent = [];
  const bot = { sendMessage: async (chatId, text, options) => { sent.push({ chatId, text, options }); } };
  const previous = process.env.BOT_KEYBOARDS_ENABLED;
  process.env.BOT_KEYBOARDS_ENABLED = "true";
  try {
    assert.equal(await menu.sendMainMenu(bot, 5, access(false, active("MANAGER")), "hi"), true);
    assert.deepEqual(rows(sent[0].options.reply_markup), [["Hisobotlar", "AI-murabbiy"], ["Yordam"]]);
    const failing = { sendMessage: async () => { throw new Error("ETELEGRAM: 403 blocked"); } };
    assert.equal(await menu.sendMainMenu(failing, 5, access(false, active("MANAGER")), "hi"), false);
  } finally {
    if (previous === undefined) delete process.env.BOT_KEYBOARDS_ENABLED; else process.env.BOT_KEYBOARDS_ENABLED = previous;
  }
});

test("a role-change refresh sends nothing while keyboards are off", async () => {
  let sent = 0;
  const bot = { sendMessage: async () => { sent += 1; } };
  const previous = process.env.BOT_KEYBOARDS_ENABLED;
  process.env.BOT_KEYBOARDS_ENABLED = "false";
  try {
    assert.equal(await menu.refreshMainMenuForTelegramUser(bot, "295612129"), false);
    assert.equal(await menu.refreshMainMenuForManager(bot, 1), false);
    assert.equal(sent, 0);
  } finally {
    if (previous === undefined) delete process.env.BOT_KEYBOARDS_ENABLED; else process.env.BOT_KEYBOARDS_ENABLED = previous;
  }
});
