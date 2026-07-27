import { randomUUID } from "node:crypto";

export const INACTIVITY_MS = 72 * 60 * 60 * 1000;
export const ACTIVATION_BOUNDARY_SETTING_KEY = "lead_inactivity.activation_boundary";
export const PRODUCTION_BASELINE_SETTING_KEY = "lead_inactivity.production_baseline";
export const PRODUCTION_BASELINE_RUN_SETTING_KEY = "lead_inactivity.production_baseline_run";
export const PRODUCTION_BASELINE_COMPLETED_SETTING_KEY = "lead_inactivity.production_baseline_completed";
export const DEFAULT_WATCH_LEASE_MS = 5 * 60 * 1000;
export const DEFAULT_TEST_SLOT_LEASE_MS = 10 * 60 * 1000;
export const DEFAULT_DAILY_MOVEMENT_SLOT_LEASE_MS = 10 * 60 * 1000;
export const TESTING_LEADS_MOVEMENT_LIMIT = 5;

export type LeadInactivityWatchState = "watching" | "leased" | "mutating" | "moved" | "outside_scope" | "skipped" | "uncertain";
export type LeadInactivityTestSlotState = "free" | "reserved" | "confirmed" | "uncertain";
export type LeadInactivityDailyMovementSlotState = "free" | "reserved" | "confirmed" | "uncertain";

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

export interface LeadInactivityProductionBaselineInput {
  leadId: number;
  leadCreatedAt: Date;
  pipelineId: number;
  statusId: number;
}

export interface LeadInactivityProductionBaselineRun {
  runId: string;
  baselineAt: Date;
  alreadyCompleted: boolean;
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
  | { kind: "confirmed"; slotNumber: number | null }
  | { kind: "skipped"; slotNumber: null }
  | { kind: "uncertain"; slotNumber: number | null }
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

export interface LeadInactivityDailyMovementSlot {
  bucketDate: string;
  slotNumber: number;
  state: LeadInactivityDailyMovementSlotState;
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
  hasProductionBaselineEvent(leadId: number): Promise<boolean>;
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
  ensureDailyMovementSlots(bucketDate: string, limit: number): Promise<void>;
  hasAvailableDailyMovementSlot(bucketDate: string): Promise<boolean>;
  reserveFreeDailyMovementSlot(
    bucketDate: string,
    leadId: number,
    auditId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<LeadInactivityDailyMovementSlot | null>;
  confirmDailyMovementSlot(
    bucketDate: string,
    slotNumber: number,
    auditId: string,
    confirmedAt: Date,
  ): Promise<LeadInactivityDailyMovementSlot | null>;
  releaseDailyMovementSlotAfterKnownNoMove(bucketDate: string, slotNumber: number, auditId: string): Promise<boolean>;
  markExpiredDailyMovementSlotLeasesUncertain(bucketDate: string, now: Date): Promise<void>;
  markDailyMovementSlotUncertain(
    bucketDate: string,
    slotNumber: number,
    auditId: string,
    uncertainAt: Date,
  ): Promise<LeadInactivityDailyMovementSlot | null>;
}

export interface LeadInactivityStoreOptions {
  clock?: () => Date;
  randomId?: () => string;
  inactivityMs?: number;
  watchLeaseMs?: number;
  testSlotLeaseMs?: number;
  dailyMovementSlotLeaseMs?: number;
}

export type LeadInactivityRecordResult =
  | { ignored: true; duplicate: false; watch: null }
  | { ignored: false; duplicate: boolean; watch: LeadInactivityWatch; requiresFreshRead?: false }
  | { ignored: false; duplicate: false; watch: LeadInactivityWatch; requiresFreshRead: true };

export interface LeadInactivityStore {
  getOrCreateActivationBoundary(now?: Date): Promise<Date>;
  getOrCreateProductionBaseline(now?: Date): Promise<Date>;
  beginProductionBaseline(runId: string, now?: Date): Promise<LeadInactivityProductionBaselineRun>;
  isProductionBaselineComplete(): Promise<boolean>;
  completeProductionBaseline(run: LeadInactivityProductionBaselineRun): Promise<void>;
  recordLeadEvent(input: LeadInactivityEventInput): Promise<LeadInactivityRecordResult>;
  recordProductionBaseline(
    input: LeadInactivityProductionBaselineInput,
    baselineAt: Date,
  ): Promise<LeadInactivityRecordResult>;
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
  ensureDailyMovementSlots(bucketDate: string, limit: number): Promise<void>;
  hasDailyMovementCapacity(bucketDate: string, limit: number): Promise<boolean>;
  reserveDailyMovementSlot(
    bucketDate: string,
    leadId: number,
    auditId: string,
    now?: Date,
  ): Promise<LeadInactivityDailyMovementSlot | null>;
  confirmDailyMovementSlot(
    bucketDate: string,
    slotNumber: number,
    auditId: string,
    confirmedAt?: Date,
  ): Promise<LeadInactivityDailyMovementSlot>;
  releaseDailyMovementSlotAfterKnownNoMove(bucketDate: string, slotNumber: number, auditId: string): Promise<void>;
  markDailyMovementSlotUncertain(
    bucketDate: string,
    slotNumber: number,
    auditId: string,
    uncertainAt?: Date,
  ): Promise<LeadInactivityDailyMovementSlot>;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function assertDailyMovementBucketDate(bucketDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bucketDate)) {
    throw new Error("daily movement bucket date is invalid");
  }
}

function ceilToSecond(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / 1000) * 1000);
}

function compareWatchActivityOrder(watch: LeadInactivityWatch, next: LeadInactivityWatch): number {
  const eventAtOrder = watch.lastActivityAt.getTime() - next.lastActivityAt.getTime();
  if (eventAtOrder !== 0) return Math.sign(eventAtOrder);
  return Math.sign(watch.lastActivityReceivedAt.getTime() - next.lastActivityReceivedAt.getTime());
}

interface PersistedProductionBaselineRun {
  runId: string;
  baselineAt: string;
}

function parseProductionBaselineRun(value: string, name: string): PersistedProductionBaselineRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`${name} is invalid`);
  const candidate = parsed as { runId?: unknown; baselineAt?: unknown };
  if (typeof candidate.runId !== "string" || !candidate.runId.trim() || typeof candidate.baselineAt !== "string") {
    throw new Error(`${name} is invalid`);
  }
  if (Number.isNaN(new Date(candidate.baselineAt).getTime())) throw new Error(`${name} is invalid`);
  return { runId: candidate.runId, baselineAt: candidate.baselineAt };
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
  const dailyMovementSlotLeaseMs = options.dailyMovementSlotLeaseMs ?? DEFAULT_DAILY_MOVEMENT_SLOT_LEASE_MS;

  const getOrCreateTimestampSetting = async (key: string, now: Date, name: string): Promise<Date> => {
    if (Number.isNaN(now.getTime())) throw new Error(`${name} input is invalid`);
    const existing = await persistence.getSetting(key);
    if (existing) {
      const timestamp = new Date(existing);
      if (Number.isNaN(timestamp.getTime())) throw new Error(`${name} is invalid`);
      return timestamp;
    }
    const persisted = await persistence.createSettingIfAbsent(key, ceilToSecond(now).toISOString());
    const timestamp = new Date(persisted);
    if (Number.isNaN(timestamp.getTime())) throw new Error(`${name} is invalid`);
    return timestamp;
  };

  const recordEvent = async (
    input: LeadInactivityEventInput,
    enforceActivationBoundary: boolean,
  ): Promise<LeadInactivityRecordResult> => {
    assertPositiveInteger(input.leadId, "leadId");
    assertPositiveInteger(input.pipelineId, "pipelineId");
    assertPositiveInteger(input.statusId, "statusId");
    if (!input.fingerprint) throw new Error("fingerprint is required");
    if (Number.isNaN(input.eventAt.getTime()) || Number.isNaN(input.receivedAt.getTime()) || Number.isNaN(input.leadCreatedAt.getTime())) {
      throw new Error("lead inactivity event timestamps are invalid");
    }

    let historicalLead = false;
    if (enforceActivationBoundary) {
      const activationBoundary = await persistence.getSetting(ACTIVATION_BOUNDARY_SETTING_KEY);
      if (!activationBoundary) throw new Error("lead inactivity activation boundary is not initialized");
      const boundary = new Date(activationBoundary);
      if (Number.isNaN(boundary.getTime())) throw new Error("lead inactivity activation boundary is invalid");
      historicalLead = input.leadCreatedAt.getTime() <= boundary.getTime();
    }

    return persistence.transaction(async (transaction) => {
      if (historicalLead && !await transaction.hasProductionBaselineEvent(input.leadId)) {
        return { ignored: true, duplicate: false, watch: null };
      }
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
  };

  return {
    async getOrCreateActivationBoundary(now = clock()): Promise<Date> {
      return getOrCreateTimestampSetting(
        ACTIVATION_BOUNDARY_SETTING_KEY,
        now,
        "lead inactivity activation boundary",
      );
    },

    async getOrCreateProductionBaseline(now = clock()): Promise<Date> {
      return getOrCreateTimestampSetting(
        PRODUCTION_BASELINE_SETTING_KEY,
        now,
        "lead inactivity production baseline",
      );
    },

    async beginProductionBaseline(runId, now = clock()): Promise<LeadInactivityProductionBaselineRun> {
      if (!runId.trim()) throw new Error("lead inactivity production baseline run ID is required");
      const baselineAt = await getOrCreateTimestampSetting(
        PRODUCTION_BASELINE_SETTING_KEY,
        now,
        "lead inactivity production baseline",
      );
      const candidate = JSON.stringify({ runId, baselineAt: baselineAt.toISOString() });
      const persisted = parseProductionBaselineRun(
        await persistence.createSettingIfAbsent(PRODUCTION_BASELINE_RUN_SETTING_KEY, candidate),
        "lead inactivity production baseline run",
      );
      if (persisted.baselineAt !== baselineAt.toISOString()) {
        throw new Error("lead inactivity production baseline run does not match the durable baseline");
      }

      const completion = await persistence.getSetting(PRODUCTION_BASELINE_COMPLETED_SETTING_KEY);
      if (completion) {
        const completed = parseProductionBaselineRun(completion, "lead inactivity production baseline completion marker");
        if (completed.runId !== persisted.runId || completed.baselineAt !== persisted.baselineAt) {
          throw new Error("lead inactivity production baseline completion marker does not match the durable run");
        }
        return { runId: persisted.runId, baselineAt, alreadyCompleted: true };
      }
      if (persisted.runId !== runId) {
        throw new Error("lead inactivity production baseline run is already in progress");
      }
      return { runId, baselineAt, alreadyCompleted: false };
    },

    async isProductionBaselineComplete(): Promise<boolean> {
      const [baseline, run, completion] = await Promise.all([
        persistence.getSetting(PRODUCTION_BASELINE_SETTING_KEY),
        persistence.getSetting(PRODUCTION_BASELINE_RUN_SETTING_KEY),
        persistence.getSetting(PRODUCTION_BASELINE_COMPLETED_SETTING_KEY),
      ]);
      if (!baseline || !run || !completion) return false;
      const durableRun = parseProductionBaselineRun(run, "lead inactivity production baseline run");
      const completed = parseProductionBaselineRun(completion, "lead inactivity production baseline completion marker");
      if (
        durableRun.runId !== completed.runId
        || durableRun.baselineAt !== completed.baselineAt
        || durableRun.baselineAt !== baseline
      ) {
        throw new Error("lead inactivity production baseline completion marker does not match the durable run");
      }
      return true;
    },

    async completeProductionBaseline(run): Promise<void> {
      if (!run.runId.trim() || Number.isNaN(run.baselineAt.getTime())) {
        throw new Error("lead inactivity production baseline completion input is invalid");
      }
      if (run.alreadyCompleted) return;
      const [baseline, persistedRun] = await Promise.all([
        persistence.getSetting(PRODUCTION_BASELINE_SETTING_KEY),
        persistence.getSetting(PRODUCTION_BASELINE_RUN_SETTING_KEY),
      ]);
      if (!baseline || !persistedRun) throw new Error("lead inactivity production baseline run is not initialized");
      const durableRun = parseProductionBaselineRun(persistedRun, "lead inactivity production baseline run");
      if (
        durableRun.runId !== run.runId
        || durableRun.baselineAt !== run.baselineAt.toISOString()
        || durableRun.baselineAt !== baseline
      ) {
        throw new Error("lead inactivity production baseline completion must be owned by the durable run");
      }
      const completion = parseProductionBaselineRun(
        await persistence.createSettingIfAbsent(PRODUCTION_BASELINE_COMPLETED_SETTING_KEY, JSON.stringify(durableRun)),
        "lead inactivity production baseline completion marker",
      );
      if (completion.runId !== durableRun.runId || completion.baselineAt !== durableRun.baselineAt) {
        throw new Error("lead inactivity production baseline completion marker does not match the durable run");
      }
    },

    async recordLeadEvent(input): Promise<LeadInactivityRecordResult> {
      return recordEvent(input, true);
    },

    async recordProductionBaseline(input, baselineAt): Promise<LeadInactivityRecordResult> {
      if (Number.isNaN(baselineAt.getTime())) throw new Error("lead inactivity production baseline input is invalid");
      const persisted = await persistence.getSetting(PRODUCTION_BASELINE_SETTING_KEY);
      if (!persisted) throw new Error("lead inactivity production baseline is not initialized");
      const durableBaselineAt = new Date(persisted);
      if (Number.isNaN(durableBaselineAt.getTime())) throw new Error("lead inactivity production baseline is invalid");
      if (durableBaselineAt.getTime() !== baselineAt.getTime()) {
        throw new Error("lead inactivity production baseline timestamp must match the durable baseline");
      }
      return recordEvent({
        fingerprint: `amo-inactivity-production-baseline:${durableBaselineAt.toISOString()}:${input.leadId}`,
        leadId: input.leadId,
        eventType: "production_baseline",
        eventAt: durableBaselineAt,
        receivedAt: durableBaselineAt,
        leadCreatedAt: input.leadCreatedAt,
        pipelineId: input.pipelineId,
        statusId: input.statusId,
      }, false);
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

    async ensureDailyMovementSlots(bucketDate, limit): Promise<void> {
      assertDailyMovementBucketDate(bucketDate);
      assertPositiveInteger(limit, "daily movement limit");
      return persistence.ensureDailyMovementSlots(bucketDate, limit);
    },

    async hasDailyMovementCapacity(bucketDate, limit): Promise<boolean> {
      assertDailyMovementBucketDate(bucketDate);
      assertPositiveInteger(limit, "daily movement limit");
      return persistence.hasAvailableDailyMovementSlot(bucketDate);
    },

    async reserveDailyMovementSlot(bucketDate, leadId, auditId, now = clock()): Promise<LeadInactivityDailyMovementSlot | null> {
      assertDailyMovementBucketDate(bucketDate);
      assertPositiveInteger(leadId, "leadId");
      if (!auditId) throw new Error("auditId is required");
      if (Number.isNaN(now.getTime())) throw new Error("daily movement reservation time is invalid");
      const leaseExpiresAt = new Date(now.getTime() + dailyMovementSlotLeaseMs);
      return persistence.transaction(async (transaction) => {
        await transaction.markExpiredDailyMovementSlotLeasesUncertain(bucketDate, now);
        return transaction.reserveFreeDailyMovementSlot(bucketDate, leadId, auditId, now, leaseExpiresAt);
      });
    },

    async confirmDailyMovementSlot(bucketDate, slotNumber, auditId, confirmedAt = clock()): Promise<LeadInactivityDailyMovementSlot> {
      assertDailyMovementBucketDate(bucketDate);
      assertPositiveInteger(slotNumber, "daily movement slotNumber");
      if (!auditId) throw new Error("auditId is required");
      if (Number.isNaN(confirmedAt.getTime())) throw new Error("daily movement confirmation time is invalid");
      const confirmed = await persistence.transaction((transaction) =>
        transaction.confirmDailyMovementSlot(bucketDate, slotNumber, auditId, confirmedAt),
      );
      if (!confirmed) throw new Error(`unable to confirm daily movement slot ${bucketDate}/${slotNumber}`);
      return confirmed;
    },

    async releaseDailyMovementSlotAfterKnownNoMove(bucketDate, slotNumber, auditId): Promise<void> {
      assertDailyMovementBucketDate(bucketDate);
      assertPositiveInteger(slotNumber, "daily movement slotNumber");
      if (!auditId) throw new Error("auditId is required");
      const released = await persistence.transaction((transaction) =>
        transaction.releaseDailyMovementSlotAfterKnownNoMove(bucketDate, slotNumber, auditId),
      );
      if (!released) {
        throw new Error(`unable to release daily movement slot ${bucketDate}/${slotNumber} after a known no-move outcome`);
      }
    },

    async markDailyMovementSlotUncertain(bucketDate, slotNumber, auditId, uncertainAt = clock()): Promise<LeadInactivityDailyMovementSlot> {
      assertDailyMovementBucketDate(bucketDate);
      assertPositiveInteger(slotNumber, "daily movement slotNumber");
      if (!auditId) throw new Error("auditId is required");
      if (Number.isNaN(uncertainAt.getTime())) throw new Error("daily movement uncertainty time is invalid");
      const uncertain = await persistence.transaction((transaction) =>
        transaction.markDailyMovementSlotUncertain(bucketDate, slotNumber, auditId, uncertainAt),
      );
      if (!uncertain) throw new Error(`unable to mark daily movement slot ${bucketDate}/${slotNumber} uncertain`);
      return uncertain;
    },
  };
}
