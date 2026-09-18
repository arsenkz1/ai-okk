import { prisma } from "../config/database";
import { isInactivityMovementPaused } from "./inactivityMovementSwitch";
import { createRecentTouchGuard, type SweepCandidate, type SweepMoveDependencies } from "./inactivitySweep";
import { createLeadInactivityAmoClient, type AmoInactivityLead } from "./leadInactivityAmoClient";
import { TARGET_PIPELINE_ID, TARGET_STATUS_ID } from "./leadInactivityPolicy";

/**
 * Production wiring shared by both sweeps — the confirmed one behind
 * /inactivity_on and the unattended nightly one — so they cannot drift apart:
 * same listing, same touch fence, same audit trail.
 */

export interface SweepRuntime extends Required<Pick<SweepMoveDependencies, "moveLeadToTarget" | "isStopped" | "hasRecentTouch" | "onMoved" | "onUncertain">> {
  listEligibleLeads(): Promise<AmoInactivityLead[]>;
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
  };
}
