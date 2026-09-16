import type { AmoInactivityLead, AmoInactivityMoveOutcome } from "./leadInactivityAmoClient";
import { SOURCE_PIPELINE_IDS, TARGET_PIPELINE_ID, TARGET_STATUS_ID } from "./leadInactivityPolicy";

/**
 * One-shot sweep run when Phoenix moves are switched back on.
 *
 * The switch-off clears every watch and drops incoming touches, so the moment
 * moves resume the queue is empty and nothing would move for another 72 hours.
 * The sweep asks amoCRM for every lead sitting on an eligible stage whose last
 * update is older than SWEEP_INACTIVITY_MS, shows the operator the count, and
 * moves them only after an explicit "yes".
 *
 * That window is wider than the worker's 72 hours on purpose: the switch-off
 * dropped every clock, so a lead idle for five days has no watch at all and
 * would otherwise wait another three days before moving. Once the sweep is
 * done the worker runs on its own 72-hour rule as before.
 *
 * amoCRM's `updated_at` is the "last touch" here. It moves on any lead change
 * — note, task, field edit, status — which is exactly the definition the
 * webhook path uses for the same question.
 */

/** Idle window for the one-shot sweep; the worker keeps its own 72 hours. */
export const SWEEP_INACTIVITY_MS = 7 * 24 * 60 * 60 * 1000;

export interface SweepCandidate {
  leadId: number;
  pipelineId: number;
  statusId: number;
  /** amoCRM updated_at; the moment the 72-hour clock is measured from. */
  lastTouchedAt: Date;
}

/** Leads on an eligible stage that have gone untouched for the full window. */
export function selectSweepCandidates(
  leads: readonly AmoInactivityLead[],
  now: Date,
  inactivityMs = SWEEP_INACTIVITY_MS,
): SweepCandidate[] {
  const cutoff = now.getTime() - inactivityMs;
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

export function countByPipeline(candidates: readonly SweepCandidate[]): SweepCountByPipeline[] {
  const counter = new Map<number, number>();
  for (const candidate of candidates) counter.set(candidate.pipelineId, (counter.get(candidate.pipelineId) ?? 0) + 1);
  return [...counter.entries()]
    .map(([pipelineId, count]) => ({ pipelineId, count }))
    .sort((left, right) => right.count - left.count || left.pipelineId - right.pipelineId);
}

export interface SweepMoveResult {
  moved: number;
  notMoved: number;
  uncertain: number;
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
  onMoved?(candidate: SweepCandidate): Promise<void>;
}

/**
 * Moves the confirmed candidates one by one. Mirrors the worker's rule that an
 * `uncertain` outcome halts everything: amoCRM's state is no longer known, so
 * continuing blind could double-move or skip.
 */
export async function moveSweepCandidates(
  candidates: readonly SweepCandidate[],
  dependencies: SweepMoveDependencies,
): Promise<SweepMoveResult> {
  const result: SweepMoveResult = { moved: 0, notMoved: 0, uncertain: 0 };
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
    const outcome = await dependencies.moveLeadToTarget(candidate.leadId, target);
    if (outcome.kind === "confirmed") {
      result.moved += 1;
      if (dependencies.onMoved) await dependencies.onMoved(candidate);
    } else if (outcome.kind === "uncertain") {
      result.uncertain += 1;
      result.stoppedAt = { index, reason: "uncertain" };
      break;
    } else {
      // The lead was touched or moved between listing and PATCH; that is the
      // fresh read doing its job, not an error.
      result.notMoved += 1;
    }
  }
  return result;
}
