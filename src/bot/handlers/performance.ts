import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import { loadManagerPerformance } from "../../services/performanceData";
import {
  aggregateTeamPerformance,
  formatManagerPerformance,
  formatTeamPerformance,
} from "../../services/performanceReport";
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
    select: { members: { where: { isActive: true }, select: { id: true } } },
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

  await bot.sendMessage(
    msg.chat.id,
    formatTeamPerformance(aggregateTeamPerformance(title, label, [...performance.values()])),
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
      const all = await prisma.manager.findMany({ where: { isActive: true }, select: { id: true } });
      await sendPerformance(bot, msg, all.map((item) => item.id), "Kompaniya");
      return;
    }

    if (manager?.role !== "TEAMLEAD") {
      await bot.sendMessage(msg.chat.id, "❌ Bu buyruq TeamLead va ROP uchun.");
      return;
    }

    await sendPerformance(bot, msg, await teamManagerIdsOf(manager.id, manager.teamId), "Jamoa");
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
