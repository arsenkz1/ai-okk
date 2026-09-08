/**
 * Formatting for the daily performance report: call volume, revenue and monthly
 * plan progress. Pure on purpose — every number the report shows is asserted in
 * tests without touching a database or OnlinePBX.
 */

export interface CallVolumeSection {
  total: number;
  connected: number;
  missed: number;
  talkSeconds: number;
  /** Calls that were long enough to be transcribed and scored. */
  analyzed: number;
  avgScore: number | null;
  /** True when the history page cap may have hidden part of the day. */
  possiblyTruncated?: boolean;
  /**
   * True when OnlinePBX could not be read at all. Distinguished from a real
   * zero: reporting "0 calls" for an outage states something untrue.
   */
  volumeUnavailable?: boolean;
}

export interface RevenueSection {
  wonCount: number;
  wonAmount: number;
  partialCount: number;
  partialAmount: number;
  /** Recorded payments whose amount could not be resolved yet. */
  unknownAmountCount: number;
}

export interface PlanSection {
  target: number;
  /** Won revenue accumulated in the plan month so far. */
  achieved: number;
}

export interface ManagerPerformance {
  managerName: string;
  calls: CallVolumeSection;
  revenue: RevenueSection;
  plan: PlanSection | null;
}

export interface TeamPerformance {
  title: string;
  periodLabel: string;
  members: ManagerPerformance[];
  calls: CallVolumeSection;
  revenue: RevenueSection;
  plan: PlanSection | null;
  /** Rendered Phoenix block; omitted when the caller did not load it. */
  phoenixLines?: readonly string[];
}

export function formatMoney(amount: number): string {
  return Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function formatTalkTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}s ${minutes}d` : `${minutes}d`;
}

/** Percent of plan reached; null when there is no target to divide by. */
export function planPercent(plan: PlanSection | null): number | null {
  if (!plan || plan.target <= 0) return null;
  return Math.round((plan.achieved / plan.target) * 100);
}

export function emptyCallVolumeSection(): CallVolumeSection {
  return { total: 0, connected: 0, missed: 0, talkSeconds: 0, analyzed: 0, avgScore: null };
}

export function emptyRevenueSection(): RevenueSection {
  return { wonCount: 0, wonAmount: 0, partialCount: 0, partialAmount: 0, unknownAmountCount: 0 };
}

export function formatCallSection(calls: CallVolumeSection): string[] {
  const lines = calls.volumeUnavailable
    ? ["📞 Qo'ng'iroqlar soni: ma'lumot olinmadi (OnlinePBX javob bermadi)"]
    : [
      `📞 Qo'ng'iroqlar: ${calls.total} (dozvon: ${calls.connected} · nedozvon: ${calls.missed})`,
      `⏱ Suhbat vaqti: ${formatTalkTime(calls.talkSeconds)}`,
    ];
  lines.push(
    calls.avgScore !== null
      ? `⭐ O'rtacha ball: ${calls.avgScore}/100 (${calls.analyzed} ta tahlil)`
      : "⭐ O'rtacha ball: tahlil qilingan qo'ng'iroq yo'q",
  );
  if (calls.possiblyTruncated) {
    lines.push("⚠️ Qo'ng'iroqlar soni to'liq bo'lmasligi mumkin (tarix limiti).");
  }
  return lines;
}

export function formatRevenueSection(revenue: RevenueSection): string[] {
  const lines = [
    "💰 Tushumlar:",
    `• Muvaffaqiyatli: ${revenue.wonCount} ta · ${formatMoney(revenue.wonAmount)}`,
    `• Qisman to'langan: ${revenue.partialCount} ta · ${formatMoney(revenue.partialAmount)}`,
  ];
  if (revenue.unknownAmountCount > 0) {
    // Never hide that a number is incomplete: the amount field is not set up.
    lines.push(`⚠️ Summasi aniqlanmagan bitimlar: ${revenue.unknownAmountCount} ta`);
  }
  return lines;
}

export function formatPlanSection(plan: PlanSection | null): string[] {
  if (!plan || plan.target <= 0) return ["🎯 Oylik reja: belgilanmagan"];
  const percent = planPercent(plan) ?? 0;
  const remaining = Math.max(0, plan.target - plan.achieved);
  const lines = [
    `🎯 Oylik reja: ${formatMoney(plan.target)}`,
    `✅ Bajarildi: ${formatMoney(plan.achieved)} (${percent}%)`,
  ];
  lines.push(
    remaining > 0
      ? `📉 Qoldi: ${formatMoney(remaining)}`
      : `🎉 Reja bajarildi! Ortiqcha: ${formatMoney(plan.achieved - plan.target)}`,
  );
  return lines;
}

export function formatManagerPerformance(performance: ManagerPerformance, periodLabel: string): string {
  return [
    `📊 ${periodLabel} — ${performance.managerName}`,
    "",
    ...formatCallSection(performance.calls),
    "",
    ...formatRevenueSection(performance.revenue),
    "",
    ...formatPlanSection(performance.plan),
  ].join("\n");
}

function memberLine(member: ManagerPerformance): string {
  const score = member.calls.avgScore !== null ? `${member.calls.avgScore}/100` : "—";
  const percent = planPercent(member.plan);
  const planPart = percent !== null ? ` · reja ${percent}%` : "";
  // "0/0 dozvon" would claim the manager made no calls; an unread PBX is not
  // the same thing as a silent day.
  const dozvon = member.calls.volumeUnavailable
    ? "dozvon: —"
    : `${member.calls.connected}/${member.calls.total} dozvon`;
  return `• ${member.managerName}: ${dozvon} · ⭐ ${score} · 💰 ${formatMoney(member.revenue.wonAmount)}${planPart}`;
}

export function formatTeamPerformance(team: TeamPerformance): string {
  const lines = [
    `👥 ${team.title} — ${team.periodLabel}`,
    "",
    ...formatCallSection(team.calls),
    "",
    ...formatRevenueSection(team.revenue),
    "",
    ...formatPlanSection(team.plan),
  ];

  if (team.phoenixLines?.length) lines.push("", ...team.phoenixLines);

  if (team.members.length > 0) {
    lines.push("", "👤 Menejerlar:");
    // Strongest revenue first: the report is read top-down for who is carrying
    // the month, with a stable name order for equal amounts.
    const ordered = [...team.members].sort((left, right) => (
      right.revenue.wonAmount - left.revenue.wonAmount
      || left.managerName.localeCompare(right.managerName)
    ));
    lines.push(...ordered.map(memberLine));
  }

  return lines.join("\n");
}

function addCallSections(target: CallVolumeSection, source: CallVolumeSection): void {
  target.total += source.total;
  target.connected += source.connected;
  target.missed += source.missed;
  target.talkSeconds += source.talkSeconds;
  target.analyzed += source.analyzed;
  if (source.possiblyTruncated) target.possiblyTruncated = true;
  if (source.volumeUnavailable) target.volumeUnavailable = true;
}

function addRevenueSections(target: RevenueSection, source: RevenueSection): void {
  target.wonCount += source.wonCount;
  target.wonAmount += source.wonAmount;
  target.partialCount += source.partialCount;
  target.partialAmount += source.partialAmount;
  target.unknownAmountCount += source.unknownAmountCount;
}

/**
 * Rolls members up into one team view. The team average score is weighted by
 * how many calls each manager had, not a mean of their averages.
 */
export function aggregateTeamPerformance(
  title: string,
  periodLabel: string,
  members: readonly ManagerPerformance[],
  phoenixLines?: readonly string[],
): TeamPerformance {
  const calls = emptyCallVolumeSection();
  const revenue = emptyRevenueSection();
  let scoreWeightedSum = 0;
  let target = 0;
  let achieved = 0;
  let hasPlan = false;

  for (const member of members) {
    addCallSections(calls, member.calls);
    addRevenueSections(revenue, member.revenue);
    if (member.calls.avgScore !== null) scoreWeightedSum += member.calls.avgScore * member.calls.analyzed;
    if (member.plan) {
      hasPlan = true;
      target += member.plan.target;
      achieved += member.plan.achieved;
    }
  }

  calls.avgScore = calls.analyzed > 0 ? Math.round(scoreWeightedSum / calls.analyzed) : null;

  return {
    title,
    periodLabel,
    members: [...members],
    calls,
    revenue,
    plan: hasPlan ? { target, achieved } : null,
    ...(phoenixLines?.length ? { phoenixLines: [...phoenixLines] } : {}),
  };
}
