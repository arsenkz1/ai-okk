import { randomUUID } from "node:crypto";
import { prisma } from "../config/database";
import { isInactivityDailyCapDisabled, isInactivityMovementPaused } from "./inactivityMovementSwitch";
import { createRecentTouchGuard, type DailySlotTicket, type SweepCandidate, type SweepMoveDependencies } from "./inactivitySweep";
import { almatyDailyMovementBucket, dailyMovementLimitForBucket } from "./leadInactivityDailyCap";
import { createPrismaLeadInactivityPersistence } from "./leadInactivityPrismaPersistence";
import { createLeadInactivityStore, type LeadInactivityStore } from "./leadInactivityStore";
import { createLeadInactivityAmoClient, type AmoInactivityLead } from "./leadInactivityAmoClient";
import { TARGET_PIPELINE_ID, TARGET_STATUS_ID } from "./leadInactivityPolicy";

/**
 * Production wiring shared by both sweeps — the confirmed one behind
 * /inactivity_on and the unattended nightly one — so they cannot drift apart:
 * same listing, same touch fence, same audit trail.
 */

export interface SweepRuntime extends Required<Pick<SweepMoveDependencies, "moveLeadToTarget" | "isStopped" | "hasRecentTouch" | "onMoved" | "onUncertain" | "reserveDailySlot">> {
  listEligibleLeads(): Promise<AmoInactivityLead[]>;
}

/** A ticket for when the cap is lifted: nothing to count, nothing to settle. */
const UNCAPPED_TICKET: DailySlotTicket = { confirm: async () => {}, release: async () => {}, markUncertain: async () => {} };

type SlotStore = Pick<LeadInactivityStore,
  "getDailyMovementOperationalStartDate" | "ensureDailyMovementSlots" | "reserveDailyMovementSlot"
  | "confirmDailyMovementSlot" | "releaseDailyMovementSlotAfterKnownNoMove" | "markDailyMovementSlotUncertain">;

/**
 * The sweeps draw from the same per-day slot table as the worker, so the cap
 * set with /inactivity_limit_on bounds every path, not the worker alone.
 */
export function createDailySlotReserver(dependencies: {
  store: SlotStore;
  isCapDisabled: () => Promise<boolean>;
  now?: () => Date;
  randomId?: () => string;
}): (candidate: SweepCandidate) => Promise<DailySlotTicket | null> {
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? randomUUID;
  const ensured = new Set<string>();
  return async (candidate) => {
    if (await dependencies.isCapDisabled()) return UNCAPPED_TICKET;
    const at = now();
    const bucket = almatyDailyMovementBucket(at, await dependencies.store.getDailyMovementOperationalStartDate());
    if (!ensured.has(bucket)) {
      await dependencies.store.ensureDailyMovementSlots(bucket, dailyMovementLimitForBucket(bucket));
      ensured.add(bucket);
    }
    const auditId = `sweep:${randomId()}`;
    const slot = await dependencies.store.reserveDailyMovementSlot(bucket, candidate.leadId, auditId, at);
    if (!slot) return null;
    return {
      confirm: async () => { await dependencies.store.confirmDailyMovementSlot(bucket, slot.slotNumber, auditId, now()); },
      release: () => dependencies.store.releaseDailyMovementSlotAfterKnownNoMove(bucket, slot.slotNumber, auditId),
      markUncertain: async () => { await dependencies.store.markDailyMovementSlotUncertain(bucket, slot.slotNumber, auditId, now()); },
    };
  };
}

/**
 * Sweep moves land in the same audit table as the worker's, so the Phoenix
 * block of the daily report counts them. Cycle 0 marks a move that belonged to
 * no watch cycle.
 */
async function recordSweepAudit(candidate: SweepCandidate, outcome: "confirmed" | "uncertain"): Promise<void> {
  const at = new Date();
  await prisma.leadInactivityMoveAudit.create({
    data: {
      leadId: candidate.leadId,
      cycle: 0,
      outcome,
      sourcePipelineId: candidate.pipelineId,
      sourceStatusId: candidate.statusId,
      targetPipelineId: TARGET_PIPELINE_ID,
      targetStatusId: TARGET_STATUS_ID,
      eventCutoffAt: candidate.lastTouchedAt,
      completedAt: at,
    },
  });
}

export function createSweepRuntime(environment: Record<string, string | undefined> = process.env): SweepRuntime | null {
  const baseUrl = environment.AMOCRM_BASE_URL?.trim();
  const accessToken = environment.AMOCRM_ACCESS_TOKEN?.trim();
  if (!baseUrl || !accessToken) return null;

  const amo = createLeadInactivityAmoClient({ baseUrl, accessToken });
  return {
    listEligibleLeads: () => amo.listAllowedSourceStageLeads(),
    moveLeadToTarget: (leadId, target) => amo.moveLeadToTarget(leadId, target),
    isStopped: () => isInactivityMovementPaused(),
    hasRecentTouch: createRecentTouchGuard({
      getWatchLastActivityAt: async (leadId) => (
        await prisma.leadInactivityWatch.findUnique({ where: { leadId }, select: { lastActivityAt: true } })
      )?.lastActivityAt ?? null,
      readLeadHistory: (leadId) => amo.readLeadHistory(leadId),
    }),
    onMoved: (candidate) => recordSweepAudit(candidate, "confirmed"),
    onUncertain: (candidate) => recordSweepAudit(candidate, "uncertain"),
    reserveDailySlot: createDailySlotReserver({
      store: createLeadInactivityStore(createPrismaLeadInactivityPersistence(prisma)),
      isCapDisabled: () => isInactivityDailyCapDisabled(),
    }),
  };
}
