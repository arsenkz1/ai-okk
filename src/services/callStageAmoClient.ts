import axios from "axios";
import {
  normalizeAmoCrmTenantBaseUrl,
  type AmoCrmGlobalRateLimiter,
  waitForGlobalAmoCrmRequestSlot,
} from "./amoCrmRateLimiter";

export const AMO_CALL_STAGE_REQUEST_TIMEOUT_MS = 10_000;
export const AMO_CALL_STAGE_MAX_SAFE_READ_ATTEMPTS = 3;
export const AMO_CALL_STAGE_HISTORY_MAX_PAGES = 3;
export const AMO_CALL_STAGE_HISTORY_PAGE_SIZE = 100;

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

export interface AmoCallStageFieldEnum {
  id: number;
  value: string;
  sort: number | null;
}

/** Metadata from amoCRM's current custom_fields.required_statuses configuration. */
export interface AmoCallStageCustomField {
  id: number;
  name: string;
  /** amoCRM field type, e.g. text, textarea, numeric, select, multiselect. */
  type: string;
  /** Existing options for select-like fields; empty for every other type. */
  enums: readonly AmoCallStageFieldEnum[];
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

/** One custom-field value to write onto a lead. */
export interface CallStageFieldWriteValue {
  fieldId: number;
  /** enum_id for select-like fields, plain text for everything else. */
  enumId: number | null;
  value: string;
}

export type WriteCallStageFieldsOutcome =
  | { kind: "confirmed"; lead: AmoCallStageLead }
  | { kind: "not_written"; reason: "patch_rejected" | "readback_missing_values"; lead: AmoCallStageLead | null }
  | { kind: "uncertain"; error: AmoCallStageSafeError };

export type ReplaceCallStageFieldOptionsOutcome =
  | { kind: "confirmed"; enums: readonly AmoCallStageFieldEnum[] }
  | { kind: "not_replaced"; reason: "patch_rejected" | "readback_mismatch" }
  | { kind: "uncertain"; error: AmoCallStageSafeError };

export type AddCallStageFieldOptionOutcome =
  | { kind: "confirmed"; enumId: number; value: string }
  | { kind: "not_created"; reason: "patch_rejected" | "readback_missing_option" }
  | { kind: "uncertain"; error: AmoCallStageSafeError };

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
  hasRecentStageMovement(input: { leadId: number; since: Date }): Promise<boolean>;
  moveLeadToTarget(input: {
    leadId: number;
    source: { pipelineId: number; statusId: number };
    target: { pipelineId: number; statusId: number };
    isMoveMutationCurrent?: () => Promise<boolean>;
    isLeadEligibleForTarget?: (lead: AmoCallStageLead) => Promise<boolean>;
  }): Promise<MoveCallStageLeadOutcome>;
  addStageReasonNote(input: { leadId: number; text: string }): Promise<AddCallStageReasonNoteOutcome>;
  writeLeadFields(input: {
    leadId: number;
    values: readonly CallStageFieldWriteValue[];
  }): Promise<WriteCallStageFieldsOutcome>;
  addFieldOption(input: { fieldId: number; value: string }): Promise<AddCallStageFieldOptionOutcome>;
  getFieldOptions(fieldId: number): Promise<readonly AmoCallStageFieldEnum[]>;
  replaceFieldOptions(input: {
    fieldId: number;
    enums: readonly AmoCallStageFieldEnum[];
  }): Promise<ReplaceCallStageFieldOptionsOutcome>;
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
  type?: unknown;
  enums?: unknown;
  required_statuses?: unknown;
}

interface RawAmoFieldEnum {
  id?: unknown;
  value?: unknown;
  sort?: unknown;
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

interface RawAmoStageHistoryEvent {
  entity_type?: unknown;
  entity_id?: unknown;
  type?: unknown;
  created_at?: unknown;
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

function requireValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${field} must be a valid Date`);
  }
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

/**
 * Reads the option list of a select-like field. Used in two places with
 * different strictness: the account-wide field listing tolerates a bad entry
 * (see normalizeLeadCustomFields), while the single-field read before an option
 * PATCH must throw, because a partial list would destroy the options it omits.
 */
function normalizeFieldEnums(raw: unknown): AmoCallStageFieldEnum[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("amoCRM lead custom field enums are malformed");
  return raw.map((rawEnum) => {
    const item = rawEnum as RawAmoFieldEnum | null;
    if (!item || typeof item !== "object") throw new Error("amoCRM lead custom field enum is malformed");
    const value = typeof item.value === "string" ? item.value.trim() : "";
    if (!value) throw new Error("amoCRM lead custom field enum has invalid value");
    const sort = Number(item.sort);
    return {
      id: requiredPositiveInteger(item.id, "lead custom field enum id"),
      value,
      sort: Number.isInteger(sort) ? sort : null,
    };
  });
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
    // Type and options are only used to decide whether a field can be
    // autofilled. They must never make the required-field read fail: that read
    // gates every stage move, autofill or not. An unreadable type or option
    // list simply makes the field ineligible for autofill.
    const type = typeof field.type === "string" ? field.type.trim() : "";
    let enums: AmoCallStageFieldEnum[];
    try {
      enums = normalizeFieldEnums(field.enums);
    } catch {
      enums = [];
    }
    if (field.required_statuses === null || field.required_statuses === undefined) {
      return { id, name, type, enums, requiredStatuses: [] };
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
    return { id, name, type, enums, requiredStatuses };
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

/** amoCRM client for the router: stage PATCHes, notes, and required-field autofill writes. */
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

    async hasRecentStageMovement(input): Promise<boolean> {
      requiredPositiveInteger(input.leadId, "lead id");
      requireValidDate(input.since, "stage history since");
      const fromSeconds = Math.floor(input.since.getTime() / 1_000);

      for (let page = 1; page <= AMO_CALL_STAGE_HISTORY_MAX_PAGES; page += 1) {
        const params = new URLSearchParams({
          "filter[entity]": "lead",
          "filter[entity_id][]": String(input.leadId),
          "filter[created_at][from]": String(fromSeconds),
          limit: String(AMO_CALL_STAGE_HISTORY_PAGE_SIZE),
          page: String(page),
        });
        const response = await request("GET", `/api/v4/events?${params.toString()}`, undefined, true);
        // amoCRM returns 204 rather than an empty embedded list when no events match.
        if (response.status === 204) return false;
        const events = (response.data as { _embedded?: { events?: unknown } } | null)?._embedded?.events;
        if (!Array.isArray(events)) throw new Error("amoCRM lead stage history response is malformed");

        for (const rawEvent of events) {
          const event = rawEvent as RawAmoStageHistoryEvent | null;
          if (!event || typeof event !== "object") throw new Error("amoCRM lead stage history event is malformed");
          if (event.entity_type !== "lead" || requiredPositiveInteger(event.entity_id, "stage history event entity_id") !== input.leadId) {
            throw new Error("amoCRM lead stage history response is outside the requested lead");
          }
          const createdAt = unixSecondsToDate(event.created_at, "stage history event created_at");
          if (typeof event.type !== "string") throw new Error("amoCRM lead stage history event type is malformed");
          if (event.type === "lead_status_changed" && createdAt.getTime() >= input.since.getTime()) return true;
        }

        if (events.length < AMO_CALL_STAGE_HISTORY_PAGE_SIZE) return false;
      }
      throw new Error("amoCRM lead stage history exceeded safe page limit");
    },

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

    /**
     * Writes required-field values, then re-reads the lead and verifies every
     * value landed. An ambiguous PATCH is never blindly retried.
     */
    async writeLeadFields(input): Promise<WriteCallStageFieldsOutcome> {
      requiredPositiveInteger(input.leadId, "id");
      if (input.values.length === 0) throw new Error("field write requires at least one value");

      const payload = input.values.map((item) => ({
        field_id: requiredPositiveInteger(item.fieldId, "field write field_id"),
        values: [item.enumId === null ? { value: item.value } : { enum_id: item.enumId }],
      }));

      try {
        await request("PATCH", "/api/v4/leads", [{
          id: input.leadId,
          custom_fields_values: payload,
        }], false);
      } catch (error) {
        if (!isAmbiguousMutationError(error)) {
          let lead: AmoCallStageLead | null = null;
          try {
            lead = await readLead(input.leadId);
          } catch {
            lead = null;
          }
          return { kind: "not_written", reason: "patch_rejected", lead };
        }
        return { kind: "uncertain", error: toSafeError(error) };
      }

      let readback: AmoCallStageLead;
      try {
        readback = await readLead(input.leadId);
      } catch (error) {
        return { kind: "uncertain", error: toSafeError(error) };
      }

      const allLanded = input.values.every((item) => {
        const stored = readback.fieldValues.get(item.fieldId);
        return Array.isArray(stored) && stored.some((value) => value.trim() === item.value.trim());
      });
      return allLanded
        ? { kind: "confirmed", lead: readback }
        : { kind: "not_written", reason: "readback_missing_values", lead: readback };
    },

    /**
     * Appends one option to a select-like field. amoCRM replaces the whole enum
     * list on PATCH, so the existing options are re-sent verbatim; a field whose
     * current options cannot be read is left untouched.
     */
    async addFieldOption(input): Promise<AddCallStageFieldOptionOutcome> {
      requiredPositiveInteger(input.fieldId, "field id");
      const value = input.value.trim();
      if (!value) throw new Error("field option value is required");

      let existing: readonly AmoCallStageFieldEnum[];
      try {
        const response = await request("GET", `/api/v4/leads/custom_fields/${input.fieldId}`, undefined, true);
        existing = normalizeFieldEnums((response.data as { enums?: unknown } | null)?.enums);
      } catch (error) {
        return { kind: "uncertain", error: toSafeError(error) };
      }

      const already = existing.find((item) => item.value.trim() === value);
      if (already) return { kind: "confirmed", enumId: already.id, value: already.value };

      const maxSort = existing.reduce((max, item) => Math.max(max, item.sort ?? 0), 0);
      try {
        await request("PATCH", "/api/v4/leads/custom_fields", [{
          id: input.fieldId,
          enums: [
            ...existing.map((item) => ({ id: item.id, value: item.value, sort: item.sort ?? 0 })),
            { value, sort: maxSort + 1 },
          ],
        }], false);
      } catch (error) {
        return isAmbiguousMutationError(error)
          ? { kind: "uncertain", error: toSafeError(error) }
          : { kind: "not_created", reason: "patch_rejected" };
      }

      try {
        const response = await request("GET", `/api/v4/leads/custom_fields/${input.fieldId}`, undefined, true);
        const created = normalizeFieldEnums((response.data as { enums?: unknown } | null)?.enums)
          .find((item) => item.value.trim() === value);
        return created
          ? { kind: "confirmed", enumId: created.id, value: created.value }
          : { kind: "not_created", reason: "readback_missing_option" };
      } catch (error) {
        return { kind: "uncertain", error: toSafeError(error) };
      }
    },

    async getFieldOptions(fieldId): Promise<readonly AmoCallStageFieldEnum[]> {
      requiredPositiveInteger(fieldId, "field id");
      const response = await request("GET", `/api/v4/leads/custom_fields/${fieldId}`, undefined, true);
      return normalizeFieldEnums((response.data as { enums?: unknown } | null)?.enums);
    },

    /**
     * Overwrites a field's option list wholesale. Used only by the rollback
     * path, which computes the list to keep from a durable record of what this
     * system added — never from a guess.
     */
    async replaceFieldOptions(input): Promise<ReplaceCallStageFieldOptionsOutcome> {
      requiredPositiveInteger(input.fieldId, "field id");
      try {
        await request("PATCH", "/api/v4/leads/custom_fields", [{
          id: input.fieldId,
          enums: input.enums.map((item, index) => ({
            id: item.id,
            value: item.value,
            sort: item.sort ?? index + 1,
          })),
        }], false);
      } catch (error) {
        return isAmbiguousMutationError(error)
          ? { kind: "uncertain", error: toSafeError(error) }
          : { kind: "not_replaced", reason: "patch_rejected" };
      }

      try {
        const response = await request("GET", `/api/v4/leads/custom_fields/${input.fieldId}`, undefined, true);
        const readback = normalizeFieldEnums((response.data as { enums?: unknown } | null)?.enums);
        const expected = new Set(input.enums.map((item) => item.id));
        const applied = readback.length === input.enums.length && readback.every((item) => expected.has(item.id));
        return applied ? { kind: "confirmed", enums: readback } : { kind: "not_replaced", reason: "readback_mismatch" };
      } catch (error) {
        return { kind: "uncertain", error: toSafeError(error) };
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
