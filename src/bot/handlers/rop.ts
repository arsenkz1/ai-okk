import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import {
  getTeamRating,
  getAllManagerRating,
  getTeamMistakes,
  getAllMistakes,
  buildManagerCard,
  ManagerWithScore,
} from "../../services/teamStats";
import { roleFlowState } from "../state";

const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;

async function isAdmin(telegramUserId: string): Promise<boolean> {
  if (telegramUserId === ADMIN_TELEGRAM_ID) return true;
  const admin = await prisma.botAdmin.findUnique({ where: { telegramUserId } });
  return !!admin;
}

async function hasRopAccess(telegramUserId: string): Promise<boolean> {
  if (await isAdmin(telegramUserId)) return true;

  const link = await prisma.telegramLink.findFirst({
    where: { telegramUserId, status: "used" },
    include: { manager: true },
  });
  const mgr = link?.manager;
  return !!mgr && mgr.role === "ROP" && mgr.isActive;
}

async function requireRop(
  bot: TelegramBot,
  msg: TelegramBot.Message
): Promise<boolean> {
  if (!(await hasRopAccess(String(msg.from!.id)))) {
    await bot.sendMessage(msg.chat.id, "вќЊ РЈ РІР°СЃ РЅРµС‚ РїСЂР°РІ Р РћРџ.");
    return false;
  }
  return true;
}

function formatRating(items: ManagerWithScore[]): string {
  if (!items.length) return "РќРµС‚ РґР°РЅРЅС‹С….";
  return items
    .map(({ manager, avgScore }, i) => {
      const score = avgScore != null ? `${avgScore}/100` : "РЅРµС‚ РґР°РЅРЅС‹С…";
      return `${i + 1}. ${manager.name} вЂ” ${score}`;
    })
    .join("\n");
}

async function sendInChunks(bot: TelegramBot, chatId: number, text: string, parseMode?: string) {
  const MAX = 4096;
  const opts = parseMode ? { parse_mode: parseMode as TelegramBot.ParseMode } : {};
  if (text.length <= MAX) {
    await bot.sendMessage(chatId, text, opts);
    return;
  }
  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    if ((chunk + "\n" + line).length > MAX) {
      if (chunk) await bot.sendMessage(chatId, chunk, opts);
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }
  if (chunk) await bot.sendMessage(chatId, chunk, opts);
}

export function registerRopHandlers(bot: TelegramBot) {
  // /teams вЂ” СЃРїРёСЃРѕРє РІСЃРµС… РєРѕРјР°РЅРґ
  bot.onText(/\/teams$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "в„№пёЏ РљРѕРјР°РЅРґС‹ РЅРµ СЃРѕР·РґР°РЅС‹.");
      return;
    }

    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    const lines = ["рџЏў *Р’СЃРµ РєРѕРјР°РЅРґС‹:*", ""];
    for (const team of teams) {
      const count = await prisma.manager.count({ where: { teamId: team.id } });
      const tl = team.teamLeadId
        ? await prisma.manager.findUnique({ where: { id: team.teamLeadId } })
        : null;
      lines.push(`вЂў *${team.name}* вЂ” ${count} РјРµРЅРµРґР¶РµСЂРѕРІ (РўР›: ${tl?.name ?? "вЂ”"})`);
      keyboard.push([{ text: `рџ‘Ґ ${team.name}`, callback_data: `rop_team:${team.id}` }]);
    }

    await bot.sendMessage(msg.chat.id, lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // /all_rating вЂ” РѕР±С‰РёР№ СЂРµР№С‚РёРЅРі РІСЃРµС… РјРµРЅРµРґР¶РµСЂРѕРІ
  bot.onText(/\/all_rating$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    await bot.sendMessage(msg.chat.id, "вЏі Р—Р°РіСЂСѓР¶Р°СЋ СЂРµР№С‚РёРЅРі...");
    const rating = await getAllManagerRating(7);
    if (!rating.length) {
      await bot.sendMessage(msg.chat.id, "в„№пёЏ РќРµС‚ РґР°РЅРЅС‹С… Рѕ РјРµРЅРµРґР¶РµСЂР°С….");
      return;
    }

    const text = `рџ“Љ *РћР±С‰РёР№ СЂРµР№С‚РёРЅРі РјРµРЅРµРґР¶РµСЂРѕРІ (7 РґРЅРµР№):*\n\n${formatRating(rating)}`;
    await sendInChunks(bot, msg.chat.id, text, "Markdown");
  });

  // /all_mistakes вЂ” РѕС€РёР±РєРё РїРѕ РІСЃРµР№ РєРѕРјРїР°РЅРёРё
  bot.onText(/\/all_mistakes$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    const mistakes = await getAllMistakes(7, 10);
    if (!mistakes.length) {
      await bot.sendMessage(msg.chat.id, "в„№пёЏ РќРµС‚ РґР°РЅРЅС‹С… РѕР± РѕС€РёР±РєР°С… Р·Р° РїРѕСЃР»РµРґРЅРёРµ 7 РґРЅРµР№.");
      return;
    }

    const lines = mistakes.map((m, i) => `${i + 1}. ${m.mistake} вЂ” ${m.count} СЂР°Р·`);
    await sendInChunks(
      bot,
      msg.chat.id,
      `вљ пёЏ *Р§Р°СЃС‚С‹Рµ РѕС€РёР±РєРё РїРѕ РєРѕРјРїР°РЅРёРё (7 РґРЅРµР№):*\n\n${lines.join("\n")}`,
      "Markdown"
    );
  });

  // /rop_team_rating вЂ” СЂРµР№С‚РёРЅРі РїРѕ РєРѕРЅРєСЂРµС‚РЅРѕР№ РєРѕРјР°РЅРґРµ (РІС‹Р±РѕСЂ РёР· СЃРїРёСЃРєР°)
  bot.onText(/\/rop_team_rating$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "в„№пёЏ РќРµС‚ РєРѕРјР°РЅРґ.");
      return;
    }

    const keyboard = teams.map((t) => [{ text: t.name, callback_data: `rop_tr:${t.id}` }]);
    await bot.sendMessage(msg.chat.id, "Р’С‹Р±РµСЂРёС‚Рµ РєРѕРјР°РЅРґСѓ РґР»СЏ СЂРµР№С‚РёРЅРіР°:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // /rop_team_mistakes вЂ” РѕС€РёР±РєРё РєРѕРЅРєСЂРµС‚РЅРѕР№ РєРѕРјР°РЅРґС‹
  bot.onText(/\/rop_team_mistakes$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "в„№пёЏ РќРµС‚ РєРѕРјР°РЅРґ.");
      return;
    }

    const keyboard = teams.map((t) => [{ text: t.name, callback_data: `rop_tm:${t.id}` }]);
    await bot.sendMessage(msg.chat.id, "Р’С‹Р±РµСЂРёС‚Рµ РєРѕРјР°РЅРґСѓ РґР»СЏ Р°РЅР°Р»РёР·Р° РѕС€РёР±РѕРє:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // /rop_manager вЂ” РєР°СЂС‚РѕС‡РєР° РјРµРЅРµРґР¶РµСЂР° (2 С€Р°РіР°: РєРѕРјР°РЅРґР° в†’ РјРµРЅРµРґР¶РµСЂ)
  bot.onText(/\/rop_manager$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "в„№пёЏ РќРµС‚ РєРѕРјР°РЅРґ.");
      return;
    }

    const keyboard = teams.map((t) => [{ text: t.name, callback_data: `rop_t_card:${t.id}` }]);
    await bot.sendMessage(msg.chat.id, "Р’С‹Р±РµСЂРёС‚Рµ РєРѕРјР°РЅРґСѓ:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // /rop_ask вЂ” AI-РІРѕРїСЂРѕСЃ Рѕ РјРµРЅРµРґР¶РµСЂРµ (2 С€Р°РіР°: РєРѕРјР°РЅРґР° в†’ РјРµРЅРµРґР¶РµСЂ)
  bot.onText(/\/rop_ask$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "в„№пёЏ РќРµС‚ РєРѕРјР°РЅРґ.");
      return;
    }

    const keyboard = teams.map((t) => [{ text: t.name, callback_data: `rop_t_ask:${t.id}` }]);
    await bot.sendMessage(msg.chat.id, "Р’С‹Р±РµСЂРёС‚Рµ РєРѕРјР°РЅРґСѓ:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // Callback handlers
  bot.on("callback_query", async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    // rop_team:<teamId> вЂ” РїРѕРєР°Р·Р°С‚СЊ СѓС‡Р°СЃС‚РЅРёРєРѕРІ РєРѕРјР°РЅРґС‹
    if (data.startsWith("rop_team:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const rating = await getTeamRating(teamId, 7);
      const team = await prisma.team.findUnique({ where: { id: teamId } });
      if (!rating.length) {
        await bot.sendMessage(chatId, "в„№пёЏ Р’ РєРѕРјР°РЅРґРµ РЅРµС‚ РјРµРЅРµРґР¶РµСЂРѕРІ.");
        return;
      }
      const text = `рџ‘Ґ *${team?.name ?? "РљРѕРјР°РЅРґР°"} (7 РґРЅРµР№):*\n\n${formatRating(rating)}`;
      await sendInChunks(bot, chatId, text, "Markdown");
      return;
    }

    // rop_tr:<teamId> вЂ” СЂРµР№С‚РёРЅРі РєРѕРјР°РЅРґС‹
    if (data.startsWith("rop_tr:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const [rating, team] = await Promise.all([
        getTeamRating(teamId, 7),
        prisma.team.findUnique({ where: { id: teamId } }),
      ]);
      if (!rating.length) {
        await bot.sendMessage(chatId, "в„№пёЏ РќРµС‚ РґР°РЅРЅС‹С… РїРѕ СЌС‚РѕР№ РєРѕРјР°РЅРґРµ.");
        return;
      }
      const text = `рџ“Љ *Р РµР№С‚РёРЅРі: ${team?.name ?? "РєРѕРјР°РЅРґР°"} (7 РґРЅРµР№):*\n\n${formatRating(rating)}`;
      await sendInChunks(bot, chatId, text, "Markdown");
      return;
    }

    // rop_tm:<teamId> вЂ” РѕС€РёР±РєРё РєРѕРјР°РЅРґС‹
    if (data.startsWith("rop_tm:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const [mistakes, team] = await Promise.all([
        getTeamMistakes(teamId, 7, 10),
        prisma.team.findUnique({ where: { id: teamId } }),
      ]);
      if (!mistakes.length) {
        await bot.sendMessage(chatId, "в„№пёЏ РќРµС‚ РґР°РЅРЅС‹С… РѕР± РѕС€РёР±РєР°С….");        
        return;
      }
      const lines = mistakes.map((m, i) => `${i + 1}. ${m.mistake} вЂ” ${m.count} СЂР°Р·`);
      await sendInChunks(
        bot,
        chatId,
        `вљ пёЏ *РћС€РёР±РєРё РєРѕРјР°РЅРґС‹ ${team?.name ?? ""} (7 РґРЅРµР№):*\n\n${lines.join("\n")}`,
        "Markdown"
      );
      return;
    }

    // rop_t_card:<teamId> вЂ” РїРѕРєР°Р·Р°С‚СЊ РјРµРЅРµРґР¶РµСЂРѕРІ РґР»СЏ РєР°СЂС‚РѕС‡РєРё
    if (data.startsWith("rop_t_card:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const members = await prisma.manager.findMany({
        where: { teamId, isActive: true },
        orderBy: { name: "asc" },
      });
      if (!members.length) {
        await bot.sendMessage(chatId, "в„№пёЏ Р’ РєРѕРјР°РЅРґРµ РЅРµС‚ РјРµРЅРµРґР¶РµСЂРѕРІ.");
        return;
      }
      const keyboard = members.map((m) => [
        { text: m.name, callback_data: `rop_card:${m.id}` },
      ]);
      await bot.sendMessage(chatId, "Р’С‹Р±РµСЂРёС‚Рµ РјРµРЅРµРґР¶РµСЂР°:", {
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    // rop_card:<managerId> вЂ” РєР°СЂС‚РѕС‡РєР° РјРµРЅРµРґР¶РµСЂР°
    if (data.startsWith("rop_card:")) {
      const managerId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const card = await buildManagerCard(managerId);
      const score = card.avgScore != null ? `${card.avgScore}/100` : "РЅРµС‚ РґР°РЅРЅС‹С…";
      const strengths = card.strengths.length ? card.strengths.join(", ") : "РЅРµС‚ РґР°РЅРЅС‹С…";
      const weaknesses = card.weaknesses.length ? card.weaknesses.join(", ") : "РЅРµС‚ РґР°РЅРЅС‹С…";

      const text =
        `рџ‘¤ *${card.name}*\n` +
        `в­ђ Р‘Р°Р»Р»: ${score} (7 РґРЅРµР№)\n` +
        `рџЏ† РњРµСЃС‚Рѕ РІ РєРѕРјР°РЅРґРµ: ${card.rankInTeam} РёР· ${card.teamSize}\n\n` +
        `рџ’Є РЎРёР»СЊРЅС‹Рµ СЃС‚РѕСЂРѕРЅС‹: ${strengths}\n` +
        `вљ пёЏ Р—РѕРЅС‹ СЂРѕСЃС‚Р°: ${weaknesses}`;

      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
      return;
    }

    // rop_t_ask:<teamId> вЂ” РІС‹Р±СЂР°С‚СЊ РјРµРЅРµРґР¶РµСЂР° РґР»СЏ AI-РІРѕРїСЂРѕСЃР°
    if (data.startsWith("rop_t_ask:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const members = await prisma.manager.findMany({
        where: { teamId, isActive: true },
        orderBy: { name: "asc" },
      });
      if (!members.length) {
        await bot.sendMessage(chatId, "в„№пёЏ Р’ РєРѕРјР°РЅРґРµ РЅРµС‚ РјРµРЅРµРґР¶РµСЂРѕРІ.");
        return;
      }
      const keyboard = members.map((m) => [
        { text: m.name, callback_data: `rop_ask_mgr:${m.id}` },
      ]);
      await bot.sendMessage(chatId, "Р’С‹Р±РµСЂРёС‚Рµ РјРµРЅРµРґР¶РµСЂР°:", {
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    // rop_ask_mgr:<managerId> вЂ” РЅР°С‡Р°С‚СЊ AI-СЃРµСЃСЃРёСЋ Р РћРџР° Рѕ РјРµРЅРµРґР¶РµСЂРµ
    if (data.startsWith("rop_ask_mgr:")) {
      const managerId = parseInt(data.split(":")[1]);
      const mgr = await prisma.manager.findUnique({ where: { id: managerId } });
      if (!mgr) {
        await bot.answerCallbackQuery(query.id, { text: "РњРµРЅРµРґР¶РµСЂ РЅРµ РЅР°Р№РґРµРЅ." });
        return;
      }

      await bot.answerCallbackQuery(query.id);
      roleFlowState.set(userId, {
        step: "awaiting_sup_question",
        data: { targetManagerId: managerId, targetManagerName: mgr.name, supervisorRole: "ROP" },
      });

      await bot.sendMessage(
        chatId,
        `рџ¤– Р—Р°РґР°Р№С‚Рµ РІРѕРїСЂРѕСЃ РѕР± *${mgr.name}* (РјРёРЅРёРјСѓРј 10 СЃР»РѕРІ):\n\nРџСЂРёРјРµСЂ: В«Р§С‚Рѕ СЂРµРєРѕРјРµРЅРґСѓРµС‚Рµ СѓР»СѓС‡С€РёС‚СЊ РјРµРЅРµРґР¶РµСЂСѓ ${mgr.name} РІ РїРµСЂРІСѓСЋ РѕС‡РµСЂРµРґСЊ?В»\n\nР”Р»СЏ РІС‹С…РѕРґР°: /stop_ai`,
        { parse_mode: "Markdown" }
      );
      return;
    }
  });
}
