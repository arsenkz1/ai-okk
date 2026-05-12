import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";

type ManagerRole = "MANAGER" | "TEAMLEAD" | "ROP";

const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;

async function isAdmin(telegramUserId: string): Promise<boolean> {
  if (telegramUserId === ADMIN_TELEGRAM_ID) return true;
  const admin = await prisma.botAdmin.findUnique({ where: { telegramUserId } });
  return !!admin;
}

async function requireAdmin(bot: TelegramBot, msg: TelegramBot.Message): Promise<boolean> {
  const tgId = String(msg.from!.id);
  if (await isAdmin(tgId)) return true;
  await bot.sendMessage(msg.chat.id, "❌ У вас нет прав для этой команды.");
  return false;
}

export function registerAdminRoleHandlers(bot: TelegramBot) {
  // /set_role <telegram_id> <manager|teamlead|rop>
  bot.onText(/\/set_role (\S+) (\S+)/, async (msg, match) => {
    if (!(await requireAdmin(bot, msg))) return;

    const targetTgId = match![1];
    const roleStr = match![2].toLowerCase();

    const roleMap: Record<string, ManagerRole> = {
      manager: "MANAGER",
      teamlead: "TEAMLEAD",
      rop: "ROP",
    };

    const role = roleMap[roleStr];
    if (!role) {
      await bot.sendMessage(msg.chat.id, "❌ Неверная роль. Доступно: manager, teamlead, rop");
      return;
    }

    const link = await prisma.telegramLink.findFirst({
      where: { telegramUserId: targetTgId, status: "used" },
      include: { manager: true },
    });

    if (!link) {
      await bot.sendMessage(msg.chat.id, `❌ Пользователь с Telegram ID ${targetTgId} не найден в системе.`);
      return;
    }

    await prisma.manager.update({ where: { id: link.managerId }, data: { role } });
    await bot.sendMessage(
      msg.chat.id,
      `✅ Роль пользователя *${link.manager.name}* изменена на *${role}*.`,
      { parse_mode: "Markdown" }
    );
  });

  // /set_teamlead <amo_id> — назначить TeamLead и создать команду
  bot.onText(/\/set_teamlead (\d+)/, async (msg, match) => {
    if (!(await requireAdmin(bot, msg))) return;

    const amoUserId = parseInt(match![1]);
    const manager = await prisma.manager.findUnique({ where: { amoUserId } });

    if (!manager) {
      await bot.sendMessage(msg.chat.id, `❌ Менеджер с amoCRM ID ${amoUserId} не найден.`);
      return;
    }

    let team = await prisma.team.findFirst({ where: { teamLeadId: manager.id } });
    if (!team) {
      team = await prisma.team.create({
        data: { name: `${manager.name} команда`, teamLeadId: manager.id },
      });
    }

    await prisma.manager.update({
      where: { id: manager.id },
      data: { role: "TEAMLEAD", teamId: team.id },
    });

    await bot.sendMessage(
      msg.chat.id,
      `✅ *${manager.name}* назначен TeamLead.\nКоманда: *${team.name}* (ID: ${team.id})`,
      { parse_mode: "Markdown" }
    );
  });

  // /add_to_team <mgr_amo_id> <tl_amo_id>
  bot.onText(/\/add_to_team (\d+) (\d+)/, async (msg, match) => {
    if (!(await requireAdmin(bot, msg))) return;

    const mgrAmoId = parseInt(match![1]);
    const tlAmoId = parseInt(match![2]);

    const [mgr, tl] = await Promise.all([
      prisma.manager.findUnique({ where: { amoUserId: mgrAmoId } }),
      prisma.manager.findUnique({ where: { amoUserId: tlAmoId } }),
    ]);

    if (!mgr) return void await bot.sendMessage(msg.chat.id, `❌ Менеджер с amoCRM ID ${mgrAmoId} не найден.`);
    if (!tl) return void await bot.sendMessage(msg.chat.id, `❌ TeamLead с amoCRM ID ${tlAmoId} не найден.`);
    if (tl.role !== "TEAMLEAD") return void await bot.sendMessage(msg.chat.id, `❌ ${tl.name} не является TeamLead.`);
    if (mgr.teamId) return void await bot.sendMessage(msg.chat.id, `❌ ${mgr.name} уже состоит в команде. Сначала выполните /remove_from_team.`);

    const team = await prisma.team.findFirst({ where: { teamLeadId: tl.id } });
    if (!team) return void await bot.sendMessage(msg.chat.id, `❌ Команда для TeamLead ${tl.name} не найдена. Сначала выполните /set_teamlead.`);

    await prisma.manager.update({ where: { id: mgr.id }, data: { teamId: team.id } });
    await bot.sendMessage(
      msg.chat.id,
      `✅ *${mgr.name}* добавлен в команду *${team.name}*.`,
      { parse_mode: "Markdown" }
    );
  });

  // /remove_from_team <mgr_amo_id>
  bot.onText(/\/remove_from_team (\d+)/, async (msg, match) => {
    if (!(await requireAdmin(bot, msg))) return;

    const amoUserId = parseInt(match![1]);
    const manager = await prisma.manager.findUnique({ where: { amoUserId } });

    if (!manager) return void await bot.sendMessage(msg.chat.id, `❌ Менеджер с amoCRM ID ${amoUserId} не найден.`);
    if (!manager.teamId) return void await bot.sendMessage(msg.chat.id, `ℹ️ ${manager.name} не состоит ни в одной команде.`);

    await prisma.manager.update({ where: { id: manager.id }, data: { teamId: null } });
    await bot.sendMessage(msg.chat.id, `✅ *${manager.name}* удалён из команды.`, { parse_mode: "Markdown" });
  });

  // /teams_list — список всех команд
  bot.onText(/\/teams_list$/, async (msg) => {
    if (!(await requireAdmin(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Команды не созданы.");
      return;
    }

    const lines = ["📋 *Все команды:*", ""];
    for (const team of teams) {
      const memberCount = await prisma.manager.count({ where: { teamId: team.id } });
      const tl = team.teamLeadId
        ? await prisma.manager.findUnique({ where: { id: team.teamLeadId } })
        : null;
      lines.push(`• *${team.name}* (ID: ${team.id})`);
      lines.push(`  ТЛ: ${tl?.name ?? "не назначен"} | Менеджеров: ${memberCount}`);
    }

    await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
  });
}
