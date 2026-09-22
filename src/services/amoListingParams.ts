/**
 * Query building and row parsing for the amoCRM listings the reports read.
 *
 * Kept apart from `amocrm.ts`, which wires a BullMQ queue at import time, so
 * the exact filter names — the part that silently returns nothing when
 * misspelled — can be checked by tests.
 */

export interface AmoStageRef {
  pipelineId: number;
  statusId: number;
}

export interface AmoDateRange {
  from: Date;
  to: Date;
}

/** The handful of lead fields the daily report needs. */
export interface AmoLeadFact {
  id: number;
  name: string | null;
  pipelineId: number;
  statusId: number;
  price: unknown;
  responsibleUserId: number | null;
  updatedAt: Date;
  closedAt: Date | null;
}

/** One `lead_status_changed` event: which deal moved, from where, to where. */
export interface AmoLeadStatusChange {
  leadId: number;
  createdAt: Date;
  before: AmoStageRef | null;
  after: AmoStageRef | null;
}

export const LEAD_LIST_PAGE_SIZE = 250;
export const EVENT_LIST_PAGE_SIZE = 100;

export const unixSeconds = (date: Date): string => String(Math.floor(date.getTime() / 1000));

const positiveInteger = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

export function toLeadFact(raw: unknown): AmoLeadFact | null {
  const lead = raw as Record<string, unknown> | null;
  const id = positiveInteger(lead?.id);
  const pipelineId = positiveInteger(lead?.pipeline_id);
  const statusId = positiveInteger(lead?.status_id);
  const updated = Number(lead?.updated_at);
  if (id === null || pipelineId === null || statusId === null || !Number.isFinite(updated)) return null;
  const closed = Number(lead?.closed_at);
  return {
    id,
    name: typeof lead?.name === "string" ? lead.name : null,
    pipelineId,
    statusId,
    price: lead?.price,
    responsibleUserId: positiveInteger(lead?.responsible_user_id),
    updatedAt: new Date(updated * 1000),
    closedAt: Number.isFinite(closed) && closed > 0 ? new Date(closed * 1000) : null,
  };
}

function toStageRef(raw: unknown): AmoStageRef | null {
  const status = (raw as { lead_status?: { id?: unknown; pipeline_id?: unknown } } | null)?.lead_status;
  const statusId = positiveInteger(status?.id);
  const pipelineId = positiveInteger(status?.pipeline_id);
  return statusId !== null && pipelineId !== null ? { pipelineId, statusId } : null;
}

export function toLeadStatusChange(raw: unknown): AmoLeadStatusChange | null {
  const event = raw as Record<string, unknown> | null;
  const leadId = positiveInteger(event?.entity_id);
  const created = Number(event?.created_at);
  if (leadId === null || !Number.isFinite(created)) return null;
  const before = Array.isArray(event?.value_before) ? toStageRef(event.value_before[0]) : null;
  const after = Array.isArray(event?.value_after) ? toStageRef(event.value_after[0]) : null;
  return { leadId, createdAt: new Date(created * 1000), before, after };
}

/** `GET /api/v4/leads` — deals whose `closed_at` falls in the range, any pipeline. */
export function leadsClosedInRangeParams(range: AmoDateRange): URLSearchParams {
  return new URLSearchParams({
    "filter[closed_at][from]": unixSeconds(range.from),
    "filter[closed_at][to]": unixSeconds(range.to),
  });
}

/** `GET /api/v4/leads` — the given deals by id. */
export function leadsByIdsParams(ids: readonly number[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const id of ids) params.append("filter[id][]", String(id));
  return params;
}

/**
 * `GET /api/v4/events` — every stage change that landed on one of the stages
 * inside the range. The `value_after` filter shape is the one amoCRM documents
 * for `lead_status_changed`; there is no pipeline-only variant, so callers pass
 * every stage of a pipeline to mean "into the pipeline".
 */
export function leadStatusChangesIntoParams(stages: readonly AmoStageRef[], range: AmoDateRange): URLSearchParams {
  const params = new URLSearchParams({
    "filter[entity]": "lead",
    "filter[type]": "lead_status_changed",
    "filter[created_at][from]": unixSeconds(range.from),
    "filter[created_at][to]": unixSeconds(range.to),
  });
  stages.forEach((stage, index) => {
    params.set(`filter[value_after][leads_statuses][${index}][pipeline_id]`, String(stage.pipelineId));
    params.set(`filter[value_after][leads_statuses][${index}][status_id]`, String(stage.statusId));
  });
  return params;
}

/** Stage refs out of a `GET /api/v4/leads/pipelines/{id}` payload. */
export function pipelineStageRefs(payload: unknown): AmoStageRef[] {
  const pipeline = payload as { id?: unknown; _embedded?: { statuses?: unknown } } | null;
  const pipelineId = positiveInteger(pipeline?.id);
  const statuses = pipeline?._embedded?.statuses;
  if (pipelineId === null || !Array.isArray(statuses)) return [];
  const refs: AmoStageRef[] = [];
  for (const raw of statuses) {
    const statusId = positiveInteger((raw as { id?: unknown } | null)?.id);
    if (statusId !== null) refs.push({ pipelineId, statusId });
  }
  return refs;
}
