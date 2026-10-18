import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import { loadManagerPerformance } from "../../services/performanceData";
import { formatManagerPerformance } from "../../services/performanceReport";
import { deliverTeamPerformance } from "../../services/teamPerformanceDelivery";
import { amoUserIdMap } from "../../services/amoDailyFacts";
import { applyAmoRevenueForManagers, buildCompanyTeam } from "../../services/companyPerformance";
import { formatManagerDisplayName } from "../../services/managerDisplayName";
import {
  formatCallProcessingBreakdown,
  loadCallProcessingBreakdown,
} from "../../services/callProcessingStats";
import { formatRevenueStageSync, syncRevenueStages } from "../../services/revenueStageSync";
import { formatInactivityStatus, loadInactivityStatus } from "../../services/inactivityStatus";
import {
  formatInactivityDailyCap,
  formatInactivityMovementSwitch,
  getInactivityMovementSwitch,
  setInactivityDailyCap,
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
import { diagnoseLead, formatLeadDiagnosis, loadLeadDiagnosisInput } from "../../services/inactivityLeadDiagnosis";
import { notifyAdmins } from "../notify";
import { splitTelegramMessage } from "../longMessage";
import { createSweepRuntime } from "../../services/inactivitySweepRuntime";
import { formatSweepMovedSummary } from "../../services/inactivityNightlySweep";
import {
  almatyPlanMonth,
  formatPlanMonth,
  getManagerPlans,
  parsePlanAmount,
  parsePlanMonth,
  setManagerPlan,
  type PlanMonth,
} from "../../services/salesPlan";
import { findLinkedManager, hasRole, resolveAccess } from "../access";
import { defineAction } from "../actions/registry";
import { registerCommandActions } from "../actions/dispatch";
import { createChoiceCollect, createPickManagerCollect, createSetPlanCollect, DAY_OPTIONS, planViewMonthOptions, splitPacked } from "../actions/pickerFlows";
import { actionCallback } from "../keyboards/menuCallbacks";

/**
 * Plan management and the call/revenue/plan report for a manager, a team lead's
 * team, and the whole company.
 */

/** The caller's manager row, only while the account is active. */
async function linkedManager(telegramUserId: string) {
  const manager = await findLinkedManager(telegramUserId);
  return manager && manager.isActive ? manager : null;
}

export const PLAN_EDITOR_DENY_TEXT = "❌ Reja belgilash faqat ROP va administrator uchun.";

/** The two switches under the limit screen; each re-runs the action with its argument. */
export function inactivityLimitKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "Включить лимит", callback_data: actionCallback("inactivity_limit", "on") },
      { text: "Снять лимит", callback_data: actionCallback("inactivity_limit", "off") },
    ]],
  };
}

/** Setting a plan is a ROP/admin action; team leads may only read one. */
async function requirePlanEditor(bot: TelegramBot, msg: TelegramBot.Message): Promise<boolean> {
  const access = await resolveAccess(String(msg.from!.id));
  if (hasRole(access, "admin", "rop")) return true;
  await bot.sendMessage(msg.chat.id, PLAN_EDITOR_DENY_TEXT);
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
  chatId: number,
  managerIds: number[],
  title: string | null,
): Promise<void> {
  if (managerIds.length === 0) {
    await bot.sendMessage(chatId, "ℹ️ Hisobot uchun menejer topilmadi.");
    return;
  }

  const { from, to, label } = yesterdayRange();
  await bot.sendChatAction(chatId, "typing");
  const performance = await loadManagerPerformance({ managerIds, range: { from, to } });

  if (title === null) {
    const owner = await prisma.manager.findUnique({ where: { id: managerIds[0] }, select: { id: true, amoUserId: true } });
    if (owner) {
      await applyAmoRevenueForManagers({ performance, managers: [owner], range: { from, to }, logPrefix: "[Performance]" });
    }
    const single = performance.get(managerIds[0]);
    if (!single) {
      await bot.sendMessage(chatId, "ℹ️ Ma'lumot topilmadi.");
      return;
    }
    await bot.sendMessage(chatId, formatManagerPerformance(single, label), { parse_mode: "HTML" });
    return;
  }

  // Phoenix arrivals and revenue come from amoCRM itself, not from our tables,
  // so hand-made moves and pre-deploy history are counted.
  const members = await prisma.manager.findMany({ where: { id: { in: managerIds } }, select: { id: true, amoUserId: true } });
  const { team } = await buildCompanyTeam({
    title,
    label,
    range: { from, to },
    performance,
    amoUserIdByManagerId: amoUserIdMap(members),
    logPrefix: "[Performance]",
  });

  await deliverTeamPerformance({
    team,
    sendText: (text) => bot.sendMessage(chatId, text, { parse_mode: "HTML" }).then(() => undefined),
    sendFile: (file) => bot.sendDocument(
      chatId,
      file.buffer,
      { caption: file.caption },
      { filename: file.filename, contentType: file.contentType },
    ).then(() => undefined),
    logPrefix: "[Performance]",
  });
}

// /my_stats — the caller's own call/revenue/plan report.
defineAction({
  id: "my_stats", section: "reports", roles: ["manager"], label: "Mening statistikam",
  denyText: "❌ Siz avtorizatsiya qilinmagansiz. /start kiriting.",
  command: { pattern: /^\/my_stats$/, usage: "/my_stats", description: "qo'ng'iroq/tushum/reja hisobotim" },
  async run(ctx) {
    // The manager role is only granted to an active linked manager.
    await sendPerformance(ctx.bot, ctx.chatId, [ctx.access.manager!.id], null);
  },
});

// /team_stats — a team lead's team, or the whole company for ROP/admin.
defineAction({
  id: "team_stats", section: "reports", roles: ["admin", "rop", "teamlead"], label: "Jamoa hisoboti",
  denyText: "❌ Bu buyruq TeamLead va ROP uchun.",
  command: { pattern: /^\/team_stats$/, usage: "/team_stats", description: "qo'ng'iroq/tushum/reja hisoboti" },
  async run(ctx) {
    if (hasRole(ctx.access, "admin", "rop")) {
      const all = await prisma.manager.findMany({
        where: { isActive: true, excludeFromReports: false },
        select: { id: true },
      });
      await sendPerformance(ctx.bot, ctx.chatId, all.map((item) => item.id), "Kompaniya");
      return;
    }
    const manager = ctx.access.manager!;
    await sendPerformance(ctx.bot, ctx.chatId, await teamManagerIdsOf(manager.id, manager.teamId), "Jamoa");
  },
});

export function registerPerformanceHandlers(bot: TelegramBot): void {
  registerCommandActions(bot, ["my_stats", "team_stats"]);

  // The amoCRM client is only needed for the sweep and only when the worker is
  // configured; built lazily so a bot without those credentials still starts.
  let sweepService: ReturnType<typeof createSweepConfirmationService> | null = null;
  const getSweepService = () => {
    if (sweepService) return sweepService;
    const runtime = createSweepRuntime();
    if (!runtime) return null;
    sweepService = createSweepConfirmationService(runtime);
    return sweepService;
  };

  // /inactivity_lead <id> — why this one deal has not been moved to Phoenix.
  defineAction({
    id: "inactivity_lead", section: "phoenix", order: 60, roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Feniks: bitim bo'yicha",
    input: { kind: "lead_id", prompt: "Bitim ID raqamini yuboring (Feniks tekshiruvi):" },
    command: { pattern: /^\/inactivity_lead\s+(\d{4,12})$/, usage: "/inactivity_lead <id>", description: "aniq bitim nega Feniksga o'tmagan" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requirePlanEditor(bot, msg))) return;
    const baseUrl = process.env.AMOCRM_BASE_URL?.trim();
    const accessToken = process.env.AMOCRM_ACCESS_TOKEN?.trim();
    if (!baseUrl || !accessToken) {
      await bot.sendMessage(msg.chat.id, "⚠️ amoCRM не настроен.");
      return;
    }
    await bot.sendChatAction(msg.chat.id, "typing");
    try {
      const amo = createLeadInactivityAmoClient({ baseUrl, accessToken });
      const input = await loadLeadDiagnosisInput(Number(ctx.args[0]), { readLead: (id) => amo.readLead(id) });
      await bot.sendMessage(msg.chat.id, formatLeadDiagnosis(input, diagnoseLead(input)));
    } catch (error) {
      await bot.sendMessage(msg.chat.id, `❌ Не удалось проверить сделку: ${error instanceof Error ? error.message : "ошибка"}`);
    }
    },
  });

  // /inactivity_off — full stop: clears the queue, webhooks record nothing.
  defineAction({
    id: "inactivity_off", section: "phoenix", order: 50, roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Feniksni to'xtatish", dangerous: true,
    command: { pattern: /^\/inactivity_off$/, usage: "/inactivity_off", description: "Feniksga ko'chirishni to'liq to'xtatish (navbat tozalanadi)" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requirePlanEditor(bot, msg))) return;
    const state = await setInactivityMovementPaused(true, String(msg.from!.id));
    await bot.sendMessage(msg.chat.id, formatInactivityMovementSwitch(state));
    },
  });

  // /inactivity_on — switch on, then offer to sweep every lead idle for 3+
  // days. The sweep waits for an explicit yes from this operator; afterwards
  // the worker runs on its 72-hour rule and the nightly sweep reconciles.
  defineAction({
    id: "inactivity_on", section: "phoenix", order: 40, roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Feniksni yoqish",
    command: { pattern: /^\/inactivity_on$/, usage: "/inactivity_on", description: "yoqish va 3+ kun tegilmagan lidlarni ko'chirishni taklif qilish" },
    async run(ctx) {
      const msg = ctx.message!;
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
          `${formatInactivityMovementSwitch(state)}\n\nЛидов без касаний 3 дня и дольше нет (проверено: ${started.scanned}).`,
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
    },
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
      // One summary for every administrator, not a message per deal: a first
      // sweep can move hundreds, and Telegram would throttle the flood.
      if (result.kind === "swept" && result.result.moved > 0) {
        const summary = formatSweepMovedSummary("Массовый перенос по неактивности", result.result.movedCandidates);
        for (const chunk of splitTelegramMessage(summary)) await notifyAdmins(chunk, "all");
      }
    } catch (error) {
      await bot.sendMessage(chatId, `❌ Массовый перенос прерван ошибкой: ${error instanceof Error ? error.message : "ошибка"}`);
    }
  });

  // /inactivity_limit_on | /inactivity_limit_off — the 100-per-day cap alone,
  // independent of whether moves run. /inactivity_limit shows the current one.
  defineAction({
    id: "inactivity_limit", section: "phoenix", order: 30, roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Feniks limiti",
    command: {
      pattern: /^\/inactivity_limit(?:_(on|off))?$/, usage: "/inactivity_limit[_on|_off]", description: "kunlik limit holati va o'zgartirish",
      menu: [
        { command: "inactivity_limit", description: "limit holatini ko'rish" },
        { command: "inactivity_limit_on", description: "kuniga 100 ta ko'chirish limitini yoqish" },
        { command: "inactivity_limit_off", description: "kunlik limitni o'chirish (cheklovsiz)" },
      ],
    },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requirePlanEditor(bot, msg))) return;
    const action = ctx.args[0];
    try {
      const state = action
        ? await setInactivityDailyCap(action === "on", String(msg.from!.id))
        : await getInactivityMovementSwitch();
      let today: { limit: number | null; used: number } | null = null;
      try {
        const status = await loadInactivityStatus();
        today = { limit: status.dailyLimit, used: status.dailyUsed };
      } catch {
        // The counter is a courtesy; the switch itself is already written.
      }
      // From the keyboard the state comes with its two switches, so the limit
      // is one screen; the command keeps its plain text.
      await bot.sendMessage(msg.chat.id, formatInactivityDailyCap(state, today), ctx.source === "command" ? {} : { reply_markup: inactivityLimitKeyboard() });
    } catch (error) {
      await bot.sendMessage(msg.chat.id, `Не удалось изменить лимит: ${error instanceof Error ? error.message : "ошибка"}`);
    }
    },
  });

  // /inactivity_switch — current state of the pause switch alone.
  defineAction({
    id: "inactivity_switch", section: "phoenix", order: 20, roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Feniks kaliti",
    command: { pattern: /^\/inactivity_switch$/, usage: "/inactivity_switch", description: "ko'chirish kaliti holati" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requirePlanEditor(bot, msg))) return;
    await bot.sendMessage(msg.chat.id, formatInactivityMovementSwitch(await getInactivityMovementSwitch()));
    },
  });

  // /inactivity_status — why the Phoenix worker is or is not moving leads.
  defineAction({
    id: "inactivity_status", section: "phoenix", order: 10, roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Feniks holati",
    command: { pattern: /^\/inactivity_status$/, usage: "/inactivity_status", description: "Feniks vorkeri nega ishlamayapti" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requirePlanEditor(bot, msg))) return;
    await bot.sendChatAction(msg.chat.id, "typing");
    try {
      await bot.sendMessage(msg.chat.id, formatInactivityStatus(await loadInactivityStatus()));
    } catch (error) {
      await bot.sendMessage(msg.chat.id, `❌ Не удалось прочитать состояние: ${error instanceof Error ? error.message : "ошибка"}`);
    }
    },
  });

  // /sync_stages — discover the revenue stages of every amoCRM pipeline.
  defineAction({
    id: "sync_stages", section: "company", roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Bosqichlarni sinxronlash",
    command: { pattern: /^\/sync_stages$/, usage: "/sync_stages", description: "amoCRM voronkalaridan tushum bosqichlarini sinxronlash" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requirePlanEditor(bot, msg))) return;

    await bot.sendMessage(msg.chat.id, "⏳ Читаю воронки amoCRM...");
    try {
      // amoCRM is imported here, not at the top: it pulls the BullMQ queue, and
    // this module is loaded in tests.
    const { fetchAllPipelines } = await import("../../services/amocrm");
    const result = await syncRevenueStages({ fetchPipelines: fetchAllPipelines });
      await bot.sendMessage(msg.chat.id, formatRevenueStageSync(result));
    } catch (error) {
      console.error("[RevenueStageSync] failed:", error instanceof Error ? error.message : error);
      await bot.sendMessage(
        msg.chat.id,
        `❌ Не удалось синхронизировать этапы: ${error instanceof Error ? error.message : "неизвестная ошибка"}`,
      );
    }
    },
  });

  // /rating_off <amo_id> | /rating_on <amo_id> — keep non-selling accounts
  // (teams, ROP and service logins) out of the rankings.
  defineAction({
    id: "rating_toggle", section: "company", roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Reyting: chiqarish/qaytarish", dangerous: true,
    variants: [{ label: "Reytingdan chiqarish", arg: "off" }, { label: "Reytingga qaytarish", arg: "on" }],
    decodeArg: splitPacked,
    collect: createPickManagerCollect("rating_toggle", { position: 1, title: "Menejerni tanlang" }),
    confirmLabel: ([direction, amoUserId]) => `${direction === "off" ? "reytingdan chiqarish" : "reytingga qaytarish"}, amoCRM ID ${amoUserId}`,
    command: {
      pattern: /^\/rating_(off|on)\s+(\d+)$/, usage: "/rating_off <amo_id>, /rating_on <amo_id>", description: "reytingdan chiqarish yoki qaytarish",
      menu: [
        { command: "rating_off", description: "reytingdan chiqarish (jamoa, HR, xizmat hisoblari)" },
        { command: "rating_on", description: "reytingga qaytarish" },
      ],
    },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requirePlanEditor(bot, msg))) return;

    const exclude = ctx.args[0] === "off";
    const amoUserId = Number(ctx.args[1]);
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
    },
  });

  // /rating_list — who counts as a seller and who is excluded.
  defineAction({
    id: "rating_list", section: "company", roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Reyting ro'yxati",
    command: { pattern: /^\/rating_list$/, usage: "/rating_list", description: "kim reytingda, kim chiqarilgan" },
    async run(ctx) {
      const msg = ctx.message!;
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
    },
  });

  // /call_status [N] — why calls over the last N days were or were not analyzed.
  defineAction({
    id: "call_status", section: "company", roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Qo'ng'iroqlar holati",
    collect: createChoiceCollect("call_status", { position: 0, title: "Necha kun uchun?", options: () => DAY_OPTIONS }),
    command: { pattern: /^\/call_status(?:\s+(\d{1,2}))?$/, usage: "/call_status [kun]", description: "qo'ng'iroqlar nega tahlil qilinmadi" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requirePlanEditor(bot, msg))) return;

    const days = Math.min(Math.max(Number(ctx.args[0] ?? 1), 1), 30);
    const to = new Date();
    to.setHours(24, 0, 0, 0);
    const from = new Date(to);
    from.setDate(from.getDate() - days);

    await bot.sendChatAction(msg.chat.id, "typing");
    const breakdown = await loadCallProcessingBreakdown({ from, to });
    const label = days === 1 ? "сегодня" : `последние ${days} дн.`;
    await bot.sendMessage(msg.chat.id, formatCallProcessingBreakdown(breakdown, label));
    },
  });

  // /set_plan <amo_user_id> <amount> [YYYY-MM]
  defineAction({
    id: "set_plan", section: "company", roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Reja belgilash",
    decodeArg: splitPacked, collect: createSetPlanCollect("set_plan"),
    command: { pattern: /^\/set_plan\s+(\d+)\s+([\d\s']+?)(?:\s+(\d{4}-\d{2}))?$/, usage: "/set_plan <amo_id> <summa> [YYYY-MM]", description: "oylik reja belgilash" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requirePlanEditor(bot, msg))) return;

    const amoUserId = Number(ctx.args[0]);
    const amountTarget = parsePlanAmount(ctx.args[1]);
    const month: PlanMonth | null = ctx.args[2] ? parsePlanMonth(ctx.args[2]) : almatyPlanMonth(new Date());

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
    },
  });

  defineAction({
    id: "set_plan_usage", section: "company", roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Reja belgilash (foydalanish)", commandOnly: true,
    command: { pattern: /^\/set_plan$/, usage: "/set_plan", description: "foydalanish bo'yicha eslatma" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requirePlanEditor(bot, msg))) return;
    await bot.sendMessage(
      msg.chat.id,
      "ℹ️ Foydalanish: /set_plan <amoCRM ID> <summa> [YYYY-MM]\nMasalan: /set_plan 12695650 50000000 2026-09\nOy ko'rsatilmasa — joriy oy.",
    );
    },
  });

  // /plans [YYYY-MM] — every active manager's target for the month.
  defineAction({
    id: "plans", section: "company", roles: ["admin", "rop"], denyText: PLAN_EDITOR_DENY_TEXT, label: "Rejalar",
    collect: createChoiceCollect("plans", { position: 0, title: "Qaysi oy?", options: () => planViewMonthOptions() }),
    command: { pattern: /^\/plans(?:\s+(\d{4}-\d{2}))?$/, usage: "/plans [YYYY-MM]", description: "barcha rejalar" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requirePlanEditor(bot, msg))) return;

    const month = ctx.args[0] ? parsePlanMonth(ctx.args[0]) : almatyPlanMonth(new Date());
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
    },
  });

  registerCommandActions(bot, [
    "inactivity_lead", "inactivity_off", "inactivity_on", "inactivity_limit", "inactivity_switch", "inactivity_status", "sync_stages", "rating_toggle", "rating_list", "call_status", "set_plan", "set_plan_usage", "plans",
  ]);
}
