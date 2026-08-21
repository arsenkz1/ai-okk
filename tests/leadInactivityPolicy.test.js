const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SOURCE_PIPELINE_IDS,
  TARGET_PIPELINE_ID,
  TARGET_STATUS_ID,
  INACTIVITY_MS,
  ALLOWED_INACTIVITY_SOURCE_STAGES,
  INACTIVITY_STAGE_PRIORITY_GROUPS,
  INACTIVITY_SOURCE_PIPELINES,
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
  assert.deepEqual(
    INACTIVITY_SOURCE_PIPELINES.map(({ pipelineId, name, takenInWork, qualified, ozhop }) => (
      [pipelineId, name, takenInWork, qualified, ozhop]
    )),
    [
      [6909890, "UZUM", 58160718, 58160726, 58160902],
      [9055778, "EXODE", 72917582, 72917586, 72919958],
      [8425422, "WB", 68567422, 68567458, 68567462],
      [9888398, "\u0414\u0430\u0442\u0430", 78602098, 78631750, 78631754],
      [10630306, "\u0411\u0443\u0445\u0433\u0430\u043b\u0442\u0435\u0440\u0438\u044f", 83801774, 83801898, 83801778],
      [10734414, "AI", 84554886, 84554934, 84554938],
      [11071910, "\u0412\u0438\u0434\u0435\u043e\u0447\u0430\u0442", 86963442, 86963446, 86963494],
    ],
  );
  assert.deepEqual(
    [...SOURCE_PIPELINE_IDS].sort((a, b) => a - b),
    [6909890, 8425422, 9055778, 9888398, 10630306, 10734414, 11071910],
  );
  assert.equal(TARGET_PIPELINE_ID, 9055770);
  assert.equal(TARGET_STATUS_ID, 72917546);
  for (const pipelineId of SOURCE_PIPELINE_IDS) {
    assert.equal(isSourcePipeline(pipelineId), true);
  }
  assert.equal(isSourcePipeline(9055770), false);
  assert.equal(isSourcePipeline(6945006), false);
});

test("never lists the target pipeline or a duplicate stage as an inactivity source", () => {
  assert.equal(SOURCE_PIPELINE_IDS.includes(TARGET_PIPELINE_ID), false);
  assert.equal(new Set(SOURCE_PIPELINE_IDS).size, SOURCE_PIPELINE_IDS.length);
  const stageKeys = ALLOWED_INACTIVITY_SOURCE_STAGES.map(({ pipelineId, statusId }) => `${pipelineId}:${statusId}`);
  assert.equal(new Set(stageKeys).size, stageKeys.length);
  assert.equal(ALLOWED_INACTIVITY_SOURCE_STAGES.length, SOURCE_PIPELINE_IDS.length * 3);
});

test("defines the business priority as OZHOP then qualified then taken-in-work in every source pipeline", () => {
  assert.equal(INACTIVITY_STAGE_PRIORITY_GROUPS.length, 3);
  const [ozhopGroup, qualifiedGroup, takenGroup] = INACTIVITY_STAGE_PRIORITY_GROUPS;
  for (const [group, stageKey] of [[ozhopGroup, "ozhop"], [qualifiedGroup, "qualified"], [takenGroup, "takenInWork"]]) {
    assert.deepEqual(
      group.map(({ pipelineId, statusId }) => [pipelineId, statusId]),
      INACTIVITY_SOURCE_PIPELINES.map((pipeline) => [pipeline.pipelineId, pipeline[stageKey]]),
    );
  }
  assert.deepEqual(ozhopGroup[0], { pipelineId: 6909890, statusId: 58160902 });
  assert.deepEqual(qualifiedGroup[0], { pipelineId: 6909890, statusId: 58160726 });
  assert.deepEqual(takenGroup[0], { pipelineId: 6909890, statusId: 58160718 });

  const stageKey = ({ pipelineId, statusId }) => `${pipelineId}:${statusId}`;
  assert.deepEqual(
    INACTIVITY_STAGE_PRIORITY_GROUPS.flat().map(stageKey).sort(),
    ALLOWED_INACTIVITY_SOURCE_STAGES.map(stageKey).sort(),
  );
});

test("treats exactly 72 elapsed calendar hours as due but never earlier", () => {
  const now = new Date("2026-07-19T12:00:00.000Z");
  const exactlyDue = new Date(now.getTime() - INACTIVITY_MS);
  const oneMillisecondEarly = new Date(exactlyDue.getTime() + 1);

  assert.equal(INACTIVITY_MS, 72 * 60 * 60 * 1000);
  assert.equal(isDue(exactlyDue, now), true);
  assert.equal(isDue(oneMillisecondEarly, now), false);
});

test("allows inactivity watches only from taken, qualified, and OZHOP stages of every source pipeline", () => {
  for (const pipeline of INACTIVITY_SOURCE_PIPELINES) {
    for (const statusId of [pipeline.takenInWork, pipeline.qualified, pipeline.ozhop]) {
      assert.equal(isAllowedInactivitySourceStage(pipeline.pipelineId, statusId), true);
    }
  }

  // New-lead stages, closed stages, and cross-pipeline stage IDs stay excluded.
  assert.equal(isAllowedInactivitySourceStage(6909890, 58160714), false);
  assert.equal(isAllowedInactivitySourceStage(9055778, 87347062), false);
  assert.equal(isAllowedInactivitySourceStage(8425422, 68567418), false);
  assert.equal(isAllowedInactivitySourceStage(9888398, 78602094), false);
  assert.equal(isAllowedInactivitySourceStage(10630306, 83801770), false);
  assert.equal(isAllowedInactivitySourceStage(10734414, 84554882), false);
  assert.equal(isAllowedInactivitySourceStage(11071910, 84554938), false);
  assert.equal(isAllowedInactivitySourceStage(6945006, 58398434), false);
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
  for (const pipelineId of SOURCE_PIPELINE_IDS) {
    assert.equal(canWatchLeadInPipeline(pipelineId), true);
  }
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
