import { prisma } from "../config/database";
import { askGeminiRaw } from "../services/aiAnalysis";

// ---------------------------------------------------------------------------
// Форматирование
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}s ${m}d` : `${m}d`;
}

const UZ_MONTHS = [
  "yanvar","fevral","mart","aprel","may","iyun",
  "iyul","avgust","sentabr","oktabr","noyabr","dekabr",
];

// ---------------------------------------------------------------------------
// Структура данных для одного дневного отчёта
// ---------------------------------------------------------------------------

interface DailyStats {
  callsTotal: number;
  talkTimeSeconds: number;
  avgScore: number | null;
  topStrengths: string[];
  topMistakes: string[];
}

interface DailyReportResult {
  text: string;
  stats: DailyStats;
}

// ---------------------------------------------------------------------------
// Генерация ежедневного отчёта для одного менеджера
// ---------------------------------------------------------------------------

async function buildDailyReport(
  managerId: number,
  managerName: string
): Promise<DailyReportResult | null> {
  const now = new Date();
  // Отчёт за вчера (крон запускается в 09:00, отчитываемся за предыдущий день)
  const from = new Date(now);
  from.setDate(from.getDate() - 1);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
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
  const avgScoreNum = scores.length
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : null;
  const avgScoreStr = avgScoreNum !== null ? avgScoreNum.toFixed(1) : null;
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
    .slice(0, 3);

  const topStrong = Object.entries(strongMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const topWeakText = topWeak.map(([w]) => `  • ${w}`).join("\n");
  const topStrongText = topStrong.map(([s]) => `  • ${s}`).join("\n");

  const today = `${from.getDate()} ${UZ_MONTHS[from.getMonth()]}`;

  const statsText = [
    `📊 Kechagi hisoboting — ${today}`,
    ``,
    `📞 Tahlil qilingan qo'ng'iroqlar: ${calls.length}`,
    `⏱ Jami vaqt: ${formatDuration(totalTalk)}`,
    avgScoreStr ? `⭐ O'rtacha ball: ${avgScoreStr}/100` : "",
    topStrongText ? `\n💪 Kuchli tomonlar:\n${topStrongText}` : "",
    topWeakText ? `\n⚠️ O'sish sohalari:\n${topWeakText}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Personalлashtirilgan AI sharhi
  let aiComment = "";
  try {
    const prompt = `Sen — AI sotish murabbiysisan. Menejер ${managerName} ish kunini yakunladi.

Bugungi statistikasi:
- Qo'ng'iroqlar: ${calls.length}
- O'rtacha ball: ${avgScoreStr ?? "ma'lumot yo'q"}/100
- Kuchli tomonlar: ${topStrongText || "ma'lumot yo'q"}
- O'sish sohalari: ${topWeakText || "ma'lumot yo'q"}

QISQA motivatsion sharh yoz (2-3 gap):
- Aniq yutuq yoki rivojlanishni qayd et
- Ertaga uchun bitta amaliy maslahat ber
- "Sen" deb murojaat qil, iliq va ishbilarmonlarcha
- Salomlashuvlarsiz va ism ishlatmasdan
- Faqat matn, formatirlashsiz
- O'ZBEK TILIDA yoz (lotin alifbosi)`;

    aiComment = await askGeminiRaw(prompt);
  } catch (err: any) {
    console.error("[DailyReport] AI comment error:", err.message);
  }

  const fullText = [
    statsText,
    aiComment ? `\n🤖 ${aiComment}` : "",
    `\nBatafsil: /report`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    text: fullText,
    stats: {
      callsTotal: calls.length,
      talkTimeSeconds: totalTalk,
      avgScore: avgScoreNum,
      topStrengths: topStrong.map(([s]) => s),
      topMistakes: topWeak.map(([w]) => w),
    },
  };
}

// ---------------------------------------------------------------------------
// Публичная функция: рассылка всем менеджерам
// ---------------------------------------------------------------------------

/**
 * Отправляет ежедневные отчёты всем активным менеджерам, у которых
 * есть привязанный Telegram-аккаунт (status="used").
 * Сохраняет результат в таблицу DailySummary.
 */
export async function sendDailyReports(
  sendFn: (chatId: string, text: string) => Promise<void>
): Promise<{ sent: number; skipped: number; errors: number }> {
  console.log("[DailyReport] Starting daily reports...");

  const today = new Date();
  today.setHours(0, 0, 0, 0);

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

    // Строим отчёт даже если нет Telegram (чтобы сохранить в DailySummary)
    let report: DailyReportResult | null = null;
    try {
      report = await buildDailyReport(manager.id, manager.name);
    } catch (err: any) {
      console.error(`[DailyReport] Build failed for ${manager.name}:`, err.message);
      errors++;
      continue;
    }

    if (!report) {
      console.log(`[DailyReport] No calls today for manager ${manager.name}, skipping`);
      skipped++;
      continue;
    }

    // Сохраняем в DailySummary (upsert чтобы не дублировать при повторном запуске)
    try {
      await prisma.dailySummary.upsert({
        where: {
          // Уникальность по менеджеру + дата + период
          managerId_date_period: {
            managerId: manager.id,
            date: today,
            period: "day",
          },
        },
        update: {
          callsTotal: report.stats.callsTotal,
          connectedTotal: report.stats.callsTotal,
          talkTimeSeconds: report.stats.talkTimeSeconds,
          avgScore: report.stats.avgScore,
          topStrengths: report.stats.topStrengths,
          topMistakes: report.stats.topMistakes,
          summaryText: report.text,
          sentStatus: link?.telegramUserId ? "sent" : "skipped_no_tg",
          updatedAt: new Date(),
        },
        create: {
          managerId: manager.id,
          date: today,
          period: "day",
          callsTotal: report.stats.callsTotal,
          connectedTotal: report.stats.callsTotal,
          talkTimeSeconds: report.stats.talkTimeSeconds,
          avgScore: report.stats.avgScore,
          topStrengths: report.stats.topStrengths,
          topMistakes: report.stats.topMistakes,
          summaryText: report.text,
          sentStatus: link?.telegramUserId ? "pending" : "skipped_no_tg",
        },
      });
    } catch (err: any) {
      console.error(`[DailyReport] DailySummary save failed for ${manager.name}:`, err.message);
    }

    // Отправка в Telegram (если есть привязка)
    if (!link?.telegramUserId) {
      skipped++;
      continue;
    }

    try {
      await sendFn(link.telegramUserId, report.text);
      console.log(`[DailyReport] Sent to ${manager.name} (${link.telegramUserId})`);

      // Обновляем статус на "sent"
      await prisma.dailySummary.updateMany({
        where: { managerId: manager.id, date: today, period: "day" },
        data: { sentStatus: "sent" },
      });

      sent++;
      await new Promise((r) => setTimeout(r, 200));
    } catch (err: any) {
      console.error(`[DailyReport] Failed to send to ${manager.name}:`, err.message);
      await prisma.dailySummary.updateMany({
        where: { managerId: manager.id, date: today, period: "day" },
        data: { sentStatus: "error" },
      }).catch(() => {});
      errors++;
    }
  }

  console.log("[DailyReport] Done:", { sent, skipped, errors });
  return { sent, skipped, errors };
}
