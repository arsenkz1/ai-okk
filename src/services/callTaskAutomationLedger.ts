import { randomBytes, randomUUID } from "crypto";
import type { CallTaskActionProposal } from "./aiAnalysis";

export type CallTaskAutomationActionStatus =
  | "analyzing"
  | "proposed"
  | "creating_task"
  | "task_confirmed"
  | "creating_note"
  | "confirmed"
  | "rejected"
  | "skipped"
  | "uncertain";

export interface CallTaskAutomationAction {
  id: string;
  callId: number;
  actionKind: string;
  dealId: number;
  testMode: boolean;
  status: CallTaskAutomationActionStatus;
  decision: "auto" | "review" | "none" | null;
  taskText: string | null;
  evidence: string | null;
  proposedDueAt: Date | null;
  selectedDueAt: Date | null;
  responsibleUserId: number | null;
  amoTaskId: number | null;
  taskRequestId: string | null;
  noteText: string | null;
  amoNoteId: number | null;
  approvalToken: string;
  reviewedByTelegramUserId: string | null;
  reviewedAt: Date | null;
  failureReason: string | null;
  analysisLeaseToken: string | null;
  analysisLeaseExpiresAt: Date | null;
  analysisLeaseGeneration: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateActionInput {
  id: string;
  callId: number;
  dealId: number;
  testMode: boolean;
  approvalToken: string;
  analysisLeaseToken: string;
  analysisLeaseExpiresAt: Date;
  now: Date;
}

export interface CallTaskAutomationActionPersistence {
  getActionByCall(callId: number): Promise<CallTaskAutomationAction | null>;
  createActionIfAbsent(input: CreateActionInput): Promise<{ created: boolean; action: CallTaskAutomationAction }>;
  reclaimExpiredAnalysis(
    actionId: string,
    now: Date,
    token: string,
    expiresAt: Date,
  ): Promise<CallTaskAutomationAction | null>;
  finalizeAnalysis(
    actionId: string,
    leaseToken: string,
    update: Pick<CallTaskAutomationAction, "status" | "decision" | "taskText" | "evidence" | "proposedDueAt" | "failureReason">,
    now: Date,
  ): Promise<CallTaskAutomationAction | null>;
  claimTaskCreation(
    actionId: string,
    dueAt: Date,
    reviewerTelegramUserId: string | null,
    now: Date,
  ): Promise<CallTaskAutomationAction | null>;
  markTaskConfirmed(
    actionId: string,
    taskId: number,
    responsibleUserId: number,
    now: Date,
  ): Promise<CallTaskAutomationAction | null>;
  markActionSkipped(
    actionId: string,
    expectedStatus: CallTaskAutomationActionStatus,
    reason: string,
    now: Date,
  ): Promise<CallTaskAutomationAction | null>;
  markActionUncertain(
    actionId: string,
    expectedStatuses: readonly CallTaskAutomationActionStatus[],
    reason: string,
    now: Date,
  ): Promise<CallTaskAutomationAction | null>;
  getActionById(actionId: string): Promise<CallTaskAutomationAction | null>;
  getActionByApprovalToken(approvalToken: string): Promise<CallTaskAutomationAction | null>;
  claimNoteCreation(actionId: string, noteText: string, now: Date): Promise<CallTaskAutomationAction | null>;
  markNoteConfirmed(actionId: string, noteId: number | null, now: Date): Promise<CallTaskAutomationAction | null>;
  rejectProposal(actionId: string, reviewerTelegramUserId: string, now: Date): Promise<CallTaskAutomationAction | null>;
}

export interface CallTaskAutomationLedgerOptions {
  analysisLeaseMs?: number;
  id?: () => string;
  token?: () => string;
  approvalToken?: () => string;
}

export interface CallTaskAutomationLedger {
  claimAnalysis(input: { callId: number; dealId: number; testMode: boolean; now: Date }): Promise<
    | { kind: "claimed"; action: CallTaskAutomationAction; leaseToken: string }
    | { kind: "existing"; action: CallTaskAutomationAction }
  >;
  finalizeAnalysis(input: {
    actionId: string;
    leaseToken: string;
    proposal: CallTaskActionProposal;
    now: Date;
  }): Promise<CallTaskAutomationAction | null>;
  markAnalysisUnavailable(input: {
    actionId: string;
    leaseToken: string;
    reason: string;
    now: Date;
  }): Promise<CallTaskAutomationAction | null>;
  claimTaskCreation(input: {
    actionId: string;
    dueAt: Date;
    reviewerTelegramUserId: string | null;
    now: Date;
  }): Promise<CallTaskAutomationAction | null>;
  markTaskConfirmed(actionId: string, taskId: number, responsibleUserId: number, now: Date): Promise<CallTaskAutomationAction | null>;
  markTaskSkipped(actionId: string, reason: string, now: Date): Promise<CallTaskAutomationAction | null>;
  markTaskUncertain(actionId: string, reason: string, now: Date): Promise<CallTaskAutomationAction | null>;
  getActionById(actionId: string): Promise<CallTaskAutomationAction | null>;
  getActionByApprovalToken(approvalToken: string): Promise<CallTaskAutomationAction | null>;
  claimNoteCreation(actionId: string, noteText: string, now: Date): Promise<CallTaskAutomationAction | null>;
  markNoteConfirmed(actionId: string, noteId: number | null, now: Date): Promise<CallTaskAutomationAction | null>;
  markNoteUncertain(actionId: string, reason: string, now: Date): Promise<CallTaskAutomationAction | null>;
  rejectProposal(actionId: string, reviewerTelegramUserId: string, now: Date): Promise<CallTaskAutomationAction | null>;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${name} must be a valid Date`);
}

function assertNonBlank(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} is required`);
}

function defaultToken(): string {
  return randomUUID();
}

function defaultApprovalToken(): string {
  return randomBytes(12).toString("base64url");
}

function actionUpdateForProposal(proposal: CallTaskActionProposal): Pick<
  CallTaskAutomationAction,
  "status" | "decision" | "taskText" | "evidence" | "proposedDueAt" | "failureReason"
> {
  if (proposal.decision === "none") {
    return {
      status: "skipped",
      decision: "none",
      taskText: null,
      evidence: null,
      proposedDueAt: null,
      failureReason: null,
    };
  }
  if (!proposal.taskText || !proposal.evidence) throw new Error("actionable proposal is incomplete");
  if (proposal.decision === "auto" && !proposal.deadlineAt) throw new Error("automatic proposal has no deadline");
  return {
    status: "proposed",
    decision: proposal.decision,
    taskText: proposal.taskText,
    evidence: proposal.evidence,
    proposedDueAt: proposal.deadlineAt,
    failureReason: null,
  };
}

export function createCallTaskAutomationLedger(
  persistence: CallTaskAutomationActionPersistence,
  options: CallTaskAutomationLedgerOptions = {},
): CallTaskAutomationLedger {
  const analysisLeaseMs = options.analysisLeaseMs ?? 10 * 60 * 1000;
  assertPositiveInteger(analysisLeaseMs, "analysisLeaseMs");
  const nextId = options.id ?? defaultToken;
  const nextToken = options.token ?? defaultToken;
  const nextApprovalToken = options.approvalToken ?? defaultApprovalToken;

  return {
    async claimAnalysis(input) {
      assertPositiveInteger(input.callId, "callId");
      assertPositiveInteger(input.dealId, "dealId");
      assertValidDate(input.now, "analysis now");

      const existing = await persistence.getActionByCall(input.callId);
      if (!existing) {
        const leaseToken = nextToken();
        const created = await persistence.createActionIfAbsent({
          id: nextId(),
          callId: input.callId,
          dealId: input.dealId,
          testMode: input.testMode,
          approvalToken: nextApprovalToken(),
          analysisLeaseToken: leaseToken,
          analysisLeaseExpiresAt: new Date(input.now.getTime() + analysisLeaseMs),
          now: input.now,
        });
        if (created.created) return { kind: "claimed", action: created.action, leaseToken };
        return { kind: "existing", action: created.action };
      }

      if (
        existing.status === "analyzing"
        && existing.analysisLeaseExpiresAt !== null
        && existing.analysisLeaseExpiresAt.getTime() <= input.now.getTime()
      ) {
        const leaseToken = nextToken();
        const reclaimed = await persistence.reclaimExpiredAnalysis(
          existing.id,
          input.now,
          leaseToken,
          new Date(input.now.getTime() + analysisLeaseMs),
        );
        if (reclaimed) return { kind: "claimed", action: reclaimed, leaseToken };
      }
      return { kind: "existing", action: existing };
    },

    async finalizeAnalysis(input) {
      assertNonBlank(input.actionId, "actionId");
      assertNonBlank(input.leaseToken, "analysis leaseToken");
      assertValidDate(input.now, "analysis finalize now");
      return persistence.finalizeAnalysis(
        input.actionId,
        input.leaseToken,
        actionUpdateForProposal(input.proposal),
        input.now,
      );
    },

    async markAnalysisUnavailable(input) {
      assertNonBlank(input.actionId, "actionId");
      assertNonBlank(input.leaseToken, "analysis leaseToken");
      assertNonBlank(input.reason, "analysis unavailable reason");
      assertValidDate(input.now, "analysis unavailable now");
      return persistence.finalizeAnalysis(input.actionId, input.leaseToken, {
        status: "skipped",
        decision: "none",
        taskText: null,
        evidence: null,
        proposedDueAt: null,
        failureReason: input.reason.slice(0, 1_000),
      }, input.now);
    },

    async claimTaskCreation(input) {
      assertNonBlank(input.actionId, "actionId");
      assertValidDate(input.dueAt, "task dueAt");
      assertValidDate(input.now, "task claim now");
      if (input.dueAt.getTime() <= input.now.getTime()) throw new Error("task dueAt must be in the future");
      if (input.reviewerTelegramUserId !== null) assertNonBlank(input.reviewerTelegramUserId, "reviewerTelegramUserId");
      return persistence.claimTaskCreation(input.actionId, input.dueAt, input.reviewerTelegramUserId, input.now);
    },

    async markTaskConfirmed(actionId, taskId, responsibleUserId, now) {
      assertNonBlank(actionId, "actionId");
      assertPositiveInteger(taskId, "taskId");
      assertPositiveInteger(responsibleUserId, "responsibleUserId");
      assertValidDate(now, "task confirmed now");
      return persistence.markTaskConfirmed(actionId, taskId, responsibleUserId, now);
    },

    async markTaskSkipped(actionId, reason, now) {
      assertNonBlank(actionId, "actionId");
      assertNonBlank(reason, "task skipped reason");
      assertValidDate(now, "task skipped now");
      return persistence.markActionSkipped(actionId, "creating_task", reason.slice(0, 1_000), now);
    },

    async markTaskUncertain(actionId, reason, now) {
      assertNonBlank(actionId, "actionId");
      assertNonBlank(reason, "task uncertain reason");
      assertValidDate(now, "task uncertain now");
      return persistence.markActionUncertain(actionId, ["creating_task"], reason.slice(0, 1_000), now);
    },

    async getActionById(actionId) {
      assertNonBlank(actionId, "actionId");
      return persistence.getActionById(actionId);
    },

    async getActionByApprovalToken(approvalToken) {
      assertNonBlank(approvalToken, "approvalToken");
      return persistence.getActionByApprovalToken(approvalToken);
    },

    async claimNoteCreation(actionId, noteText, now) {
      assertNonBlank(actionId, "actionId");
      assertNonBlank(noteText, "note text");
      if (noteText.trim().length > 4_000) throw new Error("note text must contain at most 4000 characters");
      assertValidDate(now, "note claim now");
      return persistence.claimNoteCreation(actionId, noteText.trim(), now);
    },

    async markNoteConfirmed(actionId, noteId, now) {
      assertNonBlank(actionId, "actionId");
      if (noteId !== null) assertPositiveInteger(noteId, "noteId");
      assertValidDate(now, "note confirmed now");
      return persistence.markNoteConfirmed(actionId, noteId, now);
    },

    async markNoteUncertain(actionId, reason, now) {
      assertNonBlank(actionId, "actionId");
      assertNonBlank(reason, "note uncertain reason");
      assertValidDate(now, "note uncertain now");
      return persistence.markActionUncertain(actionId, ["creating_note"], reason.slice(0, 1_000), now);
    },

    async rejectProposal(actionId, reviewerTelegramUserId, now) {
      assertNonBlank(actionId, "actionId");
      assertNonBlank(reviewerTelegramUserId, "reviewerTelegramUserId");
      assertValidDate(now, "proposal reject now");
      return persistence.rejectProposal(actionId, reviewerTelegramUserId, now);
    },
  };
}
