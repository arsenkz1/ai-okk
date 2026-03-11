import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../config/database";
import { redisConnection } from "../config/queue";
import { syncManagersFromPbx, resetManagerCode } from "../services/managerSync";
import {
  askGeminiWithHistory,
  GeminiMessage,
} from "../services/aiAnalysis";
import { writeManagersToSheet } from "../services/googleSheets";
import { syncHistoryRange } from "../services/pbxHistory";
import { callProcessingQueue } from "../queues/callProcessing";

// ---------------------------------------------------------------------------
// Инициализация бота
// ---------------------------------------------------------------------------

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

export const bot = new TelegramBot(token, { polling: true });
console.log("[Bot] Telegram bot started (polling)");

// ---------------------------------------------------------------------------
// Дедупликация через Redis: гарантирует что только ОДИН инстанс бота
// обработает каждое сообщение, даже если ts-node-dev запустил несколько инстансов
// ---------------------------------------------------------------------------

/**
 * Атомарно резервирует апдейт через Redis SET NX.
 * Возвращает true если ЭТОт инстанс должен обрабатывать сообщение,
 * false если уже обрабатывается другим инстансом.
 */
async function claimUpdate(chatId: number, messageId: number): Promise<boolean> {
  try {
    const key = `bot:dedup:${chatId}:${messageId}`;
    const result = await redisConnection.set(key, "1", "EX", 120, "NX");
    return result === "OK";
  } catch {
    // Если Redis недоступен — пропускаем дедупликацию (лучше дубль чем пропуск)
    return true;
  }
}

// ---------------------------------------------------------------------------
// Состояния пользователей (in-memory, сбрасываются при рестарте)
// ---------------------------------------------------------------------------

// Ждут ввода кода активации после /start
const awaitingCode = new Set<number>();

// Режим выбора произвольного периода: { step, from }
interface PeriodState {
  step: "from" | "to";
  from?: Date;
}
const periodState = new Map<number, PeriodState>();

// AI-коуч сессии: история диалога + флаг активности
interface AiSession {
  active: boolean;
  history: GeminiMessage[];
  systemContext: string; // контекст со звонками, загружается при /ask
}
const aiSessions = new Map<number, AiSession>();

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

async function getManager(telegramUserId: string) {
  const link = await prisma.telegramLink.findFirst({
    where: { telegramUserId, status: "used" },
    include: { manager: true },
  });
  return link?.manager ?? null;
}

async function isAdmin(telegramUserId: string): Promise<boolean> {
  if (telegramUserId === process.env.ADMIN_TELEGRAM_ID) return true;
  const admin = await prisma.botAdmin.findUnique({ where: { telegramUserId } });
  return !!admin;
}

async function requireManager(msg: TelegramBot.Message) {
  const tgId = String(msg.from!.id);
  const manager = await getManager(tgId);
  if (!manager) {
    await bot.sendMessage(
      msg.chat.id,
      "❌ Вы не авторизованы.\nВведите /start и ваш 6-значный код."
    );
    return null;
  }
  if (!manager.isActive) {
    await bot.sendMessage(
      msg.chat.id,
      "❌ Ваш аккаунт деактивирован. Обратитесь к администратору."
    );
    return null;
  }
  return manager;
}

async function requireAdmin(msg: TelegramBot.Message): Promise<boolean> {
  const ok = await isAdmin(String(msg.from!.id));
  if (!ok) await bot.sendMessage(msg.chat.id, "❌ У вас нет прав администратора.");
  return ok;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

/** Парсит дату в форматах DD.MM.YYYY или YYYY-MM-DD */
function parseDate(str: string): Date | null {
  str = str.trim();
  let d: Date | null = null;

  // DD.MM.YYYY
  const dmyMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dmyMatch) {
    d = new Date(`${dmyMatch[3]}-${dmyMatch[2].padStart(2, "0")}-${dmyMatch[1].padStart(2, "0")}`);
  }

  // YYYY-MM-DD
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    d = new Date(str);
  }

  return d && !isNaN(d.getTime()) ? d : null;
}

// ---------------------------------------------------------------------------
// Построение отчёта по диапазону дат
// ---------------------------------------------------------------------------

async function buildReport(
  managerId: number,
  from: Date,
  to: Date,
  label: string
): Promise<string> {
  const fromStart = new Date(from);
  fromStart.setHours(0, 0, 0, 0);
  const toEnd = new Date(to);
  toEnd.setHours(23, 59, 59, 999);

  const calls = await prisma.call.findMany({
    where: {
      managerId,
      startedAt: { gte: fromStart, lte: toEnd },
      processingStatus: "processed",
    },
    include: { analysis: true },
    orderBy: { startedAt: "desc" },
  });

  if (!calls.length) {
    return `📊 Отчёт за ${label}\n\nАнализов звонков не найдено за этот период.`;
  }

  const scores = calls
    .map((c) => c.analysis?.overallScore)
    .filter((s): s is number => s !== null && s !== undefined);
  const avgScore = scores.length
    ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
    : "н/д";
  const totalTalk = calls.reduce((a, c) => a + c.durationSeconds, 0);

  const weakMap: Record<string, number> = {};
  const strongMap: Record<string, number> = {};
  for (const call of calls) {
    for (const w of (call.analysis?.weaknesses as string[] | null) ?? [])
      weakMap[w] = (weakMap[w] ?? 0) + 1;
    for (const s of (call.analysis?.strengths as string[] | null) ?? [])
      strongMap[s] = (strongMap[s] ?? 0) + 1;
  }

  const topWeak = Object.entries(weakMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => `  • ${w}`)
    .join("\n");

  const topStrong = Object.entries(strongMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s]) => `  • ${s}`)
    .join("\n");

  return [
    `📊 Отчёт за ${label}`,
    ``,
    `📞 Проанализировано звонков: ${calls.length}`,
    `⏱ Суммарное время: ${formatDuration(totalTalk)}`,
    `⭐ Средняя оценка: ${avgScore}/10`,
    topStrong ? `\n💪 Сильные стороны:\n${topStrong}` : "",
    topWeak ? `\n⚠️ Зоны роста:\n${topWeak}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function presetRange(preset: "day" | "week" | "month"): { from: Date; to: Date; label: string } {
  const now = new Date();
  const to = new Date(now);
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  if (preset === "week") from.setDate(from.getDate() - 6);
  else if (preset === "month") from.setDate(1);

  const dayStr = now.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  const label =
    preset === "day"
      ? `сегодня, ${dayStr}`
      : preset === "week"
      ? "последние 7 дней"
      : `${now.toLocaleDateString("ru-RU", { month: "long", year: "numeric" })}`;

  return { from, to, label };
}

// ---------------------------------------------------------------------------
// Построение system prompt для AI-коуча (роль + данные звонков)
// ---------------------------------------------------------------------------

type AiPeriod = "day" | "week" | "month" | "30days";

/**
 * Парсит ключевое слово периода из аргумента команды /ask.
 * Возвращает период и остаток строки (вопрос, если есть).
 */
function parseAskArg(arg: string): { period: AiPeriod; question: string } {
  const trimmed = arg.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "день" || lower === "сегодня") return { period: "day", question: "" };
  if (lower === "неделя" || lower === "7 дней") return { period: "week", question: "" };
  if (lower === "месяц" || lower === "30 дней") return { period: "month", question: "" };

  // Проверяем если слово в начале: "/ask день как дела?" → period=day, question="как дела?"
  const prefixMatch = trimmed.match(/^(день|сегодня|неделя|месяц)\s+(.+)$/i);
  if (prefixMatch) {
    const kw = prefixMatch[1].toLowerCase();
    const q = prefixMatch[2].trim();
    if (kw === "день" || kw === "сегодня") return { period: "day", question: q };
    if (kw === "неделя") return { period: "week", question: q };
    if (kw === "месяц") return { period: "month", question: q };
  }

  return { period: "30days", question: trimmed };
}

function periodLabel(period: AiPeriod): string {
  switch (period) {
    case "day":    return "сегодня";
    case "week":   return "последние 7 дней";
    case "month":  return "текущий месяц";
    default:       return "последние 30 дней";
  }
}

function periodDateRange(period: AiPeriod): { from: Date; to: Date } {
  const now = new Date();
  const to = new Date(now);
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  if (period === "week") {
    from.setDate(from.getDate() - 6);
  } else if (period === "month") {
    from.setDate(1);
  } else if (period === "30days") {
    from.setDate(from.getDate() - 29);
  }
  // day — from = начало сегодня (уже установлено)

  return { from, to };
}

async function buildAiSystemPrompt(
  managerId: number,
  managerName: string,
  period: AiPeriod = "30days"
): Promise<string> {
  const { from } = periodDateRange(period);
  const label = periodLabel(period);

  const calls = await prisma.call.findMany({
    where: { managerId, startedAt: { gte: from }, processingStatus: "processed" },
    include: { analysis: true },
    orderBy: { startedAt: "desc" },
    take: 50,
  });

  const scores = calls
    .map((c) => c.analysis?.overallScore)
    .filter((s): s is number => s !== null && s !== undefined);
  const avg = scores.length
    ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
    : "нет данных";

  const callLines = calls.length
    ? calls
        .map((c) => {
          const date = c.startedAt.toLocaleDateString("ru-RU");
          const score = c.analysis?.overallScore ?? "н/д";
          const summary = c.analysis?.summary ?? "";
          const strengths = ((c.analysis?.strengths as string[] | null) ?? []).join(", ");
          const weak = ((c.analysis?.weaknesses as string[] | null) ?? []).join(", ");
          const recs = ((c.analysis?.recommendations as string[] | null) ?? []).join(", ");
          return (
            `  • ${date} | оценка ${score}/10${summary ? ` | ${summary}` : ""}` +
            (strengths ? `\n    Сильные стороны: ${strengths}` : "") +
            (weak ? `\n    Ошибки: ${weak}` : "") +
            (recs ? `\n    Рекомендации: ${recs}` : "")
          );
        })
        .join("\n")
    : `  Звонков с анализом за ${label} не найдено.`;

  return `Ты — опытный AI-тренер по продажам. Твоя задача — помогать менеджеру ${managerName} профессионально расти.

ТВОЯ РОЛЬ И СТИЛЬ:
- Ты говоришь как наставник: поддерживаешь, но честен и конкретен
- Даёшь практичные советы с конкретными примерами фраз и техник
- Основываешься ТОЛЬКО на реальных данных звонков менеджера — не придумывай факты
- Ответы короткие и по делу (3–6 предложений), без воды
- Говоришь на "ты", тепло но профессионально
- Если данных недостаточно — честно говоришь об этом
- ВАЖНО: никогда не используй приветствия ("Привет", "Здравствуй", "Добрый день" и т.п.) в ответах — ты уже в диалоге, приветствие было только один раз при входе

ДАННЫЕ МЕНЕДЖЕРА ЗА ПЕРИОД: ${label.toUpperCase()}
Имя: ${managerName}
Звонков с анализом: ${calls.length}
Средняя оценка: ${avg}/10

Детализация по звонкам:
${callLines}

Используй эти данные как основу для всех своих ответов и рекомендаций.`;
}

// ---------------------------------------------------------------------------
// /start — приветствие и авторизация
// ---------------------------------------------------------------------------

bot.onText(/\/start$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const tgId = String(msg.from!.id);
  const manager = await getManager(tgId);

  if (manager) {
    await bot.sendMessage(
      msg.chat.id,
      `👋 Привет, *${manager.name}*!\n\n` +
        `📊 *Отчёты:*\n` +
        `/report — сегодня\n` +
        `/week — неделя\n` +
        `/month — месяц\n` +
        `/period — произвольный период\n\n` +
        `🤖 *AI-коуч:*\n` +
        `/ask — за последние 30 дней\n` +
        `/ask день — только сегодня\n` +
        `/ask неделя — за 7 дней\n` +
        `/ask месяц — за текущий месяц\n\n` +
        `📋 *Другое:*\n` +
        `/errors — мои частые ошибки`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  awaitingCode.add(msg.from!.id);
  await bot.sendMessage(
    msg.chat.id,
    `👋 Привет!\n\nЧтобы начать, введи свой *6-значный код*.\nЕго можно найти в таблице менеджеров (спроси у руководителя).`,
    { parse_mode: "Markdown" }
  );
});

// ---------------------------------------------------------------------------
// Единый обработчик текстовых сообщений (не-команды)
// Обрабатывает: активационный код, ввод дат для /period, диалог с AI-коучем
// ---------------------------------------------------------------------------

bot.on("message", async (msg) => {
  if (!msg.text || !msg.from) return;
  if (msg.text.startsWith("/")) return; // команды обрабатываются отдельными onText

  // Дедупликация: пропускаем если другой инстанс уже обрабатывает это сообщение
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;

  const userId = msg.from.id;
  const tgId = String(userId);

  // ── Состояние 1: Ввод кода активации ────────────────────────────────────
  if (awaitingCode.has(userId)) {
    const text = msg.text.trim();
    if (!/^\d{6}$/.test(text)) {
      await bot.sendMessage(msg.chat.id, "Код должен быть 6-значным числом. Попробуй ещё раз.");
      return;
    }

    const link = await prisma.telegramLink.findUnique({
      where: { oneTimeCode: text },
      include: { manager: true },
    });

    if (!link || link.status !== "issued") {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Код неверный или уже использован. Обратись к администратору для сброса."
      );
      return;
    }

    if (!link.manager.isActive) {
      await bot.sendMessage(msg.chat.id, "❌ Этот аккаунт деактивирован.");
      awaitingCode.delete(userId);
      return;
    }

    // Проверяем: нет ли уже активной (used) привязки этого Telegram к другому менеджеру
    const existing = await prisma.telegramLink.findFirst({
      where: { telegramUserId: tgId, status: "used" },
    });
    if (existing && existing.managerId !== link.managerId) {
      await bot.sendMessage(msg.chat.id, "⚠️ Этот Telegram уже привязан к другому менеджеру.");
      awaitingCode.delete(userId);
      return;
    }

    // Очищаем telegramUserId из старых записей этого пользователя (expired/issued),
    // иначе @unique constraint упадёт при записи нового
    await prisma.telegramLink.updateMany({
      where: { telegramUserId: tgId, id: { not: link.id } },
      data: { telegramUserId: null },
    });

    await prisma.telegramLink.update({
      where: { id: link.id },
      data: { telegramUserId: tgId, status: "used", usedAt: new Date() },
    });

    awaitingCode.delete(userId);
    writeManagersToSheet().catch((e) =>
      console.error("[Bot] Sheet update after link failed:", e.message)
    );

    await bot.sendMessage(
      msg.chat.id,
      `✅ Готово! Ты вошёл как *${link.manager.name}*.\n\nНапиши /start чтобы увидеть доступные команды.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ── Состояние 2: Ввод дат для /period ────────────────────────────────────
  if (periodState.has(userId)) {
    const state = periodState.get(userId)!;
    const date = parseDate(msg.text.trim());

    if (!date) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Не могу распознать дату. Введи в формате *ДД.ММ.ГГГГ*, например: `10.03.2026`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (state.step === "from") {
      periodState.set(userId, { step: "to", from: date });
      await bot.sendMessage(
        msg.chat.id,
        `✅ Начало: *${date.toLocaleDateString("ru-RU")}*\n\nТеперь введи *конечную дату*:`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // step === "to"
    const from = state.from!;
    const to = date;
    periodState.delete(userId);

    if (to < from) {
      await bot.sendMessage(msg.chat.id, "❌ Конечная дата не может быть раньше начальной.");
      return;
    }

    const manager = await getManager(tgId);
    if (!manager) {
      await bot.sendMessage(msg.chat.id, "❌ Вы не авторизованы.");
      return;
    }

    await bot.sendMessage(msg.chat.id, "⏳ Формирую отчёт...");
    const label = `${from.toLocaleDateString("ru-RU")} — ${to.toLocaleDateString("ru-RU")}`;
    const text = await buildReport(manager.id, from, to, label);
    await bot.sendMessage(msg.chat.id, text);
    return;
  }

  // ── Состояние 3: Диалог с AI-коучем ──────────────────────────────────────
  const session = aiSessions.get(userId);
  if (session?.active) {
    const question = msg.text.trim();
    await bot.sendChatAction(msg.chat.id, "typing");

    // Добавляем вопрос пользователя в историю
    session.history.push({ role: "user", parts: [{ text: question }] });

    const answer = await askGeminiWithHistory(session.history, session.systemContext);

    // Сохраняем ответ модели в историю
    session.history.push({ role: "model", parts: [{ text: answer }] });

    // Ограничиваем историю: максимум 20 пар (40 сообщений) чтобы не превысить лимит токенов
    if (session.history.length > 40) {
      session.history = session.history.slice(-40);
    }

    await bot.sendMessage(msg.chat.id, answer);
    return;
  }
});

// ---------------------------------------------------------------------------
// /report, /week, /month — отчёты за пресет-периоды
// ---------------------------------------------------------------------------

bot.onText(/\/report$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const manager = await requireManager(msg);
  if (!manager) return;
  await bot.sendMessage(msg.chat.id, "⏳ Формирую отчёт...");
  const { from, to, label } = presetRange("day");
  await bot.sendMessage(msg.chat.id, await buildReport(manager.id, from, to, label));
});

bot.onText(/\/week$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const manager = await requireManager(msg);
  if (!manager) return;
  await bot.sendMessage(msg.chat.id, "⏳ Формирую отчёт...");
  const { from, to, label } = presetRange("week");
  await bot.sendMessage(msg.chat.id, await buildReport(manager.id, from, to, label));
});

bot.onText(/\/month$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const manager = await requireManager(msg);
  if (!manager) return;
  await bot.sendMessage(msg.chat.id, "⏳ Формирую отчёт...");
  const { from, to, label } = presetRange("month");
  await bot.sendMessage(msg.chat.id, await buildReport(manager.id, from, to, label));
});

// ---------------------------------------------------------------------------
// /period — произвольный диапазон дат
// ---------------------------------------------------------------------------

bot.onText(/\/period$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const manager = await requireManager(msg);
  if (!manager) return;

  periodState.set(msg.from!.id, { step: "from" });
  await bot.sendMessage(
    msg.chat.id,
    `📅 Введи *начальную дату* периода в формате ДД.ММ.ГГГГ:\n\nНапример: \`01.03.2026\``,
    { parse_mode: "Markdown" }
  );
});

// ---------------------------------------------------------------------------
// /errors — топ ошибок за 30 дней
// ---------------------------------------------------------------------------

bot.onText(/\/errors$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const manager = await requireManager(msg);
  if (!manager) return;

  const from = new Date();
  from.setDate(from.getDate() - 30);

  const calls = await prisma.call.findMany({
    where: { managerId: manager.id, startedAt: { gte: from }, processingStatus: "processed" },
    include: { analysis: true },
  });

  const weakMap: Record<string, number> = {};
  for (const call of calls)
    for (const w of (call.analysis?.weaknesses as string[] | null) ?? [])
      weakMap[w] = (weakMap[w] ?? 0) + 1;

  if (!Object.keys(weakMap).length) {
    await bot.sendMessage(msg.chat.id, "✅ За последние 30 дней ошибок не найдено!");
    return;
  }

  const sorted = Object.entries(weakMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w, count], i) => `${i + 1}. ${w} (${count}×)`)
    .join("\n");

  await bot.sendMessage(
    msg.chat.id,
    `⚠️ Частые ошибки за 30 дней (${calls.length} звонков):\n\n${sorted}`
  );
});

// ---------------------------------------------------------------------------
// /ask — вход в режим диалога с AI-коучем
// ---------------------------------------------------------------------------

bot.onText(/\/ask(.*)/, async (msg, match) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const manager = await requireManager(msg);
  if (!manager) return;

  const userId = msg.from!.id;
  const rawArg = match![1].trim();
  const { period, question: inlineQuestion } = parseAskArg(rawArg);
  const label = periodLabel(period);

  // Загружаем system prompt с данными за выбранный период
  await bot.sendMessage(
    msg.chat.id,
    `⏳ Загружаю данные за ${label}...`
  );
  const systemContext = await buildAiSystemPrompt(manager.id, manager.name, period);

  const history: GeminiMessage[] = [];

  const activationText =
    `🤖 *AI-коуч активен!*\n\n` +
    `📅 Период анализа: *${label}*\n` +
    `Задавай вопросы — я помню весь наш разговор.\n\n` +
    `Сменить период: /ask день · /ask неделя · /ask месяц\n` +
    `Выход: /stop\\_ai`;

  // Если вопрос передан сразу с командой — задаём его немедленно
  if (inlineQuestion) {
    history.push({ role: "user", parts: [{ text: inlineQuestion }] });
    const answer = await askGeminiWithHistory(history, systemContext);
    history.push({ role: "model", parts: [{ text: answer }] });

    aiSessions.set(userId, { active: true, history, systemContext });

    await bot.sendMessage(
      msg.chat.id,
      `🤖 *AI-коуч активен* (период: *${label}*).\nДля выхода: /stop\\_ai\n\n${answer}`,
      { parse_mode: "Markdown" }
    );
  } else {
    aiSessions.set(userId, { active: true, history, systemContext });

    await bot.sendMessage(msg.chat.id, activationText, { parse_mode: "Markdown" });
  }
});

// ---------------------------------------------------------------------------
// /stop_ai — выход из режима AI-коуча
// ---------------------------------------------------------------------------

bot.onText(/\/stop_ai$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const userId = msg.from!.id;
  const session = aiSessions.get(userId);

  if (!session?.active) {
    await bot.sendMessage(msg.chat.id, "ℹ️ AI-коуч и так не активен.");
    return;
  }

  const msgCount = Math.floor(session.history.length / 2);
  aiSessions.delete(userId);

  await bot.sendMessage(
    msg.chat.id,
    `✅ Диалог с AI-коучем завершён. Сообщений в сессии: ${msgCount}.\n\nДля нового сеанса введи /ask`
  );
});

// ---------------------------------------------------------------------------
// ADMIN: /sync_managers
// ---------------------------------------------------------------------------

bot.onText(/\/sync_managers$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  await bot.sendMessage(msg.chat.id, "⏳ Синхронизирую менеджеров из OnlinePBX...");

  try {
    const result = await syncManagersFromPbx();
    await bot.sendMessage(
      msg.chat.id,
      `✅ Синхронизация завершена:\n` +
        `• Создано: ${result.created}\n` +
        `• Обновлено: ${result.updated}\n` +
        `• Реактивировано: ${result.reactivated}\n` +
        `• Деактивировано: ${result.deactivated}\n` +
        `• Всего в PBX: ${result.total}\n\n` +
        `Google Sheet обновлён ✓`
    );
  } catch (err: any) {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка синхронизации: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// ADMIN: /admins
// ---------------------------------------------------------------------------

bot.onText(/\/admins$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  const admins = await prisma.botAdmin.findMany({ orderBy: { createdAt: "asc" } });
  const lines = [`👑 Суперадмин: ${process.env.ADMIN_TELEGRAM_ID}`];

  if (admins.length) {
    lines.push(
      `\n🔑 Дополнительные:`,
      ...admins.map((a) => `• ${a.telegramUserId}${a.addedBy ? ` (добавил: ${a.addedBy})` : ""}`)
    );
  } else {
    lines.push("\nДополнительных администраторов нет.");
  }

  await bot.sendMessage(msg.chat.id, lines.join("\n"));
});

// ---------------------------------------------------------------------------
// ADMIN: /add_admin <id>
// ---------------------------------------------------------------------------

bot.onText(/\/add_admin (\d+)/, async (msg, match) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  const newId = match![1];
  if (newId === process.env.ADMIN_TELEGRAM_ID) {
    await bot.sendMessage(msg.chat.id, "ℹ️ Уже суперадмин.");
    return;
  }

  await prisma.botAdmin.upsert({
    where: { telegramUserId: newId },
    update: { addedBy: String(msg.from!.id) },
    create: { telegramUserId: newId, addedBy: String(msg.from!.id) },
  });
  await bot.sendMessage(msg.chat.id, `✅ Пользователь ${newId} назначен администратором.`);
});

// ---------------------------------------------------------------------------
// ADMIN: /remove_admin <id>
// ---------------------------------------------------------------------------

bot.onText(/\/remove_admin (\d+)/, async (msg, match) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  const targetId = match![1];
  if (targetId === process.env.ADMIN_TELEGRAM_ID) {
    await bot.sendMessage(msg.chat.id, "❌ Нельзя удалить суперадмина.");
    return;
  }

  const deleted = await prisma.botAdmin.deleteMany({ where: { telegramUserId: targetId } });
  await bot.sendMessage(
    msg.chat.id,
    deleted.count ? `✅ Администратор ${targetId} удалён.` : `ℹ️ Пользователь не является администратором.`
  );
});

// ---------------------------------------------------------------------------
// ADMIN: /reset_code <amo_id>
// ---------------------------------------------------------------------------

bot.onText(/\/reset_code (\d+)/, async (msg, match) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  const result = await resetManagerCode(parseInt(match![1]));
  if (!result) {
    await bot.sendMessage(msg.chat.id, `❌ Менеджер с amoCRM ID ${match![1]} не найден.`);
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    `✅ Новый код для *${result.managerName}*:\n\n🔑 \`${result.code}\`\n\nСтарые привязки сброшены.`,
    { parse_mode: "Markdown" }
  );
});

// ---------------------------------------------------------------------------
// ADMIN: /managers — список менеджеров
// ---------------------------------------------------------------------------

bot.onText(/\/managers$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  const managers = await prisma.manager.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    include: {
      telegramLinks: {
        where: { status: { in: ["issued", "used"] } },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!managers.length) {
    await bot.sendMessage(msg.chat.id, "Менеджеров нет. Запустите /sync_managers");
    return;
  }

  const lines = managers.map((m) => {
    const usedLink = m.telegramLinks.find((l) => l.status === "used");
    const issuedLink = m.telegramLinks.find((l) => l.status === "issued");
    const status = usedLink ? "✅" : issuedLink ? "⏳" : "❌";
    const active = m.isActive ? "" : " 🚫";
    return `${status}${active} ${m.name} (uid: ${m.internalNumber ?? "—"}, amo: ${m.amoUserId ?? "—"})`;
  });

  for (let i = 0; i < lines.length; i += 30) {
    await bot.sendMessage(msg.chat.id, `👥 Менеджеры:\n\n${lines.slice(i, i + 30).join("\n")}`);
  }
});

// ---------------------------------------------------------------------------
// ADMIN: /sync_history [from_date] [to_date]
// Запуск исторической синхронизации звонков из OnlinePBX
// ---------------------------------------------------------------------------

bot.onText(/\/sync_history(.*)/, async (msg, match) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  const args = (match![1] ?? "").trim().split(/\s+/).filter(Boolean);

  let fromDate: Date;
  let toDate: Date;

  if (args.length >= 2) {
    const f = parseDate(args[0]);
    const t = parseDate(args[1]);
    if (!f || !t) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Неверный формат дат. Используй: /sync\\_history ДД.ММ.ГГГГ ДД.ММ.ГГГГ\nНапример: `/sync_history 01.03.2026 10.03.2026`",
        { parse_mode: "Markdown" }
      );
      return;
    }
    fromDate = f;
    toDate = t;
  } else if (args.length === 1) {
    const f = parseDate(args[0]);
    if (!f) {
      await bot.sendMessage(msg.chat.id, "❌ Неверный формат даты.");
      return;
    }
    fromDate = f;
    toDate = new Date(); // до сегодня
  } else {
    // По умолчанию — последние 7 дней
    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 7);
  }

  if (toDate < fromDate) {
    await bot.sendMessage(msg.chat.id, "❌ Конечная дата не может быть раньше начальной.");
    return;
  }

  const fromStr = fromDate.toLocaleDateString("ru-RU");
  const toStr = toDate.toLocaleDateString("ru-RU");

  // Создаём запись задачи в БД
  let syncJob;
  try {
    syncJob = await prisma.historySyncJob.create({
      data: {
        fromDate,
        toDate,
        status: "in_progress",
      },
    });
  } catch (err: any) {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка создания задачи: ${err.message}`);
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    `⏳ Запускаю синхронизацию истории звонков...\n\n📅 Период: ${fromStr} — ${toStr}\n🆔 Job ID: ${syncJob.id}\n\nЭто может занять несколько минут. Я сообщу о результатах.`
  );

  // Запускаем асинхронно
  syncHistoryRange(fromDate, toDate, syncJob.id)
    .then(async (stats) => {
      try {
        await bot.sendMessage(
          msg.chat.id,
          `✅ Синхронизация завершена (Job #${syncJob.id}):\n\n` +
            `📊 Просканировано: ${stats.scanned}\n` +
            `📥 Добавлено в очередь: ${stats.queued}\n` +
            `⏭ Пропущено (короткие < 8 мин): ${stats.skippedShort}\n` +
            `⏭ Пропущено (внутренние): ${stats.skippedInternal}\n` +
            `⏭ Уже обработаны: ${stats.skippedDuplicate}\n` +
            (stats.errors > 0 ? `⚠️ Ошибок: ${stats.errors}\n` : "")
        );
      } catch {}
    })
    .catch(async (err: any) => {
      console.error("[Bot] sync_history failed:", err.message);
      try {
        await bot.sendMessage(
          msg.chat.id,
          `❌ Синхронизация завершилась с ошибкой (Job #${syncJob.id}):\n${err.message}`
        );
      } catch {}
    });
});

// ---------------------------------------------------------------------------
// ADMIN: /analyze_deal <deal_id>
// Ручной запуск анализа последнего звонка по сделке
// ---------------------------------------------------------------------------

bot.onText(/\/analyze_deal (\d+)/, async (msg, match) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  const dealId = parseInt(match![1]);

  // Ищем последний звонок по сделке
  const call = await prisma.call.findFirst({
    where: { dealId },
    orderBy: { startedAt: "desc" },
    include: { analysis: true },
  });

  if (!call) {
    await bot.sendMessage(
      msg.chat.id,
      `❌ Звонки по сделке #${dealId} не найдены в базе данных.\n\nВозможно, сделка ещё не синхронизирована или звонков не было.`
    );
    return;
  }

  // Проверяем что есть URL записи
  if (!call.recordUrl) {
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ У звонка (ID: ${call.id}) по сделке #${dealId} нет URL записи. Анализ невозможен.`
    );
    return;
  }

  const callDate = call.startedAt.toLocaleDateString("ru-RU");
  const currentStatus = call.processingStatus;

  await bot.sendMessage(
    msg.chat.id,
    `⏳ Ставлю в очередь повторный анализ...\n\n` +
      `📞 Звонок ID: ${call.id}\n` +
      `📅 Дата: ${callDate}\n` +
      `⏱ Длительность: ${formatDuration(call.durationSeconds)}\n` +
      `📊 Текущий статус: ${currentStatus}`
  );

  // Сбрасываем статус и ставим в очередь
  try {
    await prisma.call.update({
      where: { id: call.id },
      data: {
        processingStatus: "queued",
        manualTriggered: true,
        lastError: null,
      },
    });

    await callProcessingQueue.add(
      `manual:${call.externalId}`,
      {
        callExternalId: call.externalId,
        source: "onlinepbx" as const,
        receivedAt: new Date().toISOString(),
        manualTriggered: true,
        payload: {
          event: "call_end" as const,
          uuid: call.externalId,
          direction: (call.direction === "out" ? "out" : "in") as "in" | "out",
          caller: "",
          callee: "",
          start_time: call.startedAt.toISOString().replace("T", " ").slice(0, 19),
          end_time: call.endedAt.toISOString().replace("T", " ").slice(0, 19),
          duration: call.durationSeconds,
          status: call.status,
          record_url: call.recordUrl ?? undefined,
          internal_number: "",
          external_number: "",
        },
      },
      {
        jobId: `manual:${call.externalId}:${Date.now()}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      }
    );

    await bot.sendMessage(
      msg.chat.id,
      `✅ Звонок поставлен в очередь на анализ.\n\nРезультат появится в Google Sheets и будет добавлен как примечание к сделке #${dealId}.`
    );
  } catch (err: any) {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Обработка ошибок polling + graceful shutdown
// ---------------------------------------------------------------------------

bot.on("polling_error", (err) => {
  if ((err as any).code === "ETELEGRAM" && err.message.includes("409")) return;
  console.error("[Bot] Polling error:", err.message);
});

async function gracefulStop() {
  console.log("[Bot] Stopping polling gracefully...");
  try {
    await bot.stopPolling();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", gracefulStop);
process.on("SIGINT", gracefulStop);
