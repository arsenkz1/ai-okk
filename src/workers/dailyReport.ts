import { prisma } from "../config/database";
import { askGeminiRaw } from "../services/aiAnalysis";

// ---------------------------------------------------------------------------
// Форматирование
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

// ---------------------------------------------------------------------------
// Генерация ежедневного отчёта для одного менеджера
// ---------------------------------------------------------------------------

async function buildDailyReportText(
  managerId: number,
  managerName: string
): Promise<string | null> {
  const now = new Date();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);

  const calls = await prisma.call.findMany({
    where: {
      managerId,
      startedAt: { gte: from, lte: to },
      processingStatus: "processed",
    },
    include: { analysis: true },
    orderBy: { startedAt: "desc" },
  });

  if (!calls.length) return null;

  const scores = calls
    .map((c) => c.analysis?.overallScore)
    .filter((s): s is number => s !== null && s !== undefined);
  const avgScore = scores.length
    ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
    : null;
  const totalTalk = calls.reduce((a, c) => a + c.durationSeconds, 0);

  const weakMap: Record<string, number> = {};
  const strongMap: Record<string, number> = {};
  for (const call of calls) {
    for (const w of (call.analysis?.weaknesses as string[] | null) ?? [])
      weakMap[w] = (weakMap[w] ?? 0) + 1;
    for (const s of (call.analysis?.strengths as string[] | null) ?? [])
      strongMap[s] = (strongMap[s] ?? 0) + 1;
  }

  const topWeak = Object.entries(weakMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => `  • ${w}`)
    .join("\n");

  const topStrong = Object.entries(strongMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s]) => `  • ${s}`)
    .join("\n");

  const today = now.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
  });

  const statsText = [
    `📊 Твой отчёт за ${today}`,
    ``,
    `📞 Проанализировано звонков: ${calls.length}`,
    `⏱ Суммарное время: ${formatDuration(totalTalk)}`,
    avgScore ? `⭐ Средняя оценка: ${avgScore}/10` : "",
    topStrong ? `\n💪 Сильные стороны:\n${topStrong}` : "",
    topWeak ? `\n⚠️ Зоны роста:\n${topWeak}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Генерируем персональный AI-комментарий
  let aiComment = "";
  try {
    const prompt = `Ты — AI-тренер по продажам. Менеджер ${managerName} завершил рабочий день.

Его статистика за сегодня:
- Звонков: ${calls.length}
- Средняя оценка: ${avgScore ?? "нет данных"}/10
- Сильные стороны: ${topStrong || "нет данных"}
- Зоны роста: ${topWeak || "нет данных"}

Напиши КРАТКИЙ мотивационный комментарий (2-3 предложения):
- Отметь конкретное достижение или прогресс
- Дай одну практическую рекомендацию на завтра
- Говори на "ты", тепло и по-деловому
- БЕЗ приветствий и обращений к имени
- Только текст, без форматирования`;

    aiComment = await askGeminiRaw(prompt);
  } catch (err: any) {
    console.error("[DailyReport] AI comment error:", err.message);
  }

  const parts = [statsText];
  if (aiComment) parts.push(`\n🤖 ${aiComment}`);
  parts.push(`\nДля подробностей: /report`);

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Публичная функция: рассылка всем менеджерам
// ---------------------------------------------------------------------------

/**
 * Отправляет ежедневные отчёты всем активным менеджерам, у которых
 * есть привязанный Telegram-аккаунт (status="used").
 */
export async function sendDailyReports(
  sendFn: (chatId: string, text: string) => Promise<void>
): Promise<{ sent: number; skipped: number; errors: number }> {
  console.log("[DailyReport] Starting daily reports...");

  const managers = await prisma.manager.findMany({
    where: { isActive: true },
    include: {
      telegramLinks: {
        where: { status: "used" },
        take: 1,
      },
    },
  });

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const manager of managers) {
    const link = manager.telegramLinks[0];
    if (!link?.telegramUserId) {
      skipped++;
      continue;
    }

    try {
      const text = await buildDailyReportText(manager.id, manager.name);
      if (!text) {
        console.log(
          `[DailyReport] No calls today for manager ${manager.name}, skipping`
        );
        skipped++;
        continue;
      }

      await sendFn(link.telegramUserId, text);
      console.log(`[DailyReport] Sent to ${manager.name} (${link.telegramUserId})`);
      sent++;

      // Небольшая пауза между отправками
      await new Promise((r) => setTimeout(r, 200));
    } catch (err: any) {
      console.error(
        `[DailyReport] Failed to send to ${manager.name}:`,
        err.message
      );
      errors++;
    }
  }

  console.log("[DailyReport] Done:", { sent, skipped, errors });
  return { sent, skipped, errors };
}
