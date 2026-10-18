const test = require("node:test");
const assert = require("node:assert/strict");

const { rolesOf, isLinkedAs } = require("../dist/bot/access");

const roles = (isAdmin, manager) => [...rolesOf(isAdmin, manager)].sort();

test("an administrator needs no manager link", () => {
  assert.deepEqual(roles(true, null), ["admin"]);
});

test("an unlinked, non-admin account has no roles", () => {
  assert.deepEqual(roles(false, null), []);
});

test("every active linked manager is a manager; leads and ROPs carry their own role on top", () => {
  assert.deepEqual(roles(false, { role: "MANAGER", isActive: true }), ["manager"]);
  assert.deepEqual(roles(false, { role: "TEAMLEAD", isActive: true }), ["manager", "teamlead"]);
  assert.deepEqual(roles(false, { role: "ROP", isActive: true }), ["manager", "rop"]);
});

test("an inactive manager keeps no manager roles, even as a ROP", () => {
  assert.deepEqual(roles(false, { role: "ROP", isActive: false }), []);
});

test("an administrator who is also a linked manager holds both", () => {
  assert.deepEqual(roles(true, { role: "TEAMLEAD", isActive: true }), ["admin", "manager", "teamlead"]);
  // Admin rights do not depend on the manager account being active.
  assert.deepEqual(roles(true, { role: "MANAGER", isActive: false }), ["admin"]);
});

test("isLinkedAs reads the manager's own role regardless of activity", () => {
  assert.equal(isLinkedAs({ role: "TEAMLEAD" }, "teamlead"), true);
  assert.equal(isLinkedAs({ role: "ROP" }, "rop"), true);
  assert.equal(isLinkedAs({ role: "ROP" }, "teamlead"), false);
  assert.equal(isLinkedAs({ role: "ROP" }, "admin"), false);
  assert.equal(isLinkedAs({ role: "WHATEVER" }, "manager"), false);
});
