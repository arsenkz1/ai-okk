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
    await bot.sendMessage(msg.chat.id, "❌ У вас нет прав TeamLead.");
    return null;
  }
  if (!tl.isActive) {
    await bot.sendMessage(msg.chat.id, "❌ Ваш аккаунт деактивирован.");
    return null;
  }
  return tl;
}

function formatRating(items: ManagerWithScore[]): string {
  if (!items.length) return "Нет участников.";
  return items
    .map(({ manager, avgScore }, i) => {
      const score = avgScore != null ? `${avgScore}/100` : "нет данных";
      return `${i + 1}. ${manager.name} — ${score}`;
    })
    .join("\n");
}

async function sendInChunks(bot: TelegramBot, chatId: number, text: string) {
  const MAX = 4096;
  if (text.length <= MAX) {
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    return;
  }
  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    if ((chunk + "\n" + line).length > MAX) {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }
  if (chunk) await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
}

export function registerTeamLeadHandlers(bot: TelegramBot) {
  // /team — список участников команды
  bot.onText(/\/team$/, async (msg) => {
    const tl = await requireTeamLead(bot, msg);
    if (!tl) return;
    if (!tl.teamId) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Вы не привязаны к команде. Обратитесь к администратору.");
      return;
    }

    const rating = await getTeamRating(tl.teamId, 7);
    if (!rating.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ В вашей команде пока нет менеджеров.");
      return;
    }

    const text = `👥 *Ваша команда (7 дней):*\n\n${formatRating(rating)}`;
    await sendInChunks(bot, msg.chat.id, text);
  });

  // /team_rating — рейтинг команды
  bot.onText(/\/team_rating$/, async (msg) => {
    const tl = await requireTeamLead(bot, msg);
    if (!tl || !tl.teamId) {
      if (tl) await bot.sendMessage(msg.chat.id, "ℹ️ Вы не привязаны к команде.");
      return;
    }

    const rating = await getTeamRating(tl.teamId, 7);
    if (!rating.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ В команде нет менеджеров.");
      return;
    }

    const text = `📊 *Рейтинг команды (7 дней):*\n\n${formatRating(rating)}`;
    await sendInChunks(bot, msg.chat.id, text);
  });

  // /team_mistakes — частые ошибки команды
  bot.onText(/\/team_mistakes$/, async (msg) => {
    const tl = await requireTeamLead(bot, msg);
    if (!tl || !tl.teamId) {
      if (tl) await bot.sendMessage(msg.chat.id, "ℹ️ Вы не привязаны к команде.");
      return;
    }

    const mistakes = await getTeamMistakes(tl.teamId, 7, 10);
    if (!mistakes.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Нет данных об ошибках за последние 7 дней.");
      return;
    }

    const lines = mistakes.map((m, i) => `${i + 1}. ${m.mistake} — ${m.count} раз`);
    await sendInChunks(bot, msg.chat.id, `⚠️ *Частые ошибки команды (7 дней):*\n\n${lines.join("\n")}`);
  });

  // /team_add — добавить менеджера в команду (inline keyboard)
  bot.onText(/\/team_add$/, async (msg) => {
    const tl = await requireTeamLead(bot, msg);
    if (!tl || !tl.teamId) {
      if (tl) await bot.sendMessage(msg.chat.id, "ℹ️ Вы не привязаны к команде.");
      return;
    }

    const unassigned = await prisma.manager.findMany({
      where: { teamId: null, role: "MANAGER", isActive: true },
      orderBy: { name: "asc" },
    });

    if (!unassigned.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Нет свободных менеджеров для добавления.");
      return;
    }

    const keyboard = unassigned.map((m) => [
      { text: m.name, callback_data: `tl_add:${m.id}` },
    ]);

    await bot.sendMessage(msg.chat.id, "Выберите менеджера для добавления в команду:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // /team_manager — карточка менеджера
  bot.onText(/\/team_manager$/, async (msg) => {
    const tl = await requireTeamLead(bot, msg);
    if (!tl || !tl.teamId) {
      if (tl) await bot.sendMessage(msg.chat.id, "ℹ️ Вы не привязаны к команде.");
      return;
    }

    const members = await prisma.manager.findMany({
      where: { teamId: tl.teamId, isActive: true },
      orderBy: { name: "asc" },
    });

    if (!members.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ В команде нет менеджеров.");
      return;
    }

    const keyboard = members.map((m) => [
      { text: m.name, callback_data: `tl_card:${m.id}` },
    ]);
    await bot.sendMessage(msg.chat.id, "Выберите менеджера:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // /ask_manager — задать AI вопрос о менеджере
  bot.onText(/\/ask_manager$/, async (msg) => {
    const tl = await requireTeamLead(bot, msg);
    if (!tl || !tl.teamId) {
      if (tl) await bot.sendMessage(msg.chat.id, "ℹ️ Вы не привязаны к команде.");
      return;
    }

    const members = await prisma.manager.findMany({
      where: { teamId: tl.teamId, isActive: true },
      orderBy: { name: "asc" },
    });

    if (!members.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ В команде нет менеджеров.");
      return;
    }

    const keyboard = members.map((m) => [
      { text: m.name, callback_data: `tl_ask:${m.id}` },
    ]);
    await bot.sendMessage(msg.chat.id, "Выберите менеджера для AI-анализа:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // Callback handlers
  bot.on("callback_query", async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    // tl_add:<managerId> — добавить менеджера в команду
    if (data.startsWith("tl_add:")) {
      const managerId = parseInt(data.split(":")[1]);
      const tl = await getTeamLead(String(userId));
      if (!tl?.teamId) {
        await bot.answerCallbackQuery(query.id, { text: "Ошибка: нет прав TeamLead." });
        return;
      }

      const mgr = await prisma.manager.findUnique({ where: { id: managerId } });
      if (!mgr) {
        await bot.answerCallbackQuery(query.id, { text: "Менеджер не найден." });
        return;
      }
      if (mgr.teamId) {
        await bot.answerCallbackQuery(query.id, { text: "Менеджер уже в команде." });
        return;
      }

      await prisma.manager.update({ where: { id: managerId }, data: { teamId: tl.teamId } });
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, `✅ *${mgr.name}* добавлен в вашу команду.`, {
        parse_mode: "Markdown",
      });
      return;
    }

    // tl_card:<managerId> — карточка менеджера
    if (data.startsWith("tl_card:")) {
      const managerId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);

      const card = await buildManagerCard(managerId);
      const score = card.avgScore != null ? `${card.avgScore}/100` : "нет данных";
      const strengths = card.strengths.length ? card.strengths.join(", ") : "нет данных";
      const weaknesses = card.weaknesses.length ? card.weaknesses.join(", ") : "нет данных";

      const text =
        `👤 *${card.name}*\n` +
        `⭐ Балл: ${score} (7 дней)\n` +
        `🏆 Место в команде: ${card.rankInTeam} из ${card.teamSize}\n\n` +
        `💪 Сильные стороны: ${strengths}\n` +
        `⚠️ Зоны роста: ${weaknesses}`;

      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
      return;
    }

    // tl_ask:<managerId> — начать AI-сессию о менеджере
    if (data.startsWith("tl_ask:")) {
      const managerId = parseInt(data.split(":")[1]);
      const mgr = await prisma.manager.findUnique({ where: { id: managerId } });
      if (!mgr) {
        await bot.answerCallbackQuery(query.id, { text: "Менеджер не найден." });
        return;
      }

      await bot.answerCallbackQuery(query.id);
      roleFlowState.set(userId, {
        step: "awaiting_sup_question",
        data: { targetManagerId: managerId, targetManagerName: mgr.name, supervisorRole: "TEAMLEAD" },
      });

      await bot.sendMessage(
        chatId,
        `🤖 Задайте вопрос об *${mgr.name}* (минимум 10 слов):\n\nПример: «Какие главные ошибки у ${mgr.name} за последнюю неделю?»\n\nДля выхода: /stop_ai`,
        { parse_mode: "Markdown" }
      );
      return;
    }
  });
}

