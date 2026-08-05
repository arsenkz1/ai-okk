import type { CallTaskActionProposal } from "./aiAnalysis";
import type { AddCallTaskReasonNoteOutcome, AmoCallTaskLead, CallTaskAmoClient, CreateVerifiedCallTaskOutcome } from "./callTaskAmoClient";
import type { CallTaskAutomationAction, CallTaskAutomationLedger } from "./callTaskAutomationLedger";
import { isCallTaskAutomationEligible, type CallTaskAutomationStore } from "./callTaskAutomationStore";

export type CallTaskAutomationExecutionMode = "live" | "dry_run";

export interface CallTaskAutomationInput {
  callId: number;
  dealId: number;
  callCreatedAt: Date;
  managerAmoUserId: number | null;
  transcript: string;
}

export interface CallTaskAutomationNotifier {
  notifyProposal(action: CallTaskAutomationAction): Promise<void>;
  notifyTestResult?(input: { action: CallTaskAutomationAction; result: CallTaskAutomationResult }): Promise<void>;
}

export interface CallTaskAutomationDependencies {
  enabled: boolean;
  testing: boolean;
  executionMode: CallTaskAutomationExecutionMode;
  now?: () => Date;
  store: Pick<CallTaskAutomationStore, "getActivationBoundary">;
  ledger: CallTaskAutomationLedger;
  amo: Pick<CallTaskAmoClient, "readLead" | "createVerifiedTask" | "addTaskReasonNote">;
  analyze(transcript: string, context: { now: Date }): Promise<CallTaskActionProposal | null>;
  notifier?: CallTaskAutomationNotifier;
}

export type CallTaskAutomationResult =
  | { kind: "disabled" }
  | { kind: "not_configured" }
  | { kind: "lead_unavailable" }
  | { kind: "ineligible"; reason: "lead_created_before_activation" | "call_created_before_activation" }
  | { kind: "existing"; actionId: string }
  | { kind: "analysis_unavailable"; actionId: string }
  | { kind: "analysis_claim_lost"; actionId: string }
  | { kind: "no_action"; actionId: string }
  | { kind: "review_pending"; actionId: string }
  | { kind: "dry_run"; actionId: string }
  | { kind: "confirmed"; actionId: string; taskId: number; noteId: number | null }
  | { kind: "task_not_created"; actionId: string }
  | { kind: "uncertain"; actionId: string; phase: "task" | "task_persistence" | "note" };

function asValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${field} must be a valid Date`);
}

function formatAlmaty(value: Date): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.day}.${fields.month}.${fields.year} ${fields.hour}:${fields.minute}`;
}

export function buildCallTaskReasonNote(action: Pick<
  CallTaskAutomationAction,
  "id" | "taskText" | "selectedDueAt" | "evidence"
>): string {
  if (!action.taskText || !action.selectedDueAt || !action.evidence) {
    throw new Error("cannot create an amoCRM note for incomplete call-task action");
  }
  return [
    "AI-задача по итогам звонка",
    `Действие: ${action.taskText}`,
    `Срок (Алматы): ${formatAlmaty(action.selectedDueAt)}`,
    `Основание: ${action.evidence}`,
    `ID обработки: ${action.id}`,
  ].join("\n");
}

async function bestEffortTestNotification(
  notifier: CallTaskAutomationNotifier | undefined,
  action: CallTaskAutomationAction,
  result: CallTaskAutomationResult,
): Promise<void> {
  if (!notifier?.notifyTestResult) return;
  try {
    await notifier.notifyTestResult({ action, result });
  } catch (error) {
    console.error("[CallTaskAutomation] Test result notification failed", {
      actionId: action.id,
      reason: error instanceof Error ? error.message : "unknown error",
    });
  }
}

async function bestEffortProposalNotification(
  notifier: CallTaskAutomationNotifier | undefined,
  action: CallTaskAutomationAction,
): Promise<void> {
  if (!notifier) return;
  try {
    await notifier.notifyProposal(action);
  } catch (error) {
    console.error("[CallTaskAutomation] Proposal notification failed", {
      actionId: action.id,
      reason: error instanceof Error ? error.message : "unknown error",
    });
  }
}

function taskFailureReason(outcome: Exclude<CreateVerifiedCallTaskOutcome, { kind: "confirmed" }>): string {
  return outcome.kind === "not_created" ? outcome.reason : outcome.error.message;
}

function noteFailureReason(outcome: Exclude<AddCallTaskReasonNoteOutcome, { kind: "confirmed" }>): string {
  return outcome.kind === "not_created" ? outcome.reason : outcome.error.message;
}

async function executeClaimedTask(
  action: CallTaskAutomationAction,
  input: CallTaskAutomationInput,
  dependencies: CallTaskAutomationDependencies,
  now: Date,
): Promise<CallTaskAutomationResult> {
  if (!action.taskText || !action.selectedDueAt || !action.taskRequestId) {
    await dependencies.ledger.markTaskUncertain(action.id, "claimed action is missing task data", now);
    return { kind: "uncertain", actionId: action.id, phase: "task" };
  }

  const taskOutcome = await dependencies.amo.createVerifiedTask({
    leadId: input.dealId,
    fallbackResponsibleUserId: input.managerAmoUserId,
    taskText: action.taskText,
    dueAt: action.selectedDueAt,
    requestId: action.taskRequestId,
  });
  if (taskOutcome.kind === "uncertain") {
    await dependencies.ledger.markTaskUncertain(action.id, taskFailureReason(taskOutcome), now);
    return { kind: "uncertain", actionId: action.id, phase: "task" };
  }
  if (taskOutcome.kind === "not_created") {
    await dependencies.ledger.markTaskSkipped(action.id, taskFailureReason(taskOutcome), now);
    return { kind: "task_not_created", actionId: action.id };
  }

  const taskPersisted = await dependencies.ledger.markTaskConfirmed(
    action.id,
    taskOutcome.task.id,
    taskOutcome.task.responsibleUserId,
    now,
  );
  if (!taskPersisted) {
    // A verified amoCRM task exists, but its durable state could not be advanced.
    // Do not add the note or repeat the mutation automatically.
    return { kind: "uncertain", actionId: action.id, phase: "task_persistence" };
  }

  const noteText = buildCallTaskReasonNote({
    id: taskPersisted.id,
    taskText: taskPersisted.taskText,
    selectedDueAt: taskPersisted.selectedDueAt,
    evidence: taskPersisted.evidence,
  });
  const noteClaimed = await dependencies.ledger.claimNoteCreation(action.id, noteText, now);
  if (!noteClaimed) {
    return { kind: "uncertain", actionId: action.id, phase: "note" };
  }

  const noteOutcome = await dependencies.amo.addTaskReasonNote({ leadId: input.dealId, text: noteText });
  if (noteOutcome.kind !== "confirmed") {
    await dependencies.ledger.markNoteUncertain(action.id, noteFailureReason(noteOutcome), now);
    return { kind: "uncertain", actionId: action.id, phase: "note" };
  }
  const confirmed = await dependencies.ledger.markNoteConfirmed(action.id, noteOutcome.noteId, now);
  if (!confirmed) return { kind: "uncertain", actionId: action.id, phase: "note" };
  return { kind: "confirmed", actionId: action.id, taskId: taskOutcome.task.id, noteId: noteOutcome.noteId };
}

export async function runCallTaskAutomation(
  input: CallTaskAutomationInput,
  dependencies: CallTaskAutomationDependencies,
): Promise<CallTaskAutomationResult> {
  if (!dependencies.enabled) return { kind: "disabled" };
  asValidDate(input.callCreatedAt, "callCreatedAt");
  const now = dependencies.now?.() ?? new Date();
  asValidDate(now, "now");

  let activationBoundary: Date | null;
  try {
    activationBoundary = await dependencies.store.getActivationBoundary();
  } catch (error) {
    console.error("[CallTaskAutomation] Activation boundary is unavailable", {
      reason: error instanceof Error ? error.message : "unknown error",
    });
    return { kind: "not_configured" };
  }
  if (!activationBoundary) return { kind: "not_configured" };

  let lead: AmoCallTaskLead;
  try {
    lead = await dependencies.amo.readLead(input.dealId);
  } catch (error) {
    console.error("[CallTaskAutomation] Fresh amoCRM lead read failed", {
      dealId: input.dealId,
      reason: error instanceof Error ? error.message : "unknown error",
    });
    return { kind: "lead_unavailable" };
  }
  if (lead.createdAt.getTime() <= activationBoundary.getTime()) {
    return { kind: "ineligible", reason: "lead_created_before_activation" };
  }
  if (input.callCreatedAt.getTime() < activationBoundary.getTime()) {
    return { kind: "ineligible", reason: "call_created_before_activation" };
  }
  if (!isCallTaskAutomationEligible({ activationBoundary, leadCreatedAt: lead.createdAt, callCreatedAt: input.callCreatedAt })) {
    return { kind: "ineligible", reason: "lead_created_before_activation" };
  }

  const analysisClaim = await dependencies.ledger.claimAnalysis({
    callId: input.callId,
    dealId: input.dealId,
    testMode: dependencies.testing,
    now,
  });
  if (analysisClaim.kind === "existing") return { kind: "existing", actionId: analysisClaim.action.id };

  const action = analysisClaim.action;
  // `testing` controls observation notifications only. The legacy five-slot
  // rollout is intentionally not consulted, so every eligible future call is
  // analysed and reported while the durable per-call ledger remains the fence.

  let proposal: CallTaskActionProposal | null;
  try {
    proposal = await dependencies.analyze(input.transcript, { now });
  } catch (error) {
    console.error("[CallTaskAutomation] Action analysis failed", {
      actionId: action.id,
      reason: error instanceof Error ? error.message : "unknown error",
    });
    proposal = null;
  }
  if (!proposal) {
    const unavailable = await dependencies.ledger.markAnalysisUnavailable({
      actionId: action.id,
      leaseToken: analysisClaim.leaseToken,
      reason: "Gemini task-action response was unavailable or invalid",
      now,
    });
    if (!unavailable) return { kind: "analysis_claim_lost", actionId: action.id };
    const result: CallTaskAutomationResult = { kind: "analysis_unavailable", actionId: action.id };
    if (dependencies.testing) await bestEffortTestNotification(dependencies.notifier, unavailable, result);
    return result;
  }

  const finalized = await dependencies.ledger.finalizeAnalysis({
    actionId: action.id,
    leaseToken: analysisClaim.leaseToken,
    proposal,
    now,
  });
  if (!finalized) {
    return { kind: "analysis_claim_lost", actionId: action.id };
  }

  if (finalized.decision === "none") {
    const result: CallTaskAutomationResult = { kind: "no_action", actionId: action.id };
    if (dependencies.testing) await bestEffortTestNotification(dependencies.notifier, finalized, result);
    return result;
  }
  if (finalized.decision === "review") {
    await bestEffortProposalNotification(dependencies.notifier, finalized);
    const result: CallTaskAutomationResult = { kind: "review_pending", actionId: action.id };
    if (dependencies.testing) await bestEffortTestNotification(dependencies.notifier, finalized, result);
    return result;
  }
  if (dependencies.executionMode === "dry_run") {
    const result: CallTaskAutomationResult = { kind: "dry_run", actionId: action.id };
    if (dependencies.testing) await bestEffortTestNotification(dependencies.notifier, finalized, result);
    return result;
  }
  if (!finalized.proposedDueAt) {
    await dependencies.ledger.markTaskUncertain(finalized.id, "automatic proposal has no due date", now);
    return { kind: "uncertain", actionId: action.id, phase: "task" };
  }

  const claimed = await dependencies.ledger.claimTaskCreation({
    actionId: finalized.id,
    dueAt: finalized.proposedDueAt,
    reviewerTelegramUserId: null,
    now,
  });
  if (!claimed) return { kind: "existing", actionId: action.id };
  const result = await executeClaimedTask(claimed, input, dependencies, now);
  if (dependencies.testing) {
    const latest = (await dependencies.ledger.getActionById(action.id)) ?? claimed;
    await bestEffortTestNotification(dependencies.notifier, latest, result);
  }
  return result;
}

export interface ExecuteReviewedCallTaskProposalInput {
  action: CallTaskAutomationAction;
  dueAt: Date;
  reviewerTelegramUserId: string;
  managerAmoUserId: number | null;
}

/**
 * Performs an explicitly approved review proposal. The lease/CAS in the ledger
 * is the authorization boundary: duplicate Telegram callbacks can never issue
 * a second non-idempotent amoCRM POST.
 */
export async function executeReviewedCallTaskProposal(
  input: ExecuteReviewedCallTaskProposalInput,
  dependencies: CallTaskAutomationDependencies,
): Promise<CallTaskAutomationResult> {
  const now = dependencies.now?.() ?? new Date();
  asValidDate(now, "review approval now");
  asValidDate(input.dueAt, "review proposal dueAt");
  if (!dependencies.enabled) return { kind: "disabled" };
  if (dependencies.executionMode === "dry_run") return { kind: "dry_run", actionId: input.action.id };
  if (input.action.status !== "proposed" || input.action.decision !== "review") {
    return { kind: "existing", actionId: input.action.id };
  }

  const claimed = await dependencies.ledger.claimTaskCreation({
    actionId: input.action.id,
    dueAt: input.dueAt,
    reviewerTelegramUserId: input.reviewerTelegramUserId,
    now,
  });
  if (!claimed) return { kind: "existing", actionId: input.action.id };
  const result = await executeClaimedTask(
    claimed,
    {
      callId: claimed.callId,
      dealId: claimed.dealId,
      callCreatedAt: claimed.createdAt,
      managerAmoUserId: input.managerAmoUserId,
      transcript: "",
    },
    dependencies,
    now,
  );
  if (claimed.testMode) {
    const latest = (await dependencies.ledger.getActionById(claimed.id)) ?? claimed;
    await bestEffortTestNotification(dependencies.notifier, latest, result);
  }
  return result;
}
