import type { CallStageFieldFillRequest, CallStageFieldFillValue } from "./aiAnalysis";
import type { AmoCallStageCustomField } from "./callStageAmoClient";
import type { UZUMRequiredField } from "./callStagePolicy";
import { matchFieldOption, type FieldOption } from "./amoOptionMatching";

/**
 * Decides what to write into the amoCRM fields that block a stage move.
 *
 * Pure on purpose: what lands in the CRM — and, crucially, which values are the
 * model's guess rather than something the customer said — is asserted in tests
 * without touching amoCRM.
 */

export const AUTOFILL_VALUE_MAX_LENGTH = 200;

/** amoCRM types that accept a plain text value. */
const TEXT_FIELD_TYPES = new Set(["text", "textarea", "url", "numeric", "price", "monetary"]);
/** amoCRM types whose value must be one of the field's options. */
const SELECT_FIELD_TYPES = new Set(["select", "radiobutton", "multiselect"]);

export type AutofillFieldKind = "text" | "select";

export function autofillKindForType(type: string): AutofillFieldKind | null {
  const normalized = type.trim().toLowerCase();
  if (TEXT_FIELD_TYPES.has(normalized)) return "text";
  if (SELECT_FIELD_TYPES.has(normalized)) return "select";
  return null;
}

/**
 * Strict comparison for the fixed-value fence only. Synonym matching is
 * deliberately not used there: a duplicate check must hit the exact option.
 */
function normalizedOption(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("uz-Latn");
}

export interface AutofillPlanEntry {
  fieldId: number;
  fieldName: string;
  kind: AutofillFieldKind;
  /** The value to store, already matched to an existing option where possible. */
  value: string;
  /** Existing option ID, or null when the option still has to be created. */
  enumId: number | null;
  /** True when a new amoCRM option must be created before writing. */
  needsNewOption: boolean;
  /** False when the value is the model's assumption, not something that was said. */
  grounded: boolean;
  /** Set when an existing option was reused under a looser rule than equality. */
  matchedBy?: "qualifier" | "typo";
  /** The model's own wording, kept when it differs from the reused option. */
  modelValue?: string;
}

export type AutofillPlan =
  | { kind: "ready"; entries: AutofillPlanEntry[] }
  | { kind: "incomplete"; entries: AutofillPlanEntry[]; unfillable: UnfillableField[] };

export interface UnfillableField {
  fieldId: number;
  fieldName: string;
  reason:
  | "unknown_field"
  | "unsupported_type"
  | "no_model_value"
  | "required_value_option_missing"
  | "ambiguous_option";
  /** Options that fit equally well when the reason is an ambiguous match. */
  candidates?: string[];
}

/**
 * Builds the list of fields to hand to the model, including the current options
 * of every select field so it can reuse one instead of inventing a duplicate.
 */
export function buildFieldFillRequests(
  missingFields: readonly UZUMRequiredField[],
  fieldsById: ReadonlyMap<number, AmoCallStageCustomField>,
): CallStageFieldFillRequest[] {
  const requests: CallStageFieldFillRequest[] = [];
  for (const missing of missingFields) {
    // A field with a fixed business value is never asked of the model.
    if (missing.requiredValue) continue;
    const meta = fieldsById.get(missing.id);
    if (!meta) continue;
    const kind = autofillKindForType(meta.type);
    if (kind === null) continue;
    requests.push({
      id: missing.id,
      name: missing.name,
      kind,
      ...(kind === "select" ? { options: meta.enums.map((option) => option.value) } : {}),
    });
  }
  return requests;
}

function planRequiredValueField(
  missing: UZUMRequiredField,
  meta: AmoCallStageCustomField,
  kind: AutofillFieldKind,
): AutofillPlanEntry | UnfillableField {
  const requiredValue = missing.requiredValue!;
  if (kind === "text") {
    return {
      fieldId: missing.id,
      fieldName: missing.name,
      kind,
      value: requiredValue,
      enumId: null,
      needsNewOption: false,
      grounded: true,
    };
  }

  const option = meta.enums.find((item) => normalizedOption(item.value) === normalizedOption(requiredValue));
  // A business fence such as "Sdelkani dubl bormi = Yoq" must match an option
  // that already exists; inventing one would fabricate the very check it gates.
  if (!option) {
    return { fieldId: missing.id, fieldName: missing.name, reason: "required_value_option_missing" };
  }
  return {
    fieldId: missing.id,
    fieldName: missing.name,
    kind,
    value: option.value,
    enumId: option.id,
    needsNewOption: false,
    grounded: true,
  };
}

/**
 * Plans one write per blocking field. The plan is `ready` only when every
 * blocking field can be filled — a partially filled lead would still be
 * rejected by amoCRM and would leave invented values behind for nothing.
 */
export function planFieldAutofill(input: {
  missingFields: readonly UZUMRequiredField[];
  fieldsById: ReadonlyMap<number, AmoCallStageCustomField>;
  modelValues: readonly CallStageFieldFillValue[];
}): AutofillPlan {
  const entries: AutofillPlanEntry[] = [];
  const unfillable: UnfillableField[] = [];
  const modelValueById = new Map(input.modelValues.map((value) => [value.id, value]));

  for (const missing of input.missingFields) {
    const meta = input.fieldsById.get(missing.id);
    if (!meta) {
      unfillable.push({ fieldId: missing.id, fieldName: missing.name, reason: "unknown_field" });
      continue;
    }
    const kind = autofillKindForType(meta.type);
    if (kind === null) {
      unfillable.push({ fieldId: missing.id, fieldName: missing.name, reason: "unsupported_type" });
      continue;
    }

    if (missing.requiredValue) {
      const planned = planRequiredValueField(missing, meta, kind);
      if ("reason" in planned) unfillable.push(planned);
      else entries.push(planned);
      continue;
    }

    const modelValue = modelValueById.get(missing.id);
    const value = modelValue?.value.replace(/\s+/g, " ").trim().slice(0, AUTOFILL_VALUE_MAX_LENGTH) ?? "";
    if (!value) {
      unfillable.push({ fieldId: missing.id, fieldName: missing.name, reason: "no_model_value" });
      continue;
    }

    if (kind === "text") {
      entries.push({
        fieldId: missing.id,
        fieldName: missing.name,
        kind,
        value,
        enumId: null,
        needsNewOption: false,
        grounded: modelValue?.grounded ?? false,
      });
      continue;
    }

    const match = matchFieldOption(value, meta.enums as readonly FieldOption[]);
    // Several existing options fit equally well — for example the city and the
    // region of the same name. Guessing would write the wrong one, so a human
    // decides instead.
    if (match.kind === "ambiguous") {
      unfillable.push({
        fieldId: missing.id,
        fieldName: missing.name,
        reason: "ambiguous_option",
        candidates: match.options.map((option) => option.value),
      });
      continue;
    }

    const reused = match.kind === "exact" || match.kind === "synonym" ? match.option : null;
    entries.push({
      fieldId: missing.id,
      fieldName: missing.name,
      kind,
      // Reusing an option keeps its exact amoCRM spelling, not the model's.
      value: reused?.value ?? value,
      enumId: reused?.id ?? null,
      needsNewOption: reused === null,
      grounded: modelValue?.grounded ?? false,
      ...(match.kind === "synonym" ? { matchedBy: match.rule, modelValue: value } : {}),
    });
  }

  return unfillable.length === 0
    ? { kind: "ready", entries }
    : { kind: "incomplete", entries, unfillable };
}
