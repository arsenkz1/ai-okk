import type { CallStageRoutingProposal } from "./aiAnalysis";
import type { UZUMRequiredField, UZUMStageTargetKey } from "./callStagePolicy";

export type CallStageActionStatus =
  | "analyzing"
  | "review"
  | "pending_move"
  | "moving"
  | "blocked_missing_fields"
  | "confirmed"
  | "skipped"
  | "uncertain";

export interface CallStageAutomationAction {
  id: string;
  callId: number;
  dealId: number;
  testMode: boolean;
  status: CallStageActionStatus;
  decision: CallStageRoutingProposal["decision"] | null;
  target: UZUMStageTargetKey | null;
  evidence: string | null;
  checkedFields: string[] | null;
  missingFields: UZUMRequiredField[] | null;
  amoNoteId: number | null;
  failureReason: string | null;
  analysisLeaseToken: string | null;
  analysisLeaseExpiresAt: Date | null;
  analysisLeaseGeneration: number;
  mutationLeaseToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CallStageAutomationLedgerPersistence {
  getActionByCall(callId: number): Promise<CallStageAutomationAction | null>;
  createActionIfAbsent(input: {
    id: string;
    callId: number;
    dealId: number;
    testMode: boolean;
    analysisLeaseToken: string;
    analysisLeaseExpiresAt: Date;
    now: Date;
  }): Promise<{ created: boolean; action: CallStageAutomationAction }>;
  reclaimExpiredAnalysis(actionId: string, now: Date, token: string, expiresAt: Date): Promise<CallStageAutomationAction | null>;
  finalizeAnalysis(
    actionId: string,
    leaseToken: string,
    update: Partial<CallStageAutomationAction>,
    now: Date,
  ): Promise<CallStageAutomationAction | null>;
  claimMove(actionId: string, mutationLeaseToken: string, now: Date): Promise<CallStageAutomationAction | null>;
  isMoveCurrent(actionId: string, mutationLeaseToken: string): Promise<boolean>;
  markBlockedMissingFields(
    actionId: string,
    mutationLeaseToken: string,
    missingFields: UZUMRequiredField[],
    now: Date,
  ): Promise<CallStageAutomationAction | null>;
  markMoveConfirmed(
    actionId: string,
    mutationLeaseToken: string,
    checkedFields: string[],
    noteId: number | null,
    now: Date,
    confirmTestSlot: boolean,
  ): Promise<CallStageAutomationAction | null>;
  markMoveSkipped(
    actionId: string,
    mutationLeaseToken: string,
    reason: string,
    now: Date,
  ): Promise<CallStageAutomationAction | null>;
  markMoveUncertain(
    actionId: string,
    mutationLeaseToken: string,
    reason: string,
    now: Date,
  ): Promise<CallStageAutomationAction | null>;
}

export interface CallStageAutomationLedgerOptions {
  analysisLeaseMs?: number;
  id?: () => string;
  token?: () => string;
}

export interface CallStageAutomationLedger {
  claimAnalysis(input: { callId: number; dealId: number; testMode: boolean; now: Date }): Promise<
    | { kind: "claimed"; action: CallStageAutomationAction; leaseToken: string }
    | { kind: "existing"; action: CallStageAutomationAction }
  >;
  finalizeAnalysis(input: {
    actionId: string;
    leaseToken: string;
    proposal: CallStageRoutingProposal;
    now: Date;
  }): Promise<CallStageAutomationAction | null>;
  claimMove(input: { actionId: string; now: Date }): Promise<CallStageAutomationAction | null>;
  isMoveCurrent(input: { actionId: string; mutationLeaseToken: string }): Promise<boolean>;
  markBlockedMissingFields(input: {
    actionId: string;
    mutationLeaseToken: string;
    missingFields: UZUMRequiredField[];
    now: Date;
  }): Promise<CallStageAutomationAction | null>;
  markMoveConfirmed(input: {
    actionId: string;
    mutationLeaseToken: string;
    checkedFields: string[];
    noteId: number | null;
    now: Date;
    confirmTestSlot: boolean;
  }): Promise<CallStageAutomationAction | null>;
  markMoveSkipped(input: { actionId: string; mutationLeaseToken: string; reason: string; now: Date }): Promise<CallStageAutomationAction | null>;
  markMoveUncertain(input: { actionId: string; mutationLeaseToken: string; reason: string; now: Date }): Promise<CallStageAutomationAction | null>;
}

const DEFAULT_ANALYSIS_LEASE_MS = 5 * 60 * 1_000;

function assertIdentifier(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} is required`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${name} must be a valid Date`);
}

function defaultRandomId(): string {
  return crypto.randomUUID();
}

function analysisUpdate(proposal: CallStageRoutingProposal): Partial<CallStageAutomationAction> {
  if (proposal.decision === "move") {
    return {
      status: "pending_move",
      decision: proposal.decision,
      target: proposal.target,
      evidence: proposal.evidence,
    };
  }
  if (proposal.decision === "review") {
    return {
      status: "review",
      decision: proposal.decision,
      target: null,
      evidence: proposal.evidence,
    };
  }
  return {
    status: "skipped",
    decision: proposal.decision,
    target: null,
    evidence: null,
    failureReason: "no clear client-stated UZUM stage outcome",
  };
}

/** Durable idempotency/fence ledger for a single source call's stage decision. */
export function createCallStageAutomationLedger(
  persistence: CallStageAutomationLedgerPersistence,
  options: CallStageAutomationLedgerOptions = {},
): CallStageAutomationLedger {
  const analysisLeaseMs = options.analysisLeaseMs ?? DEFAULT_ANALYSIS_LEASE_MS;
  assertPositiveInteger(analysisLeaseMs, "analysisLeaseMs");
  const id = options.id ?? defaultRandomId;
  const token = options.token ?? defaultRandomId;

  function leaseExpiration(now: Date): Date {
    return new Date(now.getTime() + analysisLeaseMs);
  }

  return {
    async claimAnalysis(input) {
      assertPositiveInteger(input.callId, "callId");
      assertPositiveInteger(input.dealId, "dealId");
      assertValidDate(input.now, "analysis now");

      const existing = await persistence.getActionByCall(input.callId);
      if (existing) {
        if (existing.status === "analyzing" && existing.analysisLeaseExpiresAt && existing.analysisLeaseExpiresAt.getTime() <= input.now.getTime()) {
          const leaseToken = token();
          assertIdentifier(leaseToken, "analysis lease token");
          const reclaimed = await persistence.reclaimExpiredAnalysis(existing.id, input.now, leaseToken, leaseExpiration(input.now));
          if (reclaimed) return { kind: "claimed", action: reclaimed, leaseToken };
        }
        return { kind: "existing", action: existing };
      }

      const leaseToken = token();
      const actionId = id();
      assertIdentifier(leaseToken, "analysis lease token");
      assertIdentifier(actionId, "stage action id");
      const created = await persistence.createActionIfAbsent({
        id: actionId,
        callId: input.callId,
        dealId: input.dealId,
        testMode: input.testMode,
        analysisLeaseToken: leaseToken,
        analysisLeaseExpiresAt: leaseExpiration(input.now),
        now: input.now,
      });
      if (!created.created) return { kind: "existing", action: created.action };
      return { kind: "claimed", action: created.action, leaseToken };
    },

    async finalizeAnalysis(input) {
      assertIdentifier(input.actionId, "actionId");
      assertIdentifier(input.leaseToken, "analysis lease token");
      assertValidDate(input.now, "analysis finalization now");
      return persistence.finalizeAnalysis(input.actionId, input.leaseToken, analysisUpdate(input.proposal), input.now);
    },

    async claimMove(input) {
      assertIdentifier(input.actionId, "actionId");
      assertValidDate(input.now, "move claim now");
      const mutationLeaseToken = token();
      assertIdentifier(mutationLeaseToken, "mutation lease token");
      return persistence.claimMove(input.actionId, mutationLeaseToken, input.now);
    },

    async isMoveCurrent(input) {
      assertIdentifier(input.actionId, "actionId");
      assertIdentifier(input.mutationLeaseToken, "mutation lease token");
      return persistence.isMoveCurrent(input.actionId, input.mutationLeaseToken);
    },

    async markBlockedMissingFields(input) {
      assertIdentifier(input.actionId, "actionId");
      assertIdentifier(input.mutationLeaseToken, "mutation lease token");
      assertValidDate(input.now, "missing fields now");
      return persistence.markBlockedMissingFields(input.actionId, input.mutationLeaseToken, input.missingFields, input.now);
    },

    async markMoveConfirmed(input) {
      assertIdentifier(input.actionId, "actionId");
      assertIdentifier(input.mutationLeaseToken, "mutation lease token");
      assertValidDate(input.now, "move confirmation now");
      return persistence.markMoveConfirmed(
        input.actionId,
        input.mutationLeaseToken,
        input.checkedFields,
        input.noteId,
        input.now,
        input.confirmTestSlot,
      );
    },

    async markMoveSkipped(input) {
      assertIdentifier(input.actionId, "actionId");
      assertIdentifier(input.mutationLeaseToken, "mutation lease token");
      assertIdentifier(input.reason, "move skip reason");
      assertValidDate(input.now, "move skip now");
      return persistence.markMoveSkipped(input.actionId, input.mutationLeaseToken, input.reason, input.now);
    },

    async markMoveUncertain(input) {
      assertIdentifier(input.actionId, "actionId");
      assertIdentifier(input.mutationLeaseToken, "mutation lease token");
      assertIdentifier(input.reason, "move uncertainty reason");
      assertValidDate(input.now, "move uncertainty now");
      return persistence.markMoveUncertain(input.actionId, input.mutationLeaseToken, input.reason, input.now);
    },
  };
}
