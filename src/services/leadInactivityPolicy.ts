export interface InactivityStagePair {
  pipelineId: number;
  statusId: number;
}

export interface InactivitySourcePipeline {
  pipelineId: number;
  /** Human-readable amoCRM pipeline name; used only for review and logging. */
  name: string;
  takenInWork: number;
  qualified: number;
  ozhop: number;
}

/**
 * Every amoCRM pipeline whose "взято в работу", "квалифицирован", and "ОЖОП"
 * stages take part in the inactivity rollout. This table is the single source
 * for the webhook filter, the worker's priority scan, the move guard, and the
 * production baseline enumeration; adding a pipeline here extends all four.
 */
export const INACTIVITY_SOURCE_PIPELINES: readonly InactivitySourcePipeline[] = Object.freeze([
  { pipelineId: 6909890, name: "UZUM", takenInWork: 58160718, qualified: 58160726, ozhop: 58160902 },
  { pipelineId: 9055778, name: "EXODE", takenInWork: 72917582, qualified: 72917586, ozhop: 72919958 },
  { pipelineId: 9888398, name: "Дата", takenInWork: 78602098, qualified: 78631750, ozhop: 78631754 },
  { pipelineId: 11071910, name: "Видеочат", takenInWork: 86963442, qualified: 86963446, ozhop: 86963494 },
].map((pipeline) => Object.freeze(pipeline)));

/**
 * Business ordering for due inactivity movements: OZHOP, then qualified, then
 * taken-in-work. The order inside one group is deliberately not a pipeline
 * priority; persisted dueAt/leadId ordering breaks ties after the worker has
 * selected the business stage group.
 */
const INACTIVITY_STAGE_PRIORITY_ORDER = Object.freeze(["ozhop", "qualified", "takenInWork"] as const);

export const SOURCE_PIPELINE_IDS: readonly number[] = Object.freeze(
  INACTIVITY_SOURCE_PIPELINES.map(({ pipelineId }) => pipelineId),
);

export const INACTIVITY_STAGE_PRIORITY_GROUPS: readonly (readonly InactivityStagePair[])[] = Object.freeze(
  INACTIVITY_STAGE_PRIORITY_ORDER.map((stageKey) => Object.freeze(
    INACTIVITY_SOURCE_PIPELINES.map((pipeline) => Object.freeze({
      pipelineId: pipeline.pipelineId,
      statusId: pipeline[stageKey],
    })),
  )),
);

export const ALLOWED_INACTIVITY_SOURCE_STAGES: readonly InactivityStagePair[] = Object.freeze(
  INACTIVITY_STAGE_PRIORITY_GROUPS.flat(),
);

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
