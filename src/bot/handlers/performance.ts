import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import { loadManagerPerformance } from "../../services/performanceData";
import {
  aggregateTeamPerformance,
  formatManagerPerformance,
  formatTeamPerformance,
} from "../../services/performanceReport";
import { formatPhoenixMovements, loadPhoenixMovements } from "../../services/phoenixMovementStats";
import { formatManagerDisplayName } from "../../services/managerDisplayName";
import {
  formatCallProcessingBreakdown,
  loadCallProcessingBreakdown,
} from "../../services/callProcessingStats";
import { fetchAllPipelines } from "../../services/amocrm";
import { formatRevenueStageSync, syncRevenueStages } from "../../services/revenueStageSync";
import { formatInactivityStatus, loadInactivityStatus } from "../../services/inactivityStatus";
import {
  formatInactivityMovementSwitch,
  getInactivityMovementSwitch,
  isInactivityMovementPaused,
  setInactivityMovementPaused,
} from "../../services/inactivityMovementSwitch";
import {
  buildSweepKeyboard,
  createSweepConfirmationService,
  formatSweepDecision,
  formatSweepProposal,
  parseSweepCallback,
} from "../../services/inactivitySweepConfirmation";
import { createLeadInactivityAmoClient } from "../../services/leadInactivityAmoClient";
import { notifyAdmins } from "../notify";
import {
  almatyPlanMonth,
  formatPlanMonth,
  getManagerPlans,
  parsePlanAmount,
  parsePlanMonth,
  setManagerPlan,
  type PlanMonth,
} from "../../services/salesPlan";

/**
 * Plan management and the call/revenue/plan report for a manager, a team lead's
 * team, and the whole company.
 */

const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;

async function isAdmin(telegramUserId: string): Promise<boolean> {
  if (telegramUserId === ADMIN_TELEGRAM_ID) return true;
  return (await prisma.botAdmin.findUnique({ where: { telegramUserId } })) !== null;
}

async function linkedManager(telegramUserId: string) {
  const link = await prisma.telegramLink.findFirst({
    where: { telegramUserId, status: "used" },
    include: { manager: true },
  });
  const manager = link?.manager;
  return manager && manager.isActive ? manager : null;
}

/** Setting a plan is a ROP/admin action; team leads may only read one. */
async function requirePlanEditor(bot: TelegramBot, msg: TelegramBot.Message): Promise<boolean> {
  const telegramUserId = String(msg.from!.id);
  if (await isAdmin(telegramUserId)) return true;
  const manager = await linkedManager(telegramUserId);
  if (manager?.role === "ROP") return true;
  await bot.sendMessage(msg.chat.id, "❌ Reja belgilash faqat ROP va administrator uchun.");
  return false;
}

/** Yesterday 00:00 → today 00:00 in server local time, matching the daily cron. */
function yesterdayRange(now = new Date()): { from: Date; to: Date; label: string } {
  const to = new Date(now);
  to.setHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - 1);
  return { from, to, label: `Kecha (${from.getDate()}.${String(from.getMonth() + 1).padStart(2, "0")})` };
}

async function teamManagerIdsOf(managerId: number, ownTeamId: number | null): Promise<number[]> {
  const teams = await prisma.team.findMany({
    where: { OR: [{ teamLeadId: managerId }, ...(ownTeamId ? [{ id: ownTeamId }] : [])] },
    select: { members: { where: { isActive: true, excludeFromReports: false }, select: { id: true } } },
  });
  const ids = new Set<number>(teams.flatMap((team) => team.members.map((member) => member.id)));
  ids.add(managerId);
  return [...ids];
}

async function sendPerformance(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  managerIds: number[],
  title: string | null,
): Promise<void> {
  if (managerIds.length === 0) {
    await bot.sendMessage(msg.chat.id, "ℹ️ Hisobot uchun menejer topilmadi.");
    return;
  }

  const { from, to, label } = yesterdayRange();
  await bot.sendChatAction(msg.chat.id, "typing");
  const performance = await loadManagerPerformance({ managerIds, range: { from, to } });

  if (title === null) {
    const single = performance.get(managerIds[0]);
    if (!single) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Ma'lumot topilmadi.");
      return;
    }
    await bot.sendMessage(msg.chat.id, formatManagerPerformance(single, label));
    return;
  }

  // Phoenix moves are company-wide, not per manager, so they are loaded once
  // for the range rather than aggregated from the member rows.
  let phoenixLines: string[] = [];
  try {
    phoenixLines = formatPhoenixMovements(await loadPhoenixMovements({ from, to }));
  } catch (error) {
    console.error("[Performance] Phoenix movement stats unavailable:", error instanceof Error ? error.message : error);
  }

  await bot.sendMessage(
    msg.chat.id,
    formatTeamPerformance(aggregateTeamPerformance(title, label, [...performance.values()], phoenixLines)),
  );
}

export function registerPerformanceHandlers(bot: TelegramBot): void {
  // /my_stats — the caller's own call/revenue/plan report.
  bot.onText(/^\/my_stats$/, async (msg) => {
    const manager = await linkedManager(String(msg.from!.id));
    if (!manager) {
      await bot.sendMessage(msg.chat.id, "❌ Siz avtorizatsiya qilinmagansiz. /start kiriting.");
      return;
    }
    await sendPerformance(bot, msg, [manager.id], null);
  });

  // /team_stats — a team lead's team, or the whole company for ROP/admin.
  bot.onText(/^\/team_stats$/, async (msg) => {
    const telegramUserId = String(msg.from!.id);
    const manager = await linkedManager(telegramUserId);

    if (await isAdmin(telegramUserId) || manager?.role === "ROP") {
      const all = await prisma.manager.findMany({
        where: { isActive: true, excludeFromReports: false },
        select: { id: true },
      });
      await sendPerformance(bot, msg, all.map((item) => item.id), "Kompaniya");
      return;
    }

    if (manager?.role !== "TEAMLEAD") {
      await bot.sendMessage(msg.chat.id, "❌ Bu buyruq TeamLead va ROP uchun.");
      return;
    }

    await sendPerformance(bot, msg, await teamManagerIdsOf(manager.id, manager.teamId), "Jamoa");
  });

  // The amoCRM client is only needed for the sweep and only when the worker is
  // configured; built lazily so a bot without those credentials still starts.
  let sweepService: ReturnType<typeof createSweepConfirmationService> | null = null;
  const getSweepService = () => {
    if (sweepService) return sweepService;
    const baseUrl = process.env.AMOCRM_BASE_URL?.trim();
    const accessToken = process.env.AMOCRM_ACCESS_TOKEN?.trim();
    if (!baseUrl || !accessToken) return null;
    const amo = createLeadInactivityAmoClient({ baseUrl, accessToken });
    sweepService = createSweepConfirmationService({
      listEligibleLeads: () => amo.listAllowedSourceStageLeads(),
      moveLeadToTarget: (leadId, target) => amo.moveLeadToTarget(leadId, target),
      isStopped: () => isInactivityMovementPaused(),
      onMoved: (candidate) => notifyAdmins(
        ["✅ Перемещение по неактивности", `Сделка: #${candidate.leadId}`].join("\n"),
        "all",
      ),
    });
    return sweepService;
  };

  // /inactivity_off — full stop: clears the queue, webhooks record nothing.
  bot.onText(/^\/inactivity_off$/, async (msg) => {
    if (!(await requirePlanEditor(bot, msg))) return;
    const state = await setInactivityMovementPaused(true, String(msg.from!.id));
    await bot.sendMessage(msg.chat.id, formatInactivityMovementSwitch(state));
  });

  // /inactivity_on — switch on, then offer to sweep every lead already idle
  // for 7 days. The sweep itself waits for an explicit yes from this operator;
  // afterwards the worker runs on its usual 72-hour rule.
  bot.onText(/^\/inactivity_on$/, async (msg) => {
    if (!(await requirePlanEditor(bot, msg))) return;
    const requestedBy = String(msg.from!.id);
    const state = await setInactivityMovementPaused(false, requestedBy);

    const service = getSweepService();
    if (!service) {
      await bot.sendMessage(msg.chat.id, `${formatInactivityMovementSwitch(state)}\n\n⚠️ amoCRM не настроен — массовый перенос недоступен.`);
      return;
    }

    await bot.sendChatAction(msg.chat.id, "typing");
    try {
      const started = await service.start(requestedBy);
      if (started.kind === "nothing_to_move") {
        await bot.sendMessage(
          msg.chat.id,
          `${formatInactivityMovementSwitch(state)}\n\nЛидов без касаний 7 дней и дольше нет (проверено: ${started.scanned}).`,
        );
        return;
      }
      await bot.sendMessage(msg.chat.id, formatSweepProposal(started.pending, started.scanned), {
        reply_markup: buildSweepKeyboard(started.pending.token),
      });
    } catch (error) {
      await bot.sendMessage(
        msg.chat.id,
        `${formatInactivityMovementSwitch(state)}\n\n❌ Не удалось получить список лидов из amoCRM: ${error instanceof Error ? error.message : "ошибка"}`,
      );
    }
  });

  bot.on("callback_query", async (query) => {
    const callback = parseSweepCallback(query.data);
    if (!callback) return;
    const chatId = query.message?.chat.id;
    const service = getSweepService();
    if (!service || !chatId) {
      await bot.answerCallbackQuery(query.id, { text: "Недоступно" });
      return;
    }

    await bot.answerCallbackQuery(query.id);
    // Clear the buttons first so a slow sweep cannot be re-tapped mid-run.
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message!.message_id }).catch(() => {});
    if (callback.decision === "yes") await bot.sendMessage(chatId, "⏳ Переношу лиды в Феникс…");

    try {
      const result = await service.decide(callback.token, callback.decision, String(query.from.id));
      await bot.sendMessage(chatId, formatSweepDecision(result));
    } catch (error) {
      await bot.sendMessage(chatId, `❌ Массовый перенос прерван ошибкой: ${error instanceof Error ? error.message : "ошибка"}`);
    }
  });

  // /inactivity_switch — current state of the pause switch alone.
  bot.onText(/^\/inactivity_switch$/, async (msg) => {
    if (!(await requirePlanEditor(bot, msg))) return;
    await bot.sendMessage(msg.chat.id, formatInactivityMovementSwitch(await getInactivityMovementSwitch()));
  });

  // /inactivity_status — why the Phoenix worker is or is not moving leads.
  bot.onText(/^\/inactivity_status$/, async (msg) => {
    if (!(await requirePlanEditor(bot, msg))) return;
    await bot.sendChatAction(msg.chat.id, "typing");
    try {
      await bot.sendMessage(msg.chat.id, formatInactivityStatus(await loadInactivityStatus()));
    } catch (error) {
      await bot.sendMessage(msg.chat.id, `❌ Не удалось прочитать состояние: ${error instanceof Error ? error.message : "ошибка"}`);
    }
  });

  // /sync_stages — discover the revenue stages of every amoCRM pipeline.
  bot.onText(/^\/sync_stages$/, async (msg) => {
    if (!(await requirePlanEditor(bot, msg))) return;

    await bot.sendMessage(msg.chat.id, "⏳ Читаю воронки amoCRM...");
    try {
      const result = await syncRevenueStages({ fetchPipelines: fetchAllPipelines });
      await bot.sendMessage(msg.chat.id, formatRevenueStageSync(result));
    } catch (error) {
      console.error("[RevenueStageSync] failed:", error instanceof Error ? error.message : error);
      await bot.sendMessage(
        msg.chat.id,
        `❌ Не удалось синхронизировать этапы: ${error instanceof Error ? error.message : "неизвестная ошибка"}`,
      );
    }
  });

  // /rating_off <amo_id> | /rating_on <amo_id> — keep non-selling accounts
  // (teams, ROP and service logins) out of the rankings.
  bot.onText(/^\/rating_(off|on)\s+(\d+)$/, async (msg, match) => {
    if (!(await requirePlanEditor(bot, msg))) return;

    const exclude = match![1] === "off";
    const amoUserId = Number(match![2]);
    const manager = await prisma.manager.findUnique({ where: { amoUserId } });
    if (!manager) {
      await bot.sendMessage(msg.chat.id, `❌ amoCRM ID ${amoUserId} bo'yicha menejer topilmadi.`);
      return;
    }

    await prisma.manager.update({ where: { id: manager.id }, data: { excludeFromReports: exclude } });
    await bot.sendMessage(
      msg.chat.id,
      exclude
        ? `✅ ${formatManagerDisplayName(manager.name)} hisobotlardan chiqarildi.`
        : `✅ ${formatManagerDisplayName(manager.name)} hisobotlarga qaytarildi.`,
    );
  });

  // /rating_list — who counts as a seller and who is excluded.
  bot.onText(/^\/rating_list$/, async (msg) => {
    if (!(await requirePlanEditor(bot, msg))) return;

    const managers = await prisma.manager.findMany({
      where: { isActive: true },
      select: { name: true, amoUserId: true, excludeFromReports: true },
      orderBy: { name: "asc" },
    });
    const included = managers.filter((manager) => !manager.excludeFromReports);
    const excluded = managers.filter((manager) => manager.excludeFromReports);

    const line = (manager: { name: string; amoUserId: number | null }): string => (
      `• ${formatManagerDisplayName(manager.name)} (${manager.amoUserId ?? "—"})`
    );
    const lines = [
      `👥 Hisobotdagi menejerlar: ${included.length}`,
      ...included.map(line),
      "",
      `🚫 Hisobotdan chiqarilgan: ${excluded.length}`,
      ...(excluded.length ? excluded.map(line) : ["—"]),
      "",
      "ℹ️ Chiqarish: /rating_off <amoCRM ID>, qaytarish: /rating_on <amoCRM ID>",
    ];
    await bot.sendMessage(msg.chat.id, lines.join("\n"));
  });

  // /call_status [N] — why calls over the last N days were or were not analyzed.
  bot.onText(/^\/call_status(?:\s+(\d{1,2}))?$/, async (msg, match) => {
    if (!(await requirePlanEditor(bot, msg))) return;

    const days = Math.min(Math.max(Number(match![1] ?? 1), 1), 30);
    const to = new Date();
    to.setHours(24, 0, 0, 0);
    const from = new Date(to);
    from.setDate(from.getDate() - days);

    await bot.sendChatAction(msg.chat.id, "typing");
    const breakdown = await loadCallProcessingBreakdown({ from, to });
    const label = days === 1 ? "сегодня" : `последние ${days} дн.`;
    await bot.sendMessage(msg.chat.id, formatCallProcessingBreakdown(breakdown, label));
  });

  // /set_plan <amo_user_id> <amount> [YYYY-MM]
  bot.onText(/^\/set_plan\s+(\d+)\s+([\d\s']+?)(?:\s+(\d{4}-\d{2}))?$/, async (msg, match) => {
    if (!(await requirePlanEditor(bot, msg))) return;

    const amoUserId = Number(match![1]);
    const amountTarget = parsePlanAmount(match![2]);
    const month: PlanMonth | null = match![3] ? parsePlanMonth(match![3]) : almatyPlanMonth(new Date());

    if (amountTarget === null) {
      await bot.sendMessage(msg.chat.id, "❌ Summa noto'g'ri. Masalan: /set_plan 12695650 50000000");
      return;
    }
    if (month === null) {
      await bot.sendMessage(msg.chat.id, "❌ Oy noto'g'ri. Format: YYYY-MM, masalan 2026-09.");
      return;
    }

    const manager = await prisma.manager.findUnique({ where: { amoUserId } });
    if (!manager) {
      await bot.sendMessage(msg.chat.id, `❌ amoCRM ID ${amoUserId} bo'yicha menejer topilmadi.`);
      return;
    }

    await setManagerPlan({
      managerId: manager.id,
      month,
      amountTarget,
      setByTelegramUserId: String(msg.from!.id),
    });

    await bot.sendMessage(
      msg.chat.id,
      `✅ Reja belgilandi.\n👤 ${manager.name}\n📅 ${formatPlanMonth(month)}\n🎯 ${amountTarget.toLocaleString("ru-RU")}`,
    );
  });

  bot.onText(/^\/set_plan$/, async (msg) => {
    if (!(await requirePlanEditor(bot, msg))) return;
    await bot.sendMessage(
      msg.chat.id,
      "ℹ️ Foydalanish: /set_plan <amoCRM ID> <summa> [YYYY-MM]\nMasalan: /set_plan 12695650 50000000 2026-09\nOy ko'rsatilmasa — joriy oy.",
    );
  });

  // /plans [YYYY-MM] — every active manager's target for the month.
  bot.onText(/^\/plans(?:\s+(\d{4}-\d{2}))?$/, async (msg, match) => {
    if (!(await requirePlanEditor(bot, msg))) return;

    const month = match![1] ? parsePlanMonth(match![1]) : almatyPlanMonth(new Date());
    if (month === null) {
      await bot.sendMessage(msg.chat.id, "❌ Oy noto'g'ri. Format: YYYY-MM.");
      return;
    }

    const managers = await prisma.manager.findMany({
      where: { isActive: true },
      select: { id: true, name: true, amoUserId: true },
      orderBy: { name: "asc" },
    });
    const plans = await getManagerPlans(managers.map((manager) => manager.id), month);

    const lines = [`🎯 Rejalar — ${formatPlanMonth(month)}`, ""];
    let total = 0;
    for (const manager of managers) {
      const target = plans.get(manager.id);
      if (target !== undefined) total += target;
      lines.push(
        `• ${manager.name} (${manager.amoUserId ?? "—"}): ${
          target !== undefined ? target.toLocaleString("ru-RU") : "belgilanmagan"
        }`,
      );
    }
    lines.push("", `Jami: ${total.toLocaleString("ru-RU")}`);

    await bot.sendMessage(msg.chat.id, lines.join("\n"));
  });
}
