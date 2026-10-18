import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import { isBotAdmin } from "../access";
import { defineAction } from "../actions/registry";
import { registerCommandActions } from "../actions/dispatch";
import { syncCommandMenuForManager, syncCommandMenuForTelegramUser } from "../commandMenu";
import { refreshMainMenuForManager, refreshMainMenuForTelegramUser } from "../keyboards/mainMenu";

type ManagerRole = "MANAGER" | "TEAMLEAD" | "ROP";

const pendingTeamDeleteConfirmations = new Map<number, number>();

export const ADMIN_ROLES_DENY_TEXT = "❌ Sizda bu buyruq uchun huquq yo'q.";

async function requireAdmin(bot: TelegramBot, msg: TelegramBot.Message): Promise<boolean> {
  const tgId = String(msg.from!.id);
  if (await isBotAdmin(tgId)) return true;
  await bot.sendMessage(msg.chat.id, ADMIN_ROLES_DENY_TEXT);
  return false;
}

export function registerAdminRoleHandlers(bot: TelegramBot) {
  defineAction({
    id: "set_role", section: "users", roles: ["admin"], denyText: ADMIN_ROLES_DENY_TEXT, label: "Rol berish", dangerous: true,
    command: { pattern: /\/set_role (\S+) (\S+)/, usage: "/set_role <tg_id> <manager|teamlead|rop>", description: "rol tayinlash" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requireAdmin(bot, msg))) return;

    const targetTgId = ctx.args[0];
    const roleStr = ctx.args[1].toLowerCase();

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
      if (await isBotAdmin(targetTgId)) {
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
    await syncCommandMenuForTelegramUser(bot, targetTgId);
    await refreshMainMenuForTelegramUser(bot, targetTgId);
    await bot.sendMessage(
      msg.chat.id,
      `✅ *${link.manager.name}* foydalanuvchisining roli *${role}* ga o'zgartirildi.`,
      { parse_mode: "Markdown" }
    );
    },
  });

  defineAction({
    id: "set_teamlead", section: "users", roles: ["admin"], denyText: ADMIN_ROLES_DENY_TEXT, label: "Tim-lid tayinlash",
    command: { pattern: /\/set_teamlead (\d+)/, usage: "/set_teamlead <amo_id>", description: "jamoa yaratish va TL tayinlash" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requireAdmin(bot, msg))) return;

    const amoUserId = parseInt(ctx.args[0]);
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
    await syncCommandMenuForManager(bot, manager.id);
    await refreshMainMenuForManager(bot, manager.id);

    await bot.sendMessage(
      msg.chat.id,
      `✅ *${manager.name}* TeamLead etib belgilandi.\nJamoa: *${team.name}* (ID: ${team.id})`,
      { parse_mode: "Markdown" }
    );
    },
  });

  defineAction({
    id: "add_to_team", section: "users", roles: ["admin"], denyText: ADMIN_ROLES_DENY_TEXT, label: "Jamoaga qo'shish",
    command: { pattern: /\/add_to_team (\d+) (\d+)/, usage: "/add_to_team <mgr_amo_id> <tl_amo_id>", description: "jamoaga qo'shish" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requireAdmin(bot, msg))) return;

    const mgrAmoId = parseInt(ctx.args[0]);
    const tlAmoId = parseInt(ctx.args[1]);

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
    },
  });

  defineAction({
    id: "remove_from_team", section: "users", roles: ["admin"], denyText: ADMIN_ROLES_DENY_TEXT, label: "Jamoadan olib tashlash",
    command: { pattern: /\/remove_from_team (\d+)/, usage: "/remove_from_team <amo_id>", description: "jamoadan chiqarish" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requireAdmin(bot, msg))) return;

    const amoUserId = parseInt(ctx.args[0]);
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
    },
  });

  defineAction({
    id: "delete_team", section: "users", roles: ["admin"], denyText: ADMIN_ROLES_DENY_TEXT, label: "Jamoani o'chirish", dangerous: true,
    command: { pattern: /\/delete_team (\d+)/, usage: "/delete_team <team_id>", description: "jamoani butunlay o'chirish" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requireAdmin(bot, msg))) return;

    const teamId = parseInt(ctx.args[0], 10);
    const team = await prisma.team.findUnique({ where: { id: teamId } });

    if (!team) {
      await bot.sendMessage(msg.chat.id, `❌ ID ${teamId} bo'lgan jamoa topilmadi.`);
      return;
    }

    const memberCount = await prisma.manager.count({ where: { teamId } });
    const tl = team.teamLeadId
      ? await prisma.manager.findUnique({ where: { id: team.teamLeadId } })
      : null;

    pendingTeamDeleteConfirmations.set(msg.from!.id, teamId);

    await bot.sendMessage(
      msg.chat.id,
      `⚠️ *Jamoani o'chirishni tasdiqlang*\n\n` +
        `Jamoa: *${team.name}*\n` +
        `ID: \`${teamId}\`\n` +
        `TeamLead: ${tl?.name ?? "tayinlanmagan"}\n` +
        `Menejerlar soni: ${memberCount}\n\n` +
        `Tasdiqlasangiz, jamoa o'chiriladi va barcha a'zolarning team bog'lanishi olib tashlanadi.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Tasdiqlash", callback_data: `admin_delete_team_confirm:${teamId}` }],
            [{ text: "Bekor qilish", callback_data: `admin_delete_team_cancel:${teamId}` }],
          ],
        },
      }
    );
    },
  });

  defineAction({
    id: "teams_list", section: "users", roles: ["admin"], denyText: ADMIN_ROLES_DENY_TEXT, label: "Jamoalar ro'yxati",
    command: { pattern: /\/teams_list$/, usage: "/teams_list", description: "barcha jamoalar ro'yxati" },
    async run(ctx) {
      const msg = ctx.message!;
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
    },
  });

  bot.on("callback_query", async (query) => {
    if (!query.data || !query.message) return;
    if (!query.data.startsWith("admin_delete_team_")) return;

    const tgId = String(query.from.id);
    if (!(await isBotAdmin(tgId))) {
      await bot.answerCallbackQuery(query.id, {
        text: "Sizda bu amal uchun huquq yo'q.",
      });
      return;
    }

    const [action, teamIdRaw] = query.data.replace("admin_delete_team_", "").split(":");
    const teamId = Number(teamIdRaw);
    const pendingTeamId = pendingTeamDeleteConfirmations.get(query.from.id);

    if (!pendingTeamId || pendingTeamId !== teamId) {
      await bot.answerCallbackQuery(query.id, {
        text: "Tasdiqlash oynasi eskirgan. Buyruqni qayta yuboring.",
      });
      return;
    }

    if (action === "cancel") {
      pendingTeamDeleteConfirmations.delete(query.from.id);
      await bot.answerCallbackQuery(query.id, { text: "O'chirish bekor qilindi." });
      await bot.editMessageText("❌ Jamoani o'chirish bekor qilindi.", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
      return;
    }

    if (action !== "confirm") return;

    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      pendingTeamDeleteConfirmations.delete(query.from.id);
      await bot.answerCallbackQuery(query.id, { text: "Jamoa topilmadi." });
      await bot.editMessageText("❌ Jamoa topilmadi yoki allaqachon o'chirilgan.", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
      return;
    }

    const members = await prisma.manager.findMany({
      where: { teamId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });

    await prisma.manager.updateMany({
      where: { teamId },
      data: { teamId: null },
    });

    await prisma.team.delete({ where: { id: teamId } });
    pendingTeamDeleteConfirmations.delete(query.from.id);

    const memberSummary = members.length
      ? `\n\nAjratilganlar: ${members.map((member) => member.name).join(", ")}`
      : "\n\nBu jamoada biriktirilgan menejer yo'q edi.";

    await bot.answerCallbackQuery(query.id, { text: "Jamoa o'chirildi." });
    await bot.editMessageText(
      `✅ *${team.name}* jamoasi o'chirildi (ID: ${teamId}).${memberSummary}`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: "Markdown",
      }
    );
  });

  registerCommandActions(bot, [
    "set_role", "set_teamlead", "add_to_team", "remove_from_team", "delete_team", "teams_list",
  ]);
}
