import { createHash, timingSafeEqual } from "node:crypto";
import { isDirectLeadActivity } from "./leadInactivityPolicy";
import type { LeadInactivityAmoClient } from "./leadInactivityAmoClient";
import type { LeadInactivityRecordResult, LeadInactivityStore } from "./leadInactivityStore";

export interface LeadInactivityWebhookEvent {
  action: string;
  leadId: number;
  eventAt: Date;
  fingerprint: string;
}

export interface LeadInactivityWebhookProcessorResult {
  accepted: number;
  ignored: number;
  duplicates: number;
  requiresFreshRead: number;
}

export interface LeadInactivityWebhookProcessor {
  process(body: unknown): Promise<LeadInactivityWebhookProcessorResult>;
}

export interface CreateLeadInactivityWebhookProcessorOptions {
  amo: Pick<LeadInactivityAmoClient, "readLead">;
  store: Pick<LeadInactivityStore, "recordLeadEvent">;
  now?: () => Date;
}

export interface ProtectedLeadInactivityWebhookRequest {
  params: { secret?: unknown };
  body: unknown;
}

export interface ProtectedLeadInactivityWebhookResponse {
  status(code: number): ProtectedLeadInactivityWebhookResponse;
  json(body: unknown): unknown;
}

export interface CreateProtectedLeadInactivityWebhookHandlerOptions {
  secret: string;
  processor: LeadInactivityWebhookProcessor;
}

type FormRecord = Record<string, unknown>;

function asRecord(value: unknown): FormRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as FormRecord : null;
}

function asItems(value: unknown): FormRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((item): FormRecord[] => {
      const record = asRecord(item);
      return record ? [record] : [];
    });
  }
  const record = asRecord(value);
  if (!record) return [];
  const indexed = Object.values(record).flatMap((item): FormRecord[] => {
    const child = asRecord(item);
    return child ? [child] : [];
  });
  return indexed.length ? indexed : [record];
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function eventTimestamp(item: FormRecord, receivedAt: Date): Date {
  for (const field of ["updated_at", "created_at", "date", "timestamp"]) {
    const seconds = positiveInteger(item[field]);
    if (seconds) return new Date(seconds * 1_000);
  }
  return receivedAt;
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as FormRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
}

function fingerprint(namespace: string, action: string, leadId: number, eventAt: Date, item: FormRecord): string {
  const digest = createHash("sha256")
    .update(`${namespace}:${action}:${leadId}:${eventAt.toISOString()}:${stableValue(item)}`)
    .digest("hex");
  return `amo-inactivity-webhook:${digest}`;
}

function leadAction(action: string, item: FormRecord): string {
  if (action !== "update") return `${action}_lead`;
  if (positiveInteger(item.status_id) || positiveInteger(item.pipeline_id)) return "status_lead";
  if (positiveInteger(item.responsible_user_id)) return "responsible_lead";
  return "update_lead";
}

function isLeadTaskOrNote(item: FormRecord): boolean {
  const entityType = item.entity_type ?? item.element_type ?? item.entity;
  return entityType === 2 || entityType === "2" || entityType === "lead" || entityType === "leads";
}

function linkedLeadId(item: FormRecord): number | null {
  return positiveInteger(item.lead_id) ?? positiveInteger(item.entity_id) ?? positiveInteger(item.element_id);
}

function collectLeadActions(body: FormRecord, receivedAt: Date): LeadInactivityWebhookEvent[] {
  const events: LeadInactivityWebhookEvent[] = [];
  for (const entityName of ["leads", "lead"]) {
    const entity = asRecord(body[entityName]);
    if (!entity) continue;
    for (const action of ["add", "update", "status", "responsible", "restore", "delete"]) {
      for (const item of asItems(entity[action])) {
        const leadId = positiveInteger(item.id);
        if (!leadId) continue;
        const normalizedAction = leadAction(action, item);
        const at = eventTimestamp(item, receivedAt);
        events.push({
          action: normalizedAction,
          leadId,
          eventAt: at,
          fingerprint: fingerprint(entityName, normalizedAction, leadId, at, item),
        });
      }
    }
  }
  return events;
}

function collectLeadLinkedActions(body: FormRecord, receivedAt: Date, entityNames: string[], actions: string[]): LeadInactivityWebhookEvent[] {
  const events: LeadInactivityWebhookEvent[] = [];
  for (const entityName of entityNames) {
    const entity = asRecord(body[entityName]);
    if (!entity) continue;
    for (const action of actions) {
      for (const item of asItems(entity[action])) {
        if (!isLeadTaskOrNote(item)) continue;
        const leadId = linkedLeadId(item);
        if (!leadId) continue;
        const at = eventTimestamp(item, receivedAt);
        const normalizedAction = entityName.startsWith("task") ? `${action}_task` : "note_lead";
        events.push({
          action: normalizedAction,
          leadId,
          eventAt: at,
          fingerprint: fingerprint(entityName, normalizedAction, leadId, at, item),
        });
      }
    }
  }
  return events;
}

export function parseLeadInactivityWebhookEvents(body: unknown, receivedAt = new Date()): LeadInactivityWebhookEvent[] {
  const record = asRecord(body);
  if (!record || Number.isNaN(receivedAt.getTime())) return [];
  return [
    ...collectLeadActions(record, receivedAt),
    ...collectLeadLinkedActions(record, receivedAt, ["tasks", "task"], ["add", "update", "delete"]),
    ...collectLeadLinkedActions(record, receivedAt, ["notes", "note"], ["add"]),
  ];
}

function secretsEqual(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createLeadInactivityWebhookProcessor(
  options: CreateLeadInactivityWebhookProcessorOptions,
): LeadInactivityWebhookProcessor {
  const now = options.now ?? (() => new Date());

  return {
    async process(body): Promise<LeadInactivityWebhookProcessorResult> {
      const receivedAt = now();
      const events = parseLeadInactivityWebhookEvents(body, receivedAt);
      const result: LeadInactivityWebhookProcessorResult = { accepted: 0, ignored: 0, duplicates: 0, requiresFreshRead: 0 };

      for (const event of events) {
        const lead = await options.amo.readLead(event.leadId);
        if (!isDirectLeadActivity({
          action: event.action,
          entityType: "lead",
          leadId: lead.id,
          pipelineId: lead.pipelineId,
          statusId: lead.statusId,
        })) {
          result.ignored += 1;
          continue;
        }

        const recorded: LeadInactivityRecordResult = await options.store.recordLeadEvent({
          fingerprint: event.fingerprint,
          leadId: lead.id,
          eventType: event.action,
          eventAt: event.eventAt,
          receivedAt,
          leadCreatedAt: lead.createdAt,
          pipelineId: lead.pipelineId,
          statusId: lead.statusId,
        });
        if (recorded.ignored) {
          result.ignored += 1;
        } else if (recorded.duplicate) {
          result.duplicates += 1;
        } else {
          result.accepted += 1;
          if (recorded.requiresFreshRead) result.requiresFreshRead += 1;
        }
      }

      return result;
    },
  };
}

export function createProtectedLeadInactivityWebhookHandler(
  options: CreateProtectedLeadInactivityWebhookHandlerOptions,
): (request: ProtectedLeadInactivityWebhookRequest, response: ProtectedLeadInactivityWebhookResponse) => Promise<void> {
  if (!options.secret) throw new Error("AMOCRM inactivity webhook secret is required");

  return async (request, response): Promise<void> => {
    if (!secretsEqual(request.params.secret, options.secret)) {
      response.status(404).json({ ok: false });
      return;
    }

    try {
      const result = await options.processor.process(request.body);
      response.status(202).json({ ok: true, ...result });
    } catch {
      console.error("[LeadInactivityWebhook] durable processing failed");
      response.status(503).json({ ok: false, error: "inactivity webhook processing failed" });
    }
  };
}
