import { prisma } from "../config/database";
import { formatManagerDisplayName } from "./managerDisplayName";
import { fetchCallVolumeForRange, emptyCallVolume, type ManagerCallVolume } from "./callVolumeStats";
import { almatyPlanMonth, getManagerPlans, type PlanMonth } from "./salesPlan";
import {
  emptyCallVolumeSection,
  emptyRevenueSection,
  type ManagerPerformance,
  type RevenueSection,
} from "./performanceReport";

/**
 * Assembles the numbers behind the daily performance report from their three
 * separate sources: OnlinePBX history for call volume, the analyzed calls in
 * the database for scores, and the recorded payment events for revenue.
 */

export interface PerformanceRange {
  from: Date;
  to: Date;
}

/** Start/end of the Almaty calendar month a moment falls into, as UTC instants. */
export function almatyMonthRange(now: Date): PerformanceRange {
  const { year, month } = almatyPlanMonth(now);
  // Almaty is UTC+5 with no DST, so the local month starts at 19:00 UTC on the
  // last day of the previous month.
  const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0) - 5 * 3600 * 1000);
  const to = new Date(Date.UTC(year, month, 1, 0, 0, 0) - 5 * 3600 * 1000);
  return { from, to };
}

async function loadCallScores(
  managerIds: readonly number[],
  range: PerformanceRange,
): Promise<Map<number, { analyzed: number; scoreSum: number }>> {
  const calls = await prisma.call.findMany({
    where: {
      managerId: { in: [...managerIds] },
      startedAt: { gte: range.from, lt: range.to },
      analysis: { isNot: null },
    },
    select: { managerId: true, analysis: { select: { overallScore: true } } },
  });

  const byManager = new Map<number, { analyzed: number; scoreSum: number }>();
  for (const call of calls) {
    const score = call.analysis?.overallScore;
    if (call.managerId === null || typeof score !== "number") continue;
    const entry = byManager.get(call.managerId) ?? { analyzed: 0, scoreSum: 0 };
    entry.analyzed += 1;
    entry.scoreSum += score;
    byManager.set(call.managerId, entry);
  }
  return byManager;
}

async function loadRevenue(
  managerIds: readonly number[],
  range: PerformanceRange,
): Promise<Map<number, RevenueSection>> {
  const events = await prisma.dealPaymentEvent.findMany({
    where: {
      managerId: { in: [...managerIds] },
      occurredAt: { gte: range.from, lt: range.to },
    },
    select: { managerId: true, kind: true, amount: true },
  });

  const byManager = new Map<number, RevenueSection>();
  for (const event of events) {
    if (event.managerId === null) continue;
    const revenue = byManager.get(event.managerId) ?? emptyRevenueSection();
    if (event.kind === "won") {
      revenue.wonCount += 1;
      revenue.wonAmount += event.amount ?? 0;
    } else {
      revenue.partialCount += 1;
      revenue.partialAmount += event.amount ?? 0;
    }
    if (event.amount === null) revenue.unknownAmountCount += 1;
    byManager.set(event.managerId, revenue);
  }
  return byManager;
}

/**
 * Plan progress is measured against won revenue in the plan month. Part-paid
 * deals are reported separately and deliberately do not advance the plan.
 */
async function loadPlanProgress(
  managerIds: readonly number[],
  month: PlanMonth,
  monthRange: PerformanceRange,
): Promise<Map<number, { target: number; achieved: number }>> {
  const targets = await getManagerPlans(managerIds, month);
  if (targets.size === 0) return new Map();

  const events = await prisma.dealPaymentEvent.findMany({
    where: {
      managerId: { in: [...targets.keys()] },
      kind: "won",
      occurredAt: { gte: monthRange.from, lt: monthRange.to },
    },
    select: { managerId: true, amount: true },
  });

  const achieved = new Map<number, number>();
  for (const event of events) {
    if (event.managerId === null) continue;
    achieved.set(event.managerId, (achieved.get(event.managerId) ?? 0) + (event.amount ?? 0));
  }

  return new Map(
    [...targets.entries()].map(([managerId, target]) => [
      managerId,
      { target, achieved: achieved.get(managerId) ?? 0 },
    ]),
  );
}

export interface LoadPerformanceOptions {
  managerIds: readonly number[];
  range: PerformanceRange;
  now?: Date;
  /** Injected in tests to avoid calling OnlinePBX. */
  loadCallVolume?: (
    range: PerformanceRange,
    extensionToManagerId: ReadonlyMap<string, number>,
  ) => Promise<{ byManager: Map<number, ManagerCallVolume>; possiblyTruncated: boolean }>;
}

/**
 * Returns one entry per requested manager, including managers with no activity
 * at all — a silent day is itself information in a report.
 */
export async function loadManagerPerformance(
  options: LoadPerformanceOptions,
): Promise<Map<number, ManagerPerformance>> {
  const { managerIds, range } = options;
  const result = new Map<number, ManagerPerformance>();
  if (managerIds.length === 0) return result;

  const managers = await prisma.manager.findMany({
    where: { id: { in: [...managerIds] } },
    select: { id: true, name: true, internalNumber: true },
  });

  const extensionToManagerId = new Map<string, number>();
  for (const manager of managers) {
    const extension = manager.internalNumber?.replace(/\D/g, "");
    if (extension) extensionToManagerId.set(extension, manager.id);
  }

  const now = options.now ?? new Date();
  const month = almatyPlanMonth(now);
  const monthRange = almatyMonthRange(now);

  let volume: { byManager: Map<number, ManagerCallVolume>; possiblyTruncated: boolean };
  try {
    volume = options.loadCallVolume
      ? await options.loadCallVolume(range, extensionToManagerId)
      : await fetchCallVolumeForRange(range.from, range.to, extensionToManagerId);
  } catch (error) {
    // Volume is the only externally-sourced block: a PBX outage must not take
    // the revenue and plan sections down with it.
    console.error("[Performance] Call volume unavailable:", error instanceof Error ? error.message : error);
    volume = { byManager: new Map(), possiblyTruncated: false };
  }

  const [scores, revenue, plans] = await Promise.all([
    loadCallScores(managerIds, range),
    loadRevenue(managerIds, range),
    loadPlanProgress(managerIds, month, monthRange),
  ]);

  for (const manager of managers) {
    const managerVolume = volume.byManager.get(manager.id) ?? emptyCallVolume();
    const managerScores = scores.get(manager.id);
    const calls = emptyCallVolumeSection();
    calls.total = managerVolume.total;
    calls.connected = managerVolume.connected;
    calls.missed = managerVolume.missed;
    calls.talkSeconds = managerVolume.talkSeconds;
    calls.analyzed = managerScores?.analyzed ?? 0;
    calls.avgScore = managerScores && managerScores.analyzed > 0
      ? Math.round(managerScores.scoreSum / managerScores.analyzed)
      : null;
    if (volume.possiblyTruncated) calls.possiblyTruncated = true;

    result.set(manager.id, {
      managerName: formatManagerDisplayName(manager.name),
      calls,
      revenue: revenue.get(manager.id) ?? emptyRevenueSection(),
      plan: plans.get(manager.id) ?? null,
    });
  }

  return result;
}
