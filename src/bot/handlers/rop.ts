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

type Manager = Awaited<ReturnType<typeof prisma.manager.findUniqueOrThrow>>;

async function getRop(telegramUserId: string): Promise<Manager | null> {
  const link = await prisma.telegramLink.findFirst({
    where: { telegramUserId, status: "used" },
    include: { manager: true },
  });
  const mgr = link?.manager;
  if (!mgr || mgr.role !== "ROP") return null;
  return mgr;
}

async function requireRop(
  bot: TelegramBot,
  msg: TelegramBot.Message
): Promise<Manager | null> {
  const rop = await getRop(String(msg.from!.id));
  if (!rop) {
    await bot.sendMessage(msg.chat.id, "❌ У вас нет прав РОП.");
    return null;
  }
  if (!rop.isActive) {
    await bot.sendMessage(msg.chat.id, "❌ Ваш аккаунт деактивирован.");
    return null;
  }
  return rop;
}

function formatRating(items: ManagerWithScore[]): string {
  if (!items.length) return "Нет данных.";
  return items
    .map(({ manager, avgScore }, i) => {
      const score = avgScore != null ? `${avgScore}/100` : "нет данных";
      return `${i + 1}. ${manager.name} — ${score}`;
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
  // /teams — список всех команд
  bot.onText(/\/teams$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Команды не созданы.");
      return;
    }

    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    const lines = ["🏢 *Все команды:*", ""];
    for (const team of teams) {
      const count = await prisma.manager.count({ where: { teamId: team.id } });
      const tl = team.teamLeadId
        ? await prisma.manager.findUnique({ where: { id: team.teamLeadId } })
        : null;
      lines.push(`• *${team.name}* — ${count} менеджеров (ТЛ: ${tl?.name ?? "—"})`);
      keyboard.push([{ text: `👥 ${team.name}`, callback_data: `rop_team:${team.id}` }]);
    }

    await bot.sendMessage(msg.chat.id, lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // /all_rating — общий рейтинг всех менеджеров
  bot.onText(/\/all_rating$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    await bot.sendMessage(msg.chat.id, "⏳ Загружаю рейтинг...");
    const rating = await getAllManagerRating(7);
    if (!rating.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Нет данных о менеджерах.");
      return;
    }

    const text = `📊 *Общий рейтинг менеджеров (7 дней):*\n\n${formatRating(rating)}`;
    await sendInChunks(bot, msg.chat.id, text, "Markdown");
  });

  // /all_mistakes — ошибки по всей компании
  bot.onText(/\/all_mistakes$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    const mistakes = await getAllMistakes(7, 10);
    if (!mistakes.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Нет данных об ошибках за последние 7 дней.");
      return;
    }

    const lines = mistakes.map((m, i) => `${i + 1}. ${m.mistake} — ${m.count} раз`);
    await sendInChunks(
      bot,
      msg.chat.id,
      `⚠️ *Частые ошибки по компании (7 дней):*\n\n${lines.join("\n")}`,
      "Markdown"
    );
  });

  // /rop_team_rating — рейтинг по конкретной команде (выбор из списка)
  bot.onText(/\/rop_team_rating$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Нет команд.");
      return;
    }

    const keyboard = teams.map((t) => [{ text: t.name, callback_data: `rop_tr:${t.id}` }]);
    await bot.sendMessage(msg.chat.id, "Выберите команду для рейтинга:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // /rop_team_mistakes — ошибки конкретной команды
  bot.onText(/\/rop_team_mistakes$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Нет команд.");
      return;
    }

    const keyboard = teams.map((t) => [{ text: t.name, callback_data: `rop_tm:${t.id}` }]);
    await bot.sendMessage(msg.chat.id, "Выберите команду для анализа ошибок:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // /rop_manager — карточка менеджера (2 шага: команда → менеджер)
  bot.onText(/\/rop_manager$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Нет команд.");
      return;
    }

    const keyboard = teams.map((t) => [{ text: t.name, callback_data: `rop_t_card:${t.id}` }]);
    await bot.sendMessage(msg.chat.id, "Выберите команду:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // /rop_ask — AI-вопрос о менеджере (2 шага: команда → менеджер)
  bot.onText(/\/rop_ask$/, async (msg) => {
    if (!(await requireRop(bot, msg))) return;

    const teams = await prisma.team.findMany({ orderBy: { name: "asc" } });
    if (!teams.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Нет команд.");
      return;
    }

    const keyboard = teams.map((t) => [{ text: t.name, callback_data: `rop_t_ask:${t.id}` }]);
    await bot.sendMessage(msg.chat.id, "Выберите команду:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // Callback handlers
  bot.on("callback_query", async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    // rop_team:<teamId> — показать участников команды
    if (data.startsWith("rop_team:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const rating = await getTeamRating(teamId, 7);
      const team = await prisma.team.findUnique({ where: { id: teamId } });
      if (!rating.length) {
        await bot.sendMessage(chatId, "ℹ️ В команде нет менеджеров.");
        return;
      }
      const text = `👥 *${team?.name ?? "Команда"} (7 дней):*\n\n${formatRating(rating)}`;
      await sendInChunks(bot, chatId, text, "Markdown");
      return;
    }

    // rop_tr:<teamId> — рейтинг команды
    if (data.startsWith("rop_tr:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const [rating, team] = await Promise.all([
        getTeamRating(teamId, 7),
        prisma.team.findUnique({ where: { id: teamId } }),
      ]);
      if (!rating.length) {
        await bot.sendMessage(chatId, "ℹ️ Нет данных по этой команде.");
        return;
      }
      const text = `📊 *Рейтинг: ${team?.name ?? "команда"} (7 дней):*\n\n${formatRating(rating)}`;
      await sendInChunks(bot, chatId, text, "Markdown");
      return;
    }

    // rop_tm:<teamId> — ошибки команды
    if (data.startsWith("rop_tm:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const [mistakes, team] = await Promise.all([
        getTeamMistakes(teamId, 7, 10),
        prisma.team.findUnique({ where: { id: teamId } }),
      ]);
      if (!mistakes.length) {
        await bot.sendMessage(chatId, "ℹ️ Нет данных об ошибках.");
        return;
      }
      const lines = mistakes.map((m, i) => `${i + 1}. ${m.mistake} — ${m.count} раз`);
      await sendInChunks(
        bot,
        chatId,
        `⚠️ *Ошибки команды ${team?.name ?? ""} (7 дней):*\n\n${lines.join("\n")}`,
        "Markdown"
      );
      return;
    }

    // rop_t_card:<teamId> — показать менеджеров для карточки
    if (data.startsWith("rop_t_card:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const members = await prisma.manager.findMany({
        where: { teamId, isActive: true },
        orderBy: { name: "asc" },
      });
      if (!members.length) {
        await bot.sendMessage(chatId, "ℹ️ В команде нет менеджеров.");
        return;
      }
      const keyboard = members.map((m) => [
        { text: m.name, callback_data: `rop_card:${m.id}` },
      ]);
      await bot.sendMessage(chatId, "Выберите менеджера:", {
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    // rop_card:<managerId> — карточка менеджера
    if (data.startsWith("rop_card:")) {
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

    // rop_t_ask:<teamId> — выбрать менеджера для AI-вопроса
    if (data.startsWith("rop_t_ask:")) {
      const teamId = parseInt(data.split(":")[1]);
      await bot.answerCallbackQuery(query.id);
      const members = await prisma.manager.findMany({
        where: { teamId, isActive: true },
        orderBy: { name: "asc" },
      });
      if (!members.length) {
        await bot.sendMessage(chatId, "ℹ️ В команде нет менеджеров.");
        return;
      }
      const keyboard = members.map((m) => [
        { text: m.name, callback_data: `rop_ask_mgr:${m.id}` },
      ]);
      await bot.sendMessage(chatId, "Выберите менеджера:", {
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    // rop_ask_mgr:<managerId> — начать AI-сессию РОПа о менеджере
    if (data.startsWith("rop_ask_mgr:")) {
      const managerId = parseInt(data.split(":")[1]);
      const mgr = await prisma.manager.findUnique({ where: { id: managerId } });
      if (!mgr) {
        await bot.answerCallbackQuery(query.id, { text: "Менеджер не найден." });
        return;
      }

      await bot.answerCallbackQuery(query.id);
      roleFlowState.set(userId, {
        step: "awaiting_sup_question",
        data: { targetManagerId: managerId, targetManagerName: mgr.name, supervisorRole: "ROP" },
      });

      await bot.sendMessage(
        chatId,
        `🤖 Задайте вопрос об *${mgr.name}* (минимум 10 слов):\n\nПример: «Что рекомендуете улучшить менеджеру ${mgr.name} в первую очередь?»\n\nДля выхода: /stop_ai`,
        { parse_mode: "Markdown" }
      );
      return;
    }
  });
}
