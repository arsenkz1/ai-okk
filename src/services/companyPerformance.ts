import {
  aggregateTeamPerformance,
  type ManagerPerformance,
  type TeamPerformance,
} from "./performanceReport";
import { formatPhoenixArrivals } from "./phoenixMovementStats";
import {
  amoUserIdMap,
  applyAmoRevenueToMembers,
  loadPhoenixArrivalsFromAmo,
  loadRevenueFromAmo,
  revenueSectionFromFact,
  type AmoDailyFactsClient,
  type AmoDailyRange,
  type RevenueFact,
} from "./amoDailyFacts";

/**
 * The company block shared by the 09:00 admin report, /team_stats and the
 * admin /report: calls from our data, Phoenix arrivals and revenue from
 * amoCRM. Each amoCRM read fails on its own, so a listing error costs one
 * block, never the whole report.
 */

export interface BuildCompanyTeamOptions {
  title: string;
  label: string;
  range: AmoDailyRange;
  performance: ReadonlyMap<number, ManagerPerformance>;
  amoUserIdByManagerId: ReadonlyMap<number, number>;
  logPrefix: string;
  client?: AmoDailyFactsClient;
}

export interface CompanyTeam {
  team: TeamPerformance;
  phoenixLines: string[];
  phoenixTotal: number;
}

export const PHOENIX_UNAVAILABLE_LINE = "Феникс (стажёр): данные amoCRM недоступны";

export async function buildCompanyTeam(options: BuildCompanyTeamOptions): Promise<CompanyTeam> {
  let phoenixLines: string[];
  let phoenixTotal = 0;
  try {
    const arrivals = await loadPhoenixArrivalsFromAmo(options.range, options.client);
    phoenixLines = formatPhoenixArrivals(arrivals);
    phoenixTotal = arrivals.total;
  } catch (error) {
    console.error(`${options.logPrefix} Phoenix arrivals unavailable:`, error instanceof Error ? error.message : error);
    phoenixLines = [PHOENIX_UNAVAILABLE_LINE];
  }

  let revenue: RevenueFact | null = null;
  try {
    revenue = await loadRevenueFromAmo(options.range, { client: options.client });
  } catch (error) {
    console.error(`${options.logPrefix} amoCRM revenue unavailable:`, error instanceof Error ? error.message : error);
  }
  if (revenue) applyAmoRevenueToMembers(options.performance, options.amoUserIdByManagerId, revenue);

  const team = aggregateTeamPerformance(options.title, options.label, [...options.performance.values()], phoenixLines);
  // The company total is amoCRM's own figure, not the sum of member lines:
  // deals whose responsible user is not a known manager still count.
  if (revenue) team.revenue = revenueSectionFromFact(revenue);

  return { team, phoenixLines, phoenixTotal };
}

/**
 * Replaces the recorded revenue of the given managers with amoCRM's figures
 * for the range. Used by the single-manager reports; a failed read leaves the
 * recorded numbers in place and is logged.
 */
export async function applyAmoRevenueForManagers(options: {
  performance: ReadonlyMap<number, ManagerPerformance>;
  managers: ReadonlyArray<{ id: number; amoUserId: number | null }>;
  range: AmoDailyRange;
  logPrefix: string;
  client?: AmoDailyFactsClient;
}): Promise<void> {
  const amoUserIds = amoUserIdMap(options.managers);
  if (amoUserIds.size === 0) return;
  try {
    applyAmoRevenueToMembers(options.performance, amoUserIds, await loadRevenueFromAmo(options.range, { client: options.client }));
  } catch (error) {
    console.error(`${options.logPrefix} amoCRM revenue unavailable:`, error instanceof Error ? error.message : error);
  }
}
