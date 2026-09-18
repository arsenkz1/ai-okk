import type { AmoInactivityLead, AmoInactivityMoveOutcome } from "./leadInactivityAmoClient";
import { INACTIVITY_MS, SOURCE_PIPELINE_IDS, TARGET_PIPELINE_ID, TARGET_STATUS_ID } from "./leadInactivityPolicy";

/**
 * Sweep of idle leads straight from amoCRM.
 *
 * The worker moves only leads it holds a watch for, and a watch exists only
 * because a webhook once reported a touch. Leads that never produced one —
 * historical deals, lost deliveries, watches cleared by an operator stop — sit
 * on their stage forever. The sweep is the reconciliation for that gap: it asks
 * amoCRM for every lead on an eligible stage idle for 3 days or more and moves
 * them. It runs on demand after /inactivity_on (behind a confirmation) and
 * unattended every night.
 *
 * amoCRM's `updated_at` selects the candidates, but it is not trusted alone:
 * each candidate is re-checked against the worker's own record and the lead's
 * event history right before its PATCH, the same fence the worker applies.
 */

/** Same rule as the worker: three days without a touch. */
export const SWEEP_IDLE_MS = INACTIVITY_MS;

export interface SweepCandidate {
  leadId: number;
  pipelineId: number;
  statusId: number;
  /** amoCRM updated_at; the moment the idle clock is measured from. */
  lastTouchedAt: Date;
}

/** Leads on an eligible stage idle for at least the window, longest-idle first. */
export function selectSweepCandidates(
  leads: readonly AmoInactivityLead[],
  now: Date,
  idleMs = SWEEP_IDLE_MS,
): SweepCandidate[] {
  const cutoff = now.getTime() - idleMs;
  const seen = new Set<number>();
  const candidates: SweepCandidate[] = [];

  for (const lead of leads) {
    if (seen.has(lead.id)) continue;
    seen.add(lead.id);
    if (!SOURCE_PIPELINE_IDS.includes(lead.pipelineId)) continue;
    if (lead.updatedAt.getTime() > cutoff) continue;
    candidates.push({
      leadId: lead.id,
      pipelineId: lead.pipelineId,
      statusId: lead.statusId,
      lastTouchedAt: lead.updatedAt,
    });
  }

  // Longest-idle first: if amoCRM starts failing part-way, the leads that most
  // needed moving are the ones already done.
  return candidates.sort((left, right) => left.lastTouchedAt.getTime() - right.lastTouchedAt.getTime());
}

export interface SweepCountByPipeline {
  pipelineId: number;
  count: number;
}

export function countByPipeline(candidates: readonly Pick<SweepCandidate, "pipelineId">[]): SweepCountByPipeline[] {
  const counter = new Map<number, number>();
  for (const candidate of candidates) counter.set(candidate.pipelineId, (counter.get(candidate.pipelineId) ?? 0) + 1);
  return [...counter.entries()]
    .map(([pipelineId, count]) => ({ pipelineId, count }))
    .sort((left, right) => right.count - left.count || left.pipelineId - right.pipelineId);
}

export interface RecentTouchGuardDependencies {
  /** The worker's own last-touch record for the lead, if it has one. */
  getWatchLastActivityAt(leadId: number): Promise<Date | null>;
  readLeadHistory(leadId: number): Promise<ReadonlyArray<{ entityType: string | null; entityId: number | null; createdAt: Date }>>;
  now?: () => Date;
  idleMs?: number;
}

/**
 * True when the lead was touched inside the idle window after all. A note or a
 * task does not reliably move amoCRM's `updated_at`, so a lead can look idle in
 * the listing while a manager is actively working it; webhooks and the event
 * history both see those touches.
 */
export function createRecentTouchGuard(
  dependencies: RecentTouchGuardDependencies,
): (candidate: SweepCandidate) => Promise<boolean> {
  const idleMs = dependencies.idleMs ?? SWEEP_IDLE_MS;
  return async (candidate) => {
    const since = (dependencies.now?.() ?? new Date()).getTime() - idleMs;
    // Cheapest first: a database row before an amoCRM request.
    const watched = await dependencies.getWatchLastActivityAt(candidate.leadId);
    if (watched && watched.getTime() > since) return true;
    const history = await dependencies.readLeadHistory(candidate.leadId);
    return history.some((event) => (
      event.entityType === "lead"
      && event.entityId === candidate.leadId
      && event.createdAt.getTime() > since
    ));
  };
}

export interface SweepMoveResult {
  moved: number;
  notMoved: number;
  uncertain: number;
  /** Looked idle by updated_at, but a touch inside the window was found. */
  skippedRecentTouch: number;
  /** The touch check itself failed; the lead was left alone rather than moved blind. */
  guardFailed: number;
  movedCandidates: SweepCandidate[];
  /** Set when the run was cut short; nothing after this index was attempted. */
  stoppedAt?: { index: number; reason: "uncertain" | "stopped" };
}

export interface SweepMoveDependencies {
  moveLeadToTarget(
    leadId: number,
    target: { sourcePipelineIds: readonly number[]; targetPipelineId: number; targetStatusId: number },
  ): Promise<AmoInactivityMoveOutcome>;
  /** Re-checked before every PATCH so a stop issued mid-sweep halts it. */
  isStopped?(): Promise<boolean>;
  hasRecentTouch?(candidate: SweepCandidate): Promise<boolean>;
  onMoved?(candidate: SweepCandidate): Promise<void>;
  onUncertain?(candidate: SweepCandidate): Promise<void>;
}

async function bestEffort(task: (() => Promise<void>) | undefined): Promise<void> {
  if (!task) return;
  try {
    await task();
  } catch (error) {
    // Bookkeeping must never turn a confirmed amoCRM move into a failed sweep.
    console.error("[InactivitySweep] post-move hook failed:", error instanceof Error ? error.message : error);
  }
}

/**
 * Moves the candidates one by one. Mirrors the worker's rule that an
 * `uncertain` outcome halts everything: amoCRM's state is no longer known, so
 * continuing blind could double-move or skip.
 */
export async function moveSweepCandidates(
  candidates: readonly SweepCandidate[],
  dependencies: SweepMoveDependencies,
): Promise<SweepMoveResult> {
  const result: SweepMoveResult = {
    moved: 0, notMoved: 0, uncertain: 0, skippedRecentTouch: 0, guardFailed: 0, movedCandidates: [],
  };
  const target = {
    sourcePipelineIds: SOURCE_PIPELINE_IDS,
    targetPipelineId: TARGET_PIPELINE_ID,
    targetStatusId: TARGET_STATUS_ID,
  };

  for (let index = 0; index < candidates.length; index += 1) {
    if (dependencies.isStopped && await dependencies.isStopped()) {
      result.stoppedAt = { index, reason: "stopped" };
      break;
    }
    const candidate = candidates[index];

    if (dependencies.hasRecentTouch) {
      let touched: boolean;
      try {
        touched = await dependencies.hasRecentTouch(candidate);
      } catch {
        result.guardFailed += 1;
        continue;
      }
      if (touched) {
        result.skippedRecentTouch += 1;
        continue;
      }
    }

    const outcome = await dependencies.moveLeadToTarget(candidate.leadId, target);
    if (outcome.kind === "confirmed") {
      result.moved += 1;
      result.movedCandidates.push(candidate);
      await bestEffort(dependencies.onMoved && (() => dependencies.onMoved!(candidate)));
    } else if (outcome.kind === "uncertain") {
      result.uncertain += 1;
      result.stoppedAt = { index, reason: "uncertain" };
      await bestEffort(dependencies.onUncertain && (() => dependencies.onUncertain!(candidate)));
      break;
    } else {
      // The lead was touched or moved between listing and PATCH; that is the
      // fresh read doing its job, not an error.
      result.notMoved += 1;
    }
  }
  return result;
}
