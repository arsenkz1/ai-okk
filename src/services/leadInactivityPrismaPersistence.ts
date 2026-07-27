import type { PrismaClient } from "../generated/prisma/client";
import type {
  LeadInactivityEventInput,
  LeadInactivityMoveAudit,
  LeadInactivityMoveAuditOutcome,
  LeadInactivityDailyMovementSlot,
  LeadInactivityDailyMovementSlotState,
  LeadInactivityPersistence,
  LeadInactivityTestSlot,
  LeadInactivityTestSlotState,
  LeadInactivityWatch,
  LeadInactivityWatchState,
} from "./leadInactivityStore";

type PrismaInactivityDb = Pick<
  PrismaClient,
  | "leadInactivitySetting"
  | "leadInactivityEvent"
  | "leadInactivityWatch"
  | "leadInactivityMoveAudit"
  | "leadInactivityTestSlot"
  | "leadInactivityDailyMovementSlot"
>;

type TransactionRunner = <T>(operation: (database: PrismaInactivityDb) => Promise<T>) => Promise<T>;

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function isTransactionConflictError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2034";
}

const WATCH_STATES = new Set<LeadInactivityWatchState>(["watching", "leased", "mutating", "moved", "outside_scope", "skipped", "uncertain"]);
const TEST_SLOT_STATES = new Set<LeadInactivityTestSlotState>(["free", "reserved", "confirmed", "uncertain"]);
const DAILY_MOVEMENT_SLOT_STATES = new Set<LeadInactivityDailyMovementSlotState>(["free", "reserved", "confirmed", "uncertain"]);

function toWatch(record: Omit<LeadInactivityWatch, "state"> & { state: string }): LeadInactivityWatch {
  if (!WATCH_STATES.has(record.state as LeadInactivityWatchState)) {
    throw new Error(`unknown lead inactivity watch state: ${record.state}`);
  }
  return { ...record, state: record.state as LeadInactivityWatchState };
}

function toSlot(record: Omit<LeadInactivityTestSlot, "state"> & { state: string }): LeadInactivityTestSlot {
  if (!TEST_SLOT_STATES.has(record.state as LeadInactivityTestSlotState)) {
    throw new Error(`unknown lead inactivity test slot state: ${record.state}`);
  }
  return { ...record, state: record.state as LeadInactivityTestSlotState };
}

function toDailyMovementSlot(
  record: Omit<LeadInactivityDailyMovementSlot, "state"> & { state: string },
): LeadInactivityDailyMovementSlot {
  if (!DAILY_MOVEMENT_SLOT_STATES.has(record.state as LeadInactivityDailyMovementSlotState)) {
    throw new Error(`unknown daily movement slot state: ${record.state}`);
  }
  return { ...record, state: record.state as LeadInactivityDailyMovementSlotState };
}

function createAdapter(database: PrismaInactivityDb, transactionRunner?: TransactionRunner): LeadInactivityPersistence {
  return {
    async transaction<T>(operation: (persistence: LeadInactivityPersistence) => Promise<T>): Promise<T> {
      if (!transactionRunner) return operation(createAdapter(database));
      return transactionRunner((transaction) => operation(createAdapter(transaction)));
    },

    async getSetting(key: string): Promise<string | null> {
      const setting = await database.leadInactivitySetting.findUnique({
        where: { key },
        select: { value: true },
      });
      return setting?.value ?? null;
    },

    async createSettingIfAbsent(key: string, value: string): Promise<string> {
      const setting = await database.leadInactivitySetting.upsert({
        where: { key },
        create: { key, value },
        update: {},
        select: { value: true },
      });
      return setting.value;
    },

    async insertEventIfAbsent(event: LeadInactivityEventInput): Promise<boolean> {
      try {
        await database.leadInactivityEvent.create({
          data: {
            fingerprint: event.fingerprint,
            leadId: event.leadId,
            eventType: event.eventType,
            eventAt: event.eventAt,
            receivedAt: event.receivedAt,
          },
          select: { id: true },
        });
        return true;
      } catch (error) {
        if (isUniqueConstraintError(error)) return false;
        throw error;
      }
    },

    async hasProductionBaselineEvent(leadId: number): Promise<boolean> {
      const event = await database.leadInactivityEvent.findFirst({
        where: { leadId, eventType: "production_baseline" },
        select: { id: true },
      });
      return Boolean(event);
    },

    async getWatch(leadId: number): Promise<LeadInactivityWatch | null> {
      const watch = await database.leadInactivityWatch.findUnique({ where: { leadId } });
      return watch ? toWatch(watch) : null;
    },

    async createWatchIfAbsent(watch: LeadInactivityWatch): Promise<LeadInactivityWatch> {
      const createdOrExisting = await database.leadInactivityWatch.upsert({
        where: { leadId: watch.leadId },
        create: {
          leadId: watch.leadId,
          leadCreatedAt: watch.leadCreatedAt,
          lastActivityAt: watch.lastActivityAt,
          lastActivityReceivedAt: watch.lastActivityReceivedAt,
          dueAt: watch.dueAt,
          pipelineId: watch.pipelineId,
          statusId: watch.statusId,
          cycle: watch.cycle,
          state: watch.state,
          leaseToken: watch.leaseToken,
          leaseExpiresAt: watch.leaseExpiresAt,
          leaseGeneration: watch.leaseGeneration,
          lastEventFingerprint: watch.lastEventFingerprint,
        },
        update: {},
      });
      return toWatch(createdOrExisting);
    },

    async advanceWatchIfNewer(leadId: number, next: LeadInactivityWatch): Promise<LeadInactivityWatch | null> {
      const advanced = await database.leadInactivityWatch.updateMany({
        where: {
          leadId,
          OR: [
            { lastActivityAt: { lt: next.lastActivityAt } },
            {
              lastActivityAt: next.lastActivityAt,
              lastActivityReceivedAt: { lt: next.lastActivityReceivedAt },
            },
          ],
        },
        data: {
          lastActivityAt: next.lastActivityAt,
          lastActivityReceivedAt: next.lastActivityReceivedAt,
          dueAt: next.dueAt,
          pipelineId: next.pipelineId,
          statusId: next.statusId,
          cycle: next.cycle,
          state: "watching",
          leaseToken: null,
          leaseExpiresAt: null,
          lastEventFingerprint: next.lastEventFingerprint,
          stoppedAt: null,
          lastFailureReason: null,
        },
      });
      if (advanced.count !== 1) return null;
      const watch = await database.leadInactivityWatch.findUnique({ where: { leadId } });
      return watch ? toWatch(watch) : null;
    },

    async markWatchUncertainForOrderConflict(leadId: number, eventAt: Date, receivedAt: Date): Promise<LeadInactivityWatch | null> {
      const marked = await database.leadInactivityWatch.updateMany({
        where: { leadId, lastActivityAt: eventAt, lastActivityReceivedAt: receivedAt },
        data: {
          state: "uncertain",
          leaseToken: null,
          leaseExpiresAt: null,
          lastFailureReason: "ambiguous amoCRM event order; requires fresh read",
        },
      });
      if (marked.count !== 1) return null;
      const watch = await database.leadInactivityWatch.findUnique({ where: { leadId } });
      return watch ? toWatch(watch) : null;
    },

    async claimDueWatch(
      leadId: number,
      now: Date,
      leaseToken: string,
      leaseExpiresAt: Date
    ): Promise<LeadInactivityWatch | null> {
      const claimed = await database.leadInactivityWatch.updateMany({
        where: { leadId, state: "watching", dueAt: { lte: now } },
        data: { state: "leased", leaseToken, leaseExpiresAt, leaseGeneration: { increment: 1 } },
      });
      if (claimed.count !== 1) return null;

      const watch = await database.leadInactivityWatch.findFirst({
        where: { leadId, state: "leased", leaseToken },
      });
      return watch ? toWatch(watch) : null;
    },

    async listDueWatchLeadIds(now: Date, limit: number): Promise<number[]> {
      const watches = await database.leadInactivityWatch.findMany({
        where: { state: "watching", dueAt: { lte: now } },
        orderBy: [{ dueAt: "asc" }, { leadId: "asc" }],
        take: limit,
        select: { leadId: true },
      });
      return watches.map((watch) => watch.leadId);
    },

    async isWatchClaimCurrent(claimed: LeadInactivityWatch): Promise<boolean> {
      const current = await database.leadInactivityWatch.findFirst({
        where: {
          leadId: claimed.leadId,
          state: "leased",
          leaseToken: claimed.leaseToken,
          leaseGeneration: claimed.leaseGeneration,
        },
        select: { leadId: true },
      });
      return current !== null;
    },

    async beginMoveMutation(claimed: LeadInactivityWatch): Promise<boolean> {
      const begun = await database.leadInactivityWatch.updateMany({
        where: {
          leadId: claimed.leadId,
          state: "leased",
          leaseToken: claimed.leaseToken,
          leaseGeneration: claimed.leaseGeneration,
        },
        data: { state: "mutating" },
      });
      return begun.count === 1;
    },

    async isMoveMutationCurrent(claimed: LeadInactivityWatch): Promise<boolean> {
      const current = await database.leadInactivityWatch.findFirst({
        where: {
          leadId: claimed.leadId,
          state: "mutating",
          leaseToken: claimed.leaseToken,
          leaseGeneration: claimed.leaseGeneration,
        },
        select: { leadId: true },
      });
      return current !== null;
    },

    async finishWatchClaim(
      claimed: LeadInactivityWatch,
      state: LeadInactivityWatchState,
      reason: string | null,
      now: Date,
    ): Promise<LeadInactivityWatch | null> {
      const finished = await database.leadInactivityWatch.updateMany({
        where: {
          leadId: claimed.leadId,
          state: { in: ["leased", "mutating"] },
          leaseToken: claimed.leaseToken,
          leaseGeneration: claimed.leaseGeneration,
        },
        data: {
          state,
          leaseToken: null,
          leaseExpiresAt: null,
          stoppedAt: state === "watching" ? null : now,
          lastFailureReason: reason,
        },
      });
      if (finished.count !== 1) return null;
      const watch = await database.leadInactivityWatch.findUnique({ where: { leadId: claimed.leadId } });
      return watch ? toWatch(watch) : null;
    },

    async createMoveAudit(audit: LeadInactivityMoveAudit): Promise<boolean> {
      try {
        await database.leadInactivityMoveAudit.create({
          data: {
            id: audit.id,
            leadId: audit.leadId,
            cycle: audit.cycle,
            outcome: "reserved",
            sourcePipelineId: audit.sourcePipelineId,
            sourceStatusId: audit.sourceStatusId,
            targetPipelineId: audit.targetPipelineId,
            targetStatusId: audit.targetStatusId,
            eventCutoffAt: audit.eventCutoffAt,
          },
          select: { id: true },
        });
        return true;
      } catch (error) {
        if (isUniqueConstraintError(error)) return false;
        throw error;
      }
    },

    async completeMoveAudit(auditId: string, outcome: LeadInactivityMoveAuditOutcome, now: Date): Promise<boolean> {
      const completed = await database.leadInactivityMoveAudit.updateMany({
        where: { id: auditId, outcome: "reserved" },
        data: {
          outcome: outcome.kind,
          slotNumber: outcome.slotNumber,
          completedAt: now,
        },
      });
      return completed.count === 1;
    },

    async releaseExpiredWatchLeases(now: Date): Promise<void> {
      await database.leadInactivityWatch.updateMany({
        where: { state: { in: ["leased", "mutating"] }, leaseExpiresAt: { lte: now } },
        data: { state: "watching", leaseToken: null, leaseExpiresAt: null },
      });
    },

    async ensureTestSlots(limit: number): Promise<void> {
      for (let slotNumber = 1; slotNumber <= limit; slotNumber += 1) {
        await database.leadInactivityTestSlot.upsert({
          where: { slotNumber },
          create: { slotNumber, state: "free" },
          update: {},
          select: { slotNumber: true },
        });
      }
    },

    async reserveFreeTestSlot(
      leadId: number,
      auditId: string,
      now: Date,
      leaseExpiresAt: Date
    ): Promise<LeadInactivityTestSlot | null> {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = await database.leadInactivityTestSlot.findFirst({
          where: { state: "free" },
          orderBy: { slotNumber: "asc" },
          select: { slotNumber: true },
        });
        if (!candidate) return null;

        const reserved = await database.leadInactivityTestSlot.updateMany({
          where: { slotNumber: candidate.slotNumber, state: "free" },
          data: { state: "reserved", leadId, auditId, reservedAt: now, leaseExpiresAt },
        });
        if (reserved.count !== 1) continue;

        const slot = await database.leadInactivityTestSlot.findFirst({
          where: { slotNumber: candidate.slotNumber, state: "reserved", auditId },
        });
        return slot ? toSlot(slot) : null;
      }
      return null;
    },

    async confirmTestSlot(slotNumber: number, auditId: string, confirmedAt: Date): Promise<LeadInactivityTestSlot | null> {
      const confirmed = await database.leadInactivityTestSlot.updateMany({
        where: { slotNumber, state: "reserved", auditId },
        data: { state: "confirmed", confirmedAt, leaseExpiresAt: null },
      });
      if (confirmed.count !== 1) return null;

      const slot = await database.leadInactivityTestSlot.findFirst({
        where: { slotNumber, state: "confirmed", auditId },
      });
      return slot ? toSlot(slot) : null;
    },

    async releaseTestSlotAfterKnownNoMove(slotNumber: number, auditId: string): Promise<boolean> {
      const released = await database.leadInactivityTestSlot.updateMany({
        where: { slotNumber, state: "reserved", auditId },
        data: {
          state: "free",
          leadId: null,
          auditId: null,
          reservedAt: null,
          confirmedAt: null,
          leaseExpiresAt: null,
        },
      });
      return released.count === 1;
    },

    async markTestSlotUncertain(slotNumber: number, auditId: string, uncertainAt: Date): Promise<LeadInactivityTestSlot | null> {
      const marked = await database.leadInactivityTestSlot.updateMany({
        where: { slotNumber, state: "reserved", auditId },
        data: { state: "uncertain", confirmedAt: uncertainAt, leaseExpiresAt: null },
      });
      if (marked.count !== 1) return null;

      const slot = await database.leadInactivityTestSlot.findFirst({
        where: { slotNumber, state: "uncertain", auditId },
      });
      return slot ? toSlot(slot) : null;
    },

    async markExpiredTestSlotLeasesUncertain(now: Date): Promise<void> {
      await database.leadInactivityTestSlot.updateMany({
        where: { state: "reserved", leaseExpiresAt: { lte: now } },
        data: { state: "uncertain", confirmedAt: now, leaseExpiresAt: null },
      });
    },

    async hasUncertainTestSlot(): Promise<boolean> {
      const slot = await database.leadInactivityTestSlot.findFirst({
        where: { state: "uncertain" },
        select: { slotNumber: true },
      });
      return slot !== null;
    },

    async ensureDailyMovementSlots(bucketDate: string, limit: number): Promise<void> {
      for (let slotNumber = 1; slotNumber <= limit; slotNumber += 1) {
        await database.leadInactivityDailyMovementSlot.upsert({
          where: { bucketDate_slotNumber: { bucketDate, slotNumber } },
          create: { bucketDate, slotNumber, state: "free" },
          update: {},
          select: { slotNumber: true },
        });
      }
    },

    async hasAvailableDailyMovementSlot(bucketDate: string): Promise<boolean> {
      const slot = await database.leadInactivityDailyMovementSlot.findFirst({
        where: { bucketDate, state: "free" },
        select: { slotNumber: true },
      });
      return slot !== null;
    },

    async reserveFreeDailyMovementSlot(
      bucketDate: string,
      leadId: number,
      auditId: string,
      now: Date,
      leaseExpiresAt: Date,
    ): Promise<LeadInactivityDailyMovementSlot | null> {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = await database.leadInactivityDailyMovementSlot.findFirst({
          where: { bucketDate, state: "free" },
          orderBy: { slotNumber: "asc" },
          select: { slotNumber: true },
        });
        if (!candidate) return null;

        const reserved = await database.leadInactivityDailyMovementSlot.updateMany({
          where: { bucketDate, slotNumber: candidate.slotNumber, state: "free" },
          data: { state: "reserved", leadId, auditId, reservedAt: now, leaseExpiresAt },
        });
        if (reserved.count !== 1) continue;

        const slot = await database.leadInactivityDailyMovementSlot.findFirst({
          where: { bucketDate, slotNumber: candidate.slotNumber, state: "reserved", auditId },
        });
        return slot ? toDailyMovementSlot(slot) : null;
      }
      return null;
    },

    async confirmDailyMovementSlot(
      bucketDate: string,
      slotNumber: number,
      auditId: string,
      confirmedAt: Date,
    ): Promise<LeadInactivityDailyMovementSlot | null> {
      const confirmed = await database.leadInactivityDailyMovementSlot.updateMany({
        where: { bucketDate, slotNumber, state: "reserved", auditId },
        data: { state: "confirmed", confirmedAt, leaseExpiresAt: null },
      });
      if (confirmed.count !== 1) return null;

      const slot = await database.leadInactivityDailyMovementSlot.findFirst({
        where: { bucketDate, slotNumber, state: "confirmed", auditId },
      });
      return slot ? toDailyMovementSlot(slot) : null;
    },

    async releaseDailyMovementSlotAfterKnownNoMove(bucketDate: string, slotNumber: number, auditId: string): Promise<boolean> {
      const released = await database.leadInactivityDailyMovementSlot.updateMany({
        where: { bucketDate, slotNumber, state: "reserved", auditId },
        data: {
          state: "free",
          leadId: null,
          auditId: null,
          reservedAt: null,
          confirmedAt: null,
          leaseExpiresAt: null,
        },
      });
      return released.count === 1;
    },

    async markExpiredDailyMovementSlotLeasesUncertain(bucketDate: string, now: Date): Promise<void> {
      await database.leadInactivityDailyMovementSlot.updateMany({
        where: { bucketDate, state: "reserved", leaseExpiresAt: { lte: now } },
        data: { state: "uncertain", confirmedAt: now, leaseExpiresAt: null },
      });
    },

    async markDailyMovementSlotUncertain(
      bucketDate: string,
      slotNumber: number,
      auditId: string,
      uncertainAt: Date,
    ): Promise<LeadInactivityDailyMovementSlot | null> {
      const marked = await database.leadInactivityDailyMovementSlot.updateMany({
        where: { bucketDate, slotNumber, state: "reserved", auditId },
        data: { state: "uncertain", confirmedAt: uncertainAt, leaseExpiresAt: null },
      });
      if (marked.count !== 1) return null;

      const slot = await database.leadInactivityDailyMovementSlot.findFirst({
        where: { bucketDate, slotNumber, state: "uncertain", auditId },
      });
      return slot ? toDailyMovementSlot(slot) : null;
    },
  };
}

export function createPrismaLeadInactivityPersistence(database: PrismaClient): LeadInactivityPersistence {
  const transactionRunner: TransactionRunner = async <T>(operation: (transaction: PrismaInactivityDb) => Promise<T>): Promise<T> => {
    let lastConflict: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await database.$transaction(
          (transaction) => operation(transaction as PrismaInactivityDb),
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
