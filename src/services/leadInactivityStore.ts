import { randomUUID } from "node:crypto";

export const INACTIVITY_MS = 72 * 60 * 60 * 1000;
export const ACTIVATION_BOUNDARY_SETTING_KEY = "lead_inactivity.activation_boundary";
export const DEFAULT_WATCH_LEASE_MS = 5 * 60 * 1000;
export const DEFAULT_TEST_SLOT_LEASE_MS = 10 * 60 * 1000;
export const TESTING_LEADS_MOVEMENT_LIMIT = 5;

export type LeadInactivityWatchState = "watching" | "leased" | "mutating" | "moved" | "outside_scope" | "skipped" | "uncertain";
export type LeadInactivityTestSlotState = "free" | "reserved" | "confirmed" | "uncertain";

export interface LeadInactivityEventInput {
  fingerprint: string;
  leadId: number;
  eventType: string;
  eventAt: Date;
  receivedAt: Date;
  leadCreatedAt: Date;
  pipelineId: number;
  statusId: number;
}

export interface LeadInactivityWatch {
  leadId: number;
  leadCreatedAt: Date;
  lastActivityAt: Date;
  lastActivityReceivedAt: Date;
  dueAt: Date;
  pipelineId: number;
  statusId: number;
  cycle: number;
  state: LeadInactivityWatchState;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  leaseGeneration: number;
  lastEventFingerprint: string | null;
  stoppedAt?: Date | null;
  lastFailureReason?: string | null;
}

export interface LeadInactivityMoveAudit {
  id: string;
  leadId: number;
  cycle: number;
  sourcePipelineId: number;
  sourceStatusId: number;
  targetPipelineId: number;
  targetStatusId: number;
  eventCutoffAt: Date;
}

export type LeadInactivityMoveAuditOutcome =
  | { kind: "confirmed"; slotNumber: number }
  | { kind: "skipped"; slotNumber: null }
  | { kind: "uncertain"; slotNumber: number }
  | { kind: "failed"; slotNumber: number | null };

export interface LeadInactivityTestSlot {
  slotNumber: number;
  state: LeadInactivityTestSlotState;
  leadId?: number | null;
  auditId?: string | null;
  reservedAt?: Date | null;
  confirmedAt?: Date | null;
  leaseExpiresAt?: Date | null;
}

export interface LeadInactivityPersistence {
  transaction<T>(operation: (persistence: LeadInactivityPersistence) => Promise<T>): Promise<T>;
  getSetting(key: string): Promise<string | null>;
  createSettingIfAbsent(key: string, value: string): Promise<string>;
  insertEventIfAbsent(event: LeadInactivityEventInput): Promise<boolean>;
  getWatch(leadId: number): Promise<LeadInactivityWatch | null>;
  createWatchIfAbsent(watch: LeadInactivityWatch): Promise<LeadInactivityWatch>;
  advanceWatchIfNewer(leadId: number, next: LeadInactivityWatch): Promise<LeadInactivityWatch | null>;
  markWatchUncertainForOrderConflict(leadId: number, eventAt: Date, receivedAt: Date): Promise<LeadInactivityWatch | null>;
  claimDueWatch(
    leadId: number,
    now: Date,
    leaseToken: string,
    leaseExpiresAt: Date
  ): Promise<LeadInactivityWatch | null>;
  listDueWatchLeadIds(now: Date, limit: number): Promise<number[]>;
  isWatchClaimCurrent(claimed: LeadInactivityWatch): Promise<boolean>;
  beginMoveMutation(claimed: LeadInactivityWatch): Promise<boolean>;
  isMoveMutationCurrent(claimed: LeadInactivityWatch): Promise<boolean>;
  finishWatchClaim(
    claimed: LeadInactivityWatch,
    state: LeadInactivityWatchState,
    reason: string | null,
    now: Date,
  ): Promise<LeadInactivityWatch | null>;
  createMoveAudit(audit: LeadInactivityMoveAudit): Promise<boolean>;
  completeMoveAudit(auditId: string, outcome: LeadInactivityMoveAuditOutcome, now: Date): Promise<boolean>;
  releaseExpiredWatchLeases(now: Date): Promise<void>;
  ensureTestSlots(limit: number): Promise<void>;
  reserveFreeTestSlot(
    leadId: number,
    auditId: string,
    now: Date,
    leaseExpiresAt: Date
  ): Promise<LeadInactivityTestSlot | null>;
  confirmTestSlot(slotNumber: number, auditId: string, confirmedAt: Date): Promise<LeadInactivityTestSlot | null>;
  releaseTestSlotAfterKnownNoMove(slotNumber: number, auditId: string): Promise<boolean>;
  markTestSlotUncertain(slotNumber: number, auditId: string, uncertainAt: Date): Promise<LeadInactivityTestSlot | null>;
  markExpiredTestSlotLeasesUncertain(now: Date): Promise<void>;
  hasUncertainTestSlot(): Promise<boolean>;
}

export interface LeadInactivityStoreOptions {
  clock?: () => Date;
  randomId?: () => string;
  inactivityMs?: number;
  watchLeaseMs?: number;
  testSlotLeaseMs?: number;
}

export type LeadInactivityRecordResult =
  | { ignored: true; duplicate: false; watch: null }
  | { ignored: false; duplicate: boolean; watch: LeadInactivityWatch; requiresFreshRead?: false }
  | { ignored: false; duplicate: false; watch: LeadInactivityWatch; requiresFreshRead: true };

export interface LeadInactivityStore {
  getOrCreateActivationBoundary(now?: Date): Promise<Date>;
  recordLeadEvent(input: LeadInactivityEventInput): Promise<LeadInactivityRecordResult>;
  listDueWatchLeadIds(now: Date, limit: number): Promise<number[]>;
  isWatchClaimCurrent(claimed: LeadInactivityWatch): Promise<boolean>;
  beginMoveMutation(claimed: LeadInactivityWatch): Promise<boolean>;
  isMoveMutationCurrent(claimed: LeadInactivityWatch): Promise<boolean>;
  claimDueWatch(leadId: number, now?: Date): Promise<LeadInactivityWatch | null>;
  finishWatchClaim(
    claimed: LeadInactivityWatch,
    state: LeadInactivityWatchState,
    reason: string | null,
    now?: Date,
  ): Promise<void>;
  createMoveAudit(audit: LeadInactivityMoveAudit): Promise<void>;
  completeMoveAudit(auditId: string, outcome: LeadInactivityMoveAuditOutcome, now?: Date): Promise<void>;
  releaseExpiredWatchLeases(now?: Date): Promise<void>;
  ensureTestSlots(limit: number): Promise<void>;
  reserveTestSlot(leadId: number, auditId: string, now?: Date): Promise<LeadInactivityTestSlot | null>;
  confirmTestSlot(slotNumber: number, auditId: string, confirmedAt?: Date): Promise<LeadInactivityTestSlot>;
  releaseTestSlotAfterKnownNoMove(slotNumber: number, auditId: string): Promise<void>;
  markTestSlotUncertain(slotNumber: number, auditId: string, uncertainAt?: Date): Promise<LeadInactivityTestSlot>;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function ceilToSecond(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / 1000) * 1000);
}

function compareWatchActivityOrder(watch: LeadInactivityWatch, next: LeadInactivityWatch): number {
  const eventAtOrder = watch.lastActivityAt.getTime() - next.lastActivityAt.getTime();
  if (eventAtOrder !== 0) return Math.sign(eventAtOrder);
  return Math.sign(watch.lastActivityReceivedAt.getTime() - next.lastActivityReceivedAt.getTime());
}

export function createLeadInactivityStore(
  persistence: LeadInactivityPersistence,
  options: LeadInactivityStoreOptions = {}
): LeadInactivityStore {
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const inactivityMs = options.inactivityMs ?? INACTIVITY_MS;
  assertPositiveInteger(inactivityMs, "inactivityMs");
  const watchLeaseMs = options.watchLeaseMs ?? DEFAULT_WATCH_LEASE_MS;
  const testSlotLeaseMs = options.testSlotLeaseMs ?? DEFAULT_TEST_SLOT_LEASE_MS;

  return {
    async getOrCreateActivationBoundary(now = clock()): Promise<Date> {
      if (Number.isNaN(now.getTime())) throw new Error("lead inactivity activation boundary input is invalid");
      const existing = await persistence.getSetting(ACTIVATION_BOUNDARY_SETTING_KEY);
      if (existing) {
        const boundary = new Date(existing);
        if (Number.isNaN(boundary.getTime())) throw new Error("lead inactivity activation boundary is invalid");
        return boundary;
      }

      const persisted = await persistence.createSettingIfAbsent(
        ACTIVATION_BOUNDARY_SETTING_KEY,
        ceilToSecond(now).toISOString()
      );
      return new Date(persisted);
    },

    async recordLeadEvent(input): Promise<LeadInactivityRecordResult> {
      assertPositiveInteger(input.leadId, "leadId");
      if (!input.fingerprint) throw new Error("fingerprint is required");

      const activationBoundary = await persistence.getSetting(ACTIVATION_BOUNDARY_SETTING_KEY);
      if (!activationBoundary) throw new Error("lead inactivity activation boundary is not initialized");
      const boundary = new Date(activationBoundary);
      if (Number.isNaN(boundary.getTime())) throw new Error("lead inactivity activation boundary is invalid");
      if (input.leadCreatedAt.getTime() <= boundary.getTime()) {
        return { ignored: true, duplicate: false, watch: null };
      }

      return persistence.transaction(async (transaction) => {
        const inserted = await transaction.insertEventIfAbsent(input);
        const existing = await transaction.getWatch(input.leadId);
        if (!inserted) {
          if (!existing) throw new Error(`duplicate event ${input.fingerprint} has no watch`);
          return { ignored: false, duplicate: true, watch: existing };
        }

        const next: LeadInactivityWatch = {
          leadId: input.leadId,
          leadCreatedAt: input.leadCreatedAt,
          lastActivityAt: input.eventAt,
          lastActivityReceivedAt: input.receivedAt,
          dueAt: new Date(input.eventAt.getTime() + inactivityMs),
          pipelineId: input.pipelineId,
          statusId: input.statusId,
          cycle: existing?.state === "moved" ? existing.cycle + 1 : (existing?.cycle ?? 1),
          state: "watching",
          leaseToken: null,
          leaseExpiresAt: null,
          leaseGeneration: existing?.leaseGeneration ?? 0,
          lastEventFingerprint: input.fingerprint,
        };

        const reconcileWithCurrentWatch = async (current: LeadInactivityWatch): Promise<LeadInactivityRecordResult> => {
          const order = compareWatchActivityOrder(current, next);
          if (order > 0) return { ignored: false, duplicate: false, watch: current };
          if (order === 0) {
            if (current.lastEventFingerprint === input.fingerprint) {
              return { ignored: false, duplicate: false, watch: current };
            }
            const uncertain = await transaction.markWatchUncertainForOrderConflict(
              input.leadId,
              input.eventAt,
              input.receivedAt,
            );
            if (!uncertain) throw new Error(`watch ${input.leadId} disappeared while flagging ambiguous event order`);
            return { ignored: false, duplicate: false, requiresFreshRead: true, watch: uncertain };
          }

          const advanced = await transaction.advanceWatchIfNewer(input.leadId, next);
          if (advanced) return { ignored: false, duplicate: false, watch: advanced };

          const concurrent = await transaction.getWatch(input.leadId);
          if (!concurrent) throw new Error(`watch ${input.leadId} disappeared while recording activity`);
          const concurrentOrder = compareWatchActivityOrder(concurrent, next);
          if (concurrentOrder > 0 || concurrent.lastEventFingerprint === input.fingerprint) {
            return { ignored: false, duplicate: false, watch: concurrent };
          }
          if (concurrentOrder === 0) {
            const uncertain = await transaction.markWatchUncertainForOrderConflict(
              input.leadId,
              input.eventAt,
              input.receivedAt,
            );
            if (!uncertain) throw new Error(`watch ${input.leadId} changed while flagging ambiguous event order`);
            return { ignored: false, duplicate: false, requiresFreshRead: true, watch: uncertain };
          }
          throw new Error(`watch ${input.leadId} did not advance to a newer event`);
        };

        if (!existing) {
          return reconcileWithCurrentWatch(await transaction.createWatchIfAbsent(next));
        }
        return reconcileWithCurrentWatch(existing);
      });
    },

    async listDueWatchLeadIds(now, limit): Promise<number[]> {
      if (Number.isNaN(now.getTime())) throw new Error("due-watch query time is invalid");
      assertPositiveInteger(limit, "due-watch query limit");
      return persistence.listDueWatchLeadIds(now, limit);
    },

    async isWatchClaimCurrent(claimed): Promise<boolean> {
      if (!claimed.leaseToken || !Number.isInteger(claimed.leaseGeneration) || claimed.leaseGeneration <= 0) return false;
      return persistence.isWatchClaimCurrent(claimed);
    },

    async beginMoveMutation(claimed): Promise<boolean> {
      if (!claimed.leaseToken || !Number.isInteger(claimed.leaseGeneration) || claimed.leaseGeneration <= 0) return false;
      return persistence.beginMoveMutation(claimed);
    },

    async isMoveMutationCurrent(claimed): Promise<boolean> {
      if (!claimed.leaseToken || !Number.isInteger(claimed.leaseGeneration) || claimed.leaseGeneration <= 0) return false;
      return persistence.isMoveMutationCurrent(claimed);
    },

    async claimDueWatch(leadId, now = clock()): Promise<LeadInactivityWatch | null> {
      assertPositiveInteger(leadId, "leadId");
      if (Number.isNaN(now.getTime())) throw new Error("due-watch claim time is invalid");
      const leaseExpiresAt = new Date(now.getTime() + watchLeaseMs);
      return persistence.claimDueWatch(leadId, now, randomId(), leaseExpiresAt);
    },

    async finishWatchClaim(claimed, state, reason, now = clock()): Promise<void> {
      assertPositiveInteger(claimed.leadId, "claimed leadId");
      if (!claimed.leaseToken || !Number.isInteger(claimed.leaseGeneration) || claimed.leaseGeneration <= 0) {
        throw new Error("claimed watch has no valid lease fence");
      }
      if (state === "leased") throw new Error("claimed watch cannot be finished in leased state");
      if (Number.isNaN(now.getTime())) throw new Error("claimed-watch completion time is invalid");
      const finished = await persistence.finishWatchClaim(claimed, state, reason, now);
      if (!finished) throw new Error(`unable to finish claimed watch ${claimed.leadId}; its lease fence is stale`);
    },

    async createMoveAudit(audit): Promise<void> {
      if (!audit.id) throw new Error("move audit id is required");
      assertPositiveInteger(audit.leadId, "move audit leadId");
      assertPositiveInteger(audit.cycle, "move audit cycle");
      assertPositiveInteger(audit.sourcePipelineId, "move audit sourcePipelineId");
      assertPositiveInteger(audit.sourceStatusId, "move audit sourceStatusId");
      assertPositiveInteger(audit.targetPipelineId, "move audit targetPipelineId");
      assertPositiveInteger(audit.targetStatusId, "move audit targetStatusId");
      if (Number.isNaN(audit.eventCutoffAt.getTime())) throw new Error("move audit event cutoff is invalid");
      const created = await persistence.createMoveAudit(audit);
      if (!created) throw new Error(`move audit ${audit.id} already exists`);
    },

    async completeMoveAudit(auditId, outcome, now = clock()): Promise<void> {
      if (!auditId) throw new Error("move audit id is required");
      if (Number.isNaN(now.getTime())) throw new Error("move audit completion time is invalid");
      const completed = await persistence.completeMoveAudit(auditId, outcome, now);
      if (!completed) throw new Error(`unable to complete move audit ${auditId}`);
    },

    async releaseExpiredWatchLeases(now = clock()): Promise<void> {
      if (Number.isNaN(now.getTime())) throw new Error("lease-release time is invalid");
      return persistence.releaseExpiredWatchLeases(now);
    },

    async ensureTestSlots(limit): Promise<void> {
      assertPositiveInteger(limit, "testing limit");
      if (limit !== TESTING_LEADS_MOVEMENT_LIMIT) {
        throw new Error(`testing limit must be exactly ${TESTING_LEADS_MOVEMENT_LIMIT}`);
      }
      return persistence.ensureTestSlots(limit);
    },

    async reserveTestSlot(leadId, auditId, now = clock()): Promise<LeadInactivityTestSlot | null> {
      assertPositiveInteger(leadId, "leadId");
      if (!auditId) throw new Error("auditId is required");
      const leaseExpiresAt = new Date(now.getTime() + testSlotLeaseMs);
      return persistence.transaction(async (transaction) => {
        await transaction.markExpiredTestSlotLeasesUncertain(now);
        if (await transaction.hasUncertainTestSlot()) return null;
        return transaction.reserveFreeTestSlot(leadId, auditId, now, leaseExpiresAt);
      });
    },

    async confirmTestSlot(slotNumber, auditId, confirmedAt = clock()): Promise<LeadInactivityTestSlot> {
      assertPositiveInteger(slotNumber, "slotNumber");
      if (!auditId) throw new Error("auditId is required");
      const confirmed = await persistence.transaction((transaction) =>
        transaction.confirmTestSlot(slotNumber, auditId, confirmedAt),
      );
      if (!confirmed) throw new Error(`unable to confirm reserved test slot ${slotNumber}`);
      return confirmed;
    },

    async releaseTestSlotAfterKnownNoMove(slotNumber, auditId): Promise<void> {
      assertPositiveInteger(slotNumber, "slotNumber");
      if (!auditId) throw new Error("auditId is required");
      const released = await persistence.transaction((transaction) =>
        transaction.releaseTestSlotAfterKnownNoMove(slotNumber, auditId),
      );
      if (!released) throw new Error(`unable to release reserved test slot ${slotNumber} after a known no-move outcome`);
    },

    async markTestSlotUncertain(slotNumber, auditId, uncertainAt = clock()): Promise<LeadInactivityTestSlot> {
      assertPositiveInteger(slotNumber, "slotNumber");
      if (!auditId) throw new Error("auditId is required");
      const uncertain = await persistence.transaction((transaction) =>
        transaction.markTestSlotUncertain(slotNumber, auditId, uncertainAt),
      );
      if (!uncertain) throw new Error(`unable to mark reserved test slot ${slotNumber} uncertain`);
      return uncertain;
    },
  };
}
