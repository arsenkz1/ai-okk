import axios from "axios";

export const AMO_CALL_TASK_REQUEST_TIMEOUT_MS = 10_000;
export const AMO_CALL_TASK_MAX_SAFE_READ_ATTEMPTS = 3;

export interface AmoCallTaskHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  timeout: number;
  data?: unknown;
}

export interface AmoCallTaskHttpResponse {
  status: number;
  data: unknown;
  headers?: Record<string, string | undefined>;
}

export interface AmoCallTaskHttpClient {
  request(request: AmoCallTaskHttpRequest): Promise<AmoCallTaskHttpResponse>;
}

export interface AmoCallTaskLead {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  responsibleUserId: number | null;
  name: string | null;
  closedAt: Date | null;
}

export interface AmoCallTask {
  id: number;
  entityId: number;
  entityType: "leads";
  responsibleUserId: number;
  text: string;
  completeTill: Date;
  taskTypeId: number;
}

export interface AmoCallTaskSafeError {
  kind: "http" | "network";
  status: number | null;
  code: string | null;
  message: string;
}

export type CreateVerifiedCallTaskOutcome =
  | { kind: "confirmed"; lead: AmoCallTaskLead; task: AmoCallTask }
  | { kind: "not_created"; reason: "lead_closed" | "missing_responsible_user" | "task_rejected"; lead: AmoCallTaskLead }
  | { kind: "uncertain"; error: AmoCallTaskSafeError; lead: AmoCallTaskLead | null };

export type AddCallTaskReasonNoteOutcome =
  | { kind: "confirmed"; noteId: number }
  | { kind: "not_created"; reason: "note_rejected" }
  | { kind: "uncertain"; error: AmoCallTaskSafeError };

export interface CreateVerifiedCallTaskInput {
  leadId: number;
  fallbackResponsibleUserId: number | null;
  taskText: string;
  dueAt: Date;
  requestId: string;
}

export interface AddCallTaskReasonNoteInput {
  leadId: number;
  text: string;
}

export interface CreateCallTaskAmoClientOptions {
  baseUrl: string;
  accessToken: string;
  taskTypeId?: number;
  http?: AmoCallTaskHttpClient;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface CallTaskAmoClient {
  readLead(leadId: number): Promise<AmoCallTaskLead>;
  createVerifiedTask(input: CreateVerifiedCallTaskInput): Promise<CreateVerifiedCallTaskOutcome>;
  addTaskReasonNote(input: AddCallTaskReasonNoteInput): Promise<AddCallTaskReasonNoteOutcome>;
}

interface RawAmoLead {
  id?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  responsible_user_id?: unknown;
  name?: unknown;
  closed_at?: unknown;
}

interface RawAmoTask {
  id?: unknown;
  request_id?: unknown;
  entity_id?: unknown;
  entity_type?: unknown;
  responsible_user_id?: unknown;
  text?: unknown;
  complete_till?: unknown;
  task_type_id?: unknown;
}

class AmoCallTaskHttpStatusError extends Error {
  readonly response: { status: number; headers: Record<string, string | undefined> | undefined };

  constructor(response: AmoCallTaskHttpResponse) {
    super(`amoCRM HTTP ${response.status}`);
    this.response = { status: response.status, headers: response.headers };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`amoCRM response has invalid ${field}`);
  }
  return numberValue;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return requiredPositiveInteger(value, field);
}

function unixSecondsToDate(value: unknown, field: string): Date {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`amoCRM response has invalid ${field}`);
  }
  const date = new Date(seconds * 1_000);
  if (Number.isNaN(date.getTime())) throw new Error(`amoCRM response has invalid ${field}`);
  return date;
}

function nullableUnixSecondsToDate(value: unknown, field: string): Date | null {
  if (value === null || value === undefined || value === 0 || value === "0") return null;
  return unixSecondsToDate(value, field);
}

function normalizeLead(raw: unknown): AmoCallTaskLead {
  const lead = raw as RawAmoLead | null;
  if (!lead || typeof lead !== "object") throw new Error("amoCRM lead response is malformed");
  return {
    id: requiredPositiveInteger(lead.id, "lead id"),
    createdAt: unixSecondsToDate(lead.created_at, "lead created_at"),
    updatedAt: unixSecondsToDate(lead.updated_at, "lead updated_at"),
    responsibleUserId: nullablePositiveInteger(lead.responsible_user_id, "lead responsible_user_id"),
    name: typeof lead.name === "string" ? lead.name : null,
    closedAt: nullableUnixSecondsToDate(lead.closed_at, "lead closed_at"),
  };
}

function normalizeTask(raw: unknown): AmoCallTask {
  const task = raw as RawAmoTask | null;
  if (!task || typeof task !== "object") throw new Error("amoCRM task response is malformed");
  const entityType = task.entity_type;
  if (entityType !== "leads") throw new Error("amoCRM task response has invalid entity_type");
  if (typeof task.text !== "string" || !task.text.trim()) {
    throw new Error("amoCRM task response has invalid text");
  }
  return {
    id: requiredPositiveInteger(task.id, "task id"),
    entityId: requiredPositiveInteger(task.entity_id, "task entity_id"),
    entityType,
    responsibleUserId: requiredPositiveInteger(task.responsible_user_id, "task responsible_user_id"),
    text: task.text,
    completeTill: unixSecondsToDate(task.complete_till, "task complete_till"),
    taskTypeId: requiredPositiveInteger(task.task_type_id, "task task_type_id"),
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

function toSafeError(error: unknown): AmoCallTaskSafeError {
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

function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function isRetryableReadError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === null || status === 429 || (status !== null && status >= 500);
}

function isAmbiguousMutationError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === null || status === 408 || status === 409 || status >= 500;
}

function retryAfterMs(headers: Record<string, string | undefined> | undefined, now: Date): number | null {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : Math.max(0, parsed - now.getTime());
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

function assertFutureDate(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${name} must be a valid Date`);
}

function parseCreatedTaskId(raw: unknown, requestId: string): number | null {
  const tasks = (raw as { _embedded?: { tasks?: unknown } } | null)?._embedded?.tasks;
  if (!Array.isArray(tasks)) return null;
  const matching = tasks.find((task) => (
    task !== null
    && typeof task === "object"
    && (task as { request_id?: unknown }).request_id === requestId
  ));
  return matching ? requiredPositiveInteger((matching as { id?: unknown }).id, "created task id") : null;
}

function parseCreatedNoteId(raw: unknown): number | null {
  const notes = (raw as { _embedded?: { notes?: unknown } } | null)?._embedded?.notes;
  if (!Array.isArray(notes) || notes.length !== 1) return null;
  const id = (notes[0] as { id?: unknown } | null)?.id;
  const numericId = Number(id);
  return Number.isInteger(numericId) && numericId > 0 ? numericId : null;
}

export function createCallTaskAmoClient(options: CreateCallTaskAmoClientOptions): CallTaskAmoClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const accessToken = options.accessToken.trim();
  if (!accessToken) throw new Error("AMOCRM access token is required");
  const taskTypeId = options.taskTypeId ?? 1;
  requiredPositiveInteger(taskTypeId, "task type id");
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const http: AmoCallTaskHttpClient = options.http ?? {
    async request(request: AmoCallTaskHttpRequest): Promise<AmoCallTaskHttpResponse> {
      const response = await axios.request({ ...request, validateStatus: () => true });
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

  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

  async function request(request: AmoCallTaskHttpRequest): Promise<AmoCallTaskHttpResponse> {
    const response = await http.request(request);
    if (!isSuccessfulStatus(response.status)) throw new AmoCallTaskHttpStatusError(response);
    return response;
  }

  async function safeRead<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= AMO_CALL_TASK_MAX_SAFE_READ_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableReadError(error) || attempt === AMO_CALL_TASK_MAX_SAFE_READ_ATTEMPTS) throw error;
        lastError = error;
        const backoff = retryAfterMs(errorHeaders(error), now()) ?? attempt * 500;
        await sleep(Math.min(backoff, 5_000));
      }
    }
    throw lastError;
  }

  async function readLead(leadId: number): Promise<AmoCallTaskLead> {
    requiredPositiveInteger(leadId, "leadId");
    return safeRead(async () => {
      const response = await request({
        method: "GET",
        url: `${baseUrl}/api/v4/leads/${leadId}`,
        headers,
        timeout: AMO_CALL_TASK_REQUEST_TIMEOUT_MS,
      });
      const lead = normalizeLead(response.data);
      if (lead.id !== leadId) throw new Error("amoCRM lead response does not match requested lead");
      return lead;
    });
  }

  async function readTask(taskId: number): Promise<AmoCallTask> {
    requiredPositiveInteger(taskId, "taskId");
    return safeRead(async () => {
      const response = await request({
        method: "GET",
        url: `${baseUrl}/api/v4/tasks/${taskId}`,
        headers,
        timeout: AMO_CALL_TASK_REQUEST_TIMEOUT_MS,
      });
      const task = normalizeTask(response.data);
      if (task.id !== taskId) throw new Error("amoCRM task response does not match created task");
      return task;
    });
  }

  type TaskReadBackResult =
    | { kind: "found"; task: AmoCallTask }
    | { kind: "no_match" }
    | { kind: "multiple_matches" };

  function matchesRequestedTask(
    task: AmoCallTask,
    input: CreateVerifiedCallTaskInput,
    responsibleUserId: number,
  ): boolean {
    return task.entityId === input.leadId
      && task.entityType === "leads"
      && task.responsibleUserId === responsibleUserId
      && task.taskTypeId === taskTypeId
      && task.text === input.taskText.trim()
      && Math.floor(task.completeTill.getTime() / 1_000) === Math.floor(input.dueAt.getTime() / 1_000);
  }

  /**
   * amoCRM's task-list filters are used as an authoritative, bounded read-back
   * after a timed-out/conflicted task POST. It deliberately never POSTs again.
   */
  async function findTaskAfterAmbiguousCreate(
    input: CreateVerifiedCallTaskInput,
    responsibleUserId: number,
  ): Promise<TaskReadBackResult> {
    const params = new URLSearchParams({
      "filter[entity_type]": "leads",
      "filter[entity_id]": String(input.leadId),
      "filter[responsible_user_id]": String(responsibleUserId),
      "filter[task_type]": String(taskTypeId),
      "filter[is_completed]": "0",
      limit: "250",
      "order[complete_till]": "asc",
    });
    const url = `${baseUrl}/api/v4/tasks?${params.toString()}`;

    for (let attempt = 1; attempt <= AMO_CALL_TASK_MAX_SAFE_READ_ATTEMPTS; attempt += 1) {
      try {
        const response = await request({
          method: "GET",
          url,
          headers,
          timeout: AMO_CALL_TASK_REQUEST_TIMEOUT_MS,
        });
        const rawTasks = (response.data as { _embedded?: { tasks?: unknown } } | null)?._embedded?.tasks;
        // A matching mutable payload is not proof that this POST succeeded: a
        // manager may already have created an identical task. Only amoCRM's
        // echoed deterministic request_id can correlate an ambiguous POST.
        const correlatedRawTasks = Array.isArray(rawTasks)
          ? rawTasks.filter((rawTask) => (
            rawTask !== null
            && typeof rawTask === "object"
            && (rawTask as RawAmoTask).request_id === input.requestId
          ))
          : [];
        const matches = correlatedRawTasks
          .map(normalizeTask)
          .filter((task) => matchesRequestedTask(task, input, responsibleUserId));
        if (matches.length === 1) return { kind: "found", task: matches[0] };
        if (matches.length > 1) return { kind: "multiple_matches" };
      } catch (error) {
        if (!isRetryableReadError(error) || attempt === AMO_CALL_TASK_MAX_SAFE_READ_ATTEMPTS) throw error;
      }
      if (attempt < AMO_CALL_TASK_MAX_SAFE_READ_ATTEMPTS) {
        await sleep(500);
      }
    }
    return { kind: "no_match" };
  }

  return {
    readLead,

    async createVerifiedTask(input: CreateVerifiedCallTaskInput): Promise<CreateVerifiedCallTaskOutcome> {
      requiredPositiveInteger(input.leadId, "leadId");
      if (input.fallbackResponsibleUserId !== null) {
        requiredPositiveInteger(input.fallbackResponsibleUserId, "fallbackResponsibleUserId");
      }
      assertFutureDate(input.dueAt, "dueAt");
      const taskText = input.taskText.trim();
      if (!taskText || taskText.length > 500) throw new Error("taskText must contain at most 500 characters");
      const requestId = input.requestId.trim();
      if (!requestId || requestId.length > 128) throw new Error("requestId must contain at most 128 characters");

      let lead: AmoCallTaskLead;
      try {
        lead = await readLead(input.leadId);
      } catch (error) {
        return { kind: "uncertain", error: toSafeError(error), lead: null };
      }
      if (lead.closedAt) return { kind: "not_created", reason: "lead_closed", lead };
      const responsibleUserId = lead.responsibleUserId ?? input.fallbackResponsibleUserId;
      if (responsibleUserId === null) return { kind: "not_created", reason: "missing_responsible_user", lead };

      let postResponse: AmoCallTaskHttpResponse;
      try {
        postResponse = await request({
          method: "POST",
          url: `${baseUrl}/api/v4/tasks`,
          headers,
          timeout: AMO_CALL_TASK_REQUEST_TIMEOUT_MS,
          data: [{
            entity_id: input.leadId,
            entity_type: "leads",
            responsible_user_id: responsibleUserId,
            task_type_id: taskTypeId,
            text: taskText,
            complete_till: Math.floor(input.dueAt.getTime() / 1_000),
            request_id: requestId,
          }],
        });
      } catch (error) {
        if (isAmbiguousMutationError(error)) {
          try {
            const readBack = await findTaskAfterAmbiguousCreate(input, responsibleUserId);
            if (readBack.kind === "found") return { kind: "confirmed", lead, task: readBack.task };
          } catch (readBackError) {
            return { kind: "uncertain", error: toSafeError(readBackError), lead };
          }
          return { kind: "uncertain", error: toSafeError(error), lead };
        }
        return { kind: "not_created", reason: "task_rejected", lead };
      }

      let taskId: number | null;
      try {
        taskId = parseCreatedTaskId(postResponse.data, requestId);
      } catch (error) {
        return { kind: "uncertain", error: toSafeError(error), lead };
      }
      if (taskId === null) {
        try {
          const readBack = await findTaskAfterAmbiguousCreate(input, responsibleUserId);
          if (readBack.kind === "found") return { kind: "confirmed", lead, task: readBack.task };
        } catch (error) {
          return { kind: "uncertain", error: toSafeError(error), lead };
        }
        return {
          kind: "uncertain",
          error: { kind: "http", status: postResponse.status, code: null, message: "amoCRM task create response is incomplete" },
          lead,
        };
      }

      try {
        const task = await readTask(taskId);
        const expectedCompleteTill = Math.floor(input.dueAt.getTime() / 1_000);
        if (
          task.entityId !== input.leadId
          || task.entityType !== "leads"
          || task.responsibleUserId !== responsibleUserId
          || task.text !== taskText
          || Math.floor(task.completeTill.getTime() / 1_000) !== expectedCompleteTill
          || task.taskTypeId !== taskTypeId
        ) {
          return {
            kind: "uncertain",
            error: { kind: "http", status: 200, code: null, message: "amoCRM task read-back does not match request" },
            lead,
          };
        }
        return { kind: "confirmed", lead, task };
      } catch (error) {
        return { kind: "uncertain", error: toSafeError(error), lead };
      }
    },

    async addTaskReasonNote(input: AddCallTaskReasonNoteInput): Promise<AddCallTaskReasonNoteOutcome> {
      requiredPositiveInteger(input.leadId, "leadId");
      const text = input.text.trim();
      if (!text || text.length > 4_000) throw new Error("note text must contain at most 4000 characters");
      try {
        const response = await request({
          method: "POST",
          url: `${baseUrl}/api/v4/leads/${input.leadId}/notes`,
          headers,
          timeout: AMO_CALL_TASK_REQUEST_TIMEOUT_MS,
          data: [{ note_type: "common", params: { text } }],
        });
        const noteId = parseCreatedNoteId(response.data);
        if (noteId === null) {
          return {
            kind: "uncertain",
            error: { kind: "http", status: response.status, code: null, message: "amoCRM note create response is incomplete" },
          };
        }
        return { kind: "confirmed", noteId };
      } catch (error) {
        if (isAmbiguousMutationError(error)) return { kind: "uncertain", error: toSafeError(error) };
        return { kind: "not_created", reason: "note_rejected" };
      }
    },
  };
}
