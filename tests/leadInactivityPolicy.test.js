const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SOURCE_PIPELINE_IDS,
  TARGET_PIPELINE_ID,
  TARGET_STATUS_ID,
  INACTIVITY_MS,
  DIRECT_LEAD_WEBHOOK_ACTIONS,
  isSourcePipeline,
  isDue,
  isActiveEditableStage,
  isSupportedDirectLeadWebhookAction,
  isDirectLeadActivity,
  canWatchLeadInPipeline,
  isAllowedInactivitySourceStage,
} = require("../dist/services/leadInactivityPolicy");

test("defines the approved source and target pipeline policy", () => {
  assert.deepEqual([...SOURCE_PIPELINE_IDS].sort((a, b) => a - b), [6909890, 9055778]);
  assert.equal(TARGET_PIPELINE_ID, 9055770);
  assert.equal(TARGET_STATUS_ID, 72917546);
  assert.equal(isSourcePipeline(9055778), true);
  assert.equal(isSourcePipeline(6909890), true);
  assert.equal(isSourcePipeline(9055770), false);
});

test("treats exactly 72 elapsed calendar hours as due but never earlier", () => {
  const now = new Date("2026-07-19T12:00:00.000Z");
  const exactlyDue = new Date(now.getTime() - INACTIVITY_MS);
  const oneMillisecondEarly = new Date(exactlyDue.getTime() + 1);

  assert.equal(INACTIVITY_MS, 72 * 60 * 60 * 1000);
  assert.equal(isDue(exactlyDue, now), true);
  assert.equal(isDue(oneMillisecondEarly, now), false);
});

test("allows inactivity watches only from taken, qualified, and OZHOP stages in UZUM and EXODE", () => {
  for (const [pipelineId, statusId] of [
    [6909890, 58160718], [6909890, 58160726], [6909890, 58160902],
    [9055778, 72917582], [9055778, 72917586], [9055778, 72919958],
  ]) {
    assert.equal(isAllowedInactivitySourceStage(pipelineId, statusId), true);
  }

  assert.equal(isAllowedInactivitySourceStage(6909890, 58160714), false);
  assert.equal(isAllowedInactivitySourceStage(9055778, 87347062), false);
  assert.equal(isAllowedInactivitySourceStage(6909890, 142), false);
  assert.equal(isAllowedInactivitySourceStage(9055778, 143), false);
});

test("accepts only active editable source stages", () => {
  assert.equal(isActiveEditableStage({ type: 0, is_editable: true }), true);
  assert.equal(isActiveEditableStage({ type: 0, is_editable: false }), false);
  assert.equal(isActiveEditableStage({ type: 1, is_editable: true }), false);
  assert.equal(isActiveEditableStage(undefined), false);
});

test("recognizes only the complete approved direct-lead webhook action list", () => {
  assert.deepEqual([...DIRECT_LEAD_WEBHOOK_ACTIONS], [
    "add_lead",
    "update_lead",
    "status_lead",
    "responsible_lead",
    "restore_lead",
    "delete_lead",
    "add_task",
    "update_task",
    "delete_task",
    "note_lead",
  ]);
  assert.equal(isSupportedDirectLeadWebhookAction("add_lead"), true);
  assert.equal(isSupportedDirectLeadWebhookAction("update_task"), true);
  assert.equal(isSupportedDirectLeadWebhookAction("note_lead"), true);
  assert.equal(isSupportedDirectLeadWebhookAction("add_contact"), false);
  assert.equal(isSupportedDirectLeadWebhookAction("leads.add"), false);
});

test("never accepts contact events as direct lead activity", () => {
  assert.equal(isDirectLeadActivity({ action: "update_lead", entityType: "contacts", leadId: 100, pipelineId: 9055778 }), false);
  assert.equal(isDirectLeadActivity({ action: "add_task", entityType: "contacts", leadId: 100, pipelineId: 9055778 }), false);
  assert.equal(isDirectLeadActivity({ action: "add_task", entityType: "leads", leadId: 100, pipelineId: 9055778, statusId: 72917586 }), true);
  assert.equal(isDirectLeadActivity({ action: "note_lead", entityType: "leads", leadId: 100, pipelineId: 9055778, statusId: 72917586 }), true);
  assert.equal(isDirectLeadActivity({ action: "unknown", entityType: "leads", leadId: 100 }), false);
});

test("safely rejects malformed direct-lead activity candidates", () => {
  assert.equal(isDirectLeadActivity(null), false);
  assert.equal(isDirectLeadActivity(undefined), false);
  assert.equal(isDirectLeadActivity({ entityType: "leads", leadId: 100, pipelineId: 9055778 }), false);
  assert.equal(isDirectLeadActivity({ action: "update_lead", entityType: "leads", leadId: 1.5, pipelineId: 9055778 }), false);
  assert.equal(isDirectLeadActivity({ action: "update_lead", entityType: "leads", leadId: 0, pipelineId: 9055778 }), false);
  assert.equal(isDirectLeadActivity({ action: "update_lead", entityType: "leads", leadId: -1, pipelineId: 9055778 }), false);
  assert.equal(isDirectLeadActivity({ action: "update_lead", entityType: "leads", leadId: 100 }), false);
});

test("does not create a direct-lead activity record for a target-pipeline lead", () => {
  assert.equal(canWatchLeadInPipeline(9055778), true);
  assert.equal(canWatchLeadInPipeline(6909890), true);
  assert.equal(canWatchLeadInPipeline(TARGET_PIPELINE_ID), false);
  assert.equal(
    isDirectLeadActivity({
      action: "update_lead",
      entityType: "leads",
      leadId: 100,
      pipelineId: TARGET_PIPELINE_ID,
    }),
    false
  );
});
