const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Completeness of the action registry.
 *
 * Every bot command must be a registry action and be registered exactly once,
 * whether it is defined at module load (the `actions/` modules) or inside a
 * handler's register function. The count below is the number of commands the
 * bot had before the migration began; a new command changes it on purpose.
 */
const EXPECTED_COMMAND_COUNT = 62; // 59 migrated + /salary, /set_rate, /team_rate (salary calculator, 2026-10-18)

const registry = require("../dist/bot/actions/registry");
require("../dist/bot/actions");

const handlerModules = {
  performance: require("../dist/bot/handlers/performance").registerPerformanceHandlers,
  adminRoles: require("../dist/bot/handlers/adminRoles").registerAdminRoleHandlers,
  rop: require("../dist/bot/handlers/rop").registerRopHandlers,
  teamlead: require("../dist/bot/handlers/teamlead").registerTeamLeadHandlers,
  callTaskReview: require("../dist/bot/handlers/callTaskReview").registerCallTaskReviewHandlers,
};

const registeredPatterns = [];
const fakeBot = {
  onText: (pattern) => { registeredPatterns.push(pattern); },
  on: () => {},
};
for (const register of Object.values(handlerModules)) register(fakeBot);

const botSourceDir = path.resolve(__dirname, "..", "src", "bot");
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}
const sources = Object.fromEntries(sourceFiles(botSourceDir).map((file) => [path.relative(botSourceDir, file), fs.readFileSync(file, "utf8")]));

function registeredIdsIn(source) {
  return [...source.matchAll(/registerCommandActions\(bot, \[([\s\S]*?)\]\)/g)].flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
}
const registeredBySource = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, registeredIdsIn(source)]));
const allRegisteredIds = Object.values(registeredBySource).flat();

test("no command is registered outside the registry", () => {
  const offenders = Object.entries(sources)
    .filter(([file]) => file !== path.join("actions", "dispatch.ts"))
    .filter(([, source]) => /bot\.onText\(/.test(source))
    .map(([file]) => file);
  assert.deepEqual(offenders, []);
});

test("every command action is registered exactly once, and only command actions are registered", () => {
  const duplicates = allRegisteredIds.filter((id, index) => allRegisteredIds.indexOf(id) !== index);
  assert.deepEqual(duplicates, []);

  const commandIds = registry.commandActions().map((action) => action.id).sort();
  assert.deepEqual([...allRegisteredIds].sort(), commandIds);
  assert.equal(commandIds.length, EXPECTED_COMMAND_COUNT);
});

test("handler files register as many patterns at runtime as their source lists", () => {
  const handlerIds = Object.entries(registeredBySource)
    .filter(([file]) => file.startsWith("handlers" + path.sep))
    .flatMap(([, ids]) => ids);
  assert.equal(registeredPatterns.length, handlerIds.length);
  for (const id of handlerIds) assert.ok(registeredPatterns.includes(registry.getAction(id).command.pattern), id);
});

test("every command pattern is a slash command and every action has a non-empty label", () => {
  for (const action of registry.allActions()) {
    assert.ok(action.label.trim().length > 0, `${action.id} has a label`);
    if (!action.command) continue;
    assert.ok(action.command.pattern instanceof RegExp, action.id);
    assert.match(action.command.pattern.source, /^\^?\\\//, `${action.id} targets a slash command`);
    assert.ok(action.command.usage.startsWith("/"), `${action.id} usage starts with a slash`);
    assert.ok(action.command.description.trim().length > 0, `${action.id} has a description`);
  }
});

test("labels stay unique once the handler actions are included", () => {
  const labels = [...registry.SECTIONS.map((s) => s.label), ...registry.allActions().map((a) => a.label)];
  assert.deepEqual(labels.filter((label, index) => labels.indexOf(label) !== index), []);
});

test("loading every action module, handlers included, never loads the queue or the PBX client", () => {
  const heavy = Object.keys(require.cache).filter((file) => /\/bullmq\/|\/queues\/callProcessing|\/services\/pbxHistory|\/services\/amocrm\.js$|\/bot\/index\.js$/.test(file));
  assert.deepEqual(heavy, []);
});
