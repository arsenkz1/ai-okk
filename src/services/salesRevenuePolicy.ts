/**
 * Which amoCRM stages count as revenue, and where each one's amount comes from.
 *
 * The stage list is not hardcoded: pipelines get added and renamed in the CRM,
 * so /sync_stages discovers them and stores them in RevenueStage. Only the
 * system "won" status is known statically, because amoCRM uses the same ID for
 * it in every pipeline.
 *
 * Amount rule: the amoCRM lead budget (`price`) values both kinds. When
 * AMOCRM_PAYMENT_AMOUNT_FIELD_ID names a field holding the amount actually
 * received, a part-paid deal uses that instead, since the budget overstates it.
 */

/** System success status; identical across every amoCRM pipeline. */
export const WON_STATUS_ID = 142;
/** System lost status, never revenue. */
export const LOST_STATUS_ID = 143;

export type RevenueKind = "won" | "partial";

export interface RevenueStageRef {
  pipelineId: number;
  statusId: number;
  kind: RevenueKind;
}

/** Names that identify a part-payment stage, compared case- and space-insensitively. */
export const PARTIAL_PAYMENT_STAGE_NAMES: readonly string[] = Object.freeze([
  "часть оплачена",
  "частично оплачено",
  "частичная оплата",
  "qisman to'langan",
  "qisman tolangan",
]);

function normalizeStageName(name: string): string {
  return name.replace(/[ʻʼ‘’`']/g, "'").replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU");
}

/**
 * Classifies one amoCRM pipeline status. `type` is amoCRM's own marker — 1 is
 * the won status — so a renamed or translated success stage is still detected.
 */
export function classifyRevenueStage(input: {
  statusId: number;
  statusName: string;
  statusType?: number | null;
}): RevenueKind | null {
  if (input.statusId === WON_STATUS_ID || input.statusType === 1) return "won";
  if (input.statusId === LOST_STATUS_ID || input.statusType === 2) return null;
  const normalized = normalizeStageName(input.statusName);
  return PARTIAL_PAYMENT_STAGE_NAMES.includes(normalized) ? "partial" : null;
}

/**
 * Returns the revenue kind a status transition represents, using the stages
 * discovered from amoCRM. The system won status is recognised even before a
 * sync has ever run.
 */
export function revenueKindForStage(
  pipelineId: number | null | undefined,
  statusId: number | null | undefined,
  knownStages: readonly RevenueStageRef[] = [],
): RevenueKind | null {
  if (typeof statusId !== "number") return null;
  if (statusId === WON_STATUS_ID) return "won";
  if (statusId === LOST_STATUS_ID || typeof pipelineId !== "number") return null;
  return knownStages.find(
    (stage) => stage.pipelineId === pipelineId && stage.statusId === statusId,
  )?.kind ?? null;
}

export interface AmoCustomFieldValue {
  field_id?: unknown;
  values?: unknown;
}

export interface AmoRevenueLead {
  price?: unknown;
  custom_fields_values?: unknown;
}

/** Parses a money value that amoCRM may return as a number or a string. */
export function parseAmount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  if (typeof value !== "string") return null;
  const digits = value.replace(/[\s ]/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const parsed = Math.round(Number(digits));
  return Number.isFinite(parsed) ? parsed : null;
}

export function readCustomFieldAmount(lead: AmoRevenueLead, fieldId: number | null): number | null {
  if (fieldId === null || !Array.isArray(lead.custom_fields_values)) return null;
  for (const raw of lead.custom_fields_values) {
    const field = raw as AmoCustomFieldValue;
    if (Number(field?.field_id) !== fieldId || !Array.isArray(field.values)) continue;
    for (const entry of field.values) {
      const amount = parseAmount((entry as { value?: unknown })?.value);
      if (amount !== null) return amount;
    }
  }
  return null;
}

/**
 * Reads the configured payment-amount field ID. An unset or malformed value
 * means "not configured" rather than an error: revenue recording must keep
 * working for won deals even when the partial-payment field is missing.
 */
export function resolvePaymentAmountFieldId(
  environment: Record<string, string | undefined> = process.env,
): number | null {
  const raw = environment.AMOCRM_PAYMENT_AMOUNT_FIELD_ID?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolves the amount to record. The lead budget values both kinds; a part-paid
 * deal prefers the dedicated payment field when one is configured, because the
 * budget is the full contract rather than the money actually received.
 */
export function resolveRevenueAmount(
  kind: RevenueKind,
  lead: AmoRevenueLead,
  paymentAmountFieldId: number | null,
): number | null {
  if (kind === "partial") {
    const received = readCustomFieldAmount(lead, paymentAmountFieldId);
    if (received !== null) return received;
  }
  return parseAmount(lead.price);
}
