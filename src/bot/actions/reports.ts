import type TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import { loadManagerPerformance } from "../../services/performanceData";
import {
  bold,
  escapeHtml,
  formatCallSection,
  formatPlanSection,
  formatRevenueSection,
  type TeamPerformance,
} from "../../services/performanceReport";
import { amoUserIdMap } from "../../services/amoDailyFacts";
import { applyAmoRevenueForManagers, buildCompanyTeam } from "../../services/companyPerformance";
import { buildTeamReportFile } from "../../services/teamPerformanceDelivery";
import { formatManagerDisplayName } from "../../services/managerDisplayName";
import { findLinkedManager, type Access, type LinkedManager } from "../access";
import { pendingInput } from "../pendingInput";
import { defineInputHandler } from "../inputHandlers";
import { cancelKeyboard } from "../keyboards/menuCallbacks";
import { formatDuration, getWeakAreas, parseDate, UZ_MONTHS, UZ_MONTHS_CAP } from "../reportText";
import { DEACTIVATED_TEXT, NOT_LINKED_TEXT } from "./dispatch";
import { defineAction } from "./registry";
import type { ActionContext } from "./types";

/**
 * Period reports: /report, /week, /month, /period and /errors.
 *
 * An administrator without a manager link gets the company report; everyone
 * else gets their own. That rule predates this module and is kept as is.
 */

export function isAdminMode(access: Access): boolean {
  return access.isAdmin && !access.manager;
}

/** The caller's manager, with the same refusals the commands always gave. */
export async function requireActiveManager(ctx: ActionContext): Promise<LinkedManager | null> {
  const manager = ctx.access.manager;
  if (!manager) {
    await ctx.bot.sendMessage(ctx.chatId, NOT_LINKED_TEXT);
    return null;
  }
  if (!manager.isActive) {
    await ctx.bot.sendMessage(ctx.chatId, DEACTIVATED_TEXT);
    return null;
  }
  return manager;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export async function buildReport(
  managerId: number,
  from: Date,
  to: Date,
  label: string
): Promise<string> {
  const fromStart = new Date(from);
  fromStart.setHours(0, 0, 0, 0);
  const toEnd = new Date(to);
  toEnd.setHours(23, 59, 59, 999);

  const calls = await prisma.call.findMany({
    where: {
      managerId,
      startedAt: { gte: fromStart, lte: toEnd },
      processingStatus: "processed",
    },
    include: { analysis: true },
    orderBy: { startedAt: "desc" },
  });

  if (!calls.length) {
    return `${bold(`${label} uchun hisobot`)}\n\nBu davr uchun tahlil qilingan qo'ng'iroqlar topilmadi.`;
  }

  const scores = calls
    .map((c) => c.analysis?.overallScore)
    .filter((s): s is number => s !== null && s !== undefined);
  const avgScore = scores.length
    ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
    : "ma'lumot yo'q";
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
    .map(([w]) => `  • ${escapeHtml(w)}`)
    .join("\n");

  const topStrong = Object.entries(strongMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s]) => `  • ${escapeHtml(s)}`)
    .join("\n");

  // Calls, revenue and plan come from the shared performance builder so the
  // report shows the same numbers as the daily one, not a second version.
  let performanceBlock: string[] = [
    `${bold("Tahlil qilingan qo'ng'iroqlar:")} ${calls.length}`,
    `${bold("Jami vaqt:")} ${formatDuration(totalTalk)}`,
    `${bold("O'rtacha ball:")} ${avgScore}/100`,
  ];
  try {
    const performanceById = await loadManagerPerformance({
      managerIds: [managerId],
      range: { from: fromStart, to: toEnd },
    });
    const owner = await prisma.manager.findUnique({ where: { id: managerId }, select: { id: true, amoUserId: true } });
    if (owner) {
      await applyAmoRevenueForManagers({
        performance: performanceById,
        managers: [owner],
        range: { from: fromStart, to: toEnd },
        logPrefix: "[Report]",
      });
    }
    const performance = performanceById.get(managerId);
    if (performance) {
      performanceBlock = [
        ...formatCallSection(performance.calls),
        "",
        ...formatRevenueSection(performance.revenue),
        "",
        ...formatPlanSection(performance.plan),
      ];
    }
  } catch (error) {
    console.error("[Report] Performance block unavailable:", error instanceof Error ? error.message : error);
  }

  return [
    bold(`${label} uchun hisobot`),
    ``,
    ...performanceBlock,
    topStrong ? `\n${bold("Kuchli tomonlar:")}\n${topStrong}` : "",
    topWeak ? `\n${bold("O'sish sohalari:")}\n${topWeak}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface AdminReport {
  text: string;
  /** Company team for the period; null when the block could not be built. */
  team: TeamPerformance | null;
}

export async function buildAdminReport(from: Date, to: Date, label: string): Promise<AdminReport> {
  const fromStart = new Date(from); fromStart.setHours(0, 0, 0, 0);
  const toEnd = new Date(to); toEnd.setHours(23, 59, 59, 999);

  const allCalls = await prisma.call.findMany({
    where: { startedAt: { gte: fromStart, lte: toEnd }, processingStatus: "processed" },
    include: { analysis: true, manager: true },
    orderBy: { startedAt: "desc" },
  });

  // Team, ROP and service accounts keep their calls but stay out of the
  // ranking: mixing them with sellers made the report unreadable.
  const calls = allCalls.filter((call) => call.manager?.excludeFromReports !== true);
  const excludedCalls = allCalls.length - calls.length;

  if (!calls.length) {
    return { text: `${bold(`${label} uchun umumiy hisobot`)}\n\nBu davr uchun tahlil qilingan qo'ng'iroqlar topilmadi.`, team: null };
  }

  const totalTalk = calls.reduce((a, c) => a + c.durationSeconds, 0);
  const allScores = calls.map(c => c.analysis?.overallScore).filter((s): s is number => s !== null && s !== undefined);
  const avgScore = allScores.length ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1) : "—";

  // Рейтинг менеджеров
  const mgrMap = new Map<string, { total: number; count: number }>();
  for (const call of calls) {
    const name = call.manager?.name ? formatManagerDisplayName(call.manager.name) : "Noma'lum";
    const score = call.analysis?.overallScore;
    if (score === null || score === undefined) continue;
    const cur = mgrMap.get(name) ?? { total: 0, count: 0 };
    mgrMap.set(name, { total: cur.total + score, count: cur.count + 1 });
  }
  const mgrRating = [...mgrMap.entries()]
    .map(([name, { total, count }]) => ({ name, avg: total / count, count }))
    .sort((a, b) => b.avg - a.avg)
    .map((m, i) => `${i + 1}. ${escapeHtml(m.name)} — ${m.avg.toFixed(0)}/100 (${m.count} ta)`)
    .join("\n");

  // Топ слабых критериев
  const weakMap: Record<string, number> = {};
  for (const call of calls)
    for (const w of getWeakAreas(call.analysis?.criteria))
      weakMap[w] = (weakMap[w] ?? 0) + 1;
  const topWeak = Object.entries(weakMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w, n]) => `  • ${escapeHtml(w)} (${n}×)`)
    .join("\n");

  const managerCount = new Set(calls.map(c => c.managerId).filter(Boolean)).size;

  // The company block is the same one the daily report sends: calls with the
  // connected/missed split, revenue, plan progress and Phoenix moves.
  let companyBlock: string[] = [
    `${bold("Menejerlar:")} ${managerCount} (jami ${calls.length} ta qo'ng'iroq)`,
    `${bold("Jami vaqt:")} ${formatDuration(totalTalk)}`,
    `${bold("O'rtacha ball:")} ${avgScore}/100`,
  ];
  let companyTeam: TeamPerformance | null = null;
  try {
    const sellers = await prisma.manager.findMany({
      where: { isActive: true, excludeFromReports: false },
      select: { id: true, amoUserId: true },
    });
    const performance = await loadManagerPerformance({
      managerIds: sellers.map((seller) => seller.id),
      range: { from: fromStart, to: toEnd },
    });
    const { team, phoenixLines } = await buildCompanyTeam({
      title: "Kompaniya",
      label,
      range: { from: fromStart, to: toEnd },
      performance,
      amoUserIdByManagerId: amoUserIdMap(sellers),
      logPrefix: "[Report]",
    });
    companyTeam = team;
    companyBlock = [
      ...formatCallSection(team.calls),
      "",
      ...formatRevenueSection(team.revenue),
      "",
      ...formatPlanSection(team.plan),
      ...(phoenixLines.length ? ["", ...phoenixLines] : []),
    ];
  } catch (error) {
    console.error("[Report] Company block unavailable:", error instanceof Error ? error.message : error);
  }

  const text = [
    bold(`${label} uchun umumiy hisobot`),
    ``,
    ...companyBlock,
    `\n${bold("Menejerlar reytingi")} (o'rtacha ball / tahlil qilingan qo'ng'iroqlar):\n${mgrRating}`,
    topWeak ? `\n${bold("Eng zaif kriteriyalar:")}\n${topWeak}` : "",
    excludedCalls > 0
      ? `\nReytingdan chiqarilgan hisoblar: ${excludedCalls} ta qo'ng'iroq hisobga olinmadi.`
      : "",
  ].filter(Boolean).join("\n");
  return { text, team: companyTeam };
}

/**
 * The admin period report: the text, then the manager table as an Excel file,
 * the same one the 09:00 report and /team_stats attach.
 */
export async function sendAdminReport(
  bot: Pick<TelegramBot, "sendMessage" | "sendDocument">,
  chatId: TelegramBot.ChatId,
  from: Date,
  to: Date,
  label: string,
): Promise<void> {
  const report = await buildAdminReport(from, to, label);
  await bot.sendMessage(chatId, report.text, { parse_mode: "HTML" });
  const file = report.team ? await buildTeamReportFile(report.team, "[Report]") : null;
  if (file) {
    await bot.sendDocument(chatId, file.buffer, { caption: file.caption }, { filename: file.filename, contentType: file.contentType });
  }
}

export type ReportPreset = "day" | "week" | "month";

export function presetRange(preset: ReportPreset, now = new Date()): { from: Date; to: Date; label: string } {
  const to = new Date(now);
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  if (preset === "week") from.setDate(from.getDate() - 6);
  else if (preset === "month") from.setDate(1);

  const dayStr = `${now.getDate()}-${UZ_MONTHS[now.getMonth()]}`;
  const label =
    preset === "day"
      ? `bugun, ${dayStr}`
      : preset === "week"
      ? "so'nggi 7 kun"
      : `${UZ_MONTHS_CAP[now.getMonth()]} ${now.getFullYear()}`;

  return { from, to, label };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function runPresetReport(ctx: ActionContext, preset: ReportPreset): Promise<void> {
  const { from, to, label } = presetRange(preset);
  await ctx.bot.sendMessage(ctx.chatId, "⏳ Hisobot tuzilmoqda...");
  if (isAdminMode(ctx.access)) {
    await sendAdminReport(ctx.bot, ctx.chatId, from, to, label);
    return;
  }
  const manager = await requireActiveManager(ctx);
  if (!manager) return;
  await ctx.bot.sendMessage(ctx.chatId, await buildReport(manager.id, from, to, label), { parse_mode: "HTML" });
}

const REPORT_ROLES = ["admin", "manager"] as const;

defineAction({
  id: "report", section: "reports", roles: [...REPORT_ROLES], label: "Bugun",
  command: { pattern: /\/report$/, usage: "/report", description: "bugungi hisobot" },
  run: (ctx) => runPresetReport(ctx, "day"),
});

defineAction({
  id: "week", section: "reports", roles: [...REPORT_ROLES], label: "Hafta",
  command: { pattern: /\/week$/, usage: "/week", description: "so'nggi 7 kun" },
  run: (ctx) => runPresetReport(ctx, "week"),
});

defineAction({
  id: "month", section: "reports", roles: [...REPORT_ROLES], label: "Oy",
  command: { pattern: /\/month$/, usage: "/month", description: "joriy oy" },
  run: (ctx) => runPresetReport(ctx, "month"),
});

defineAction({
  id: "period", section: "reports", roles: [...REPORT_ROLES], label: "Davr",
  command: { pattern: /\/period$/, usage: "/period", description: "ixtiyoriy sana oralig'i" },
  async run(ctx) {
    const adminMode = isAdminMode(ctx.access);
    if (!adminMode) {
      const manager = await requireActiveManager(ctx);
      if (!manager) return;
    }
    await pendingInput.expect(ctx.userId, "period_from", { adminMode });
    await ctx.bot.sendMessage(
      ctx.chatId,
      `📅 Davr *boshlanish sanasini* KK.OO.YYYY formatida kiriting:\n\nMasalan: \`01.03.2026\``,
      { parse_mode: "Markdown", reply_markup: cancelKeyboard() }
    );
  },
});

// ---------------------------------------------------------------------------
// /period dialog: two dates, answered as plain text
// ---------------------------------------------------------------------------

export const DATE_FORMAT_ERROR_TEXT = "❌ Sanani aniqlab bo'lmadi. *KK.OO.YYYY* formatida kiriting, masalan: `10.03.2026`";
export const PERIOD_ORDER_ERROR_TEXT = "❌ Oxirgi sana boshidan oldin bo'la olmaydi.";

export function formatDmy(d: Date): string {
  return `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1).toString().padStart(2, "0")}.${d.getFullYear()}`;
}

// A wrong date leaves the question open: the user simply types again.
defineInputHandler("period_from", async ({ bot, chatId, userId, text, input, pending }) => {
  const date = parseDate(text.trim());
  if (!date) {
    await bot.sendMessage(chatId, DATE_FORMAT_ERROR_TEXT, { parse_mode: "Markdown" });
    return;
  }
  await pending.expect(userId, "period_to", { adminMode: input.payload.adminMode === true, from: date.toISOString() });
  await bot.sendMessage(
    chatId,
    `✅ Boshi: *${formatDmy(date)}*\n\nEndi *oxirgi sana* kiriting:`,
    { parse_mode: "Markdown", reply_markup: cancelKeyboard() }
  );
});

defineInputHandler("period_to", async ({ bot, chatId, userId, telegramUserId, text, input, pending }) => {
  const to = parseDate(text.trim());
  if (!to) {
    await bot.sendMessage(chatId, DATE_FORMAT_ERROR_TEXT, { parse_mode: "Markdown" });
    return;
  }
  const from = new Date(String(input.payload.from));
  await pending.cancel(userId);

  if (to < from) {
    await bot.sendMessage(chatId, PERIOD_ORDER_ERROR_TEXT);
    return;
  }

  await bot.sendMessage(chatId, "⏳ Hisobot tuzilmoqda...");
  const label = `${formatDmy(from)} — ${formatDmy(to)}`;

  if (input.payload.adminMode === true) {
    await sendAdminReport(bot, chatId, from, to, label);
    return;
  }

  const manager = await findLinkedManager(telegramUserId);
  if (!manager) {
    await bot.sendMessage(chatId, "❌ Siz avtorizatsiya qilinmagansiz.");
    return;
  }
  await bot.sendMessage(chatId, await buildReport(manager.id, from, to, label), { parse_mode: "HTML" });
});

defineAction({
  id: "errors", section: "reports", roles: [...REPORT_ROLES], label: "Xatolar",
  command: { pattern: /\/errors$/, usage: "/errors", description: "so'nggi 30 kunlik eng ko'p xatolar" },
  async run(ctx) {
    const adminMode = isAdminMode(ctx.access);

    const from = new Date();
    from.setDate(from.getDate() - 30);

    let calls: Awaited<ReturnType<typeof prisma.call.findMany<{ include: { analysis: true } }>>>;
    if (adminMode) {
      calls = await prisma.call.findMany({
        where: { startedAt: { gte: from }, processingStatus: "processed" },
        include: { analysis: true },
      });
    } else {
      const manager = await requireActiveManager(ctx);
      if (!manager) return;
      calls = await prisma.call.findMany({
        where: { managerId: manager.id, startedAt: { gte: from }, processingStatus: "processed" },
        include: { analysis: true },
      });
    }

    const weakMap: Record<string, number> = {};
    for (const call of calls)
      for (const w of getWeakAreas(call.analysis?.criteria))
        weakMap[w] = (weakMap[w] ?? 0) + 1;

    if (!Object.keys(weakMap).length) {
      await ctx.bot.sendMessage(ctx.chatId, "✅ So'nggi 30 kunda xatolar topilmadi!");
      return;
    }

    const sorted = Object.entries(weakMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([w, count], i) => `${i + 1}. ${w} (${count}×)`)
      .join("\n");

    await ctx.bot.sendMessage(
      ctx.chatId,
      `⚠️ 30 kunlik eng ko'p xatolar (${calls.length} qo'ng'iroq):\n\n${sorted}`
    );
  },
});
