import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import {
  getTeamRating,
  getTeamMistakes,
  buildManagerCard,
} from "../../services/teamStats";
import { roleFlowState } from "../state";
import { ManagerWithScore } from "../../services/teamStats";

type Manager = Awaited<ReturnType<typeof prisma.manager.findUniqueOrThrow>>;
type Team = Awaited<ReturnType<typeof prisma.team.findUniqueOrThrow>>;
type TeamLeadManager = Manager & { team: Team | null };

async function getTeamLead(telegramUserId: string): Promise<TeamLeadManager | null> {
  const link = await prisma.telegramLink.findFirst({
    where: { telegramUserId, status: "used" },
    include: { manager: { include: { team: true } } },
  });
  const mgr = link?.manager as TeamLeadManager | undefined;
  if (!mgr || mgr.role !== "TEAMLEAD") return null;
  return mgr;
}

async function requireTeamLead(
  bot: TelegramBot,
  msg: TelegramBot.Message
): Promise<TeamLeadManager | null> {
  const tl = await getTeamLead(String(msg.from!.id));
  if (!tl) {
    await bot.sendMessage(msg.chat.id, "❌ Sizda TeamLead huquqi yo'q.");
    return null;
  }
  if (!tl.isActive) {
    await bot.sendMessage(msg.chat.id, "❌ Hisobingiz deaktiv qilingan.");
    return null;
  }
  return tl;
}

function formatRating(items: ManagerWithScore[]): string {
  if (!items.length) return "Ishtirokchilar topilmadi.";
  return items
    .map(({ manager, avgScore }, i) => {
      const score = avgScore != null ? `${avgScore}/100` : "ma'lumot yo'q";
      return `${i + 1}. ${manager.name} — ${score}`;
    })
    .join("\n");
}

async function sendInChunks(bot: TelegramBot, chatId: number, text: string) {
  const maxLength = 4096;
  if (text.length <= maxLength) {
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    return;
  }
  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    if ((chunk + "\n" + line).length > maxLength) {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk) await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
}

export function registerTeamLeadHandlers(bot: TelegramBot) {
  bot.onText(/\/team$/, async (msg) => {
    const tl = await requireTeamLead(bot, msg);
    if (!tl) return;
    if (!tl.teamId) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Siz jamoaga biriktirilmagansiz. Administratorga murojaat qiling.");
      return;
    }

    const rating = await getTeamRating(tl.teamId, 7);
    if (!rating.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoangizda hozircha menejerlar yo'q.");
      return;
    }

    const text = `👥 *Sizning jamoangiz (7 kun):*\n\n${formatRating(rating)}`;
    await sendInChunks(bot, msg.chat.id, text);
  });

  bot.onText(/\/team_rating$/, async (msg) => {
    const tl = await requireTeamLead(bot, msg);
    if (!tl || !tl.teamId) {
      if (tl) await bot.sendMessage(msg.chat.id, "ℹ️ Siz jamoaga biriktirilmagansiz.");
      return;
    }

    const rating = await getTeamRating(tl.teamId, 7);
    if (!rating.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoada menejerlar yo'q.");
      return;
    }

    const text = `📊 *Jamoa reytingi (7 kun):*\n\n${formatRating(rating)}`;
    await sendInChunks(bot, msg.chat.id, text);
  });

  bot.onText(/\/team_mistakes$/, async (msg) => {
    const tl = await requireTeamLead(bot, msg);
    if (!tl || !tl.teamId) {
      if (tl) await bot.sendMessage(msg.chat.id, "ℹ️ Siz jamoaga biriktirilmagansiz.");
      return;
    }

    const mistakes = await getTeamMistakes(tl.teamId, 7, 10);
    if (!mistakes.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Oxirgi 7 kun bo'yicha xatolar topilmadi.");
      return;
    }

    const lines = mistakes.map((m, i) => `${i + 1}. ${m.mistake} — ${m.count} marta`);
    await sendInChunks(bot, msg.chat.id, `⚠️ *Jamoaning ko'p uchraydigan xatolari (7 kun):*\n\n${lines.join("\n")}`);
  });

  bot.onText(/\/team_add$/, async (msg) => {
    const tl = await requireTeamLead(bot, msg);
    if (!tl || !tl.teamId) {
      if (tl) await bot.sendMessage(msg.chat.id, "ℹ️ Siz jamoaga biriktirilmagansiz.");
      return;
    }

    const unassigned = await prisma.manager.findMany({
      where: { teamId: null, role: "MANAGER", isActive: true },
      orderBy: { name: "asc" },
    });

    if (!unassigned.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Qo'shish uchun bo'sh menejerlar yo'q.");
      return;
    }

    const keyboard = unassigned.map((m) => [{ text: m.name, callback_data: `tl_add:${m.id}` }]);

    await bot.sendMessage(msg.chat.id, "Jamoaga qo'shish uchun menejerni tanlang:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  bot.onText(/\/team_manager$/, async (msg) => {
    const tl = await requireTeamLead(bot, msg);
    if (!tl || !tl.teamId) {
      if (tl) await bot.sendMessage(msg.chat.id, "ℹ️ Siz jamoaga biriktirilmagansiz.");
      return;
    }

    const members = await prisma.manager.findMany({
      where: { teamId: tl.teamId, isActive: true },
      orderBy: { name: "asc" },
    });

    if (!members.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoada menejerlar yo'q.");
      return;
    }

    const keyboard = members.map((m) => [{ text: m.name, callback_data: `tl_card:${m.id}` }]);
    await bot.sendMessage(msg.chat.id, "Menejerni tanlang:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  bot.onText(/\/ask_manager$/, async (msg) => {
    const tl = await requireTeamLead(bot, msg);
    if (!tl || !tl.teamId) {
      if (tl) await bot.sendMessage(msg.chat.id, "ℹ️ Siz jamoaga biriktirilmagansiz.");
      return;
    }

    const members = await prisma.manager.findMany({
      where: { teamId: tl.teamId, isActive: true },
      orderBy: { name: "asc" },
    });

    if (!members.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoada menejerlar yo'q.");
      return;
    }

    const keyboard = members.map((m) => [{ text: m.name, callback_data: `tl_ask:${m.id}` }]);
    await bot.sendMessage(msg.chat.id, "AI tahlil uchun menejerni tanlang:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  bot.on("callback_query", async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (data.startsWith("tl_add:")) {
      const managerId = parseInt(data.split(":")[1]);
      const tl = await getTeamLead(String(userId));
      if (!tl?.teamId) {
        await bot.answerCallbackQuery(query.id, { text: "Xato: TeamLead huquqi yo'q." });
        return;
      }

      const mgr = await prisma.manager.findUnique({ where: { id: managerId } });
      if (!mgr) {
        await bot.answerCallbackQuery(query.id, { text: "Menejer topilmadi." });
        return;
      }
      if (mgr.teamId) {
        await bot.answerCallbackQuery(query.id, { text: "Menejer allaqachon jamoada." });
        return;
      }

      await prisma.manager.update({ where: { id: managerId }, data: { teamId: tl.teamId } });
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, `✅ *${mgr.name}* sizning jamoangizga qo'shildi.`, {
        parse_mode: "Markdown",
      });
      return;
    }

    if (data.startsWith("tl_card:")) {
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

    if (data.startsWith("tl_ask:")) {
      const managerId = parseInt(data.split(":")[1]);
      const mgr = await prisma.manager.findUnique({ where: { id: managerId } });
      if (!mgr) {
        await bot.answerCallbackQuery(query.id, { text: "Menejer topilmadi." });
        return;
      }

      await bot.answerCallbackQuery(query.id);
      roleFlowState.set(userId, {
        step: "awaiting_sup_question",
        data: { targetManagerId: managerId, targetManagerName: mgr.name, supervisorRole: "TEAMLEAD" },
      });

      await bot.sendMessage(
        chatId,
        `🤖 *${mgr.name}* haqida savol yozing (kamida 10 ta so'z):\n\nMasalan: "${mgr.name} ning oxirgi haftadagi asosiy xatolari qaysilar?"\n\nChiqish uchun: /stop_ai`,
        { parse_mode: "Markdown" }
      );
      return;
    }
  });
}
