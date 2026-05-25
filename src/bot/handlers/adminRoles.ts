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
  await bot.sendMessage(msg.chat.id, "вќЊ РЈ РІР°СЃ РЅРµС‚ РїСЂР°РІ РґР»СЏ СЌС‚РѕР№ РєРѕРјР°РЅРґС‹.");
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
      await bot.sendMessage(msg.chat.id, "вќЊ РќРµРІРµСЂРЅР°СЏ СЂРѕР»СЊ. Р”РѕСЃС‚СѓРїРЅРѕ: manager, teamlead, rop");
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
          `ℹ️ Telegram ID ${targetTgId} уже имеет админский доступ. Для ROP-команд ему не нужна отдельная роль через /set_role.`
        );
        return;
      }

      await bot.sendMessage(msg.chat.id, `вќЊ РџРѕР»СЊР·РѕРІР°С‚РµР»СЊ СЃ Telegram ID ${targetTgId} РЅРµ РЅР°Р№РґРµРЅ РІ СЃРёСЃС‚РµРјРµ.`);
      return;
    }

    await prisma.manager.update({ where: { id: link.managerId }, data: { role } });
    await bot.sendMessage(
      msg.chat.id,
      `вњ… Р РѕР»СЊ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ *${link.manager.name}* РёР·РјРµРЅРµРЅР° РЅР° *${role}*.`,
      { parse_mode: "Markdown" }
    );
  });

  // /set_teamlead <amo_id> вЂ” РЅР°Р·РЅР°С‡РёС‚СЊ TeamLead Рё СЃРѕР·РґР°С‚СЊ РєРѕРјР°РЅРґСѓ
  bot.onText(/\/set_teamlead (\d+)/, async (msg, match) => {
    if (!(await requireAdmin(bot, msg))) return;

    const amoUserId = parseInt(match![1]);
    const manager = await prisma.manager.findUnique({ where: { amoUserId } });

    if (!manager) {
      await bot.sendMessage(msg.chat.id, `вќЊ РњРµРЅРµРґР¶РµСЂ СЃ amoCRM ID ${amoUserId} РЅРµ РЅР°Р№РґРµРЅ.`);
      return;
    }

    let team = await prisma.team.findFirst({ where: { teamLeadId: manager.id } });
    if (!team) {
      team = await prisma.team.create({
        data: { name: `${manager.name} РєРѕРјР°РЅРґР°`, teamLeadId: manager.id },
      });
    }

    await prisma.manager.update({
      where: { id: manager.id },
      data: { role: "TEAMLEAD", teamId: team.id },
    });

    await bot.sendMessage(
      msg.chat.id,
      `вњ… *${manager.name}* РЅР°Р·РЅР°С‡РµРЅ TeamLead.\nРљРѕРјР°РЅРґР°: *${team.name}* (ID: ${team.id})`,
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

    if (!mgr) return void await bot.sendMessage(msg.chat.id, `вќЊ РњРµРЅРµРґР¶РµСЂ СЃ amoCRM ID ${mgrAmoId} РЅРµ РЅР°Р№РґРµРЅ.`);
    if (!tl) return void await bot.sendMessage(msg.chat.id, `вќЊ TeamLead СЃ amoCRM ID ${tlAmoId} РЅРµ РЅР°Р№РґРµРЅ.`);
    if (tl.role !== "TEAMLEAD") return void await bot.sendMessage(msg.chat.id, `вќЊ ${tl.name} РЅРµ СЏРІР»СЏРµС‚СЃСЏ TeamLead.`);
    if (mgr.teamId) return void await bot.sendMessage(msg.chat.id, `вќЊ ${mgr.name} СѓР¶Рµ СЃРѕСЃС‚РѕРёС‚ РІ РєРѕРјР°РЅРґРµ. РЎРЅР°С‡Р°Р»Р° РІС‹РїРѕР»РЅРёС‚Рµ /remove_from_team.`);

    const team = await prisma.team.findFirst({ where: { teamLeadId: tl.id } });
    if (!team) return void await bot.sendMessage(msg.chat.id, `вќЊ РљРѕРјР°РЅРґР° РґР»СЏ TeamLead ${tl.name} РЅРµ РЅР°Р№РґРµРЅР°. РЎРЅР°С‡Р°Р»Р° РІС‹РїРѕР»РЅРёС‚Рµ /set_teamlead.`);

    await prisma.manager.update({ where: { id: mgr.id }, data: { teamId: team.id } });
    await bot.sendMessage(
      msg.chat.id,
      `вњ… *${mgr.name}* РґРѕР±Р°РІР»РµРЅ РІ РєРѕРјР°РЅРґСѓ *${team.name}*.`,
      { parse_mode: "Markdown" }
    );
  });

  // /remove_from_team <mgr_amo_id>
  bot.onText(/\/remove_from_team (\d+)/, async (msg, match) => {
    if (!(await requireAdmin(bot, msg))) return;

    const amoUserId = parseInt(match![1]);
    const manager = await prisma.manager.findUnique({ where: { amoUserId } });

    if (!manager) return void await bot.sendMessage(msg.chat.id, `вќЊ РњРµРЅРµРґР¶РµСЂ СЃ amoCRM ID ${amoUserId} РЅРµ РЅР°Р№РґРµРЅ.`);
    if (!manager.teamId) return void await bot.sendMessage(msg.chat.id, `в„№пёЏ ${manager.name} РЅРµ СЃРѕСЃС‚РѕРёС‚ РЅРё РІ РѕРґРЅРѕР№ РєРѕРјР°РЅРґРµ.`);

    await prisma.manager.update({ where: { id: manager.id }, data: { teamId: null } });
    await bot.sendMessage(msg.chat.id, `вњ… *${manager.name}* СѓРґР°Р»С‘РЅ РёР· РєРѕРјР°РЅРґС‹.`, { parse_mode: "Markdown" });
  });

  // /teams_list вЂ” СЃРїРёСЃРѕРє РІСЃРµС… РєРѕРјР°РЅРґ
  bot.onText(/\/teams_list$/, async (msg) => {
    if (!(await requireAdmin(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "в„№пёЏ РљРѕРјР°РЅРґС‹ РЅРµ СЃРѕР·РґР°РЅС‹.");
      return;
    }

    const lines = ["рџ“‹ *Р’СЃРµ РєРѕРјР°РЅРґС‹:*", ""];
    for (const team of teams) {
      const memberCount = await prisma.manager.count({ where: { teamId: team.id } });
      const tl = team.teamLeadId
        ? await prisma.manager.findUnique({ where: { id: team.teamLeadId } })
        : null;
      lines.push(`вЂў *${team.name}* (ID: ${team.id})`);
      lines.push(`  РўР›: ${tl?.name ?? "РЅРµ РЅР°Р·РЅР°С‡РµРЅ"} | РњРµРЅРµРґР¶РµСЂРѕРІ: ${memberCount}`);
    }

    await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
  });
}
