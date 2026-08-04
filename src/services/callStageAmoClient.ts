import axios from "axios";
import {
  normalizeAmoCrmTenantBaseUrl,
  type AmoCrmGlobalRateLimiter,
  waitForGlobalAmoCrmRequestSlot,
} from "./amoCrmRateLimiter";

export const AMO_CALL_STAGE_REQUEST_TIMEOUT_MS = 10_000;
export const AMO_CALL_STAGE_MAX_SAFE_READ_ATTEMPTS = 3;

export interface AmoCallStageHttpRequest {
  method: "GET" | "POST" | "PATCH";
  url: string;
  headers: Record<string, string>;
  timeout: number;
  data?: unknown;
  __amoCrmGlobalRateLimitReserved?: true;
}

export interface AmoCallStageHttpResponse {
  status: number;
  data: unknown;
  headers?: Record<string, string | undefined>;
}

export interface AmoCallStageHttpClient {
  request(request: AmoCallStageHttpRequest): Promise<AmoCallStageHttpResponse>;
}

export interface AmoCallStageLead {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  pipelineId: number;
  statusId: number;
  responsibleUserId: number | null;
  name: string | null;
  fieldValues: ReadonlyMap<number, string[]>;
}

/** Metadata from amoCRM's current custom_fields.required_statuses configuration. */
export interface AmoCallStageCustomField {
  id: number;
  name: string;
  requiredStatuses: readonly { pipelineId: number; statusId: number }[];
}

export interface AmoCallStageSafeError {
  kind: "http" | "network";
  status: number | null;
  code: string | null;
  message: string;
}

export type MoveCallStageLeadOutcome =
  | { kind: "confirmed"; lead: AmoCallStageLead }
  | { kind: "not_moved"; reason: "source_changed" | "preconditions_changed" | "fence_cancelled" | "patch_rejected" | "readback_not_target"; lead: AmoCallStageLead }
  | { kind: "uncertain"; error: AmoCallStageSafeError; readback: AmoCallStageLead | null };

export type AddCallStageReasonNoteOutcome =
  | { kind: "confirmed"; noteId: number }
  | { kind: "not_created"; reason: "note_rejected" }
  | { kind: "uncertain"; error: AmoCallStageSafeError };

export interface CreateCallStageAmoClientOptions {
  baseUrl: string;
  accessToken: string;
  http?: AmoCallStageHttpClient;
  globalRateLimiter?: AmoCrmGlobalRateLimiter;
}

export interface CallStageAmoClient {
  readLead(leadId: number): Promise<AmoCallStageLead>;
  getLeadCustomFields(): Promise<readonly AmoCallStageCustomField[]>;
  moveLeadToTarget(input: {
    leadId: number;
    source: { pipelineId: number; statusId: number };
    target: { pipelineId: number; statusId: number };
    isMoveMutationCurrent?: () => Promise<boolean>;
    isLeadEligibleForTarget?: (lead: AmoCallStageLead) => Promise<boolean>;
  }): Promise<MoveCallStageLeadOutcome>;
  addStageReasonNote(input: { leadId: number; text: string }): Promise<AddCallStageReasonNoteOutcome>;
}

interface RawAmoFieldValue {
  value?: unknown;
}

interface RawAmoCustomField {
  field_id?: unknown;
  values?: unknown;
}

interface RawAmoRequiredStatus {
  pipeline_id?: unknown;
  status_id?: unknown;
}

interface RawAmoLeadCustomField {
  id?: unknown;
  name?: unknown;
  required_statuses?: unknown;
}

interface RawAmoLead {
  id?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  pipeline_id?: unknown;
  status_id?: unknown;
  responsible_user_id?: unknown;
  name?: unknown;
  custom_fields_values?: unknown;
}

class AmoCallStageHttpStatusError extends Error {
  readonly response: { status: number; headers: Record<string, string | undefined> | undefined };

  constructor(response: AmoCallStageHttpResponse) {
    super(`amoCRM HTTP ${response.status}`);
    this.response = { status: response.status, headers: response.headers };
  }
}

/** A known local cancellation after reserving a rate slot; no HTTP request was sent. */
class AmoCallStagePreDispatchCancelledError extends Error {}

function requiredPositiveInteger(value: unknown, field: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) throw new Error(`amoCRM lead has invalid ${field}`);
  return numeric;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return requiredPositiveInteger(value, field);
}

function unixSecondsToDate(value: unknown, field: string): Date {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`amoCRM lead has invalid ${field}`);
  const date = new Date(seconds * 1_000);
  if (Number.isNaN(date.getTime())) throw new Error(`amoCRM lead has invalid ${field}`);
  return date;
}

function toFieldValues(raw: unknown): ReadonlyMap<number, string[]> {
  if (raw === undefined || raw === null) return new Map();
  if (!Array.isArray(raw)) throw new Error("amoCRM lead custom_fields_values is malformed");
  const fields = new Map<number, string[]>();
  for (const rawField of raw) {
    const field = rawField as RawAmoCustomField | null;
    if (!field || typeof field !== "object") throw new Error("amoCRM custom field is malformed");
    const id = requiredPositiveInteger(field.field_id, "custom field id");
    if (!Array.isArray(field.values)) throw new Error("amoCRM custom field values are malformed");
    const values = field.values.flatMap((rawValue) => {
      const value = (rawValue as RawAmoFieldValue | null)?.value;
      if (typeof value === "string") return value.trim() ? [value.trim()] : [];
      if (typeof value === "number" || typeof value === "boolean") return [String(value)];
      return [];
    });
    fields.set(id, [...(fields.get(id) ?? []), ...values]);
  }
  return fields;
}

function normalizeLead(raw: unknown): AmoCallStageLead {
  const lead = raw as RawAmoLead | null;
  if (!lead || typeof lead !== "object") throw new Error("amoCRM lead response is malformed");
  return {
    id: requiredPositiveInteger(lead.id, "id"),
    createdAt: unixSecondsToDate(lead.created_at, "created_at"),
    updatedAt: unixSecondsToDate(lead.updated_at, "updated_at"),
    pipelineId: requiredPositiveInteger(lead.pipeline_id, "pipeline_id"),
    statusId: requiredPositiveInteger(lead.status_id, "status_id"),
    responsibleUserId: nullablePositiveInteger(lead.responsible_user_id, "responsible_user_id"),
    name: typeof lead.name === "string" ? lead.name : null,
    fieldValues: toFieldValues(lead.custom_fields_values),
  };
}

function normalizeLeadCustomFields(raw: unknown): AmoCallStageCustomField[] {
  const fields = (raw as { _embedded?: { custom_fields?: unknown } } | null)?._embedded?.custom_fields;
  if (!Array.isArray(fields)) throw new Error("amoCRM lead custom fields response is malformed");
  return fields.map((rawField) => {
    const field = rawField as RawAmoLeadCustomField | null;
    if (!field || typeof field !== "object") throw new Error("amoCRM lead custom field is malformed");
    const id = requiredPositiveInteger(field.id, "lead custom field id");
    const name = typeof field.name === "string" ? field.name.trim() : "";
    if (!name) throw new Error("amoCRM lead custom field has invalid name");
    if (field.required_statuses === null || field.required_statuses === undefined) {
      return { id, name, requiredStatuses: [] };
    }
    if (!Array.isArray(field.required_statuses)) throw new Error("amoCRM lead required_statuses is malformed");
    const requiredStatuses = field.required_statuses.map((rawStatus) => {
      const status = rawStatus as RawAmoRequiredStatus | null;
      if (!status || typeof status !== "object") throw new Error("amoCRM required status is malformed");
      return {
        pipelineId: requiredPositiveInteger(status.pipeline_id, "required status pipeline_id"),
        statusId: requiredPositiveInteger(status.status_id, "required status status_id"),
      };
    });
    return { id, name, requiredStatuses };
  });
}

function errorStatus(error: unknown): number | null {
  const status = Number((error as { response?: { status?: unknown } } | null)?.response?.status);
  return Number.isInteger(status) ? status : null;
}

function toSafeError(error: unknown): AmoCallStageSafeError {
  const status = errorStatus(error);
  const code = (error as { code?: unknown } | null)?.code;
  return {
    kind: status === null ? "network" : "http",
    status,
    code: typeof code === "string" && /^[A-Z0-9_-]{1,64}$/.test(code) ? code : null,
    message: status === null ? "amoCRM network request outcome is unknown" : `amoCRM HTTP ${status}`,
  };
}

function isRetryableReadError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === null || status === 429 || (status !== null && status >= 500);
}

function isAmbiguousMutationError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === null || status === 408 || status === 409 || (status !== null && status >= 500);
}

function isExactStage(lead: AmoCallStageLead, stage: { pipelineId: number; statusId: number }): boolean {
  return lead.pipelineId === stage.pipelineId && lead.statusId === stage.statusId;
}

function responseNoteId(data: unknown): number | null {
  const notes = (data as { _embedded?: { notes?: unknown } } | null)?._embedded?.notes;
  if (!Array.isArray(notes) || notes.length !== 1) return null;
  const id = Number((notes[0] as { id?: unknown } | null)?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** amoCRM client for the router: only stage PATCHes and explanatory notes, never field writes. */
export function createCallStageAmoClient(options: CreateCallStageAmoClientOptions): CallStageAmoClient {
  const baseUrl = normalizeAmoCrmTenantBaseUrl(options.baseUrl);
  const accessToken = options.accessToken.trim();
  if (!accessToken) throw new Error("AMOCRM access token is required");
  const globalRateLimiter = options.globalRateLimiter ?? { waitForRequestSlot: waitForGlobalAmoCrmRequestSlot };
  const http: AmoCallStageHttpClient = options.http ?? {
    async request(request) {
      const response = await axios.request(request);
      return {
        status: response.status,
        data: response.data,
        headers: Object.fromEntries(Object.entries(response.headers ?? {}).map(([key, value]) => [
          key, Array.isArray(value) ? value.join(",") : String(value),
        ])),
      };
    },
  };

  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  });

  const request = async (
    method: AmoCallStageHttpRequest["method"],
    path: string,
    data: unknown,
    retrySafe: boolean,
    beforeDispatch?: () => Promise<boolean>,
  ): Promise<AmoCallStageHttpResponse> => {
    const attempts = retrySafe ? AMO_CALL_STAGE_MAX_SAFE_READ_ATTEMPTS : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await globalRateLimiter.waitForRequestSlot();
      if (beforeDispatch && !await beforeDispatch()) {
        throw new AmoCallStagePreDispatchCancelledError("amoCRM dispatch fence was cancelled");
      }
      try {
        const response = await http.request({
          method,
          url: `${baseUrl}${path}`,
          headers: headers(),
          timeout: AMO_CALL_STAGE_REQUEST_TIMEOUT_MS,
          __amoCrmGlobalRateLimitReserved: true,
          ...(data === undefined ? {} : { data }),
        });
        if (response.status < 200 || response.status >= 300) throw new AmoCallStageHttpStatusError(response);
        return response;
      } catch (error) {
        lastError = error;
        if (!retrySafe || attempt === attempts || !isRetryableReadError(error)) throw error;
      }
    }
    throw lastError;
  };

  const readLead = async (leadId: number): Promise<AmoCallStageLead> => {
    requiredPositiveInteger(leadId, "id");
    return normalizeLead((await request("GET", `/api/v4/leads/${leadId}`, undefined, true)).data);
  };

  const getLeadCustomFields = async (): Promise<readonly AmoCallStageCustomField[]> => {
    const all: AmoCallStageCustomField[] = [];
    // amoCRM documents a 250-field page limit. Follow deterministic pages, never
    // server-supplied URLs, so metadata cannot redirect credentialed requests.
    for (let page = 1; page <= 20; page += 1) {
      const response = await request("GET", `/api/v4/leads/custom_fields?limit=250&page=${page}`, undefined, true);
      const fields = normalizeLeadCustomFields(response.data);
      all.push(...fields);
      if (fields.length < 250) return all;
    }
    throw new Error("amoCRM lead custom field pagination exceeded safe limit");
  };

  return {
    readLead,
    getLeadCustomFields,

    async moveLeadToTarget(input): Promise<MoveCallStageLeadOutcome> {
      requiredPositiveInteger(input.leadId, "id");
      const current = await readLead(input.leadId);
      if (!isExactStage(current, input.source)) return { kind: "not_moved", reason: "source_changed", lead: current };
      if (input.isMoveMutationCurrent && !await input.isMoveMutationCurrent()) {
        return { kind: "not_moved", reason: "fence_cancelled", lead: current };
      }

      const latest = await readLead(input.leadId);
      if (!isExactStage(latest, input.source)) return { kind: "not_moved", reason: "source_changed", lead: latest };
      if (input.isLeadEligibleForTarget && !await input.isLeadEligibleForTarget(latest)) {
        return { kind: "not_moved", reason: "preconditions_changed", lead: latest };
      }
      if (input.isMoveMutationCurrent && !await input.isMoveMutationCurrent()) {
        return { kind: "not_moved", reason: "fence_cancelled", lead: latest };
      }

      try {
        await request("PATCH", "/api/v4/leads", [{
          id: latest.id,
          pipeline_id: input.target.pipelineId,
          status_id: input.target.statusId,
        }], false, input.isMoveMutationCurrent
          ? async () => input.isMoveMutationCurrent!()
          : undefined);
      } catch (error) {
        if (error instanceof AmoCallStagePreDispatchCancelledError) {
          return { kind: "not_moved", reason: "fence_cancelled", lead: latest };
        }
        if (!isAmbiguousMutationError(error)) {
          return { kind: "not_moved", reason: "patch_rejected", lead: latest };
        }
        try {
          const readback = await readLead(input.leadId);
          if (isExactStage(readback, input.target)) return { kind: "confirmed", lead: readback };
          return { kind: "uncertain", error: toSafeError(error), readback };
        } catch {
          return { kind: "uncertain", error: toSafeError(error), readback: null };
        }
      }

      try {
        const readback = await readLead(input.leadId);
        if (isExactStage(readback, input.target)) return { kind: "confirmed", lead: readback };
        return { kind: "not_moved", reason: "readback_not_target", lead: readback };
      } catch (error) {
        return { kind: "uncertain", error: toSafeError(error), readback: null };
      }
    },

    async addStageReasonNote(input): Promise<AddCallStageReasonNoteOutcome> {
      requiredPositiveInteger(input.leadId, "id");
      if (!input.text.trim()) throw new Error("stage note text is required");
      try {
        const response = await request("POST", "/api/v4/leads/notes", [{
          entity_id: input.leadId,
          note_type: "common",
          params: { text: input.text },
        }], false);
        const noteId = responseNoteId(response.data);
        return noteId === null ? { kind: "not_created", reason: "note_rejected" } : { kind: "confirmed", noteId };
      } catch (error) {
        return isAmbiguousMutationError(error)
          ? { kind: "uncertain", error: toSafeError(error) }
          : { kind: "not_created", reason: "note_rejected" };
      }
    },
  };
}
