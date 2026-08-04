const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const schemaPath = path.join(root, "prisma", "schema.prisma");
const migrationsRoot = path.join(root, "prisma", "migrations");

function migrationSqlForCallTaskAutomation() {
  const directory = fs.readdirSync(migrationsRoot)
    .find((entry) => entry.endsWith("_add_call_task_automation"));
  assert.ok(directory, "expected a forward add_call_task_automation migration");
  return fs.readFileSync(path.join(migrationsRoot, directory, "migration.sql"), "utf8");
}

test("call-task automation schema has durable per-call identity and five-slot relations", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");

  assert.match(schema, /model CallTaskAutomationSetting\s*\{/);
  assert.match(schema, /model CallTaskAction\s*\{/);
  assert.match(schema, /model CallTaskAutomationTestSlot\s*\{/);
  assert.match(schema, /actionKind\s+String/);
  assert.match(schema, /@@unique\(\[callId, actionKind\]\)/);
  assert.match(schema, /approvalToken\s+String\s+@unique/);
  assert.match(schema, /analysisLeaseToken\s+String\?/);
  assert.match(schema, /analysisLeaseExpiresAt\s+DateTime\?/);
  assert.match(schema, /analysisLeaseGeneration\s+Int\s+@default\(0\)/);
  assert.match(schema, /@@index\(\[status, analysisLeaseExpiresAt\]\)/);
  assert.match(schema, /dealId\s+Int\?\s+@unique/);
  assert.match(schema, /actionId\s+String\?\s+@unique/);
  assert.match(schema, /taskActions\s+CallTaskAction\[\]/);
});

test("call-task automation migration is additive and constrains workflow state", () => {
  const migration = migrationSqlForCallTaskAutomation();

  assert.match(migration, /CREATE TABLE "CallTaskAutomationSetting"/);
  assert.match(migration, /CREATE TABLE "CallTaskAction"/);
  assert.match(migration, /CREATE TABLE "CallTaskAutomationTestSlot"/);
  assert.match(migration, /"CallTaskAction_status_check"/);
  assert.match(migration, /'analyzing'/);
  assert.match(migration, /'proposed'/);
  assert.match(migration, /'uncertain'/);
  assert.match(migration, /"analysisLeaseToken" TEXT/);
  assert.match(migration, /"analysisLeaseExpiresAt" TIMESTAMPTZ\(3\)/);
  assert.match(migration, /"analysisLeaseGeneration" INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /CallTaskAction_status_analysisLeaseExpiresAt_idx/);
  assert.match(migration, /CREATE UNIQUE INDEX "CallTaskAction_callId_actionKind_key" ON "CallTaskAction"\("callId", "actionKind"\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "CallTaskAction_approvalToken_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX "CallTaskAutomationTestSlot_dealId_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX "CallTaskAutomationTestSlot_actionId_key"/);
});
