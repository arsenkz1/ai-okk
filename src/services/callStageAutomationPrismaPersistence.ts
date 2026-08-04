import type { Prisma, PrismaClient } from "../generated/prisma/client";
import type {
  CallStageAutomationAction,
  CallStageAutomationLedgerPersistence,
  CallStageActionStatus,
} from "./callStageAutomationLedger";
import {
  CALL_STAGE_AUTOMATION_TEST_LIMIT,
  type CallStageAutomationPersistence,
  type CallStageAutomationTestSlot,
  type CallStageAutomationTestSlotState,
} from "./callStageAutomationStore";
import type { UZUMRequiredField, UZUMStageTargetKey } from "./callStagePolicy";

type PrismaCallStageAutomationDb = Pick<
  PrismaClient,
  "callStageAutomationSetting" | "callStageAutomationTestSlot" | "callStageAction"
>;

type TransactionRunner = <T>(operation: (database: PrismaCallStageAutomationDb) => Promise<T>) => Promise<T>;

const SLOT_STATES = new Set<CallStageAutomationTestSlotState>(["free", "reserved", "confirmed", "uncertain"]);
const ACTION_STATUSES = new Set<CallStageActionStatus>([
  "analyzing", "review", "pending_move", "moving", "blocked_missing_fields", "confirmed", "skipped", "uncertain",
]);
const ACTION_DECISIONS = new Set<NonNullable<CallStageAutomationAction["decision"]>>(["move", "review", "none"]);
const TARGET_KEYS = new Set<UZUMStageTargetKey>([
  "takenInWork", "qualified", "ozhop", "formalization", "partiallyPaid", "successful", "closedLost",
]);

function isTransactionConflictError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2034";
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function toSlot(record: {
  slotNumber: number;
  state: string;
  dealId: number | null;
  actionId: string | null;
  reservedAt: Date | null;
  confirmedAt: Date | null;
  leaseExpiresAt: Date | null;
}): CallStageAutomationTestSlot {
  if (!SLOT_STATES.has(record.state as CallStageAutomationTestSlotState)) {
    throw new Error(`unknown call-stage test slot state: ${record.state}`);
  }
  return {
    slotNumber: record.slotNumber,
    state: record.state as CallStageAutomationTestSlotState,
    dealId: record.dealId,
    actionId: record.actionId,
    reservedAt: record.reservedAt,
    confirmedAt: record.confirmedAt,
    leaseExpiresAt: record.leaseExpiresAt,
  };
}

function checkedFields(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((field) => typeof field !== "string")) {
    throw new Error("corrupt call-stage checkedFields");
  }
  return [...value];
}

function missingFields(value: unknown): UZUMRequiredField[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error("corrupt call-stage missingFields");
  return value.map((field) => {
    if (!field || typeof field !== "object" || !("id" in field) || !("name" in field)
      || typeof field.id !== "number" || typeof field.name !== "string") {
      throw new Error("corrupt call-stage missing field");
    }
    return { id: field.id, name: field.name };
  });
}

function toAction(record: {
  id: string;
  callId: number;
  dealId: number;
  testMode: boolean;
  status: string;
  decision: string | null;
  target: string | null;
  evidence: string | null;
  checkedFields: unknown;
  missingFields: unknown;
  amoNoteId: number | null;
  failureReason: string | null;
  analysisLeaseToken: string | null;
  analysisLeaseExpiresAt: Date | null;
  analysisLeaseGeneration: number;
  mutationLeaseToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CallStageAutomationAction {
  if (!ACTION_STATUSES.has(record.status as CallStageActionStatus)) {
    throw new Error(`unknown call-stage action status: ${record.status}`);
  }
  if (record.decision !== null && !ACTION_DECISIONS.has(record.decision as NonNullable<CallStageAutomationAction["decision"]>)) {
    throw new Error(`unknown call-stage action decision: ${record.decision}`);
  }
  if (record.target !== null && !TARGET_KEYS.has(record.target as UZUMStageTargetKey)) {
    throw new Error(`unknown call-stage action target: ${record.target}`);
  }
  return {
    ...record,
    status: record.status as CallStageActionStatus,
    decision: record.decision as CallStageAutomationAction["decision"],
    target: record.target as UZUMStageTargetKey | null,
    checkedFields: checkedFields(record.checkedFields),
    missingFields: missingFields(record.missingFields),
  };
}

function createStoreAdapter(
  database: PrismaCallStageAutomationDb,
  transactionRunner?: TransactionRunner,
): CallStageAutomationPersistence {
  return {
    async transaction<T>(operation: (persistence: CallStageAutomationPersistence) => Promise<T>): Promise<T> {
      if (!transactionRunner) return operation(createStoreAdapter(database));
      return transactionRunner((transaction) => operation(createStoreAdapter(transaction)));
    },
    async getSetting(key) {
      return (await database.callStageAutomationSetting.findUnique({ where: { key }, select: { value: true } }))?.value ?? null;
    },
    async createSettingIfAbsent(key, value) {
      const setting = await database.callStageAutomationSetting.upsert({
        where: { key }, create: { key, value }, update: {}, select: { value: true },
      });
      return setting.value;
    },
    async ensureTestSlots(limit) {
      for (let slotNumber = 1; slotNumber <= limit; slotNumber += 1) {
        await database.callStageAutomationTestSlot.upsert({
          where: { slotNumber }, create: { slotNumber, state: "free" }, update: {}, select: { slotNumber: true },
        });
      }
    },
    async findTestSlotForDeal(dealId) {
      const slot = await database.callStageAutomationTestSlot.findUnique({ where: { dealId } });
      return slot ? toSlot(slot) : null;
    },
    async reserveFreeTestSlot(dealId, actionId, now, leaseExpiresAt) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = await database.callStageAutomationTestSlot.findFirst({
          where: {
            state: "free",
            slotNumber: { gte: 1, lte: CALL_STAGE_AUTOMATION_TEST_LIMIT },
          },
          orderBy: { slotNumber: "asc" },
          select: { slotNumber: true },
        });
        if (!candidate) return null;
        try {
          const reserved = await database.callStageAutomationTestSlot.updateMany({
            where: { slotNumber: candidate.slotNumber, state: "free" },
            data: { state: "reserved", dealId, actionId, reservedAt: now, confirmedAt: null, leaseExpiresAt },
          });
          if (reserved.count !== 1) continue;
        } catch (error) {
          if (isUniqueConstraintError(error)) return null;
          throw error;
        }
        const slot = await database.callStageAutomationTestSlot.findFirst({
          where: { slotNumber: candidate.slotNumber, state: "reserved", actionId },
        });
        return slot ? toSlot(slot) : null;
      }
      return null;
    },
    async reclaimTestSlotLease(actionId, now, leaseExpiresAt) {
      const updated = await database.callStageAutomationTestSlot.updateMany({
        where: { state: "reserved", actionId }, data: { reservedAt: now, leaseExpiresAt },
      });
      if (updated.count !== 1) return null;
      const slot = await database.callStageAutomationTestSlot.findFirst({ where: { state: "reserved", actionId } });
      return slot ? toSlot(slot) : null;
    },
    async markExpiredTestSlotsUncertain(now) {
      return (await database.callStageAutomationTestSlot.updateMany({
        where: { state: "reserved", leaseExpiresAt: { lte: now } },
        data: { state: "uncertain", confirmedAt: now, leaseExpiresAt: null },
      })).count;
    },
    async confirmTestSlot(actionId, now) {
      const updated = await database.callStageAutomationTestSlot.updateMany({
        where: { state: "reserved", actionId }, data: { state: "confirmed", confirmedAt: now, leaseExpiresAt: null },
      });
      if (updated.count !== 1) return null;
      const slot = await database.callStageAutomationTestSlot.findFirst({ where: { state: "confirmed", actionId } });
      return slot ? toSlot(slot) : null;
    },
    async releaseTestSlotBeforePatch(actionId) {
      const updated = await database.callStageAutomationTestSlot.updateMany({
        where: { state: "reserved", actionId },
        data: { state: "free", dealId: null, actionId: null, reservedAt: null, confirmedAt: null, leaseExpiresAt: null },
      });
      return updated.count === 1;
    },
    async markTestSlotUncertain(actionId, now) {
      const updated = await database.callStageAutomationTestSlot.updateMany({
        where: { state: "reserved", actionId }, data: { state: "uncertain", confirmedAt: now, leaseExpiresAt: null },
      });
      if (updated.count !== 1) return null;
      const slot = await database.callStageAutomationTestSlot.findFirst({ where: { state: "uncertain", actionId } });
      return slot ? toSlot(slot) : null;
    },
  };
}

function createLedgerAdapter(database: PrismaCallStageAutomationDb): CallStageAutomationLedgerPersistence {
  const read = async (actionId: string): Promise<CallStageAutomationAction | null> => {
    const action = await database.callStageAction.findUnique({ where: { id: actionId } });
    return action ? toAction(action) : null;
  };
  return {
    async getActionByCall(callId) {
      const action = await database.callStageAction.findUnique({ where: { callId } });
      return action ? toAction(action) : null;
    },
    async createActionIfAbsent(input) {
      try {
        const action = await database.callStageAction.create({
          data: {
            id: input.id, callId: input.callId, dealId: input.dealId, testMode: input.testMode,
            status: "analyzing", analysisLeaseToken: input.analysisLeaseToken,
            analysisLeaseExpiresAt: input.analysisLeaseExpiresAt, analysisLeaseGeneration: 1,
          },
        });
        return { created: true, action: toAction(action) };
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const action = await database.callStageAction.findUnique({ where: { callId: input.callId } });
        if (!action) throw error;
        return { created: false, action: toAction(action) };
      }
    },
    async reclaimExpiredAnalysis(actionId, now, token, expiresAt) {
      const updated = await database.callStageAction.updateMany({
        where: { id: actionId, status: "analyzing", analysisLeaseExpiresAt: { lte: now } },
        data: { analysisLeaseToken: token, analysisLeaseExpiresAt: expiresAt, analysisLeaseGeneration: { increment: 1 } },
      });
      return updated.count === 1 ? read(actionId) : null;
    },
    async finalizeAnalysis(actionId, leaseToken, update) {
      const updated = await database.callStageAction.updateMany({
        where: { id: actionId, status: "analyzing", analysisLeaseToken: leaseToken },
        data: {
          status: update.status,
          decision: update.decision,
          target: update.target,
          evidence: update.evidence,
          failureReason: update.failureReason,
          analysisLeaseToken: null,
          analysisLeaseExpiresAt: null,
        },
      });
      return updated.count === 1 ? read(actionId) : null;
    },
    async claimMove(actionId, mutationLeaseToken) {
      const updated = await database.callStageAction.updateMany({
        where: { id: actionId, status: "pending_move", decision: "move" },
        data: { status: "moving", mutationLeaseToken },
      });
      return updated.count === 1 ? read(actionId) : null;
    },
    async isMoveCurrent(actionId, mutationLeaseToken) {
      const current = await database.callStageAction.count({
        where: { id: actionId, status: "moving", mutationLeaseToken },
      });
      return current === 1;
    },
    async markBlockedMissingFields(actionId, mutationLeaseToken, fields) {
      const updated = await database.callStageAction.updateMany({
        where: { id: actionId, status: "moving", mutationLeaseToken },
        data: {
          status: "blocked_missing_fields",
          missingFields: fields as unknown as Prisma.InputJsonValue,
          mutationLeaseToken: null,
        },
      });
      return updated.count === 1 ? read(actionId) : null;
    },
    async markMoveConfirmed(actionId, mutationLeaseToken, fields, noteId) {
      const updated = await database.callStageAction.updateMany({
        where: { id: actionId, status: "moving", mutationLeaseToken },
        data: { status: "confirmed", checkedFields: fields, amoNoteId: noteId, mutationLeaseToken: null, failureReason: null },
      });
      return updated.count === 1 ? read(actionId) : null;
    },
    async markMoveSkipped(actionId, mutationLeaseToken, reason) {
      const updated = await database.callStageAction.updateMany({
        where: { id: actionId, status: "moving", mutationLeaseToken },
        data: { status: "skipped", failureReason: reason, mutationLeaseToken: null },
      });
      return updated.count === 1 ? read(actionId) : null;
    },
    async markMoveUncertain(actionId, mutationLeaseToken, reason) {
      const updated = await database.callStageAction.updateMany({
        where: { id: actionId, status: "moving", mutationLeaseToken },
        data: { status: "uncertain", failureReason: reason, mutationLeaseToken: null },
      });
      return updated.count === 1 ? read(actionId) : null;
    },
  };
}

export function createPrismaCallStageAutomationStorePersistence(database: PrismaClient): CallStageAutomationPersistence {
  const transactionRunner: TransactionRunner = async <T>(operation): Promise<T> => {
    let lastConflict: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await database.$transaction(
          (transaction) => operation(transaction as PrismaCallStageAutomationDb),
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        if (!isTransactionConflictError(error)) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict;
  };
  return createStoreAdapter(database, transactionRunner);
}

export function createPrismaCallStageAutomationLedgerPersistence(database: PrismaClient): CallStageAutomationLedgerPersistence {
  return createLedgerAdapter(database);
}
