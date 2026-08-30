import type { CallStageFieldFillValue, CallStageRoutingProposal } from "./aiAnalysis";
import type {
  AmoCallStageCustomField,
  AmoCallStageLead,
  CallStageAmoClient,
  MoveCallStageLeadOutcome,
} from "./callStageAmoClient";
import type { CallStageAutomationLedger } from "./callStageAutomationLedger";
import { isCallStageAutomationEligible, isCallStageHistoryFenceEligible, type CallStageAutomationStore } from "./callStageAutomationStore";
import {
  evaluateUzumStageRoute,
  UZUM_PIPELINE_ID,
  UZUM_STAGE_IDS,
  type UZUMRequiredField,
  type UZUMStageTargetKey,
} from "./callStagePolicy";
import type { CallStageAdminAlert, CallStageAutofilledField } from "../bot/callStageNotifications";
import {
  buildFieldFillRequests,
  planFieldAutofill,
  type AutofillPlanEntry,
} from "./callStageFieldAutofill";
import type { AmoFieldOptionRegistry } from "./amoFieldOptionRegistry";

export type CallStageAutomationExecutionMode = "live" | "dry_run";

export interface CallStageAutomationInput {
  callId: number;
  dealId: number;
  callCreatedAt: Date;
  callEndedAt: Date;
  transcript: string;
}

export interface CallStageAutomationNotifier {
  notify(alert: CallStageAdminAlert): Promise<void>;
}

export const CALL_STAGE_HISTORY_LOOKBACK_MS = 30 * 60 * 1_000;

export interface CallStageAutomationDependencies {
  enabled: boolean;
  testing: boolean;
  executionMode: CallStageAutomationExecutionMode;
  now?: () => Date;
  isLatestCompletedCall(input: { callId: number; dealId: number; callEndedAt: Date }): Promise<boolean>;
  store: Pick<
    CallStageAutomationStore,
    | "getActivationBoundary"
    | "getHistoryFenceActivationBoundary"
    | "reserveHistoryFenceTestMove"
    | "releaseTestMoveBeforePatch"
    | "markTestMoveUncertain"
  >;
  ledger: CallStageAutomationLedger;
  amo: Pick<
    CallStageAmoClient,
    | "readLead"
    | "getLeadCustomFields"
    | "hasRecentStageMovement"
    | "moveLeadToTarget"
    | "addStageReasonNote"
    | "writeLeadFields"
    | "addFieldOption"
  >;
  analyze(transcript: string): Promise<CallStageRoutingProposal | null>;
  /**
   * Fills the required fields that block a move. Only consulted when
   * `autofillMissingFields` is on; a null result blocks the move as before.
   */
  analyzeFieldValues?(
    transcript: string,
    fields: readonly import("./aiAnalysis").CallStageFieldFillRequest[],
  ): Promise<CallStageFieldFillValue[] | null>;
  /** Writes AI-derived values into blocking amoCRM fields, then moves the deal. */
  autofillMissingFields: boolean;
  /**
   * Stores each field's original option list before it is modified and logs
   * every option added. Required whenever autofill is on: an option list must
   * never be changed without a recoverable record of what it was.
   */
  optionRegistry?: Pick<AmoFieldOptionRegistry, "captureSnapshot" | "recordAddition">;
  notifier?: CallStageAutomationNotifier;
}

export type CallStageAutomationResult =
  | { kind: "disabled" }
  | { kind: "not_configured" }
  | { kind: "not_latest_call" }
  | { kind: "lead_unavailable" }
  | { kind: "out_of_scope" }
  | { kind: "ineligible"; reason: "lead_created_before_activation" | "call_created_before_activation" | "call_created_before_history_fence_activation" }
  | { kind: "existing"; actionId: string }
  | { kind: "no_action"; actionId: string }
  | { kind: "review"; actionId: string }
  | { kind: "missing_fields"; actionId: string }
  | { kind: "autofill_failed"; actionId: string }
  | { kind: "test_limit_reached"; actionId: string }
  | { kind: "test_deal_already_claimed"; actionId: string }
  | { kind: "dry_run"; actionId: string }
  | { kind: "recent_stage_movement"; actionId: string }
  | { kind: "skipped"; actionId: string }
  | { kind: "confirmed"; actionId: string; noteId: number | null }
  | { kind: "uncertain"; actionId: string; phase: "lead" | "move" | "note" | "persistence" };

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${name} must be a valid Date`);
}

function isUzumLead(lead: AmoCallStageLead): boolean {
  return lead.pipelineId === UZUM_PIPELINE_ID && lead.statusId !== UZUM_STAGE_IDS.unprocessed;
}

const DUPLICATE_FIELD_NAME = "sdelkani dubl bormi";

function normalizedFieldName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("uz-Latn");
}

/**
 * Derives the exact current amoCRM required_statuses rules for the target. The
 * sole business condition not represented by `required_statuses` is the agreed
 * "Sdelkani dubl bormi = Yoq" fence for moving to taken-in-work.
 */
export function requiredFieldsForUzumTarget(input: {
  target: UZUMStageTargetKey;
  fields: readonly AmoCallStageCustomField[];
}): UZUMRequiredField[] {
  const targetStatusId = UZUM_STAGE_IDS[input.target];
  const requirements = input.fields
    .filter((field) => field.requiredStatuses.some((status) => (
      status.pipelineId === UZUM_PIPELINE_ID && status.statusId === targetStatusId
    )))
    .map(({ id, name }) => ({ id, name }));

  if (input.target !== "takenInWork") return requirements;
  const duplicateField = input.fields.find((field) => normalizedFieldName(field.name) === DUPLICATE_FIELD_NAME);
  if (!duplicateField) {
    throw new Error("amoCRM duplicate field Sdelkani dubl bormi is unavailable");
  }
  const duplicateRequirement: UZUMRequiredField = {
    id: duplicateField.id,
    name: duplicateField.name,
    requiredValue: "Yoq",
  };
  const withoutDuplicate = requirements.filter((field) => field.id !== duplicateField.id);
  return [...withoutDuplicate, duplicateRequirement];
}

function reasonForMoveOutcome(outcome: Exclude<MoveCallStageLeadOutcome, { kind: "confirmed" }>): string {
  return outcome.kind === "uncertain" ? outcome.error.message : `amoCRM move was not applied: ${outcome.reason}`;
}

async function bestEffortAlert(notifier: CallStageAutomationNotifier | undefined, alert: CallStageAdminAlert): Promise<void> {
  if (!notifier) return;
  try {
    await notifier.notify(alert);
  } catch (error) {
    console.error("[CallStageAutomation] admin alert failed", {
      actionId: alert.actionId,
      reason: error instanceof Error ? error.message : "unknown error",
    });
  }
}

function missingFieldAlert(action: { id: string; dealId: number; evidence: string | null }, targetName: string, missingFields: UZUMRequiredField[]): CallStageAdminAlert {
  return {
    kind: "missing_fields",
    actionId: action.id,
    dealId: action.dealId,
    targetName,
    evidence: action.evidence ?? "Клиентский итог звонка определён, но проверка полей заблокировала перевод.",
    missingFields,
  };
}

function recentStageMovementAlert(action: { id: string; dealId: number }, targetName: string): CallStageAdminAlert {
  return {
    kind: "recent_stage_movement",
    actionId: action.id,
    dealId: action.dealId,
    targetName,
  };
}

function movedAlert(action: { id: string; dealId: number }, targetName: string): CallStageAdminAlert {
  return {
    kind: "moved",
    actionId: action.id,
    dealId: action.dealId,
    targetName,
  };
}

export function buildCallStageReasonNote(input: {
  id: string;
  targetName: string;
  evidence: string;
  checkedFields: string[];
}): string {
  if (!input.id.trim() || !input.targetName.trim() || !input.evidence.trim()) {
    throw new Error("cannot create a stage note for incomplete stage action");
  }
  return [
    "Автоперевод UZUM по итогам звонка",
    `Этап: ${input.targetName}`,
    `Основание: ${input.evidence.replace(/\s+/g, " ").trim().slice(0, 700)}`,
    `Проверены поля: ${input.checkedFields.length ? input.checkedFields.join("; ") : "обязательных полей для этапа нет"}`,
    `ID обработки: ${input.id}`,
  ].join("\n");
}

async function markTestMoveUncertain(
  dependencies: CallStageAutomationDependencies,
  actionId: string,
  now: Date,
): Promise<void> {
  if (!dependencies.testing) return;
  try {
    await dependencies.store.markTestMoveUncertain(actionId, now);
  } catch (error) {
    console.error("[CallStageAutomation] could not mark test slot uncertain", {
      actionId,
      reason: error instanceof Error ? error.message : "unknown error",
    });
  }
}

async function releaseTestMoveBeforePatch(
  dependencies: CallStageAutomationDependencies,
  actionId: string,
): Promise<void> {
  if (!dependencies.testing) return;
  try {
    await dependencies.store.releaseTestMoveBeforePatch(actionId);
  } catch (error) {
    console.error("[CallStageAutomation] could not release pre-PATCH test slot", {
      actionId,
      reason: error instanceof Error ? error.message : "unknown error",
    });
  }
}


/**
 * Fills the fields blocking the move and reports exactly what was written.
 * Returns null when nothing could safely be filled, which leaves the existing
 * "blocked, notify an admin" behaviour in place.
 */
async function autofillBlockingFields(
  input: { transcript: string },
  dependencies: CallStageAutomationDependencies,
  context: {
    actionId: string;
    dealId: number;
    missingFields: UZUMRequiredField[];
    requiredFields: readonly AmoCallStageCustomField[];
  },
): Promise<{ kind: "filled"; filled: CallStageAutofilledField[] } | { kind: "failed"; reason: string }> {
  const fieldsById = new Map(context.requiredFields.map((field) => [field.id, field]));
  const requests = buildFieldFillRequests(context.missingFields, fieldsById);

  let modelValues: CallStageFieldFillValue[] = [];
  if (requests.length > 0) {
    if (!dependencies.analyzeFieldValues) return { kind: "failed", reason: "модель заполнения полей не настроена" };
    try {
      modelValues = await dependencies.analyzeFieldValues(input.transcript, requests) ?? [];
    } catch (error) {
      console.error("[CallStageAutomation] field-fill analysis failed", {
        dealId: context.dealId,
        reason: error instanceof Error ? error.message : "unknown error",
      });
      return { kind: "failed", reason: "ИИ не вернул значения для полей" };
    }
  }

  const plan = planFieldAutofill({ missingFields: context.missingFields, fieldsById, modelValues });
  if (plan.kind === "incomplete") {
    // Writing a partial set would leave invented values behind and still not
    // unblock the move, so nothing is written at all.
    const names = plan.unfillable.map((field) => (
      field.candidates?.length
        ? `${field.fieldName} (${field.reason}: ${field.candidates.join(" / ")})`
        : `${field.fieldName} (${field.reason})`
    )).join("; ");
    return { kind: "failed", reason: `не удалось подобрать значение: ${names}` };
  }

  const resolved: Array<AutofillPlanEntry & { enumId: number | null; createdOption: boolean }> = [];
  for (const entry of plan.entries) {
    if (!entry.needsNewOption) {
      resolved.push({ ...entry, createdOption: false });
      continue;
    }
    if (!dependencies.optionRegistry) {
      return { kind: "failed", reason: "нет журнала вариантов списка — изменение поля запрещено" };
    }

    const meta = fieldsById.get(entry.fieldId);
    if (!meta) return { kind: "failed", reason: `метаданные поля ${entry.fieldName} недоступны` };

    // The original list is stored before the field is touched. Without a
    // durable record there is nothing to restore from, so the option is not
    // created at all.
    try {
      await dependencies.optionRegistry.captureSnapshot({
        fieldId: meta.id,
        fieldName: meta.name,
        fieldType: meta.type,
        enums: meta.enums.map((option) => ({ id: option.id, value: option.value, sort: option.sort })),
      });
    } catch (error) {
      console.error("[CallStageAutomation] option snapshot failed", {
        fieldId: entry.fieldId,
        reason: error instanceof Error ? error.message : "unknown error",
      });
      return { kind: "failed", reason: `не удалось сохранить исходный список вариантов поля ${entry.fieldName}` };
    }

    const created = await dependencies.amo.addFieldOption({ fieldId: entry.fieldId, value: entry.value });
    if (created.kind !== "confirmed") {
      return {
        kind: "failed",
        reason: `не удалось создать вариант списка для поля ${entry.fieldName}`,
      };
    }

    try {
      await dependencies.optionRegistry.recordAddition({
        fieldId: entry.fieldId,
        fieldName: entry.fieldName,
        enumId: created.enumId,
        value: created.value,
        actionId: context.actionId,
        dealId: context.dealId,
      });
    } catch (error) {
      // The option now exists in amoCRM. Losing its log entry only costs the
      // one-command rollback, so the move continues and admins are told.
      console.error("[CallStageAutomation] option addition log failed", {
        fieldId: entry.fieldId,
        enumId: created.enumId,
        reason: error instanceof Error ? error.message : "unknown error",
      });
    }
    resolved.push({ ...entry, value: created.value, enumId: created.enumId, createdOption: true });
  }

  const write = await dependencies.amo.writeLeadFields({
    leadId: context.dealId,
    values: resolved.map((entry) => ({ fieldId: entry.fieldId, enumId: entry.enumId, value: entry.value })),
  });
  if (write.kind !== "confirmed") {
    return {
      kind: "failed",
      reason: write.kind === "uncertain"
        ? `запись полей в amoCRM завершилась неопределённо (${write.error.message})`
        : `amoCRM не сохранил значения полей (${write.reason})`,
    };
  }

  return {
    kind: "filled",
    filled: resolved.map((entry) => ({
      fieldName: entry.fieldName,
      value: entry.value,
      createdOption: entry.createdOption,
      grounded: entry.grounded,
      ...(entry.matchedBy ? { matchedBy: entry.matchedBy, modelValue: entry.modelValue } : {}),
    })),
  };
}

export async function runCallStageAutomation(
  input: CallStageAutomationInput,
  dependencies: CallStageAutomationDependencies,
): Promise<CallStageAutomationResult> {
  if (!dependencies.enabled) return { kind: "disabled" };
  assertValidDate(input.callCreatedAt, "callCreatedAt");
  assertValidDate(input.callEndedAt, "callEndedAt");
  const now = dependencies.now?.() ?? new Date();
  assertValidDate(now, "now");

  if (!await dependencies.isLatestCompletedCall({ callId: input.callId, dealId: input.dealId, callEndedAt: input.callEndedAt })) {
    return { kind: "not_latest_call" };
  }

  let activationBoundary: Date | null;
  let historyFenceActivationBoundary: Date | null;
  try {
    activationBoundary = await dependencies.store.getActivationBoundary();
    historyFenceActivationBoundary = await dependencies.store.getHistoryFenceActivationBoundary();
  } catch (error) {
    console.error("[CallStageAutomation] activation boundary is unavailable", {
      reason: error instanceof Error ? error.message : "unknown error",
    });
    return { kind: "not_configured" };
  }
  if (!activationBoundary || !historyFenceActivationBoundary) return { kind: "not_configured" };

  let initialLead: AmoCallStageLead;
  try {
    initialLead = await dependencies.amo.readLead(input.dealId);
  } catch (error) {
    console.error("[CallStageAutomation] initial amoCRM lead read failed", {
      dealId: input.dealId,
      reason: error instanceof Error ? error.message : "unknown error",
    });
    return { kind: "lead_unavailable" };
  }
  if (!isUzumLead(initialLead)) return { kind: "out_of_scope" };
  if (initialLead.createdAt.getTime() <= activationBoundary.getTime()) {
    return { kind: "ineligible", reason: "lead_created_before_activation" };
  }
  if (input.callCreatedAt.getTime() <= activationBoundary.getTime()) {
    return { kind: "ineligible", reason: "call_created_before_activation" };
  }
  if (!isCallStageAutomationEligible({
    activationBoundary,
    leadCreatedAt: initialLead.createdAt,
    callCreatedAt: input.callCreatedAt,
  })) {
    return { kind: "ineligible", reason: "lead_created_before_activation" };
  }
  if (!isCallStageHistoryFenceEligible({
    historyFenceActivationBoundary,
    callCreatedAt: input.callCreatedAt,
  })) {
    return { kind: "ineligible", reason: "call_created_before_history_fence_activation" };
  }

  const analysisClaim = await dependencies.ledger.claimAnalysis({
    callId: input.callId,
    dealId: input.dealId,
    testMode: dependencies.testing,
    now,
  });
  if (analysisClaim.kind === "existing") return { kind: "existing", actionId: analysisClaim.action.id };

  let proposal: CallStageRoutingProposal | null;
  try {
    proposal = await dependencies.analyze(input.transcript);
  } catch (error) {
    console.error("[CallStageAutomation] Gemini stage decision failed", {
      actionId: analysisClaim.action.id,
      reason: error instanceof Error ? error.message : "unknown error",
    });
    proposal = null;
  }
  // A failed or malformed model decision is deliberately treated as review,
  // never retried into a later mutation from the same source call.
  proposal ??= {
    decision: "review",
    target: null,
    evidence: "Не удалось безопасно определить итог последнего звонка; автоматический перевод не выполнен.",
  };
  const finalized = await dependencies.ledger.finalizeAnalysis({
    actionId: analysisClaim.action.id,
    leaseToken: analysisClaim.leaseToken,
    proposal,
    now,
  });
  if (!finalized) return { kind: "existing", actionId: analysisClaim.action.id };

  if (finalized.decision === "none") return { kind: "no_action", actionId: finalized.id };
  // Ambiguous or malformed customer outcomes are intentionally silent: no move,
  // no capacity reservation, and no admin alert. Only a clear blocked target
  // needs human attention because it specifies which amoCRM fields are missing.
  if (finalized.decision === "review") return { kind: "review", actionId: finalized.id };
  if (!finalized.target || !finalized.evidence) {
    return { kind: "uncertain", actionId: finalized.id, phase: "persistence" };
  }
  if (dependencies.executionMode === "dry_run") return { kind: "dry_run", actionId: finalized.id };

  const moving = await dependencies.ledger.claimMove({ actionId: finalized.id, now });
  if (!moving) return { kind: "existing", actionId: finalized.id };
  if (!moving.mutationLeaseToken) return { kind: "uncertain", actionId: moving.id, phase: "persistence" };

  let freshLead: AmoCallStageLead;
  try {
    freshLead = await dependencies.amo.readLead(input.dealId);
  } catch {
    await dependencies.ledger.markMoveUncertain({
      actionId: moving.id,
      mutationLeaseToken: moving.mutationLeaseToken,
      reason: "amoCRM lead could not be re-read before routing",
      now,
    });
    return { kind: "uncertain", actionId: moving.id, phase: "lead" };
  }

  let requiredFields: UZUMRequiredField[];
  let allCustomFields: readonly AmoCallStageCustomField[] = [];
  try {
    allCustomFields = await dependencies.amo.getLeadCustomFields();
    requiredFields = requiredFieldsForUzumTarget({
      target: finalized.target,
      fields: allCustomFields,
    });
  } catch (error) {
    await dependencies.ledger.markMoveUncertain({
      actionId: moving.id,
      mutationLeaseToken: moving.mutationLeaseToken,
      reason: error instanceof Error ? error.message : "amoCRM required-field rules are unavailable",
      now,
    });
    return { kind: "uncertain", actionId: moving.id, phase: "lead" };
  }

  let route = evaluateUzumStageRoute({
    pipelineId: freshLead.pipelineId,
    currentStatusId: freshLead.statusId,
    target: finalized.target,
    fieldValues: freshLead.fieldValues,
    requiredFields,
  });

  // Fields written by autofill, reported to admins once the move is decided.
  let autofilled: CallStageAutofilledField[] | null = null;
  if (route.kind === "missing_fields" && dependencies.autofillMissingFields) {
    const targetName = route.target.name;
    const outcome = await autofillBlockingFields(
      { transcript: input.transcript },
      dependencies,
      {
        actionId: moving.id,
        dealId: moving.dealId,
        missingFields: route.missingFields,
        requiredFields: allCustomFields,
      },
    );

    if (outcome.kind === "failed") {
      await dependencies.ledger.markBlockedMissingFields({
        actionId: moving.id,
        mutationLeaseToken: moving.mutationLeaseToken,
        missingFields: route.missingFields,
        now,
      });
      await bestEffortAlert(dependencies.notifier, {
        kind: "autofill_failed",
        actionId: moving.id,
        dealId: moving.dealId,
        targetName,
        evidence: finalized.evidence,
        missingFields: route.missingFields,
        reason: outcome.reason,
      });
      return { kind: "autofill_failed", actionId: moving.id };
    }

    autofilled = outcome.filled;
    // The lead must be re-read: the route is only allowed to proceed on values
    // amoCRM actually stored, never on what was sent.
    try {
      freshLead = await dependencies.amo.readLead(input.dealId);
    } catch {
      await dependencies.ledger.markMoveUncertain({
        actionId: moving.id,
        mutationLeaseToken: moving.mutationLeaseToken,
        reason: "amoCRM lead could not be re-read after field autofill",
        now,
      });
      await bestEffortAlert(dependencies.notifier, {
        kind: "autofilled",
        actionId: moving.id,
        dealId: moving.dealId,
        targetName,
        evidence: finalized.evidence,
        filled: autofilled,
        moveFailedReason: "сделку не удалось перечитать после записи полей",
      });
      return { kind: "uncertain", actionId: moving.id, phase: "lead" };
    }

    route = evaluateUzumStageRoute({
      pipelineId: freshLead.pipelineId,
      currentStatusId: freshLead.statusId,
      target: finalized.target,
      fieldValues: freshLead.fieldValues,
      requiredFields,
    });
  }

  if (route.kind === "missing_fields") {
    await dependencies.ledger.markBlockedMissingFields({
      actionId: moving.id,
      mutationLeaseToken: moving.mutationLeaseToken,
      missingFields: route.missingFields,
      now,
    });
    if (autofilled) {
      await bestEffortAlert(dependencies.notifier, {
        kind: "autofilled",
        actionId: moving.id,
        dealId: moving.dealId,
        targetName: route.target.name,
        evidence: finalized.evidence,
        filled: autofilled,
        moveFailedReason: "после автозаполнения amoCRM всё ещё считает поля незаполненными",
      });
    } else {
      await bestEffortAlert(dependencies.notifier, missingFieldAlert(moving, route.target.name, route.missingFields));
    }
    return { kind: "missing_fields", actionId: moving.id };
  }
  if (route.kind !== "allowed") {
    await dependencies.ledger.markMoveSkipped({
      actionId: moving.id,
      mutationLeaseToken: moving.mutationLeaseToken,
      reason: route.kind === "not_forward" ? "target stage is not forward from the current amoCRM stage" : "lead is outside UZUM routing scope",
      now,
    });
    return { kind: "skipped", actionId: moving.id };
  }

  const historySince = new Date(now.getTime() - CALL_STAGE_HISTORY_LOOKBACK_MS);
  let hasRecentStageMovement: boolean;
  try {
    hasRecentStageMovement = await dependencies.amo.hasRecentStageMovement({ leadId: moving.dealId, since: historySince });
  } catch (error) {
    const skipped = await dependencies.ledger.markMoveSkipped({
      actionId: moving.id,
      mutationLeaseToken: moving.mutationLeaseToken,
      reason: "amoCRM stage history could not be read safely",
      now,
    });
    if (!skipped) return { kind: "existing", actionId: moving.id };
    console.error("[CallStageAutomation] amoCRM stage-history check failed", {
      actionId: moving.id,
      reason: error instanceof Error ? error.message : "unknown error",
    });
    return { kind: "skipped", actionId: moving.id };
  }
  if (hasRecentStageMovement) {
    const skipped = await dependencies.ledger.markMoveSkipped({
      actionId: moving.id,
      mutationLeaseToken: moving.mutationLeaseToken,
      reason: "amoCRM stage changed during the prior thirty minutes",
      now,
    });
    if (!skipped) return { kind: "existing", actionId: moving.id };
    await bestEffortAlert(dependencies.notifier, recentStageMovementAlert(moving, route.target.name));
    return { kind: "recent_stage_movement", actionId: moving.id };
  }

  let testSlotReserved = false;
  if (dependencies.testing) {
    const reservation = await dependencies.store.reserveHistoryFenceTestMove({ dealId: moving.dealId, actionId: moving.id, now });
    if (reservation.kind === "limit_reached") {
      await dependencies.ledger.markMoveSkipped({
        actionId: moving.id,
        mutationLeaseToken: moving.mutationLeaseToken,
        reason: "five-deal call-stage history-fence test limit reached",
        now,
      });
      return { kind: "test_limit_reached", actionId: moving.id };
    }
    if (reservation.kind === "already_claimed") {
      await dependencies.ledger.markMoveSkipped({
        actionId: moving.id,
        mutationLeaseToken: moving.mutationLeaseToken,
        reason: "deal was already claimed by the call-stage test",
        now,
      });
      return { kind: "test_deal_already_claimed", actionId: moving.id };
    }
    testSlotReserved = true;
  }

  const source = { pipelineId: freshLead.pipelineId, statusId: freshLead.statusId };
  const target = { pipelineId: UZUM_PIPELINE_ID, statusId: route.target.statusId };
  let historyFenceCancelledMove = false;
  let historyFenceCheckFailed = false;
  let outcome: MoveCallStageLeadOutcome;
  try {
    outcome = await dependencies.amo.moveLeadToTarget({
      leadId: moving.dealId,
      source,
      target,
      isMoveMutationCurrent: async () => {
        const leaseIsCurrent = await dependencies.ledger.isMoveCurrent({
          actionId: moving.id,
          mutationLeaseToken: moving.mutationLeaseToken!,
        });
        if (!leaseIsCurrent) return false;
        // Run inside the amo client's pre-dispatch fence too, including after
        // its PATCH rate-slot wait: a newly completed call or a recent stage
        // movement always wins over the automatic route.
        const latestCallIsCurrent = await dependencies.isLatestCompletedCall({
          callId: input.callId,
          dealId: input.dealId,
          callEndedAt: input.callEndedAt,
        });
        if (!latestCallIsCurrent) return false;
        try {
          const hasMovement = await dependencies.amo.hasRecentStageMovement({ leadId: moving.dealId, since: historySince });
          if (hasMovement) historyFenceCancelledMove = true;
          return !hasMovement;
        } catch (error) {
          // This callback runs before the amoCRM PATCH dispatch. A failed
          // history read must block the move, but it is a proven no-PATCH
          // cancellation and must not burn one of the five new slots.
          historyFenceCheckFailed = true;
          console.error("[CallStageAutomation] final amoCRM stage-history check failed", {
            actionId: moving.id,
            reason: error instanceof Error ? error.message : "unknown error",
          });
          return false;
        }
      },
      isLeadEligibleForTarget: async (lead) => evaluateUzumStageRoute({
        pipelineId: lead.pipelineId,
        currentStatusId: lead.statusId,
        target: finalized.target!,
        fieldValues: lead.fieldValues,
        requiredFields: requiredFieldsForUzumTarget({
          target: finalized.target!,
          fields: await dependencies.amo.getLeadCustomFields(),
        }),
      }).kind === "allowed",
    });
  } catch (error) {
    await dependencies.ledger.markMoveUncertain({
      actionId: moving.id,
      mutationLeaseToken: moving.mutationLeaseToken,
      reason: error instanceof Error ? error.message : "amoCRM move execution failed",
      now,
    });
    if (testSlotReserved) await markTestMoveUncertain(dependencies, moving.id, now);
    return { kind: "uncertain", actionId: moving.id, phase: "move" };
  }

  if (outcome.kind !== "confirmed") {
    if ((historyFenceCancelledMove || historyFenceCheckFailed) && outcome.kind === "not_moved" && outcome.reason === "fence_cancelled") {
      const skipped = await dependencies.ledger.markMoveSkipped({
        actionId: moving.id,
        mutationLeaseToken: moving.mutationLeaseToken,
        reason: historyFenceCancelledMove
          ? "amoCRM stage changed during the prior thirty minutes"
          : "amoCRM stage history could not be read safely before PATCH",
        now,
      });
      if (!skipped) {
        if (testSlotReserved) await markTestMoveUncertain(dependencies, moving.id, now);
        return { kind: "uncertain", actionId: moving.id, phase: "persistence" };
      }
      if (testSlotReserved) await releaseTestMoveBeforePatch(dependencies, moving.id);
      if (historyFenceCancelledMove) {
        await bestEffortAlert(dependencies.notifier, recentStageMovementAlert(moving, route.target.name));
        return { kind: "recent_stage_movement", actionId: moving.id };
      }
      return { kind: "skipped", actionId: moving.id };
    }
    if (outcome.kind === "not_moved" && outcome.reason === "preconditions_changed") {
      let refreshedRequiredFields: UZUMRequiredField[];
      try {
        refreshedRequiredFields = requiredFieldsForUzumTarget({
          target: finalized.target,
          fields: await dependencies.amo.getLeadCustomFields(),
        });
      } catch (error) {
        await dependencies.ledger.markMoveUncertain({
          actionId: moving.id,
          mutationLeaseToken: moving.mutationLeaseToken,
          reason: error instanceof Error ? error.message : "amoCRM required-field rules are unavailable",
          now,
        });
        if (testSlotReserved) await markTestMoveUncertain(dependencies, moving.id, now);
        return { kind: "uncertain", actionId: moving.id, phase: "lead" };
      }
      const refreshedRoute = evaluateUzumStageRoute({
        pipelineId: outcome.lead.pipelineId,
        currentStatusId: outcome.lead.statusId,
        target: finalized.target,
        fieldValues: outcome.lead.fieldValues,
        requiredFields: refreshedRequiredFields,
      });
      if (refreshedRoute.kind === "missing_fields") {
        await dependencies.ledger.markBlockedMissingFields({
          actionId: moving.id,
          mutationLeaseToken: moving.mutationLeaseToken,
          missingFields: refreshedRoute.missingFields,
          now,
        });
        if (testSlotReserved) await releaseTestMoveBeforePatch(dependencies, moving.id);
        await bestEffortAlert(dependencies.notifier, missingFieldAlert(moving, refreshedRoute.target.name, refreshedRoute.missingFields));
        return { kind: "missing_fields", actionId: moving.id };
      }
    }

    if (outcome.kind === "not_moved" && outcome.reason !== "readback_not_target") {
      await dependencies.ledger.markMoveSkipped({
        actionId: moving.id,
        mutationLeaseToken: moving.mutationLeaseToken,
        reason: reasonForMoveOutcome(outcome),
        now,
      });
      if (testSlotReserved) await releaseTestMoveBeforePatch(dependencies, moving.id);
      return { kind: "skipped", actionId: moving.id };
    }

    await dependencies.ledger.markMoveUncertain({
      actionId: moving.id,
      mutationLeaseToken: moving.mutationLeaseToken,
      reason: reasonForMoveOutcome(outcome),
      now,
    });
    if (testSlotReserved) await markTestMoveUncertain(dependencies, moving.id, now);
    return { kind: "uncertain", actionId: moving.id, phase: "move" };
  }

  const note = await dependencies.amo.addStageReasonNote({
    leadId: moving.dealId,
    text: buildCallStageReasonNote({
      id: moving.id,
      targetName: route.target.name,
      evidence: finalized.evidence,
      checkedFields: route.checkedFields,
    }),
  });
  if (note.kind !== "confirmed") {
    await dependencies.ledger.markMoveUncertain({
      actionId: moving.id,
      mutationLeaseToken: moving.mutationLeaseToken,
      reason: note.kind === "uncertain" ? note.error.message : note.reason,
      now,
    });
    if (testSlotReserved) await markTestMoveUncertain(dependencies, moving.id, now);
    return { kind: "uncertain", actionId: moving.id, phase: "note" };
  }

  let confirmed;
  try {
    confirmed = await dependencies.ledger.markMoveConfirmed({
      actionId: moving.id,
      mutationLeaseToken: moving.mutationLeaseToken,
      checkedFields: route.checkedFields,
      noteId: note.noteId,
      now,
      confirmTestSlot: testSlotReserved,
    });
  } catch (error) {
    // The confirmed amoCRM PATCH is already read back. The atomic DB
    // transaction rolled back, so persist only an uncertain terminal state;
    // never emit a successful-move alert or silently retry the PATCH.
    await dependencies.ledger.markMoveUncertain({
      actionId: moving.id,
      mutationLeaseToken: moving.mutationLeaseToken,
      reason: error instanceof Error ? error.message : "atomic move confirmation failed",
      now,
    });
    if (testSlotReserved) await markTestMoveUncertain(dependencies, moving.id, now);
    return { kind: "uncertain", actionId: moving.id, phase: "persistence" };
  }
  if (!confirmed) {
    if (testSlotReserved) await markTestMoveUncertain(dependencies, moving.id, now);
    return { kind: "uncertain", actionId: moving.id, phase: "persistence" };
  }
  // An autofilled move always reports the values that were written, so a move
  // built on AI-supplied CRM data is never logged as a plain move.
  await bestEffortAlert(dependencies.notifier, autofilled
    ? {
      kind: "autofilled",
      actionId: moving.id,
      dealId: moving.dealId,
      targetName: route.target.name,
      evidence: finalized.evidence,
      filled: autofilled,
    }
    : movedAlert(moving, route.target.name));
  return { kind: "confirmed", actionId: moving.id, noteId: note.noteId };
}
