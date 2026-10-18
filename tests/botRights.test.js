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
const pendingModule = require("../dist/bot/pendingInput");
const { rolesOf } = require("../dist/bot/access");

const access = (isAdmin, manager) => ({ telegramUserId: "7", isAdmin, manager, roles: rolesOf(isAdmin, manager) });
const active = (role) => ({ role, isActive: true, id: 7, teamId: null });
const PROFILES = {
  unlinked: access(false, null),
  inactive: access(false, { role: "ROP", isActive: false, id: 7, teamId: null }),
  manager: access(false, active("MANAGER")),
  teamlead: access(false, active("TEAMLEAD")),
  rop: access(false, active("ROP")),
  admin: access(true, null),
};

const pending = pendingModule.createPendingInputService({ async get() { return null; }, async set() {}, async del() {} });
const realActions = () => registry.allActions().filter((a) => !a.id.startsWith("test_"));

test("every restricted action refuses each profile that lacks its roles with exactly one message and no run", async () => {
  let checked = 0;
  for (const action of realActions()) {
    if (action.roles.length === 0) continue;
    const originalRun = action.run;
    let ran = 0;
    action.run = async () => { ran += 1; };
    try {
      for (const [name, profile] of Object.entries(PROFILES)) {
        if (registry.isAllowed(action, profile)) continue;
        const sent = [];
        const bot = { sendMessage: async (chatId, text) => { sent.push(text); } };
        await dispatch.execute(action, { bot, chatId: 1, userId: 7, telegramUserId: "7", access: profile, args: ["1", "2", "3"], source: "command", pending });
        assert.equal(ran, 0, `${action.id} must not run for ${name}`);
        assert.equal(sent.length, 1, `${action.id} sends one refusal to ${name}`);
        assert.ok(typeof sent[0] === "string" && sent[0].length > 0, `${action.id} refusal text for ${name}`);
        checked += 1;
      }
    } finally {
      action.run = originalRun;
    }
  }
  assert.ok(checked > 100, `checked ${checked} action/profile pairs`);
});

test("every restricted action is reachable by at least one profile", () => {
  for (const action of realActions()) {
    assert.ok(Object.values(PROFILES).some((profile) => registry.isAllowed(action, profile)), action.id);
  }
});

test("an action with required arguments never dead-ends a button: it asks, or collects, or is command-only", () => {
  for (const action of realActions()) {
    if (!action.command || action.commandOnly) continue;
    if (dispatch.requiredArgCount(action.command.usage) === 0) continue;
    assert.ok(action.input !== undefined || typeof action.collect === "function", `${action.id} (${action.command.usage})`);
  }
});

test("dangerous actions are commands with a confirmation path and a readable label", () => {
  const dangerous = realActions().filter((a) => a.dangerous);
  assert.ok(dangerous.length >= 5);
  for (const action of dangerous) {
    assert.ok(action.command, action.id);
    assert.ok(action.label.trim().length > 0, action.id);
  }
});
