import type { PrismaClient } from "../generated/prisma/client";
import type {
  CallTaskAutomationAction,
  CallTaskAutomationActionPersistence,
  CallTaskAutomationActionStatus,
} from "./callTaskAutomationLedger";
import type {
  CallTaskAutomationPersistence,
  CallTaskAutomationTestSlot,
  CallTaskAutomationTestSlotState,
} from "./callTaskAutomationStore";

type PrismaCallTaskAutomationDb = Pick<
  PrismaClient,
  | "callTaskAutomationSetting"
  | "callTaskAutomationTestSlot"
  | "callTaskAction"
>;

type TransactionRunner = <T>(operation: (database: PrismaCallTaskAutomationDb) => Promise<T>) => Promise<T>;

const TEST_SLOT_STATES = new Set<CallTaskAutomationTestSlotState>([
  "free", "reserved", "confirmed", "uncertain",
]);

function isTransactionConflictError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2034";
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

interface PrismaTestSlotRecord {
  slotNumber: number;
  state: string;
  dealId: number | null;
  actionId: string | null;
  reservedAt: Date | null;
  confirmedAt: Date | null;
  leaseExpiresAt: Date | null;
}

function toTestSlot(record: PrismaTestSlotRecord): CallTaskAutomationTestSlot {
  if (!TEST_SLOT_STATES.has(record.state as CallTaskAutomationTestSlotState)) {
    throw new Error(`unknown call-task test slot state: ${record.state}`);
  }
  return {
    slotNumber: record.slotNumber,
    state: record.state as CallTaskAutomationTestSlotState,
    leadId: record.dealId,
    actionId: record.actionId,
    reservedAt: record.reservedAt,
    confirmedAt: record.confirmedAt,
    leaseExpiresAt: record.leaseExpiresAt,
  };
}

function createAdapter(
  database: PrismaCallTaskAutomationDb,
  transactionRunner?: TransactionRunner,
): CallTaskAutomationPersistence {
  return {
    async transaction<T>(operation: (persistence: CallTaskAutomationPersistence) => Promise<T>): Promise<T> {
      if (!transactionRunner) return operation(createAdapter(database));
      return transactionRunner((transaction) => operation(createAdapter(transaction)));
    },

    async getSetting(key: string): Promise<string | null> {
      const setting = await database.callTaskAutomationSetting.findUnique({
        where: { key },
        select: { value: true },
      });
      return setting?.value ?? null;
    },

    async createSettingIfAbsent(key: string, value: string): Promise<string> {
      const setting = await database.callTaskAutomationSetting.upsert({
        where: { key },
        create: { key, value },
        update: {},
        select: { value: true },
      });
      return setting.value;
    },

    async ensureTestSlots(limit: number): Promise<void> {
      for (let slotNumber = 1; slotNumber <= limit; slotNumber += 1) {
        await database.callTaskAutomationTestSlot.upsert({
          where: { slotNumber },
          create: { slotNumber, state: "free" },
          update: {},
          select: { slotNumber: true },
        });
      }
    },

    async findTestSlotForLead(leadId: number): Promise<CallTaskAutomationTestSlot | null> {
      const slot = await database.callTaskAutomationTestSlot.findUnique({ where: { dealId: leadId } });
      return slot ? toTestSlot(slot) : null;
    },

    async reserveFreeTestSlot(
      leadId: number,
      actionId: string,
      now: Date,
      leaseExpiresAt: Date,
    ): Promise<CallTaskAutomationTestSlot | null> {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = await database.callTaskAutomationTestSlot.findFirst({
          where: { state: "free" },
          orderBy: { slotNumber: "asc" },
          select: { slotNumber: true },
        });
        if (!candidate) return null;

        try {
          const reserved = await database.callTaskAutomationTestSlot.updateMany({
            where: { slotNumber: candidate.slotNumber, state: "free" },
            data: {
              state: "reserved",
              dealId: leadId,
              actionId,
              reservedAt: now,
              confirmedAt: null,
              leaseExpiresAt,
            },
          });
          if (reserved.count !== 1) continue;
        } catch (error) {
          // The unique lead/action identity can lose a concurrent race; the
          // caller re-reads the slot before deciding that capacity is full.
          if (isUniqueConstraintError(error)) return null;
          throw error;
        }

        const slot = await database.callTaskAutomationTestSlot.findFirst({
          where: { slotNumber: candidate.slotNumber, state: "reserved", actionId },
        });
        return slot ? toTestSlot(slot) : null;
      }
      return null;
    },

    async reclaimTestSlotLease(
      actionId: string,
      now: Date,
      leaseExpiresAt: Date,
    ): Promise<CallTaskAutomationTestSlot | null> {
      const reclaimed = await database.callTaskAutomationTestSlot.updateMany({
        where: { state: "reserved", actionId },
        data: { reservedAt: now, leaseExpiresAt },
      });
      if (reclaimed.count !== 1) return null;
      const slot = await database.callTaskAutomationTestSlot.findFirst({
        where: { state: "reserved", actionId },
      });
      return slot ? toTestSlot(slot) : null;
    },

    async markExpiredTestSlotsUncertain(now: Date): Promise<number> {
      const expired = await database.callTaskAutomationTestSlot.updateMany({
        where: { state: "reserved", leaseExpiresAt: { lte: now } },
        data: { state: "uncertain", confirmedAt: now, leaseExpiresAt: null },
      });
      return expired.count;
    },

    async confirmTestSlot(actionId: string, now: Date): Promise<CallTaskAutomationTestSlot | null> {
      const confirmed = await database.callTaskAutomationTestSlot.updateMany({
        where: { state: "reserved", actionId },
        data: { state: "confirmed", confirmedAt: now, leaseExpiresAt: null },
      });
      if (confirmed.count !== 1) return null;
      const slot = await database.callTaskAutomationTestSlot.findFirst({
        where: { state: "confirmed", actionId },
      });
      return slot ? toTestSlot(slot) : null;
    },

    async releaseTestSlotBeforeAnalysis(actionId: string): Promise<boolean> {
      const released = await database.callTaskAutomationTestSlot.updateMany({
        where: { state: "reserved", actionId },
        data: {
          state: "free",
          dealId: null,
          actionId: null,
          reservedAt: null,
          confirmedAt: null,
          leaseExpiresAt: null,
        },
      });
      return released.count === 1;
    },

    async markTestSlotUncertain(actionId: string, now: Date): Promise<CallTaskAutomationTestSlot | null> {
      const marked = await database.callTaskAutomationTestSlot.updateMany({
        where: { state: "reserved", actionId },
        data: { state: "uncertain", confirmedAt: now, leaseExpiresAt: null },
      });
      if (marked.count !== 1) return null;
      const slot = await database.callTaskAutomationTestSlot.findFirst({
        where: { state: "uncertain", actionId },
      });
      return slot ? toTestSlot(slot) : null;
    },
  };
}

export function createPrismaCallTaskAutomationPersistence(
  database: PrismaClient,
): CallTaskAutomationPersistence {
  const transactionRunner: TransactionRunner = async <T>(
    operation: (transaction: PrismaCallTaskAutomationDb) => Promise<T>,
  ): Promise<T> => {
    let lastConflict: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await database.$transaction(
          (transaction) => operation(transaction as PrismaCallTaskAutomationDb),
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        if (!isTransactionConflictError(error)) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict;
  };
  return createAdapter(database, transactionRunner);
}

const ACTION_STATUSES = new Set<CallTaskAutomationActionStatus>([
  "analyzing", "proposed", "creating_task", "task_confirmed", "creating_note",
  "confirmed", "rejected", "skipped", "uncertain",
]);
const ACTION_DECISIONS = new Set<NonNullable<CallTaskAutomationAction["decision"]>>([
  "auto", "review", "none",
]);

type PrismaActionRecord = Omit<CallTaskAutomationAction, "status" | "decision"> & {
  status: string;
  decision: string | null;
};

function toAction(record: PrismaActionRecord): CallTaskAutomationAction {
  if (!ACTION_STATUSES.has(record.status as CallTaskAutomationActionStatus)) {
    throw new Error(`unknown call-task action status: ${record.status}`);
  }
  if (record.decision !== null && !ACTION_DECISIONS.has(record.decision as NonNullable<CallTaskAutomationAction["decision"]>)) {
    throw new Error(`unknown call-task action decision: ${record.decision}`);
  }
  return {
    ...record,
    status: record.status as CallTaskAutomationActionStatus,
    decision: record.decision as CallTaskAutomationAction["decision"],
  };
}

function createActionAdapter(database: PrismaCallTaskAutomationDb): CallTaskAutomationActionPersistence {
  const readById = async (actionId: string): Promise<CallTaskAutomationAction | null> => {
    const action = await database.callTaskAction.findUnique({ where: { id: actionId } });
    return action ? toAction(action) : null;
  };

  return {
    async getActionByCall(callId: number): Promise<CallTaskAutomationAction | null> {
      const action = await database.callTaskAction.findUnique({
        where: { callId_actionKind: { callId, actionKind: "next_step" } },
      });
      return action ? toAction(action) : null;
    },

    async createActionIfAbsent(input) {
      try {
        const action = await database.callTaskAction.create({
          data: {
            id: input.id,
            callId: input.callId,
            actionKind: "next_step",
            dealId: input.dealId,
            testMode: input.testMode,
            status: "analyzing",
            approvalToken: input.approvalToken,
            analysisLeaseToken: input.analysisLeaseToken,
            analysisLeaseExpiresAt: input.analysisLeaseExpiresAt,
            analysisLeaseGeneration: 1,
          },
        });
        return { created: true, action: toAction(action) };
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const action = await database.callTaskAction.findUnique({
          where: { callId_actionKind: { callId: input.callId, actionKind: "next_step" } },
        });
        if (!action) throw error;
        return { created: false, action: toAction(action) };
      }
    },

    async reclaimExpiredAnalysis(actionId, now, token, expiresAt) {
      const reclaimed = await database.callTaskAction.updateMany({
        where: { id: actionId, status: "analyzing", analysisLeaseExpiresAt: { lte: now } },
        data: {
          analysisLeaseToken: token,
          analysisLeaseExpiresAt: expiresAt,
          analysisLeaseGeneration: { increment: 1 },
        },
      });
      return reclaimed.count === 1 ? readById(actionId) : null;
    },

    async finalizeAnalysis(actionId, leaseToken, update, now) {
      const finalized = await database.callTaskAction.updateMany({
        where: { id: actionId, status: "analyzing", analysisLeaseToken: leaseToken },
        data: {
          status: update.status,
          decision: update.decision,
          taskText: update.taskText,
          evidence: update.evidence,
          proposedDueAt: update.proposedDueAt,
          failureReason: update.failureReason,
          analysisLeaseToken: null,
          analysisLeaseExpiresAt: null,
        },
      });
      return finalized.count === 1 ? readById(actionId) : null;
    },

    async claimTaskCreation(actionId, dueAt, reviewerTelegramUserId, now) {
      const decision = reviewerTelegramUserId === null ? "auto" : "review";
      const claimed = await database.callTaskAction.updateMany({
        where: { id: actionId, status: "proposed", decision },
        data: {
          status: "creating_task",
          selectedDueAt: dueAt,
          taskRequestId: `call-task:${actionId}`,
          reviewedByTelegramUserId: reviewerTelegramUserId,
          reviewedAt: reviewerTelegramUserId === null ? null : now,
        },
      });
      return claimed.count === 1 ? readById(actionId) : null;
    },

    async markTaskConfirmed(actionId, taskId, responsibleUserId, now) {
      const confirmed = await database.callTaskAction.updateMany({
        where: { id: actionId, status: "creating_task" },
        data: { status: "task_confirmed", amoTaskId: taskId, responsibleUserId, failureReason: null },
      });
      return confirmed.count === 1 ? readById(actionId) : null;
    },

    async markActionSkipped(actionId, expectedStatus, reason, now) {
      const skipped = await database.callTaskAction.updateMany({
        where: { id: actionId, status: expectedStatus },
        data: { status: "skipped", failureReason: reason },
      });
      return skipped.count === 1 ? readById(actionId) : null;
    },

    async markActionUncertain(actionId, expectedStatuses, reason, now) {
      const uncertain = await database.callTaskAction.updateMany({
        where: { id: actionId, status: { in: [...expectedStatuses] } },
        data: { status: "uncertain", failureReason: reason },
      });
      return uncertain.count === 1 ? readById(actionId) : null;
    },

    getActionById: readById,

    async getActionByApprovalToken(approvalToken) {
      const action = await database.callTaskAction.findUnique({ where: { approvalToken } });
      return action ? toAction(action) : null;
    },

    async claimNoteCreation(actionId, noteText, now) {
      const claimed = await database.callTaskAction.updateMany({
        where: { id: actionId, status: "task_confirmed" },
        data: { status: "creating_note", noteText },
      });
      return claimed.count === 1 ? readById(actionId) : null;
    },

    async markNoteConfirmed(actionId, noteId, now) {
      const confirmed = await database.callTaskAction.updateMany({
        where: { id: actionId, status: "creating_note" },
        data: { status: "confirmed", ...(noteId === null ? {} : { amoNoteId: noteId }), failureReason: null },
      });
      return confirmed.count === 1 ? readById(actionId) : null;
    },

    async rejectProposal(actionId, reviewerTelegramUserId, now) {
      const rejected = await database.callTaskAction.updateMany({
        where: { id: actionId, status: "proposed", decision: "review" },
        data: {
          status: "rejected",
          reviewedByTelegramUserId: reviewerTelegramUserId,
          reviewedAt: now,
          failureReason: "proposal rejected by reviewer",
        },
      });
      return rejected.count === 1 ? readById(actionId) : null;
    },
  };
}

export function createPrismaCallTaskAutomationActionPersistence(
  database: PrismaClient,
): CallTaskAutomationActionPersistence {
  return createActionAdapter(database);
}
