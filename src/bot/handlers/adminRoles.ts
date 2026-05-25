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
  await bot.sendMessage(msg.chat.id, "❌ Sizda bu buyruq uchun huquq yo'q.");
  return false;
}

export function registerAdminRoleHandlers(bot: TelegramBot) {
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
      await bot.sendMessage(msg.chat.id, "❌ Noto'g'ri rol. Mavjud variantlar: manager, teamlead, rop");
      return;
    }

    const link = await prisma.telegramLink.findFirst({
      where: { telegramUserId: targetTgId, status: "used" },
      include: { manager: true },
    });

    if (!link) {
      if (await isAdmin(targetTgId)) {
        await bot.sendMessage(
          msg.chat.id,
          `ℹ️ Telegram ID ${targetTgId} allaqachon admin huquqiga ega. ROP buyruqlari uchun unga /set_role orqali alohida rol kerak emas.`
        );
        return;
      }

      await bot.sendMessage(msg.chat.id, `❌ Telegram ID ${targetTgId} bo'lgan foydalanuvchi tizimda topilmadi.`);
      return;
    }

    await prisma.manager.update({ where: { id: link.managerId }, data: { role } });
    await bot.sendMessage(
      msg.chat.id,
      `✅ *${link.manager.name}* foydalanuvchisining roli *${role}* ga o'zgartirildi.`,
      { parse_mode: "Markdown" }
    );
  });

  bot.onText(/\/set_teamlead (\d+)/, async (msg, match) => {
    if (!(await requireAdmin(bot, msg))) return;

    const amoUserId = parseInt(match![1]);
    const manager = await prisma.manager.findUnique({ where: { amoUserId } });

    if (!manager) {
      await bot.sendMessage(msg.chat.id, `❌ amoCRM ID ${amoUserId} bo'lgan menejer topilmadi.`);
      return;
    }

    let team = await prisma.team.findFirst({ where: { teamLeadId: manager.id } });
    if (!team) {
      team = await prisma.team.create({
        data: { name: `${manager.name} jamoasi`, teamLeadId: manager.id },
      });
    }

    await prisma.manager.update({
      where: { id: manager.id },
      data: { role: "TEAMLEAD", teamId: team.id },
    });

    await bot.sendMessage(
      msg.chat.id,
      `✅ *${manager.name}* TeamLead etib belgilandi.\nJamoa: *${team.name}* (ID: ${team.id})`,
      { parse_mode: "Markdown" }
    );
  });

  bot.onText(/\/add_to_team (\d+) (\d+)/, async (msg, match) => {
    if (!(await requireAdmin(bot, msg))) return;

    const mgrAmoId = parseInt(match![1]);
    const tlAmoId = parseInt(match![2]);

    const [mgr, tl] = await Promise.all([
      prisma.manager.findUnique({ where: { amoUserId: mgrAmoId } }),
      prisma.manager.findUnique({ where: { amoUserId: tlAmoId } }),
    ]);

    if (!mgr) {
      await bot.sendMessage(msg.chat.id, `❌ amoCRM ID ${mgrAmoId} bo'lgan menejer topilmadi.`);
      return;
    }
    if (!tl) {
      await bot.sendMessage(msg.chat.id, `❌ amoCRM ID ${tlAmoId} bo'lgan TeamLead topilmadi.`);
      return;
    }
    if (tl.role !== "TEAMLEAD") {
      await bot.sendMessage(msg.chat.id, `❌ ${tl.name} TeamLead emas.`);
      return;
    }
    if (mgr.teamId) {
      await bot.sendMessage(msg.chat.id, `❌ ${mgr.name} allaqachon jamoada. Avval /remove_from_team buyrug'ini ishlating.`);
      return;
    }

    const team = await prisma.team.findFirst({ where: { teamLeadId: tl.id } });
    if (!team) {
      await bot.sendMessage(msg.chat.id, `❌ ${tl.name} uchun jamoa topilmadi. Avval /set_teamlead buyrug'ini ishlating.`);
      return;
    }

    await prisma.manager.update({ where: { id: mgr.id }, data: { teamId: team.id } });
    await bot.sendMessage(
      msg.chat.id,
      `✅ *${mgr.name}* *${team.name}* jamoasiga qo'shildi.`,
      { parse_mode: "Markdown" }
    );
  });

  bot.onText(/\/remove_from_team (\d+)/, async (msg, match) => {
    if (!(await requireAdmin(bot, msg))) return;

    const amoUserId = parseInt(match![1]);
    const manager = await prisma.manager.findUnique({ where: { amoUserId } });

    if (!manager) {
      await bot.sendMessage(msg.chat.id, `❌ amoCRM ID ${amoUserId} bo'lgan menejer topilmadi.`);
      return;
    }
    if (!manager.teamId) {
      await bot.sendMessage(msg.chat.id, `ℹ️ ${manager.name} hech qaysi jamoada emas.`);
      return;
    }

    await prisma.manager.update({ where: { id: manager.id }, data: { teamId: null } });
    await bot.sendMessage(msg.chat.id, `✅ *${manager.name}* jamoadan chiqarildi.`, {
      parse_mode: "Markdown",
    });
  });

  bot.onText(/\/teams_list$/, async (msg) => {
    if (!(await requireAdmin(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoalar yaratilmagan.");
      return;
    }

    const lines = ["📋 *Barcha jamoalar:*", ""];
    for (const team of teams) {
      const memberCount = await prisma.manager.count({ where: { teamId: team.id } });
      const tl = team.teamLeadId
        ? await prisma.manager.findUnique({ where: { id: team.teamLeadId } })
        : null;
      lines.push(`• *${team.name}* (ID: ${team.id})`);
      lines.push(`  TL: ${tl?.name ?? "tayinlanmagan"} | Menejerlar: ${memberCount}`);
    }

    await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
  });
}
