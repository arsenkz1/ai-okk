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
import { hasRole, resolveAccess } from "../access";
import { defineAction } from "../actions/registry";
import { registerCommandActions } from "../actions/dispatch";

/** ROP commands: administrators, and active managers with the ROP role. */
async function hasRopAccess(telegramUserId: string): Promise<boolean> {
  return hasRole(await resolveAccess(telegramUserId), "admin", "rop");
}

export const ROP_DENY_TEXT = "❌ Sizda ROP huquqi yo'q.";

async function requireRop(bot: TelegramBot, msg: TelegramBot.Message): Promise<boolean> {
  if (!(await hasRopAccess(String(msg.from!.id)))) {
    await bot.sendMessage(msg.chat.id, ROP_DENY_TEXT);
    return false;
  }
  return true;
}

function formatRating(items: ManagerWithScore[]): string {
  if (!items.length) return "Ma'lumot yo'q.";
  return items
    .map(({ manager, avgScore }, i) => {
      const score = avgScore != null ? `${avgScore}/100` : "ma'lumot yo'q";
      return `${i + 1}. ${manager.name} — ${score}`;
    })
    .join("\n");
}

async function sendInChunks(
  bot: TelegramBot,
  chatId: number,
  text: string,
  parseMode?: string
) {
  const maxLength = 4096;
  const options = parseMode ? { parse_mode: parseMode as TelegramBot.ParseMode } : {};

  if (text.length <= maxLength) {
    await bot.sendMessage(chatId, text, options);
    return;
  }

  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    if ((chunk + "\n" + line).length > maxLength) {
      if (chunk) await bot.sendMessage(chatId, chunk, options);
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }

  if (chunk) await bot.sendMessage(chatId, chunk, options);
}

export function registerRopHandlers(bot: TelegramBot) {
  defineAction({
    id: "teams", section: "company", order: 10, roles: ["admin", "rop"], denyText: ROP_DENY_TEXT, label: "Jamoalar",
    command: { pattern: /\/teams$/, usage: "/teams", description: "barcha jamoalar" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoalar yaratilmagan.");
      return;
    }

    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    const lines = ["🏢 *Barcha jamoalar:*", ""];

    for (const team of teams) {
      const count = await prisma.manager.count({ where: { teamId: team.id } });
      const tl = team.teamLeadId
        ? await prisma.manager.findUnique({ where: { id: team.teamLeadId } })
        : null;
      lines.push(`• *${team.name}* — ${count} menejer (TL: ${tl?.name ?? "—"})`);
      keyboard.push([{ text: `👥 ${team.name}`, callback_data: `rop_team:${team.id}` }]);
    }

    await bot.sendMessage(msg.chat.id, lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
    },
  });

  defineAction({
    id: "all_rating", section: "company", order: 10, roles: ["admin", "rop"], denyText: ROP_DENY_TEXT, label: "Umumiy reyting",
    command: { pattern: /\/all_rating$/, usage: "/all_rating", description: "menejerlarning umumiy reytingi (7 kun)" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requireRop(bot, msg))) return;

    await bot.sendMessage(msg.chat.id, "⏳ Reyting yuklanmoqda...");
    const rating = await getAllManagerRating(7);
    if (!rating.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Menejerlar bo'yicha ma'lumot topilmadi.");
      return;
    }

    const text = `📊 *Menejerlarning umumiy reytingi (7 kun):*\n\n${formatRating(rating)}`;
    await sendInChunks(bot, msg.chat.id, text, "Markdown");
    },
  });

  defineAction({
    id: "all_mistakes", section: "company", order: 10, roles: ["admin", "rop"], denyText: ROP_DENY_TEXT, label: "Kompaniya xatolari",
    command: { pattern: /\/all_mistakes$/, usage: "/all_mistakes", description: "kompaniya bo'yicha xatolar" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requireRop(bot, msg))) return;

    const mistakes = await getAllMistakes(7, 10);
    if (!mistakes.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Oxirgi 7 kun bo'yicha xatolar topilmadi.");
      return;
    }

    const lines = mistakes.map((m, i) => `${i + 1}. ${m.mistake} — ${m.count} marta`);
    await sendInChunks(
      bot,
      msg.chat.id,
      `⚠️ *Kompaniya bo'yicha ko'p uchraydigan xatolar (7 kun):*\n\n${lines.join("\n")}`,
      "Markdown"
    );
    },
  });

  defineAction({
    id: "rop_team_rating", section: "company", order: 10, roles: ["admin", "rop"], denyText: ROP_DENY_TEXT, label: "Jamoa bo'yicha reyting",
    command: { pattern: /\/rop_team_rating$/, usage: "/rop_team_rating", description: "aniq jamoa reytingi" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoalar topilmadi.");
      return;
    }

    const keyboard = teams.map((t) => [{ text: t.name, callback_data: `rop_tr:${t.id}` }]);
    await bot.sendMessage(msg.chat.id, "Reyting uchun jamoani tanlang:", {
      reply_markup: { inline_keyboard: keyboard },
    });
    },
  });

  defineAction({
    id: "rop_team_mistakes", section: "company", order: 10, roles: ["admin", "rop"], denyText: ROP_DENY_TEXT, label: "Jamoa bo'yicha xatolar",
    command: { pattern: /\/rop_team_mistakes$/, usage: "/rop_team_mistakes", description: "aniq jamoa xatolari" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoalar topilmadi.");
      return;
    }

    const keyboard = teams.map((t) => [{ text: t.name, callback_data: `rop_tm:${t.id}` }]);
    await bot.sendMessage(msg.chat.id, "Xatolar tahlili uchun jamoani tanlang:", {
      reply_markup: { inline_keyboard: keyboard },
    });
    },
  });

  defineAction({
    id: "rop_manager", section: "company", order: 10, roles: ["admin", "rop"], denyText: ROP_DENY_TEXT, label: "Menejer kartasi",
    command: { pattern: /\/rop_manager$/, usage: "/rop_manager", description: "menejer kartasi" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoalar topilmadi.");
      return;
    }

    const keyboard = teams.map((t) => [{ text: t.name, callback_data: `rop_t_card:${t.id}` }]);
    await bot.sendMessage(msg.chat.id, "Jamoani tanlang:", {
      reply_markup: { inline_keyboard: keyboard },
    });
    },
  });

  defineAction({
    id: "rop_ask", section: "company", order: 10, roles: ["admin", "rop"], denyText: ROP_DENY_TEXT, label: "Menejer haqida AI-savol",
    command: { pattern: /\/rop_ask$/, usage: "/rop_ask", description: "menejer haqida AI-savol" },
    async run(ctx) {
      const msg = ctx.message!;
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoalar topilmadi.");
      return;
    }

    const keyboard = teams.map((t) => [{ text: t.name, callback_data: `rop_t_ask:${t.id}` }]);
    await bot.sendMessage(msg.chat.id, "Jamoani tanlang:", {
      reply_markup: { inline_keyboard: keyboard },
    });
    },
  });

  bot.on("callback_query", async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (data.startsWith("rop_team:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const rating = await getTeamRating(teamId, 7);
      const team = await prisma.team.findUnique({ where: { id: teamId } });
      if (!rating.length) {
        await bot.sendMessage(chatId, "ℹ️ Jamoada menejerlar yo'q.");
        return;
      }
      const text = `👥 *${team?.name ?? "Jamoa"} (7 kun):*\n\n${formatRating(rating)}`;
      await sendInChunks(bot, chatId, text, "Markdown");
      return;
    }

    if (data.startsWith("rop_tr:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const [rating, team] = await Promise.all([
        getTeamRating(teamId, 7),
        prisma.team.findUnique({ where: { id: teamId } }),
      ]);
      if (!rating.length) {
        await bot.sendMessage(chatId, "ℹ️ Bu jamoa bo'yicha ma'lumot topilmadi.");
        return;
      }
      const text = `📊 *Reyting: ${team?.name ?? "jamoa"} (7 kun):*\n\n${formatRating(rating)}`;
      await sendInChunks(bot, chatId, text, "Markdown");
      return;
    }

    if (data.startsWith("rop_tm:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const [mistakes, team] = await Promise.all([
        getTeamMistakes(teamId, 7, 10),
        prisma.team.findUnique({ where: { id: teamId } }),
      ]);
      if (!mistakes.length) {
        await bot.sendMessage(chatId, "ℹ️ Xatolar bo'yicha ma'lumot topilmadi.");
        return;
      }
      const lines = mistakes.map((m, i) => `${i + 1}. ${m.mistake} — ${m.count} marta`);
      await sendInChunks(
        bot,
        chatId,
        `⚠️ *${team?.name ?? ""} jamoasi xatolari (7 kun):*\n\n${lines.join("\n")}`,
        "Markdown"
      );
      return;
    }

    if (data.startsWith("rop_t_card:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const members = await prisma.manager.findMany({
        where: { teamId, isActive: true },
        orderBy: { name: "asc" },
      });
      if (!members.length) {
        await bot.sendMessage(chatId, "ℹ️ Jamoada menejerlar yo'q.");
        return;
      }
      const keyboard = members.map((m) => [{ text: m.name, callback_data: `rop_card:${m.id}` }]);
      await bot.sendMessage(chatId, "Menejerni tanlang:", {
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    if (data.startsWith("rop_card:")) {
      const managerId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const card = await buildManagerCard(managerId);
      const score = card.avgScore != null ? `${card.avgScore}/100` : "ma'lumot yo'q";
      const strengths = card.strengths.length ? card.strengths.join(", ") : "ma'lumot yo'q";
      const weaknesses = card.weaknesses.length ? card.weaknesses.join(", ") : "ma'lumot yo'q";

      const text =
        `👤 *${card.name}*\n` +
        `⭐ Ball: ${score} (7 kun)\n` +
        `🏆 Jamoadagi o'rni: ${card.rankInTeam} / ${card.teamSize}\n\n` +
        `💪 Kuchli tomonlari: ${strengths}\n` +
        `⚠️ O'sish nuqtalari: ${weaknesses}`;

      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
      return;
    }

    if (data.startsWith("rop_t_ask:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const members = await prisma.manager.findMany({
        where: { teamId, isActive: true },
        orderBy: { name: "asc" },
      });
      if (!members.length) {
        await bot.sendMessage(chatId, "ℹ️ Jamoada menejerlar yo'q.");
        return;
      }
      const keyboard = members.map((m) => [{ text: m.name, callback_data: `rop_ask_mgr:${m.id}` }]);
      await bot.sendMessage(chatId, "Menejerni tanlang:", {
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    if (data.startsWith("rop_ask_mgr:")) {
      const managerId = parseInt(data.split(":")[1]);
      const mgr = await prisma.manager.findUnique({ where: { id: managerId } });
      if (!mgr) {
        await bot.answerCallbackQuery(query.id, { text: "Menejer topilmadi." });
        return;
      }

      await bot.answerCallbackQuery(query.id);
      roleFlowState.set(userId, {
        step: "awaiting_sup_question",
        data: { targetManagerId: managerId, targetManagerName: mgr.name, supervisorRole: "ROP" },
      });

      await bot.sendMessage(
        chatId,
        `🤖 *${mgr.name}* haqida savol yozing (kamida 10 ta so'z):\n\nMasalan: "${mgr.name} uchun birinchi navbatda nimani yaxshilash kerak?"\n\nChiqish uchun: /stop_ai`,
        { parse_mode: "Markdown" }
      );
    }
  });

  registerCommandActions(bot, [
    "teams", "all_rating", "all_mistakes", "rop_team_rating", "rop_team_mistakes", "rop_manager", "rop_ask",
  ]);
}
