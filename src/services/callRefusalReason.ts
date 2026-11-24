import type {
  AmoCallStageLead,
  AmoLeadCustomFieldMeta,
  CallStageAmoClient,
  CallStageFieldWriteValue,
} from "./callStageAmoClient";
import { autofillKindForType } from "./callStageFieldAutofill";

/**
 * Predicted close reason for a deal that is likely to be lost.
 *
 * The call analysis says whether the conversation points to a refusal and, if
 * so, which reason from the amoCRM close-reason list fits. The reason is written
 * only into lead field 1046167: no note, no stage move. Closed deals are never
 * touched, because there the field holds the manager's actual reason.
 */

export const REFUSAL_REASON_FIELD_ID = 1046167;

/** amoCRM's terminal statuses: won and lost. */
const CLOSED_STATUS_IDS = new Set([142, 143]);

/** Field metadata changes rarely; one read per window keeps the call path cheap. */
export const REFUSAL_REASON_FIELD_CACHE_MS = 10 * 60 * 1_000;

export interface RefusalReasonOption {
  /** The option's exact amoCRM spelling. */
  reason: string;
  /**
   * What the reason means, for the model. Null for reasons a single
   * conversation cannot show: they describe the lead's history, not what the
   * client said, so the model is not offered them.
   */
  hint: string | null;
}

export const CALL_REFUSAL_REASON_OPTIONS: readonly RefusalReasonOption[] = Object.freeze([
  { reason: "Yosh filtri bo'yicha o'tmadi", hint: "клиент не подходит по возрасту" },
  { reason: "Uydigilari ruxsat bermadi", hint: "родные или супруг не разрешают учиться или платить" },
  { reason: "Boshqasini tanladi", hint: "выбрал другую школу, курс или вариант обучения" },
  { reason: "Qiziqishi yo'qoldi", hint: "интерес к обучению пропал" },
  { reason: "Bunga mos keladigan kurs yo'q", hint: "нужного клиенту направления у нас нет" },
  { reason: "Xizmatlarimiz to'g'ri kelmadi", hint: "формат, график или условия обучения клиенту не подходят" },
  { reason: "Дубликат / тест", hint: null },
  { reason: "Qimmat", hint: "дорого, нет денег на оплату" },
  { reason: "Bemaqsad", hint: "у клиента нет цели, просто интересуется" },
  { reason: "Keyinroq o'qimoqchi", hint: "хочет учиться, но позже" },
  { reason: "Konsultatsiyadan keyin 3 martta NDZ", hint: null },
  { reason: "Noto'g'ri raqam", hint: "человек не оставлял заявку или это не тот человек" },
  { reason: "Bog'lanib bo'lmadi", hint: null },
  { reason: "Bo'lib to'lashda rad etildi", hint: "клиенту отказали в рассрочке" },
  { reason: "Boshqa sabab", hint: "отказ вероятен, но ни одна причина выше не подходит" },
  { reason: "Filtr boyicha otmadi", hint: "не проходит по другим условиям отбора, кроме возраста" },
].map((option) => Object.freeze(option)));

/** The reasons the model may choose from a call transcript. */
export const CALL_REFUSAL_REASONS_FROM_CALL: readonly string[] = Object.freeze(
  CALL_REFUSAL_REASON_OPTIONS.filter((option) => option.hint !== null).map((option) => option.reason),
);

/**
 * Comparison key: case, spacing and quote marks ignored. The analysis prompt
 * forbids quote marks inside JSON text, so "Qiziqishi yoqoldi" must still find
 * "Qiziqishi yo'qoldi".
 */
export function normalizeRefusalReason(value: string): string {
  return value
    .replace(/['"`‘’ʻʼ]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!]+$/, "")
    .trim()
    .toLocaleLowerCase("uz-Latn");
}

/** The reason as the prompt shows it: without quote marks, per the JSON rules. */
export function promptRefusalReason(reason: string): string {
  return reason.replace(/['‘’ʻʼ]/g, "");
}

export type RefusalPrediction =
  | { kind: "none" }
  | { kind: "unmatched"; raw: string }
  | { kind: "reason"; reason: string };

/** Maps the model's answer onto one of the offered reasons, never onto a guess. */
export function readRefusalPrediction(analysis: { refusalLikely: boolean; refusalReason: string }): RefusalPrediction {
  if (!analysis.refusalLikely) return { kind: "none" };
  const raw = analysis.refusalReason.trim();
  const key = normalizeRefusalReason(raw);
  const reason = key ? CALL_REFUSAL_REASONS_FROM_CALL.find((item) => normalizeRefusalReason(item) === key) : undefined;
  return reason ? { kind: "reason", reason } : { kind: "unmatched", raw: raw.slice(0, 100) };
}

export type RefusalReasonSkipReason =
  | "lead_closed"
  | "unsupported_field_type"
  | "option_missing"
  | "already_set";

export type RefusalReasonWritePlan =
  | { kind: "write"; value: CallStageFieldWriteValue }
  | { kind: "skip"; reason: RefusalReasonSkipReason };

export function planRefusalReasonWrite(input: {
  reason: string;
  field: AmoLeadCustomFieldMeta;
  lead: AmoCallStageLead;
}): RefusalReasonWritePlan {
  if (CLOSED_STATUS_IDS.has(input.lead.statusId)) return { kind: "skip", reason: "lead_closed" };
  const kind = autofillKindForType(input.field.type);
  if (kind === null) return { kind: "skip", reason: "unsupported_field_type" };

  const key = normalizeRefusalReason(input.reason);
  let value: CallStageFieldWriteValue;
  if (kind === "select") {
    // Options are never created here: the list belongs to the business.
    const option = input.field.enums.find((item) => normalizeRefusalReason(item.value) === key);
    if (!option) return { kind: "skip", reason: "option_missing" };
    value = { fieldId: input.field.id, enumId: option.id, value: option.value };
  } else {
    value = { fieldId: input.field.id, enumId: null, value: input.reason };
  }

  const current = input.lead.fieldValues.get(input.field.id) ?? [];
  if (current.some((stored) => normalizeRefusalReason(stored) === key)) {
    return { kind: "skip", reason: "already_set" };
  }
  return { kind: "write", value };
}

export type RefusalReasonWriteResult =
  | { kind: "no_refusal" }
  | { kind: "unmatched"; raw: string }
  | { kind: "not_latest_call" }
  | { kind: "skipped"; reason: RefusalReasonSkipReason }
  | { kind: "written"; value: string }
  | { kind: "not_written"; reason: "patch_rejected" | "readback_missing_values" }
  | { kind: "uncertain" };

export interface RefusalReasonWriterDependencies {
  amo: Pick<CallStageAmoClient, "readLead" | "getLeadCustomField" | "writeLeadFields">;
  now?: () => number;
}

export interface RefusalReasonWriteInput {
  dealId: number;
  refusalLikely: boolean;
  refusalReason: string;
  /** An older call re-processed later must not replace a newer prediction. */
  isLatestCall(): Promise<boolean>;
}

export function createRefusalReasonWriter(dependencies: RefusalReasonWriterDependencies) {
  const now = dependencies.now ?? Date.now;
  let cached: { field: AmoLeadCustomFieldMeta; expiresAt: number } | null = null;

  const readField = async (): Promise<AmoLeadCustomFieldMeta> => {
    if (cached && cached.expiresAt > now()) return cached.field;
    const field = await dependencies.amo.getLeadCustomField(REFUSAL_REASON_FIELD_ID);
    cached = { field, expiresAt: now() + REFUSAL_REASON_FIELD_CACHE_MS };
    return field;
  };

  return async function writeRefusalReason(input: RefusalReasonWriteInput): Promise<RefusalReasonWriteResult> {
    const prediction = readRefusalPrediction(input);
    if (prediction.kind === "none") return { kind: "no_refusal" };
    if (prediction.kind === "unmatched") return prediction;
    if (!await input.isLatestCall()) return { kind: "not_latest_call" };

    const field = await readField();
    const lead = await dependencies.amo.readLead(input.dealId);
    const plan = planRefusalReasonWrite({ reason: prediction.reason, field, lead });
    if (plan.kind === "skip") return { kind: "skipped", reason: plan.reason };

    const outcome = await dependencies.amo.writeLeadFields({ leadId: input.dealId, values: [plan.value] });
    if (outcome.kind === "confirmed") return { kind: "written", value: plan.value.value };
    if (outcome.kind === "not_written") return { kind: "not_written", reason: outcome.reason };
    return { kind: "uncertain" };
  };
}

export type RefusalReasonWriter = ReturnType<typeof createRefusalReasonWriter>;

/** On by default; CALL_REFUSAL_REASON_ENABLED=false (0/no/off) turns the field write off. */
export function isRefusalReasonWriteEnabled(environment: Record<string, string | undefined> = process.env): boolean {
  const raw = environment.CALL_REFUSAL_REASON_ENABLED?.trim().toLowerCase();
  return !raw || !["false", "0", "no", "off"].includes(raw);
}

let runtimeWriter: RefusalReasonWriter | null = null;

/** The process-wide writer, or null when the write is off or amoCRM is not configured. */
export async function getRefusalReasonWriter(
  environment: Record<string, string | undefined> = process.env,
): Promise<RefusalReasonWriter | null> {
  if (!isRefusalReasonWriteEnabled(environment)) return null;
  if (runtimeWriter) return runtimeWriter;
  const baseUrl = environment.AMOCRM_BASE_URL?.trim();
  const accessToken = environment.AMOCRM_ACCESS_TOKEN?.trim();
  if (!baseUrl || !accessToken) return null;
  const { createCallStageAmoClient } = await import("./callStageAmoClient");
  runtimeWriter = createRefusalReasonWriter({ amo: createCallStageAmoClient({ baseUrl, accessToken }) });
  return runtimeWriter;
}
