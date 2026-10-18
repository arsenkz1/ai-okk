const test = require("node:test");
const assert = require("node:assert/strict");

require("../dist/bot/actions");
const fakeRegistrar = { onText: () => {}, on: () => {} };
require("../dist/bot/handlers/performance").registerPerformanceHandlers(fakeRegistrar);
require("../dist/bot/handlers/adminRoles").registerAdminRoleHandlers(fakeRegistrar);
require("../dist/bot/handlers/rop").registerRopHandlers(fakeRegistrar);
require("../dist/bot/handlers/teamlead").registerTeamLeadHandlers(fakeRegistrar);
require("../dist/bot/handlers/callTaskReview").registerCallTaskReviewHandlers(fakeRegistrar);

const menu = require("../dist/bot/commandMenu");
const { rolesOf } = require("../dist/bot/access");

const access = (isAdmin, manager) => ({ telegramUserId: "7", isAdmin, manager, roles: rolesOf(isAdmin, manager) });
const active = (role) => ({ role, isActive: true, id: 7, teamId: null });
const names = (list) => list.map((entry) => entry.command);

test("every menu entry is a valid Telegram command with a description", () => {
  for (const a of [access(false, null), access(false, active("MANAGER")), access(false, active("TEAMLEAD")), access(false, active("ROP")), access(true, null)]) {
    const list = menu.commandMenuFor(a);
    assert.ok(list.length > 0 && list.length <= 100);
    for (const entry of list) {
      assert.match(entry.command, /^[a-z0-9_]{1,32}$/);
      assert.ok(entry.description.length >= 1 && entry.description.length <= 256, entry.command);
    }
    assert.deepEqual(names(list).filter((n, i, all) => all.indexOf(n) !== i), [], "no duplicate command names");
  }
});

test("an unlinked account sees only start and help", () => {
  assert.deepEqual(names(menu.commandMenuFor(access(false, null))), ["start", "help"]);
});

test("a manager sees reports and the AI coach with every period alias, nothing administrative", () => {
  const list = names(menu.commandMenuFor(access(false, active("MANAGER"))));
  for (const c of ["report", "week", "month", "period", "errors", "my_stats", "deal", "ask", "ask_kun", "ask_hafta", "ask_oy", "stop_ai", "help"]) assert.ok(list.includes(c), c);
  for (const c of ["team_stats", "set_plan", "managers", "teams", "team", "inactivity_status", "check_tg", "start"]) assert.equal(list.includes(c), false, c);
  assert.ok(list.indexOf("report") < list.indexOf("ask"), "reports come before the AI coach");
});

test("team leads, ROPs and admins each get their own additions; command-only actions stay hidden", () => {
  const teamLead = names(menu.commandMenuFor(access(false, active("TEAMLEAD"))));
  for (const c of ["team_stats", "team", "team_add", "ask_manager"]) assert.ok(teamLead.includes(c), c);
  assert.equal(teamLead.includes("set_plan"), false);

  const rop = names(menu.commandMenuFor(access(false, active("ROP"))));
  for (const c of ["team_stats", "set_plan", "plans", "rating_off", "rating_on", "rating_list", "call_status", "teams", "rop_ask", "inactivity_status", "inactivity_limit", "inactivity_limit_on", "inactivity_limit_off"]) assert.ok(rop.includes(c), c);
  for (const c of ["managers", "team", "add_admin"]) assert.equal(rop.includes(c), false, c);

  const admin = names(menu.commandMenuFor(access(true, null)));
  for (const c of ["managers", "add_admin", "analyze_deal", "set_role", "sync_managers", "set_plan", "inactivity_off", "report", "team_stats"]) assert.ok(admin.includes(c), c);
  for (const c of ["check_tg", "test_restrict", "test_restore", "call_task_time", "my_stats", "ask"]) assert.equal(admin.includes(c), false, c);
});

test("the sync sets a per-chat scope and swallows Telegram errors", async () => {
  const calls = [];
  const bot = { setMyCommands: async (commands, form) => { calls.push({ commands, form }); return true; } };
  assert.equal(await menu.syncCommandMenu(bot, 42, access(false, active("MANAGER"))), true);
  assert.deepEqual(calls[0].form, { scope: { type: "chat", chat_id: 42 } });
  assert.ok(calls[0].commands.some((c) => c.command === "report"));

  const failing = { setMyCommands: async () => { throw new Error("ETELEGRAM: 429"); } };
  assert.equal(await menu.syncCommandMenu(failing, 42, access(false, active("MANAGER"))), false);
});

test("the default scope carries the manager set", async () => {
  const calls = [];
  const bot = { setMyCommands: async (commands, form) => { calls.push({ commands, form }); return true; } };
  assert.equal(await menu.installDefaultCommandMenu(bot), true);
  assert.deepEqual(calls[0].form, { scope: { type: "default" } });
  assert.deepEqual(names(calls[0].commands), names(menu.commandMenuFor(access(false, active("MANAGER")))));
});

test("a Telegram id that is not a number is skipped instead of hitting the API", async () => {
  let called = 0;
  const bot = { setMyCommands: async () => { called += 1; return true; } };
  assert.equal(await menu.syncCommandMenuForTelegramUser(bot, "not-a-number"), false);
  assert.equal(called, 0);
});
