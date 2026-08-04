export const UZUM_PIPELINE_ID = 6909890;

export const UZUM_STAGE_IDS = {
  unprocessed: 58160710,
  newLead: 58160714,
  takenInWork: 58160718,
  qualified: 58160726,
  ozhop: 58160902,
  formalization: 87346998,
  partiallyPaid: 58810350,
  successful: 142,
  closedLost: 143,
} as const;

export type UZUMStageTargetKey =
  | "takenInWork"
  | "qualified"
  | "ozhop"
  | "formalization"
  | "partiallyPaid"
  | "successful"
  | "closedLost";

/** A live amoCRM transition requirement, read from custom_fields.required_statuses. */
export interface UZUMRequiredField {
  id: number;
  name: string;
  /** A business-specific condition beyond amoCRM's non-empty requirement. */
  requiredValue?: string;
}

export interface UZUMStageTarget {
  key: UZUMStageTargetKey;
  statusId: number;
  name: string;
  order: number;
}

export const UZUM_STAGE_TARGETS: Readonly<Record<UZUMStageTargetKey, UZUMStageTarget>> = {
  takenInWork: { key: "takenInWork", statusId: UZUM_STAGE_IDS.takenInWork, name: "взято в работу", order: 1 },
  qualified: { key: "qualified", statusId: UZUM_STAGE_IDS.qualified, name: "квалифицирован", order: 2 },
  ozhop: { key: "ozhop", statusId: UZUM_STAGE_IDS.ozhop, name: "ОЖОП", order: 3 },
  formalization: { key: "formalization", statusId: UZUM_STAGE_IDS.formalization, name: "Оформление", order: 4 },
  partiallyPaid: { key: "partiallyPaid", statusId: UZUM_STAGE_IDS.partiallyPaid, name: "Часть оплачена", order: 5 },
  successful: { key: "successful", statusId: UZUM_STAGE_IDS.successful, name: "Успешно реализовано", order: 6 },
  closedLost: { key: "closedLost", statusId: UZUM_STAGE_IDS.closedLost, name: "Закрыто и не реализовано", order: 6 },
};

const UZUM_STAGE_ORDERS: Readonly<Record<number, number>> = {
  [UZUM_STAGE_IDS.newLead]: 0,
  [UZUM_STAGE_IDS.takenInWork]: 1,
  [UZUM_STAGE_IDS.qualified]: 2,
  [UZUM_STAGE_IDS.ozhop]: 3,
  [UZUM_STAGE_IDS.formalization]: 4,
  [UZUM_STAGE_IDS.partiallyPaid]: 5,
  [UZUM_STAGE_IDS.successful]: 6,
  [UZUM_STAGE_IDS.closedLost]: 6,
};

export type UZUMFieldValues = ReadonlyMap<number, unknown>;

export type EvaluateUzumStageRouteResult =
  | { kind: "out_of_scope" }
  | { kind: "not_forward"; target: Pick<UZUMStageTarget, "key" | "statusId" | "name"> }
  | {
    kind: "missing_fields";
    target: Pick<UZUMStageTarget, "key" | "statusId" | "name">;
    missingFields: UZUMRequiredField[];
  }
  | {
    kind: "allowed";
    target: Pick<UZUMStageTarget, "key" | "statusId" | "name">;
    checkedFields: string[];
  };

function publicTarget(target: UZUMStageTarget): Pick<UZUMStageTarget, "key" | "statusId" | "name"> {
  return { key: target.key, statusId: target.statusId, name: target.name };
}

function normalizedStrings(value: unknown): string[] {
  if (typeof value === "string") return [value.trim()].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(normalizedStrings);
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  return [];
}

function hasRequiredValue(value: unknown, expected: string | undefined): boolean {
  const values = normalizedStrings(value);
  if (!expected) return values.length > 0;
  const normalizedExpected = expected.trim().toLocaleLowerCase("uz-Latn");
  return values.some((item) => item.toLocaleLowerCase("uz-Latn") === normalizedExpected);
}

function uniqueRequirements(requiredFields: readonly UZUMRequiredField[]): UZUMRequiredField[] {
  const seen = new Set<number>();
  return requiredFields.map((field) => ({ ...field })).filter((field) => {
    if (!Number.isInteger(field.id) || field.id <= 0 || !field.name.trim() || seen.has(field.id)) return false;
    seen.add(field.id);
    return true;
  });
}

/**
 * Applies the approved UZUM workflow policy to a freshly read amoCRM lead.
 * The requirements must be fetched from amoCRM's current required_statuses
 * configuration for the target stage; this policy holds no parallel list.
 */
export function evaluateUzumStageRoute(input: {
  pipelineId: number;
  currentStatusId: number;
  target: UZUMStageTargetKey;
  fieldValues: UZUMFieldValues;
  requiredFields: readonly UZUMRequiredField[];
}): EvaluateUzumStageRouteResult {
  if (input.pipelineId !== UZUM_PIPELINE_ID) return { kind: "out_of_scope" };
  const currentOrder = UZUM_STAGE_ORDERS[input.currentStatusId];
  if (currentOrder === undefined) return { kind: "out_of_scope" };

  const target = UZUM_STAGE_TARGETS[input.target];
  // The agreed payment flow is full payment directly → OZHOP; only a remaining
  // balance paid from the partial-payment stage may become successful realization.
  if (
    target.order <= currentOrder
    || (input.target === "successful" && input.currentStatusId !== UZUM_STAGE_IDS.partiallyPaid)
  ) {
    return { kind: "not_forward", target: publicTarget(target) };
  }

  const requirements = uniqueRequirements(input.requiredFields);
  const missingFields = requirements.filter((field) => (
    !hasRequiredValue(input.fieldValues.get(field.id), field.requiredValue)
  ));
  if (missingFields.length > 0) {
    return {
      kind: "missing_fields",
      target: publicTarget(target),
      missingFields: missingFields.map(({ id, name }) => ({ id, name })),
    };
  }

  return {
    kind: "allowed",
    target: publicTarget(target),
    checkedFields: requirements.map((field) => field.name),
  };
}
