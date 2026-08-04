const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const schemaPath = path.join(root, "prisma", "schema.prisma");
const migrationsRoot = path.join(root, "prisma", "migrations");

function migrationSql() {
  const directory = fs.readdirSync(migrationsRoot).find((entry) => entry.endsWith("_add_call_stage_automation"));
  assert.ok(directory, "expected an additive call-stage automation migration");
  return fs.readFileSync(path.join(migrationsRoot, directory, "migration.sql"), "utf8");
}

test("call-stage automation schema has isolated per-call identity, mutation fence, and three-slot state", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");
  assert.match(schema, /model CallStageAutomationSetting\s*\{/);
  assert.match(schema, /model CallStageAction\s*\{/);
  assert.match(schema, /model CallStageAutomationTestSlot\s*\{/);
  assert.match(schema, /stageActions\s+CallStageAction\[\]/);
  assert.match(schema, /callId\s+Int\s+@unique/);
  assert.match(schema, /mutationLeaseToken\s+String\?/);
  assert.match(schema, /checkedFields\s+Json\?/);
  assert.match(schema, /missingFields\s+Json\?/);
  assert.match(schema, /dealId\s+Int\?\s+@unique/);
  assert.match(schema, /actionId\s+String\?\s+@unique/);
});

test("call-stage migration is additive, status constrained, and does not touch task-automation tables", () => {
  const sql = migrationSql();
  assert.match(sql, /CREATE TABLE "CallStageAutomationSetting"/);
  assert.match(sql, /CREATE TABLE "CallStageAction"/);
  assert.match(sql, /CREATE TABLE "CallStageAutomationTestSlot"/);
  assert.match(sql, /"CallStageAction_status_check"/);
  assert.match(sql, /'analyzing'/);
  assert.match(sql, /'pending_move'/);
  assert.match(sql, /'uncertain'/);
  assert.match(sql, /"mutationLeaseToken" TEXT/);
  assert.match(sql, /"CallStageAutomationTestSlot_slotNumber_check" CHECK \("slotNumber" BETWEEN 1 AND 3\)/);
  assert.match(sql, /CREATE UNIQUE INDEX "CallStageAction_callId_key"/);
  assert.match(sql, /CREATE UNIQUE INDEX "CallStageAutomationTestSlot_dealId_key"/);
  assert.doesNotMatch(sql, /CallTaskAction/);
});
