import type { AmoDateRange, AmoLeadFact, AmoLeadStatusChange, AmoStageRef } from "./amoListingParams";
import { TARGET_PIPELINE_ID, TARGET_STATUS_ID } from "./leadInactivityPolicy";
import { LOST_STATUS_ID, WON_STATUS_ID, parseAmount, type RevenueStageRef } from "./salesRevenuePolicy";
import { loadRevenueStages } from "./revenueStageSync";
import type { ManagerPerformance, RevenueSection } from "./performanceReport";

/**
 * Daily report facts read straight from amoCRM instead of from our own tables.
 *
 * The database only records what this service itself did or saw since it was
 * deployed: a webhook it received, a move it made. Deals that people move by
 * hand, moves from before the deploy, and any webhook that was ever missed are
 * invisible to it — which is why the report kept saying "nothing moved" and
 * "no revenue" while amoCRM plainly showed both. amoCRM is the system of
 * record, so for "what happened in the period" it is asked directly.
 */

export type AmoDailyRange = AmoDateRange;

export interface AmoDailyFactsClient {
  fetchPipelineStageRefs(pipelineId: number): Promise<AmoStageRef[]>;
  fetchLeadStatusChangesInto(stages: readonly AmoStageRef[], range: AmoDailyRange): Promise<AmoLeadStatusChange[]>;
  fetchLeadsClosedInRange(range: AmoDailyRange): Promise<AmoLeadFact[]>;
  fetchLeadFactsByIds(ids: readonly number[]): Promise<AmoLeadFact[]>;
}

/**
 * `amocrm.ts` wires a BullMQ queue at import time; loading it lazily keeps the
 * pure summaries below usable without Redis.
 */
async function defaultClient(): Promise<AmoDailyFactsClient> {
  const amo = await import("./amocrm");
  return {
    fetchPipelineStageRefs: amo.fetchPipelineStageRefs,
    fetchLeadStatusChangesInto: amo.fetchLeadStatusChangesInto,
    fetchLeadsClosedInRange: amo.fetchLeadsClosedInRange,
    fetchLeadFactsByIds: amo.fetchLeadFactsByIds,
  };
}

// ---------------------------------------------------------------------------
// Phoenix arrivals
// ---------------------------------------------------------------------------

export interface PhoenixArrivalsFact {
  /** Distinct deals that entered the Phoenix pipeline in the range. */
  total: number;
  byPipeline: Array<{ pipelineId: number; count: number }>;
  /** Arrivals whose event carried no previous stage. */
  unknownOrigin: number;
}

/**
 * Stage-change events that landed on any Phoenix stage. The event's
 * `value_before` names the pipeline the deal came from, so the origin is
 * exact rather than inferred. When the stage list cannot be read, the entry
 * stage alone is used — that is where the inactivity worker puts deals.
 */
export async function loadPhoenixArrivalsFromAmo(
  range: AmoDailyRange,
  client?: AmoDailyFactsClient,
): Promise<PhoenixArrivalsFact> {
  const amo = client ?? await defaultClient();
  let stages: AmoStageRef[] = [];
  try {
    stages = await amo.fetchPipelineStageRefs(TARGET_PIPELINE_ID);
  } catch (error) {
    console.warn("[AmoDailyFacts] Phoenix stage list unavailable, using the entry stage only:", error instanceof Error ? error.message : error);
  }
  if (stages.length === 0) stages = [{ pipelineId: TARGET_PIPELINE_ID, statusId: TARGET_STATUS_ID }];
  return summarizePhoenixArrivals(await amo.fetchLeadStatusChangesInto(stages, range));
}

/**
 * A deal counts once, by the pipeline it first arrived from. A stage change
 * inside Phoenix is not an arrival and is skipped.
 */
export function summarizePhoenixArrivals(events: readonly AmoLeadStatusChange[]): PhoenixArrivalsFact {
  const ordered = [...events].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  const seen = new Set<number>();
  const counter = new Map<number, number>();
  let unknownOrigin = 0;

  for (const event of ordered) {
    if (event.after && event.after.pipelineId !== TARGET_PIPELINE_ID) continue;
    if (event.before?.pipelineId === TARGET_PIPELINE_ID) continue;
    if (seen.has(event.leadId)) continue;
    seen.add(event.leadId);
    const origin = event.before?.pipelineId ?? null;
    if (origin === null) unknownOrigin += 1;
    else counter.set(origin, (counter.get(origin) ?? 0) + 1);
  }

  return {
    total: seen.size,
    byPipeline: [...counter.entries()]
      .map(([pipelineId, count]) => ({ pipelineId, count }))
      .sort((left, right) => right.count - left.count || left.pipelineId - right.pipelineId),
    unknownOrigin,
  };
}

// ---------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------

export interface RevenueTotals {
  wonCount: number;
  wonAmount: number;
  partialCount: number;
  partialAmount: number;
  /** Deals counted whose budget is empty in amoCRM. */
  withoutBudget: number;
}

export interface RevenueFact extends RevenueTotals {
  /** False when no part-paid stage has been synced, so that line is necessarily 0. */
  stagesSynced: boolean;
  /** The same totals split by amoCRM responsible user, for the per-manager lines. */
  byResponsible: Map<number, RevenueTotals>;
}

const emptyTotals = (): RevenueTotals => ({ wonCount: 0, wonAmount: 0, partialCount: 0, partialAmount: 0, withoutBudget: 0 });

/**
 * Won deals are found by `closed_at`: amoCRM sets it exactly when a deal
 * reaches the won status. Part-paid stages have no such stamp, so the deals
 * that moved onto one of them are taken from the stage-change events and then
 * read for their budget.
 */
export async function loadRevenueFromAmo(
  range: AmoDailyRange,
  options: { client?: AmoDailyFactsClient; stages?: readonly RevenueStageRef[] } = {},
): Promise<RevenueFact> {
  const amo = options.client ?? await defaultClient();
  const stages = options.stages ?? await loadRevenueStages();
  const partialStages: AmoStageRef[] = stages
    .filter((stage) => stage.kind === "partial")
    .map(({ pipelineId, statusId }) => ({ pipelineId, statusId }));

  const won = await amo.fetchLeadsClosedInRange(range);
  let partial: AmoLeadFact[] = [];
  if (partialStages.length > 0) {
    const arrivals = await amo.fetchLeadStatusChangesInto(partialStages, range);
    const ids = [...new Set(arrivals.map((event) => event.leadId))];
    partial = ids.length > 0 ? await amo.fetchLeadFactsByIds(ids) : [];
  }

  return summarizeRevenue(won, partial, partialStages.length > 0);
}

export function summarizeRevenue(
  won: readonly AmoLeadFact[],
  partial: readonly AmoLeadFact[],
  stagesSynced: boolean,
): RevenueFact {
  const totals = emptyTotals();
  const byResponsible = new Map<number, RevenueTotals>();
  const seenWon = new Set<number>();
  const seenPartial = new Set<number>();

  const count = (lead: AmoLeadFact, kind: "won" | "partial"): void => {
    const amount = parseAmount(lead.price);
    const buckets = [totals];
    if (lead.responsibleUserId !== null) {
      let bucket = byResponsible.get(lead.responsibleUserId);
      if (!bucket) byResponsible.set(lead.responsibleUserId, bucket = emptyTotals());
      buckets.push(bucket);
    }
    for (const bucket of buckets) {
      if (kind === "won") { bucket.wonCount += 1; bucket.wonAmount += amount ?? 0; }
      else { bucket.partialCount += 1; bucket.partialAmount += amount ?? 0; }
      if (amount === null || amount === 0) bucket.withoutBudget += 1;
    }
  };

  for (const lead of won) {
    // The closed_at listing also returns lost deals.
    if (seenWon.has(lead.id) || lead.statusId !== WON_STATUS_ID) continue;
    seenWon.add(lead.id);
    count(lead, "won");
  }
  for (const lead of partial) {
    // A deal that has since been won or lost is no longer "part-paid".
    if (seenPartial.has(lead.id) || seenWon.has(lead.id)) continue;
    if (lead.statusId === WON_STATUS_ID || lead.statusId === LOST_STATUS_ID) continue;
    seenPartial.add(lead.id);
    count(lead, "partial");
  }

  return { ...totals, stagesSynced, byResponsible };
}

export function revenueSectionFromTotals(totals: RevenueTotals, stagesSynced: boolean): RevenueSection {
  return {
    wonCount: totals.wonCount,
    wonAmount: totals.wonAmount,
    partialCount: totals.partialCount,
    partialAmount: totals.partialAmount,
    unknownAmountCount: totals.withoutBudget,
    stagesNotSynced: !stagesSynced,
  };
}

export const revenueSectionFromFact = (fact: RevenueFact): RevenueSection => revenueSectionFromTotals(fact, fact.stagesSynced);

/**
 * Gives every manager with a known amoCRM user their amoCRM figures for the
 * range. A manager without an amoCRM user keeps what our database recorded.
 */
export function applyAmoRevenueToMembers(
  performance: ReadonlyMap<number, ManagerPerformance>,
  amoUserIdByManagerId: ReadonlyMap<number, number>,
  fact: RevenueFact,
): void {
  for (const [managerId, member] of performance) {
    const amoUserId = amoUserIdByManagerId.get(managerId);
    if (amoUserId === undefined) continue;
    member.revenue = revenueSectionFromTotals(fact.byResponsible.get(amoUserId) ?? emptyTotals(), fact.stagesSynced);
  }
}

export function amoUserIdMap(managers: ReadonlyArray<{ id: number; amoUserId: number | null }>): Map<number, number> {
  const map = new Map<number, number>();
  for (const manager of managers) if (manager.amoUserId !== null) map.set(manager.id, manager.amoUserId);
  return map;
}
