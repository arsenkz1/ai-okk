import axios from "axios";
import { ALLOWED_INACTIVITY_SOURCE_STAGES, isAllowedInactivitySourceStage } from "./leadInactivityPolicy";

export const AMO_INACTIVITY_MAX_REQUESTS_PER_SECOND = 2;
export const AMO_INACTIVITY_MIN_REQUEST_INTERVAL_MS = 1_000 / AMO_INACTIVITY_MAX_REQUESTS_PER_SECOND;
export const AMO_INACTIVITY_REQUEST_TIMEOUT_MS = 10_000;
export const AMO_INACTIVITY_MAX_SAFE_ATTEMPTS = 3;
export const AMO_INACTIVITY_HISTORY_MAX_PAGES = 2;
export const AMO_INACTIVITY_HISTORY_MAX_PAGE_SIZE = 100;
export const AMO_INACTIVITY_LEAD_LIST_MAX_PAGES = 1_000;
export const AMO_INACTIVITY_LEAD_LIST_MAX_PAGE_SIZE = 250;

export interface AmoInactivityHttpRequest {
  method: "GET" | "PATCH";
  url: string;
  headers: Record<string, string>;
  timeout: number;
  data?: unknown;
}

export interface AmoInactivityHttpResponse {
  status: number;
  data: unknown;
  headers?: Record<string, string | undefined>;
}

export interface AmoInactivityHttpClient {
  request(request: AmoInactivityHttpRequest): Promise<AmoInactivityHttpResponse>;
}

export interface AmoInactivityLead {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  pipelineId: number;
  statusId: number;
  responsibleUserId: number | null;
  name: string | null;
}

export interface AmoInactivityHistoryEvent {
  id: string;
  entityType: string | null;
  entityId: number | null;
  createdAt: Date;
  type: number | null;
  raw: unknown;
}

export interface AmoInactivityMoveTarget {
  sourcePipelineIds: readonly number[];
  targetPipelineId: number;
  targetStatusId: number;
}

export interface AmoInactivityMoveHooks {
  isMoveMutationCurrent?: () => Promise<boolean>;
  beforeFinalPatch?: () => Promise<"allow" | "daily_capacity_unavailable">;
  beforePatchSend?: () => Promise<"allow" | "daily_capacity_unavailable">;
}

export interface AmoInactivitySafeError {
  kind: "http" | "network";
  status: number | null;
  code: string | null;
  message: string;
}

export type AmoInactivityMoveOutcome =
  | { kind: "confirmed"; lead: AmoInactivityLead }
  | { kind: "not_moved"; reason: "not_in_source" | "fence_cancelled" | "daily_capacity_unavailable" | "patch_rejected" | "readback_not_target"; lead: AmoInactivityLead }
  | { kind: "uncertain"; error: AmoInactivitySafeError; readback: AmoInactivityLead | null };

export interface CreateLeadInactivityAmoClientOptions {
  baseUrl: string;
  accessToken: string;
  http?: AmoInactivityHttpClient;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface RawAmoLead {
  id?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  pipeline_id?: unknown;
  status_id?: unknown;
  responsible_user_id?: unknown;
  name?: unknown;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) throw new Error(`amoCRM lead has invalid ${field}`);
  return numberValue;
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return requiredPositiveInteger(value, "responsible_user_id");
}

function unixSecondsToDate(value: unknown, field: string): Date {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`amoCRM lead has invalid ${field}`);
  const date = new Date(seconds * 1_000);
  if (Number.isNaN(date.getTime())) throw new Error(`amoCRM lead has invalid ${field}`);
  return date;
}

function normalizeLead(raw: unknown): AmoInactivityLead {
  const lead = raw as RawAmoLead | null;
  if (!lead || typeof lead !== "object") throw new Error("amoCRM lead response is malformed");
  return {
    id: requiredPositiveInteger(lead.id, "id"),
    createdAt: unixSecondsToDate(lead.created_at, "created_at"),
    updatedAt: unixSecondsToDate(lead.updated_at, "updated_at"),
    pipelineId: requiredPositiveInteger(lead.pipeline_id, "pipeline_id"),
    statusId: requiredPositiveInteger(lead.status_id, "status_id"),
    responsibleUserId: nullablePositiveInteger(lead.responsible_user_id),
    name: typeof lead.name === "string" ? lead.name : null,
  };
}

function errorStatus(error: unknown): number | null {
  const status = Number((error as { response?: { status?: unknown } } | null)?.response?.status);
  return Number.isInteger(status) ? status : null;
}

function errorHeaders(error: unknown): Record<string, string | undefined> | undefined {
  const headers = (error as { response?: { headers?: unknown } } | null)?.response?.headers;
  return headers && typeof headers === "object" ? headers as Record<string, string | undefined> : undefined;
}

class AmoInactivityHttpStatusError extends Error {
  readonly response: { status: number; headers: Record<string, string | undefined> | undefined };

  constructor(response: AmoInactivityHttpResponse) {
    super(`amoCRM HTTP ${response.status}`);
    this.response = { status: response.status, headers: response.headers };
  }
}

class AmoInactivityPrePatchFenceCancelledError extends Error {
  constructor() {
    super("durable mutation fence was cancelled before amoCRM PATCH");
  }
}

class AmoInactivityPrePatchDailyCapacityUnavailableError extends Error {
  constructor() {
    super("daily movement capacity became unavailable before amoCRM PATCH");
  }
}

class AmoInactivityPrePatchScopeChangedError extends Error {
  constructor(readonly lead: AmoInactivityLead) {
    super("amoCRM lead is no longer in an allowed inactivity source stage");
  }
}

class AmoInactivityPrePatchReadFailedError extends Error {
  constructor() {
    super("amoCRM lead could not be refreshed before PATCH");
  }
}

function toSafeError(error: unknown): AmoInactivitySafeError {
  const status = errorStatus(error);
  const code = (error as { code?: unknown } | null)?.code;
  const safeCode = typeof code === "string" && /^[A-Z0-9_-]{1,64}$/.test(code) ? code : null;
  return {
    kind: status === null ? "network" : "http",
    status,
    code: safeCode,
    message: status === null ? "amoCRM network request outcome is unknown" : `amoCRM HTTP ${status}`,
  };
}

function retryAfterMs(headers: Record<string, string | undefined> | undefined, now: Date): number | null {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - now.getTime());
}

function isRetryableReadError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 429 || (status !== null && status >= 500) || status === null;
}

function isAmbiguousMutationError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === null || status === 408 || status === 409 || status >= 500;
}

function normalizeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error("AMOCRM base URL must be a valid amoCRM HTTPS tenant URL");
  }
  const allowedHost = parsed.hostname.endsWith(".amocrm.ru") || parsed.hostname.endsWith(".amocrm.com");
  if (
    parsed.protocol !== "https:"
    || !allowedHost
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("AMOCRM base URL must be a valid amoCRM HTTPS tenant URL");
  }
  return parsed.origin;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer`);
  return Math.min(resolved, maximum);
}

export interface LeadInactivityAmoClient {
  readLead(leadId: number): Promise<AmoInactivityLead>;
  listAllowedSourceStageLeads(options?: { maxPages?: number; pageSize?: number }): Promise<AmoInactivityLead[]>;
  readLeadHistory(leadId: number, options?: { maxPages?: number; pageSize?: number }): Promise<AmoInactivityHistoryEvent[]>;
  moveLeadToTarget(
    leadId: number,
    target: AmoInactivityMoveTarget,
    hooks?: AmoInactivityMoveHooks | (() => Promise<boolean>),
  ): Promise<AmoInactivityMoveOutcome>;
}

export function createLeadInactivityAmoClient(options: CreateLeadInactivityAmoClientOptions): LeadInactivityAmoClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const accessToken = options.accessToken.trim();
  if (!accessToken) throw new Error("AMOCRM access token is required");

  const http: AmoInactivityHttpClient = options.http ?? {
    async request(request: AmoInactivityHttpRequest): Promise<AmoInactivityHttpResponse> {
      const response = await axios.request(request);
      return {
        status: response.status,
        data: response.data,
        headers: Object.fromEntries(
          Object.entries(response.headers ?? {}).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(",") : String(value),
          ]),
        ),
      };
    },
  };
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  let nextAllowedAt = 0;
  let serverCooldownUntil = 0;
  let logicalNow = 0;

  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  });

  const waitForRateLimit = async (): Promise<void> => {
    while (true) {
      const current = Math.max(now().getTime(), logicalNow);
      const allowedAt = Math.max(nextAllowedAt, serverCooldownUntil);
      if (allowedAt > current) {
        await sleep(allowedAt - current);
        logicalNow = Math.max(logicalNow, allowedAt);
        continue;
      }
      logicalNow = current;
      nextAllowedAt = current + AMO_INACTIVITY_MIN_REQUEST_INTERVAL_MS;
      return;
    }
  };

  const makeRequest = async (
    method: "GET" | "PATCH",
    path: string,
    data: unknown,
    retrySafe: boolean,
    beforeSend?: () => Promise<boolean>,
  ): Promise<AmoInactivityHttpResponse> => {
    const attempts = retrySafe ? AMO_INACTIVITY_MAX_SAFE_ATTEMPTS : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await waitForRateLimit();
      if (beforeSend && !await beforeSend()) throw new AmoInactivityPrePatchFenceCancelledError();
      try {
        const response = await http.request({
          method,
          url: `${baseUrl}${path}`,
          headers: headers(),
          timeout: AMO_INACTIVITY_REQUEST_TIMEOUT_MS,
          ...(data === undefined ? {} : { data }),
        });
        if (response.status < 200 || response.status >= 300) {
          throw new AmoInactivityHttpStatusError(response);
        }
        return response;
      } catch (error) {
        lastError = error;
        const retryAfterDelay = retryAfterMs(errorHeaders(error), now());
        if (retryAfterDelay !== null) {
          serverCooldownUntil = Math.max(serverCooldownUntil, now().getTime() + retryAfterDelay);
        }
        if (!retrySafe || attempt === attempts || !isRetryableReadError(error)) throw error;
        const backoff = Math.min(4_000, 500 * 2 ** (attempt - 1));
        const retryDelay = retryAfterDelay ?? backoff;
        await sleep(retryDelay);
      }
    }

    throw lastError;
  };

  const readLead = async (leadId: number): Promise<AmoInactivityLead> => {
    requiredPositiveInteger(leadId, "lead id");
    const response = await makeRequest("GET", `/api/v4/leads/${leadId}`, undefined, true);
    return normalizeLead(response.data);
  };

  return {
    readLead,

    async listAllowedSourceStageLeads(listOptions = {}): Promise<AmoInactivityLead[]> {
      const maxPages = boundedInteger(
        listOptions.maxPages,
        AMO_INACTIVITY_LEAD_LIST_MAX_PAGES,
        AMO_INACTIVITY_LEAD_LIST_MAX_PAGES,
        "lead-list maxPages",
      );
      const pageSize = boundedInteger(
        listOptions.pageSize,
        AMO_INACTIVITY_LEAD_LIST_MAX_PAGE_SIZE,
        AMO_INACTIVITY_LEAD_LIST_MAX_PAGE_SIZE,
        "lead-list pageSize",
      );
      const leadsById = new Map<number, AmoInactivityLead>();

      for (const stage of ALLOWED_INACTIVITY_SOURCE_STAGES) {
        let exhausted = false;
        for (let page = 1; page <= maxPages; page += 1) {
          const params = new URLSearchParams({
            "filter[statuses][0][pipeline_id]": String(stage.pipelineId),
            "filter[statuses][0][status_id]": String(stage.statusId),
            limit: String(pageSize),
            page: String(page),
          });
          const response = await makeRequest("GET", `/api/v4/leads?${params.toString()}`, undefined, true);
          if (response.status === 204) {
            exhausted = true;
            break;
          }
          const rawLeads = (response.data as { _embedded?: { leads?: unknown } } | null)?._embedded?.leads;
          if (!Array.isArray(rawLeads)) throw new Error("amoCRM lead list response is malformed");

          for (const rawLead of rawLeads) {
            const normalized = normalizeLead(rawLead);
            if (
              !isAllowedInactivitySourceStage(normalized.pipelineId, normalized.statusId)
              || normalized.pipelineId !== stage.pipelineId
              || normalized.statusId !== stage.statusId
            ) {
              throw new Error("amoCRM lead list contains a lead outside the allowed inactivity source stages");
            }
            const previous = leadsById.get(normalized.id);
            if (
              previous
              && (previous.pipelineId !== normalized.pipelineId
                || previous.statusId !== normalized.statusId
                || previous.createdAt.getTime() !== normalized.createdAt.getTime())
            ) {
              throw new Error(`amoCRM lead list has conflicting records for lead ${normalized.id}`);
            }
            leadsById.set(normalized.id, normalized);
          }

          if (rawLeads.length < pageSize) {
            exhausted = true;
            break;
          }
        }
        if (!exhausted) throw new Error("amoCRM lead list reached its maximum page limit");
      }

      return [...leadsById.values()];
    },

    async readLeadHistory(leadId, historyOptions = {}): Promise<AmoInactivityHistoryEvent[]> {
      requiredPositiveInteger(leadId, "lead id");
      const maxPages = boundedInteger(historyOptions.maxPages, AMO_INACTIVITY_HISTORY_MAX_PAGES, AMO_INACTIVITY_HISTORY_MAX_PAGES, "maxPages");
      const pageSize = boundedInteger(historyOptions.pageSize, AMO_INACTIVITY_HISTORY_MAX_PAGE_SIZE, AMO_INACTIVITY_HISTORY_MAX_PAGE_SIZE, "pageSize");
      const events: AmoInactivityHistoryEvent[] = [];

      for (let page = 1; page <= maxPages; page += 1) {
        const params = new URLSearchParams({
          "filter[entity]": "lead",
          "filter[entity_id][]": String(leadId),
          limit: String(pageSize),
          page: String(page),
        });
        const response = await makeRequest("GET", `/api/v4/events?${params.toString()}`, undefined, true);
        const rawEvents = (response.data as { _embedded?: { events?: unknown } } | null)?._embedded?.events;
        if (!Array.isArray(rawEvents)) break;

        for (const raw of rawEvents) {
          const event = raw as { id?: unknown; entity_type?: unknown; entity_id?: unknown; created_at?: unknown; type?: unknown };
          events.push({
            id: String(event.id ?? ""),
            entityType: typeof event.entity_type === "string" ? event.entity_type : null,
            entityId: Number.isInteger(Number(event.entity_id)) ? Number(event.entity_id) : null,
            createdAt: unixSecondsToDate(event.created_at, "event.created_at"),
            type: Number.isInteger(Number(event.type)) ? Number(event.type) : null,
            raw,
          });
        }

        if (rawEvents.length < pageSize) break;
      }

      return events;
    },

    async moveLeadToTarget(leadId, target, hooks): Promise<AmoInactivityMoveOutcome> {
      const isMoveMutationCurrent = typeof hooks === "function" ? hooks : hooks?.isMoveMutationCurrent;
      const beforeFinalPatch = typeof hooks === "function" ? undefined : hooks?.beforeFinalPatch;
      const beforePatchSend = typeof hooks === "function" ? undefined : hooks?.beforePatchSend;
      const isAllowedSourceStage = (lead: AmoInactivityLead): boolean => (
        target.sourcePipelineIds.includes(lead.pipelineId)
        && isAllowedInactivitySourceStage(lead.pipelineId, lead.statusId)
      );
      const current = await readLead(leadId);
      if (!isAllowedSourceStage(current)) {
        return { kind: "not_moved", reason: "not_in_source", lead: current };
      }
      if (isMoveMutationCurrent && !await isMoveMutationCurrent()) {
        return { kind: "not_moved", reason: "fence_cancelled", lead: current };
      }

      const patch: { id: number; pipeline_id: number; status_id: number; responsible_user_id?: number } = {
        id: current.id,
        pipeline_id: target.targetPipelineId,
        status_id: target.targetStatusId,
        ...(current.responsibleUserId === null ? {} : { responsible_user_id: current.responsibleUserId }),
      };
      const refreshSourceStageBeforePatch = async (): Promise<boolean> => {
        if (isMoveMutationCurrent && !await isMoveMutationCurrent()) return false;
        let latest: AmoInactivityLead;
        try {
          latest = await readLead(current.id);
        } catch {
          throw new AmoInactivityPrePatchReadFailedError();
        }
        if (!isAllowedSourceStage(latest)) throw new AmoInactivityPrePatchScopeChangedError(latest);
        if (beforeFinalPatch && await beforeFinalPatch() === "daily_capacity_unavailable") {
          throw new AmoInactivityPrePatchDailyCapacityUnavailableError();
        }
        if (isMoveMutationCurrent && !await isMoveMutationCurrent()) return false;
        if (beforePatchSend && await beforePatchSend() === "daily_capacity_unavailable") {
          throw new AmoInactivityPrePatchDailyCapacityUnavailableError();
        }
        if (latest.responsibleUserId === null) delete patch.responsible_user_id;
        else patch.responsible_user_id = latest.responsibleUserId;
        return true;
      };

      try {
        await makeRequest("PATCH", `/api/v4/leads/${current.id}`, patch, false, refreshSourceStageBeforePatch);
      } catch (error) {
        if (error instanceof AmoInactivityPrePatchFenceCancelledError) {
          return { kind: "not_moved", reason: "fence_cancelled", lead: current };
        }
        if (error instanceof AmoInactivityPrePatchDailyCapacityUnavailableError) {
          return { kind: "not_moved", reason: "daily_capacity_unavailable", lead: current };
        }
        if (error instanceof AmoInactivityPrePatchScopeChangedError) {
          return { kind: "not_moved", reason: "not_in_source", lead: error.lead };
        }
        if (error instanceof AmoInactivityPrePatchReadFailedError) {
          return { kind: "not_moved", reason: "patch_rejected", lead: current };
        }
        if (!isAmbiguousMutationError(error)) {
          return { kind: "not_moved", reason: "patch_rejected", lead: current };
        }
        let readback: AmoInactivityLead | null = null;
        try {
          readback = await readLead(current.id);
        } catch {
          // The mutation outcome remains unknown when the follow-up read fails too.
        }
        return { kind: "uncertain", error: toSafeError(error), readback };
      }

      try {
        const readback = await readLead(current.id);
        if (readback.pipelineId === target.targetPipelineId && readback.statusId === target.targetStatusId) {
          return { kind: "confirmed", lead: readback };
        }
        if (target.sourcePipelineIds.includes(readback.pipelineId)) {
          return { kind: "not_moved", reason: "readback_not_target", lead: readback };
        }
        return {
          kind: "uncertain",
          error: { kind: "network", status: null, code: "AMO_READBACK_UNEXPECTED_STATE", message: "amoCRM PATCH read-back reached an unexpected state" },
          readback,
        };
      } catch (error) {
        return { kind: "uncertain", error: toSafeError(error), readback: null };
      }
    },
  };
}
