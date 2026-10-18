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
const buttons = (a, id) => sectionKeyboard(a, section(id), 7).inline_keyboard.flat().map((b) => [b.text, b.callback_data]);

test("the team section is the team lead's seven actions, in command order, each wired to its action", () => {
  assert.deepEqual(buttons(access(false, active("TEAMLEAD")), "team"), [
    ["Jamoam", "m:team"],
    ["Jamoa reytingi", "m:team_rating"],
    ["Jamoa xatolari", "m:team_mistakes"],
    ["Jamoaga biriktirish", "m:team_add"],
    ["Jamoadan chiqarish", "m:team_remove"],
    ["Jamoa menejeri kartasi", "m:team_manager"],
    ["Jamoa menejeri haqida AI-savol", "m:ask_manager"],
  ]);
});

test("only team leads see the team section; a lead who is also admin keeps it", () => {
  const ids = (a) => mainMenuSections(a).map((s) => s.id);
  assert.ok(ids(access(false, active("TEAMLEAD"))).includes("team"));
  assert.ok(ids(access(true, active("TEAMLEAD"))).includes("team"));
  for (const a of [access(false, active("MANAGER")), access(false, active("ROP")), access(true, null)]) {
    assert.equal(ids(a).includes("team"), false);
    assert.deepEqual(buttons(a, "team"), []);
  }
});

test("team actions need no typed argument, so a tap runs them directly", () => {
  for (const id of ["team", "team_rating", "team_mistakes", "team_add", "team_remove", "team_manager", "ask_manager"]) {
    const action = registry.getAction(id);
    assert.equal(action.input, undefined, id);
    assert.equal(/<[^>]+>/.test(action.command.usage), false, id);
  }
});
