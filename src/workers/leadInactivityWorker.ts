import { randomUUID } from "node:crypto";
import {
  INACTIVITY_STAGE_PRIORITY_GROUPS,
  isAllowedInactivitySourceStage,
  SOURCE_PIPELINE_IDS,
  TARGET_PIPELINE_ID,
  TARGET_STATUS_ID,
} from "../services/leadInactivityPolicy";
import type { AmoInactivityHistoryEvent, AmoInactivityLead, AmoInactivityMoveOutcome } from "../services/leadInactivityAmoClient";
import type {
  LeadInactivityDailyMovementSlot,
  LeadInactivityStagePair,
  LeadInactivityTestSlot,
  LeadInactivityWatch,
  LeadInactivityWatchState,
} from "../services/leadInactivityStore";
import { almatyDailyMovementBucket, dailyMovementLimitForBucket } from "../services/leadInactivityDailyCap";

export const LEAD_INACTIVITY_WORKER_INTERVAL_MS = 60_000;
export const LEAD_INACTIVITY_WORKER_MAX_WATCHES_PER_RUN = 5;

export interface LeadInactivityWorkerAudit {
  id: string;
  leadId: number;
  cycle: number;
  sourcePipelineId: number;
  sourceStatusId: number;
  targetPipelineId: number;
  targetStatusId: number;
  eventCutoffAt: Date;
}

export type LeadInactivityWorkerAuditOutcome =
  | { kind: "confirmed"; slotNumber: number | null }
  | { kind: "skipped"; slotNumber: null }
  | { kind: "uncertain"; slotNumber: number | null }
  | { kind: "failed"; slotNumber: number | null };

export interface LeadInactivityWorkerStore {
  isProductionBaselineComplete(): Promise<boolean>;
  getDailyMovementOperationalStartDate(): Promise<string>;
  tryAcquireWorkerRunLease(token: string, now?: Date): Promise<boolean>;
  renewWorkerRunLease(token: string, now?: Date): Promise<boolean>;
  releaseWorkerRunLease(token: string, now?: Date): Promise<boolean>;
  releaseExpiredWatchLeases(now?: Date): Promise<void>;
  ensureTestSlots(limit: number): Promise<void>;
  listDueWatchLeadIds(now: Date, limit: number, stagePairs?: readonly LeadInactivityStagePair[]): Promise<number[]>;
  claimDueWatchForWorkerRun(leadId: number, workerRunToken: string, now?: Date): Promise<LeadInactivityWatch | null>;
  isWatchClaimCurrent(claimed: LeadInactivityWatch): Promise<boolean>;
  beginMoveMutation(claimed: LeadInactivityWatch): Promise<boolean>;
  isMoveMutationCurrent(claimed: LeadInactivityWatch): Promise<boolean>;
  createMoveAudit(audit: LeadInactivityWorkerAudit): Promise<void>;
  completeMoveAudit(auditId: string, outcome: LeadInactivityWorkerAuditOutcome, now?: Date): Promise<void>;
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
  finishWatchClaim(watch: LeadInactivityWatch, state: LeadInactivityWatchState, reason: string | null, now?: Date): Promise<void>;
  recordLeadEvent(input: {
    fingerprint: string;
    leadId: number;
    eventType: string;
    eventAt: Date;
    receivedAt: Date;
    leadCreatedAt: Date;
    pipelineId: number;
    statusId: number;
  }): Promise<unknown>;
}

export interface LeadInactivityWorkerAmoClient {
  readLead(leadId: number): Promise<AmoInactivityLead>;
  readLeadHistory(leadId: number): Promise<AmoInactivityHistoryEvent[]>;
  moveLeadToTarget(leadId: number, target: {
    sourcePipelineIds: readonly number[];
    targetPipelineId: number;
    targetStatusId: number;
  }, hooks?: {
    isMoveMutationCurrent?: () => Promise<boolean>;
    beforeFinalPatch?: () => Promise<"allow" | "daily_capacity_unavailable">;
    beforePatchSend?: () => Promise<"allow" | "daily_capacity_unavailable">;
  } | (() => Promise<boolean>)): Promise<AmoInactivityMoveOutcome>;
}

export interface LeadInactivityWorkerResult {
  scanned: number;
  claimed: number;
  moved: number;
  deferred: number;
  uncertain: number;
  failed: number;
}

export interface LeadInactivityWorker {
  runOnce(): Promise<LeadInactivityWorkerResult>;
}

export interface CreateLeadInactivityWorkerOptions {
  store: LeadInactivityWorkerStore;
  amo: LeadInactivityWorkerAmoClient;
  notifyAdmins?: (text: string) => Promise<void>;
  testingMode?: boolean;
  clock?: () => Date;
  randomId?: () => string;
  maxWatchesPerRun?: number;
}

function assertBatchLimit(value: number | undefined): number {
  const limit = value ?? LEAD_INACTIVITY_WORKER_MAX_WATCHES_PER_RUN;
  if (!Number.isInteger(limit) || limit <= 0 || limit > LEAD_INACTIVITY_WORKER_MAX_WATCHES_PER_RUN) {
    throw new Error(`lead inactivity worker batch limit must be between 1 and ${LEAD_INACTIVITY_WORKER_MAX_WATCHES_PER_RUN}`);
  }
  return limit;
}

function hasNewerDirectLeadHistory(history: AmoInactivityHistoryEvent[], watch: LeadInactivityWatch): AmoInactivityHistoryEvent | null {
  return history
    .filter((event) => event.entityType === "lead" && event.entityId === watch.leadId && event.createdAt > watch.lastActivityAt)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
}

function isFreshLeadCompatible(lead: AmoInactivityLead, watch: LeadInactivityWatch): boolean {
  return lead.id === watch.leadId
    && lead.createdAt.getTime() === watch.leadCreatedAt.getTime()
    && isAllowedInactivitySourceStage(lead.pipelineId, lead.statusId);
}

export function createLeadInactivityWorker(options: CreateLeadInactivityWorkerOptions): LeadInactivityWorker {
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const testingMode = options.testingMode ?? true;
  const maxWatchesPerRun = assertBatchLimit(options.maxWatchesPerRun);

  const listPrioritizedDueWatchLeadIds = async (now: Date): Promise<number[]> => {
    const leadIds: number[] = [];
    for (const stagePairs of INACTIVITY_STAGE_PRIORITY_GROUPS) {
      const remaining = maxWatchesPerRun - leadIds.length;
      if (remaining <= 0) break;
      leadIds.push(...await options.store.listDueWatchLeadIds(now, remaining, stagePairs));
    }
    return leadIds;
  };

  const processClaim = async (
    claimed: LeadInactivityWatch,
    now: Date,
    dailyBucketDate: string,
    operationalStartDate: string,
    result: LeadInactivityWorkerResult,
    renewWorkerRunLease: () => Promise<boolean>,
  ): Promise<void> => {
    const auditId = randomId();
    const dailyReservation = { slot: null as LeadInactivityDailyMovementSlot | null };
    let slot: LeadInactivityTestSlot | null = null;
    let dailySlotWasConfirmed = false;
    let patchDispatchedAt: Date | null = null;
    let mutationConfirmed = false;
    let confirmedMoveDurablyFinalized = false;
    let slotWasConfirmed = false;
    let watchWasFinalized = false;
    let auditCreated = false;
    try {
      await options.store.createMoveAudit({
        id: auditId,
        leadId: claimed.leadId,
        cycle: claimed.cycle,
        sourcePipelineId: claimed.pipelineId,
        sourceStatusId: claimed.statusId,
        targetPipelineId: TARGET_PIPELINE_ID,
        targetStatusId: TARGET_STATUS_ID,
        eventCutoffAt: claimed.lastActivityAt,
      });
      auditCreated = true;
      const freshLead = await options.amo.readLead(claimed.leadId);
      if (!isFreshLeadCompatible(freshLead, claimed)) {
        await options.store.finishWatchClaim(claimed, "outside_scope", "fresh amoCRM lead is no longer eligible", now);
        watchWasFinalized = true;
        await options.store.completeMoveAudit(auditId, { kind: "skipped", slotNumber: null });
        result.deferred += 1;
        return;
      }

      const newerHistory = hasNewerDirectLeadHistory(await options.amo.readLeadHistory(claimed.leadId), claimed);
      if (newerHistory) {
        await options.store.recordLeadEvent({
          fingerprint: `amo-inactivity-history:${claimed.leadId}:${newerHistory.id}`,
          leadId: claimed.leadId,
          eventType: "history_direct_lead",
          eventAt: newerHistory.createdAt,
          receivedAt: now,
          leadCreatedAt: freshLead.createdAt,
          pipelineId: freshLead.pipelineId,
          statusId: freshLead.statusId,
        });
        await options.store.completeMoveAudit(auditId, { kind: "skipped", slotNumber: null });
        result.deferred += 1;
        return;
      }

      if (!await options.store.isWatchClaimCurrent(claimed)) {
        await options.store.completeMoveAudit(auditId, { kind: "skipped", slotNumber: null });
        result.deferred += 1;
        return;
      }

      if (testingMode) {
        slot = await options.store.reserveTestSlot(claimed.leadId, auditId, now);
        if (!slot) {
          await options.store.finishWatchClaim(claimed, "watching", "testing movement capacity is unavailable", now);
          watchWasFinalized = true;
          await options.store.completeMoveAudit(auditId, { kind: "skipped", slotNumber: null });
          result.deferred += 1;
          return;
        }
      }

      if (!await options.store.beginMoveMutation(claimed)) {
        if (slot) await options.store.releaseTestSlotAfterKnownNoMove(slot.slotNumber, auditId);
        await options.store.completeMoveAudit(auditId, { kind: "skipped", slotNumber: null });
        result.deferred += 1;
        return;
      }
      const outcome = await options.amo.moveLeadToTarget(claimed.leadId, {
        sourcePipelineIds: SOURCE_PIPELINE_IDS,
        targetPipelineId: TARGET_PIPELINE_ID,
        targetStatusId: TARGET_STATUS_ID,
      }, {
        isMoveMutationCurrent: async (): Promise<boolean> => (
          await renewWorkerRunLease() && await options.store.isMoveMutationCurrent(claimed)
        ),
        ...(!testingMode ? {
          beforeFinalPatch: async (): Promise<"allow" | "daily_capacity_unavailable"> => {
            const finalNow = clock();
            const finalBucketDate = almatyDailyMovementBucket(finalNow, operationalStartDate);
            const finalLimit = dailyMovementLimitForBucket(finalBucketDate);
            if (finalBucketDate !== dailyBucketDate) {
              await options.store.ensureDailyMovementSlots(finalBucketDate, finalLimit);
            }
            dailyReservation.slot = await options.store.reserveDailyMovementSlot(finalBucketDate, claimed.leadId, auditId, finalNow);
            return dailyReservation.slot ? "allow" : "daily_capacity_unavailable";
          },
          beforePatchSend: async (): Promise<"allow" | "daily_capacity_unavailable"> => {
            const dispatchNow = clock();
            if (!dailyReservation.slot || almatyDailyMovementBucket(dispatchNow, operationalStartDate) !== dailyReservation.slot.bucketDate) {
              return "daily_capacity_unavailable";
            }
            patchDispatchedAt = dispatchNow;
            return "allow";
          },
        } : {}),
      });
      if (outcome.kind === "confirmed") {
        mutationConfirmed = true;
        if (slot) {
          await options.store.confirmTestSlot(slot.slotNumber, auditId, now);
          slotWasConfirmed = true;
        }
        if (dailyReservation.slot) {
          await options.store.confirmDailyMovementSlot(
            dailyReservation.slot.bucketDate,
            dailyReservation.slot.slotNumber,
            auditId,
            patchDispatchedAt ?? now,
          );
          dailySlotWasConfirmed = true;
        }
        await options.store.finishWatchClaim(claimed, "moved", null, now);
        watchWasFinalized = true;
        confirmedMoveDurablyFinalized = true;
        await options.store.completeMoveAudit(auditId, { kind: "confirmed", slotNumber: slot?.slotNumber ?? null });
        result.moved += 1;
        if (options.notifyAdmins) {
          try {
            await options.notifyAdmins(
              testingMode
                ? [
                  "✅ Тестовое перемещение по неактивности",
                  `Сделка: #${claimed.leadId}`,
                  `Тестовый слот: ${slot?.slotNumber}/${LEAD_INACTIVITY_WORKER_MAX_WATCHES_PER_RUN}`,
                ].join("\n")
                : ["✅ Перемещение по неактивности", `Сделка: #${claimed.leadId}`].join("\n"),
            );
          } catch {
            console.error(`[LeadInactivityWorker] admin notification failed for lead ${claimed.leadId}`);
          }
        }
        return;
      }
      if (outcome.kind === "uncertain") {
        if (slot) await options.store.markTestSlotUncertain(slot.slotNumber, auditId, now);
        if (dailyReservation.slot) await options.store.markDailyMovementSlotUncertain(dailyReservation.slot.bucketDate, dailyReservation.slot.slotNumber, auditId, now);
        await options.store.finishWatchClaim(claimed, "uncertain", "amoCRM mutation outcome is uncertain", now);
        watchWasFinalized = true;
        await options.store.completeMoveAudit(auditId, { kind: "uncertain", slotNumber: slot?.slotNumber ?? null });
        result.uncertain += 1;
        return;
      }

      if (outcome.kind === "not_moved" && outcome.reason === "daily_capacity_unavailable") {
        if (slot) await options.store.releaseTestSlotAfterKnownNoMove(slot.slotNumber, auditId);
        if (dailyReservation.slot) await options.store.releaseDailyMovementSlotAfterKnownNoMove(dailyReservation.slot.bucketDate, dailyReservation.slot.slotNumber, auditId);
        await options.store.finishWatchClaim(
          claimed,
          "watching",
          "daily movement capacity is unavailable; queued for the next Almaty day",
          now,
        );
        watchWasFinalized = true;
        await options.store.completeMoveAudit(auditId, { kind: "skipped", slotNumber: null });
        result.deferred += 1;
        return;
      }

      if (outcome.kind === "not_moved" && outcome.reason === "fence_cancelled") {
        if (slot) await options.store.releaseTestSlotAfterKnownNoMove(slot.slotNumber, auditId);
        if (dailyReservation.slot) await options.store.releaseDailyMovementSlotAfterKnownNoMove(dailyReservation.slot.bucketDate, dailyReservation.slot.slotNumber, auditId);
        await options.store.completeMoveAudit(auditId, { kind: "skipped", slotNumber: null });
        result.deferred += 1;
        return;
      }

      if (slot) await options.store.releaseTestSlotAfterKnownNoMove(slot.slotNumber, auditId);
      if (dailyReservation.slot) await options.store.releaseDailyMovementSlotAfterKnownNoMove(dailyReservation.slot.bucketDate, dailyReservation.slot.slotNumber, auditId);
      const state: LeadInactivityWatchState = outcome.reason === "not_in_source" ? "outside_scope" : "skipped";
      await options.store.finishWatchClaim(claimed, state, `amoCRM move was not confirmed: ${outcome.reason}`, now);
      watchWasFinalized = true;
      await options.store.completeMoveAudit(auditId, { kind: "skipped", slotNumber: null });
      result.deferred += 1;
    } catch {
      let safeToRetry = true;
      if (mutationConfirmed && !watchWasFinalized) {
        safeToRetry = false;
      }
      if (slot && !slotWasConfirmed && !mutationConfirmed) {
        try {
          await options.store.releaseTestSlotAfterKnownNoMove(slot.slotNumber, auditId);
        } catch {
          safeToRetry = false;
          try {
            await options.store.markTestSlotUncertain(slot.slotNumber, auditId, now);
          } catch {
            // The durable slot lease will become uncertain before capacity can be reused.
          }
        }
      } else if (slot && mutationConfirmed && !slotWasConfirmed) {
        safeToRetry = false;
        try {
          await options.store.markTestSlotUncertain(slot.slotNumber, auditId, now);
        } catch {
          // Retaining the reserved slot is safer than making capacity reusable.
        }
      }
      if (dailyReservation.slot && !dailySlotWasConfirmed && !mutationConfirmed) {
        try {
          await options.store.releaseDailyMovementSlotAfterKnownNoMove(dailyReservation.slot.bucketDate, dailyReservation.slot.slotNumber, auditId);
        } catch {
          safeToRetry = false;
          try {
            await options.store.markDailyMovementSlotUncertain(dailyReservation.slot.bucketDate, dailyReservation.slot.slotNumber, auditId, now);
          } catch {
            // The durable slot lease will become uncertain before daily capacity can be reused.
          }
        }
      } else if (dailyReservation.slot && mutationConfirmed && !dailySlotWasConfirmed) {
        safeToRetry = false;
        try {
          await options.store.markDailyMovementSlotUncertain(dailyReservation.slot.bucketDate, dailyReservation.slot.slotNumber, auditId, now);
        } catch {
          // Retaining the reserved daily capacity is safer than reusing it after a confirmed move.
        }
      }
      const capacityWasConfirmed = testingMode
        ? Boolean(slot && slotWasConfirmed)
        : Boolean(dailyReservation.slot && dailySlotWasConfirmed && (!slot || slotWasConfirmed));
      if (!watchWasFinalized) {
        try {
          await options.store.finishWatchClaim(
            claimed,
            capacityWasConfirmed && safeToRetry ? "moved" : (safeToRetry ? "watching" : "uncertain"),
            capacityWasConfirmed && safeToRetry
              ? null
              : (safeToRetry
                ? "worker failed before a confirmed movement"
                : (mutationConfirmed
                  ? "worker could not safely finalize a confirmed amoCRM movement"
                  : "worker could not safely release its reserved movement capacity")),
            now,
          );
          watchWasFinalized = true;
        } catch {
          // Lease expiry remains the final fence when durable completion is unavailable.
        }
      }
      if (auditCreated) {
        try {
          if (confirmedMoveDurablyFinalized) {
            await options.store.completeMoveAudit(auditId, { kind: "confirmed", slotNumber: slot?.slotNumber ?? null }, now);
          } else if (!safeToRetry) {
            await options.store.completeMoveAudit(auditId, { kind: "uncertain", slotNumber: slot?.slotNumber ?? null }, now);
          } else {
            await options.store.completeMoveAudit(auditId, { kind: "failed", slotNumber: slot?.slotNumber ?? null }, now);
          }
        } catch {
          // Audit is intentionally left reserved for manual recovery rather than overwritten blindly.
        }
      }
      if (confirmedMoveDurablyFinalized && !slot) result.moved += 1;
      else if (!safeToRetry && mutationConfirmed && !slot) result.uncertain += 1;
      else result.failed += 1;
    }
  };

  return {
    async runOnce(): Promise<LeadInactivityWorkerResult> {
      const now = clock();
      const result = { scanned: 0, claimed: 0, moved: 0, deferred: 0, uncertain: 0, failed: 0 };
      const runLeaseToken = randomId();
      if (!await options.store.tryAcquireWorkerRunLease(runLeaseToken, now)) return result;
      try {
        if (!testingMode && !await options.store.isProductionBaselineComplete()) {
          throw new Error("unrestricted production movement is blocked: durable production baseline is not complete");
        }
        await options.store.releaseExpiredWatchLeases(now);
        const operationalStartDate = testingMode
          ? "9999-12-31"
          : await options.store.getDailyMovementOperationalStartDate();
        const dailyBucketDate = almatyDailyMovementBucket(now, operationalStartDate);
        const dailyMovementLimit = dailyMovementLimitForBucket(dailyBucketDate);
        if (!testingMode) {
          await options.store.ensureDailyMovementSlots(dailyBucketDate, dailyMovementLimit);
          if (!await options.store.hasDailyMovementCapacity(dailyBucketDate, dailyMovementLimit)) {
            return result;
          }
        }
        if (testingMode) await options.store.ensureTestSlots(LEAD_INACTIVITY_WORKER_MAX_WATCHES_PER_RUN);
        const leadIds = await listPrioritizedDueWatchLeadIds(now);
        result.scanned = leadIds.length;
        for (const leadId of leadIds) {
          const claimed = await options.store.claimDueWatchForWorkerRun(leadId, runLeaseToken, clock());
          if (!claimed) continue;
          result.claimed += 1;
          await processClaim(
            claimed,
            now,
            dailyBucketDate,
            operationalStartDate,
            result,
            () => options.store.renewWorkerRunLease(runLeaseToken, clock()),
          );
          const currentDailyBucketDate = almatyDailyMovementBucket(clock(), operationalStartDate);
          const currentDailyMovementLimit = dailyMovementLimitForBucket(currentDailyBucketDate);
          if (
            result.uncertain > 0
            || (!testingMode && !await options.store.hasDailyMovementCapacity(currentDailyBucketDate, currentDailyMovementLimit))
          ) break;
        }
        return result;
      } finally {
        await options.store.releaseWorkerRunLease(runLeaseToken, clock());
      }
    },
  };
}
