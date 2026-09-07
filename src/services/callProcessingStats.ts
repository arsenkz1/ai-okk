import { prisma } from "../config/database";

/**
 * Why calls did or did not get analyzed over a period.
 *
 * Every skip in the pipeline already writes a distinct `processingStatus`, but
 * nothing surfaced them, so "some deals don't get processed" could only be
 * guessed at. This turns the statuses already in the database into an answer.
 */

export interface CallProcessingBreakdown {
  total: number;
  byStatus: Array<{ status: string; count: number }>;
  /** Analyzed calls whose amoCRM note was never written. */
  analyzedWithoutNote: number;
  /** Analyzed calls that produced no AI recommendations. */
  analyzedWithoutRecommendations: number;
}

/** Operator-facing explanation of each processingStatus value. */
export const CALL_STATUS_LABELS: Readonly<Record<string, string>> = {
  processed: "проанализирован полностью",
  analyzed: "проанализирован, запись в CRM не завершена",
  queued: "в очереди",
  processing: "обрабатывается",
  skipped_stage: "пропущен: сделка найдена, но контакт без подходящей сделки",
  skipped_no_deal: "пропущен: сделка по номеру не найдена в amoCRM",
  skipped_short: "пропущен: звонок короче 6 минут",
  failed: "ошибка обработки",
  error: "ошибка обработки",
  no_deal: "пропущен: сделка не найдена",
};

export function describeCallStatus(status: string): string {
  return CALL_STATUS_LABELS[status] ?? status;
}

export async function loadCallProcessingBreakdown(
  range: { from: Date; to: Date },
): Promise<CallProcessingBreakdown> {
  const grouped = await prisma.call.groupBy({
    by: ["processingStatus"],
    where: { startedAt: { gte: range.from, lt: range.to } },
    _count: { _all: true },
  });

  const byStatus = grouped
    .map((row) => ({ status: row.processingStatus, count: row._count._all }))
    .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status));

  const analyzed = await prisma.call.findMany({
    where: {
      startedAt: { gte: range.from, lt: range.to },
      processingStatus: { in: ["processed", "analyzed"] },
    },
    select: { id: true, analysis: { select: { recommendations: true } } },
  });

  let analyzedWithoutRecommendations = 0;
  for (const call of analyzed) {
    const raw = call.analysis?.recommendations as { client?: unknown; manager?: unknown } | null;
    const client = Array.isArray(raw?.client) ? raw!.client.length : 0;
    const manager = Array.isArray(raw?.manager) ? raw!.manager.length : 0;
    if (client + manager === 0) analyzedWithoutRecommendations += 1;
  }

  return {
    total: byStatus.reduce((sum, row) => sum + row.count, 0),
    byStatus,
    // "analyzed" is the state a call is left in when the CRM write did not
    // finish; "processed" is only reached after the notes were attempted.
    analyzedWithoutNote: byStatus.find((row) => row.status === "analyzed")?.count ?? 0,
    analyzedWithoutRecommendations,
  };
}

export function formatCallProcessingBreakdown(
  breakdown: CallProcessingBreakdown,
  periodLabel: string,
): string {
  if (breakdown.total === 0) {
    return `🔎 Обработка звонков — ${periodLabel}\n\nЗа период звонков в базе нет.`;
  }

  const lines = [
    `🔎 Обработка звонков — ${periodLabel}`,
    "",
    `Всего звонков в базе: ${breakdown.total}`,
    "",
  ];
  for (const row of breakdown.byStatus) {
    lines.push(`• ${row.count} — ${describeCallStatus(row.status)} (${row.status})`);
  }

  if (breakdown.analyzedWithoutNote > 0) {
    lines.push("", `⚠️ Проанализировано, но запись в amoCRM не завершена: ${breakdown.analyzedWithoutNote}`);
  }
  if (breakdown.analyzedWithoutRecommendations > 0) {
    lines.push(`⚠️ Без рекомендаций ИИ: ${breakdown.analyzedWithoutRecommendations}`);
  }

  lines.push(
    "",
    "💡 Звонки короче 6 минут в базу не попадают вообще — они отсеиваются на вебхуке OnlinePBX.",
  );
  return lines.join("\n");
}
