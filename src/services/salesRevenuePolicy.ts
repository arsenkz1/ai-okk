/**
 * Which amoCRM stages count as revenue, and where each one's amount comes from.
 *
 * Agreed rule: a won deal is valued by the amoCRM lead budget (`price`), while a
 * part-paid deal is valued by the custom field holding the amount actually
 * received — its ID comes from AMOCRM_PAYMENT_AMOUNT_FIELD_ID. Until that field
 * is configured, part-paid deals are still recorded, but with no amount, so a
 * count is reported and no invented money reaches a sum.
 */

/** System success status; identical across every amoCRM pipeline. */
export const WON_STATUS_ID = 142;

export interface PartialPaymentStage {
  pipelineId: number;
  statusId: number;
  /** Pipeline name, for review only. */
  name: string;
}

/**
 * "Часть оплачена" stages. Only UZUM's ID is known so far; add one row per
 * pipeline as the remaining IDs arrive.
 */
export const PARTIAL_PAYMENT_STAGES: readonly PartialPaymentStage[] = Object.freeze([
  { pipelineId: 6909890, statusId: 58810350, name: "UZUM" },
].map((stage) => Object.freeze(stage)));

export type RevenueKind = "won" | "partial";

const partialStageKeys = new Set(
  PARTIAL_PAYMENT_STAGES.map(({ pipelineId, statusId }) => `${pipelineId}:${statusId}`),
);

/**
 * Returns the revenue kind a status transition represents, or null when the
 * stage carries no revenue meaning.
 */
export function revenueKindForStage(
  pipelineId: number | null | undefined,
  statusId: number | null | undefined,
): RevenueKind | null {
  if (typeof statusId !== "number") return null;
  if (statusId === WON_STATUS_ID) return "won";
  if (typeof pipelineId !== "number") return null;
  return partialStageKeys.has(`${pipelineId}:${statusId}`) ? "partial" : null;
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
 * Resolves the amount to record. Won deals use the lead budget; part-paid deals
 * use the configured payment field and are recorded amount-less otherwise —
 * never silently falling back to the full budget, which would overstate revenue.
 */
export function resolveRevenueAmount(
  kind: RevenueKind,
  lead: AmoRevenueLead,
  paymentAmountFieldId: number | null,
): number | null {
  if (kind === "won") return parseAmount(lead.price);
  return readCustomFieldAmount(lead, paymentAmountFieldId);
}
