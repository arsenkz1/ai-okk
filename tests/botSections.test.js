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
const { sectionKeyboard } = require("../dist/bot/keyboards/menuCallbacks");
const { mainMenuSections } = require("../dist/bot/keyboards/mainMenu");
const { rolesOf } = require("../dist/bot/access");

const access = (isAdmin, manager) => ({ telegramUserId: "7", isAdmin, manager, roles: rolesOf(isAdmin, manager) });
const active = (role) => ({ role, isActive: true, id: 7, teamId: null });
const section = (id) => registry.SECTIONS.find((s) => s.id === id);
const buttons = async (a, id) => (await sectionKeyboard(a, section(id), 7)).inline_keyboard.flat().map((b) => [b.text, b.callback_data]);

test("the team section is the team lead's seven actions, in command order, each wired to its action", async () => {
  assert.deepEqual(await buttons(access(false, active("TEAMLEAD")), "team"), [
    ["Jamoam", "m:team"],
    ["Jamoa reytingi", "m:team_rating"],
    ["Jamoa xatolari", "m:team_mistakes"],
    ["Jamoaga biriktirish", "m:team_add"],
    ["Jamoadan chiqarish", "m:team_remove"],
    ["Jamoa menejeri kartasi", "m:team_manager"],
    ["Jamoa menejeri haqida AI-savol", "m:ask_manager"],
    ["Jamoa: stavka belgilash", "m:team_rate"],
  ]);
});

test("only team leads see the team section; a lead who is also admin keeps it", async () => {
  const ids = (a) => mainMenuSections(a).map((s) => s.id);
  assert.ok(ids(access(false, active("TEAMLEAD"))).includes("team"));
  assert.ok(ids(access(true, active("TEAMLEAD"))).includes("team"));
  for (const a of [access(false, active("MANAGER")), access(false, active("ROP")), access(true, null)]) {
    assert.equal(ids(a).includes("team"), false);
    assert.deepEqual(await buttons(a, "team"), []);
  }
});

test("team actions need no typed argument, so a tap runs them directly", async () => {
  for (const id of ["team", "team_rating", "team_mistakes", "team_add", "team_remove", "team_manager", "ask_manager"]) {
    const action = registry.getAction(id);
    assert.equal(action.input, undefined, id);
    assert.equal(/<[^>]+>/.test(action.command.usage), false, id);
  }
  assert.equal(typeof registry.getAction("team_rate").collect, "function", "the rate needs a manager and an amount, gathered with buttons");
});

test("the company section shows the ROP analytics first, then plans and ratings, for ROP and admin alike", async () => {
  const expected = [
    ["Jamoalar", "m:teams"],
    ["Umumiy reyting", "m:all_rating"],
    ["Kompaniya xatolari", "m:all_mistakes"],
    ["Jamoa bo'yicha reyting", "m:rop_team_rating"],
    ["Jamoa bo'yicha xatolar", "m:rop_team_mistakes"],
    ["Menejer kartasi", "m:rop_manager"],
    ["Menejer haqida AI-savol", "m:rop_ask"],
    ["Bosqichlarni sinxronlash", "m:sync_stages"],
    ["Reytingdan chiqarish", "m:rating_toggle:off"],
    ["Reytingga qaytarish", "m:rating_toggle:on"],
    ["Reyting ro'yxati", "m:rating_list"],
    ["Qo'ng'iroqlar holati", "m:call_status"],
    ["Reja belgilash", "m:set_plan"],
    ["Rejalar", "m:plans"],
  ];
  assert.deepEqual(await buttons(access(false, active("ROP")), "company"), expected);
  assert.deepEqual(await buttons(access(true, null), "company"), expected);
  for (const a of [access(false, active("MANAGER")), access(false, active("TEAMLEAD"))]) {
    assert.deepEqual(await buttons(a, "company"), []);
    assert.equal(mainMenuSections(a).some((s) => s.id === "company"), false);
  }
});

test("company buttons either run on tap or collect their arguments with buttons", async () => {
  for (const id of ["teams", "all_rating", "all_mistakes", "rop_team_rating", "rop_team_mistakes", "rop_manager", "rop_ask", "sync_stages", "rating_list"]) {
    assert.equal(/<[^>]+>/.test(registry.getAction(id).command.usage), false, id);
    assert.equal(registry.getAction(id).collect, undefined, id);
  }
  for (const id of ["set_plan", "rating_toggle", "call_status", "plans"]) {
    assert.equal(typeof registry.getAction(id).collect, "function", id);
  }
});

test("the Phoenix section reads status, switch, limit, on, off, deal check, for ROP and admin only", async () => {
  const expected = [
    ["Feniks holati", "m:inactivity_status"],
    ["Feniks kaliti", "m:inactivity_switch"],
    ["Feniks limiti", "m:inactivity_limit"],
    ["Feniksni yoqish", "m:inactivity_on"],
    ["Feniksni to'xtatish", "m:inactivity_off"],
    ["Feniks: bitim bo'yicha", "m:inactivity_lead"],
  ];
  assert.deepEqual(await buttons(access(false, active("ROP")), "phoenix"), expected);
  assert.deepEqual(await buttons(access(true, null), "phoenix"), expected);
  for (const a of [access(false, active("MANAGER")), access(false, active("TEAMLEAD"))]) {
    assert.deepEqual(await buttons(a, "phoenix"), []);
    assert.equal(mainMenuSections(a).some((s) => s.id === "phoenix"), false);
  }
});

test("the users and sync sections exist for admins only", async () => {
  const ids = (a) => mainMenuSections(a).map((s) => s.id);
  assert.ok(ids(access(true, null)).includes("users") && ids(access(true, null)).includes("sync"));
  for (const a of [access(false, active("MANAGER")), access(false, active("TEAMLEAD")), access(false, active("ROP"))]) {
    assert.equal(ids(a).some((id) => id === "users" || id === "sync"), false);
  }
});

test("stopping Phoenix is dangerous and asks for a deal id where needed; the limit screen carries its switches", async () => {
  const { parseMenuCallback } = require("../dist/bot/keyboards/menuCallbacks");
  const { inactivityLimitKeyboard } = require("../dist/bot/handlers/performance");
  assert.equal(registry.getAction("inactivity_off").dangerous, true);
  assert.equal(registry.getAction("inactivity_on").dangerous, undefined, "enabling is reversible and the sweep has its own yes/no");
  assert.equal(registry.getAction("inactivity_lead").input.kind, "lead_id");
  const switches = inactivityLimitKeyboard().inline_keyboard[0].map((b) => parseMenuCallback(b.callback_data));
  assert.deepEqual(switches, [
    { kind: "action", actionId: "inactivity_limit", arg: "on", decision: null },
    { kind: "action", actionId: "inactivity_limit", arg: "off", decision: null },
  ]);
  // The command pattern still yields the same single argument.
  assert.equal(registry.getAction("inactivity_limit").command.pattern.exec("/inactivity_limit_on")[1], "on");
});
