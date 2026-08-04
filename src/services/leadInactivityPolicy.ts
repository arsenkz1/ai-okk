export const SOURCE_PIPELINE_IDS = Object.freeze([9055778, 6909890] as const);
export const ALLOWED_INACTIVITY_SOURCE_STAGES = Object.freeze([
  { pipelineId: 6909890, statusId: 58160718 }, // UZUM: взято в работу
  { pipelineId: 6909890, statusId: 58160726 }, // UZUM: квалифицирован
  { pipelineId: 6909890, statusId: 58160902 }, // UZUM: ОЖОП
  { pipelineId: 9055778, statusId: 72917582 }, // EXODE: взято в работу
  { pipelineId: 9055778, statusId: 72917586 }, // EXODE: квалифицирован
  { pipelineId: 9055778, statusId: 72919958 }, // EXODE: ОЖОП
] as const);

/**
 * Business ordering for due inactivity movements. The order inside one group is
 * deliberately not a pipeline priority; persisted dueAt/leadId ordering breaks
 * ties after the worker has selected the business stage group.
 */
export const INACTIVITY_STAGE_PRIORITY_GROUPS = Object.freeze([
  Object.freeze([
    { pipelineId: 6909890, statusId: 58160902 }, // UZUM: ОЖОП
    { pipelineId: 9055778, statusId: 72919958 }, // EXODE: ОЖОП
  ]),
  Object.freeze([
    { pipelineId: 6909890, statusId: 58160726 }, // UZUM: квалифицирован
    { pipelineId: 9055778, statusId: 72917586 }, // EXODE: квалифицирован
  ]),
  Object.freeze([
    { pipelineId: 6909890, statusId: 58160718 }, // UZUM: взято в работу
    { pipelineId: 9055778, statusId: 72917582 }, // EXODE: взято в работу
  ]),
] as const);
export const TARGET_PIPELINE_ID = 9055770;
export const TARGET_STATUS_ID = 72917546;
export const INACTIVITY_MS = 72 * 60 * 60 * 1000;

export const DIRECT_LEAD_WEBHOOK_ACTIONS = Object.freeze([
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
] as const);

const sourcePipelineIdSet = new Set<number>(SOURCE_PIPELINE_IDS);
const allowedInactivitySourceStageKeys = new Set(
  ALLOWED_INACTIVITY_SOURCE_STAGES.map(({ pipelineId, statusId }) => `${pipelineId}:${statusId}`),
);
const directLeadWebhookActionSet = new Set<string>(DIRECT_LEAD_WEBHOOK_ACTIONS);

export interface AmoPipelineStage {
  type?: number | null;
  is_editable?: boolean | null;
}

export interface DirectLeadActivityCandidate {
  action: string;
  entityType?: string | null;
  leadId?: number | null;
  pipelineId?: number | null;
  statusId?: number | null;
}

function isLeadEntityType(entityType: string | null | undefined): boolean {
  return entityType === "lead" || entityType === "leads";
}

export function isSourcePipeline(pipelineId: number | null | undefined): boolean {
  return typeof pipelineId === "number" && sourcePipelineIdSet.has(pipelineId);
}

export function canWatchLeadInPipeline(pipelineId: number | null | undefined): boolean {
  return isSourcePipeline(pipelineId) && pipelineId !== TARGET_PIPELINE_ID;
}

export function isAllowedInactivitySourceStage(
  pipelineId: number | null | undefined,
  statusId: number | null | undefined,
): boolean {
  return typeof pipelineId === "number"
    && typeof statusId === "number"
    && allowedInactivitySourceStageKeys.has(`${pipelineId}:${statusId}`);
}

export function isDue(lastActivityAt: Date, now: Date): boolean {
  return now.getTime() - lastActivityAt.getTime() >= INACTIVITY_MS;
}

export function isActiveEditableStage(stage: AmoPipelineStage | null | undefined): boolean {
  return stage?.type === 0 && stage.is_editable === true;
}

export function isSupportedDirectLeadWebhookAction(action: string | null | undefined): boolean {
  return typeof action === "string" && directLeadWebhookActionSet.has(action);
}

export function isDirectLeadActivity(
  candidate: DirectLeadActivityCandidate | null | undefined
): boolean {
  return (
    candidate !== null &&
    candidate !== undefined &&
    isSupportedDirectLeadWebhookAction(candidate.action) &&
    isLeadEntityType(candidate.entityType) &&
    isAllowedInactivitySourceStage(candidate.pipelineId, candidate.statusId) &&
    typeof candidate.leadId === "number" &&
    Number.isInteger(candidate.leadId) &&
    candidate.leadId > 0
  );
}
