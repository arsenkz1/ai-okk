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
import { syncHistoryRange, findPbxRecordByDateAndPhone } from "../services/pbxHistory";
import { callProcessingQueue } from "../queues/callProcessing";
import { fetchDealCallNotes, fetchDealContactPhones } from "../services/amocrm";

// ---------------------------------------------------------------------------
// Bot initialization
// ---------------------------------------------------------------------------

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

export const bot = new TelegramBot(token, { polling: true });
console.log("[Bot] Telegram bot started (polling)");

// ---------------------------------------------------------------------------
// Admin notifications
// ---------------------------------------------------------------------------

export { notifyAdmins } from "./notify";

// ---------------------------------------------------------------------------
// Redis deduplication
// ---------------------------------------------------------------------------

async function claimUpdate(chatId: number, messageId: number): Promise<boolean> {
  try {
    const key = `bot:dedup:${chatId}:${messageId}`;
    const result = await redisConnection.set(key, "1", "EX", 120, "NX");
    return result === "OK";
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// User state (in-memory)
// ---------------------------------------------------------------------------

const awaitingCode = new Set<number>();

interface PeriodState {
  step: "from" | "to";
  from?: Date;
  adminMode?: boolean; // true = показывать сводный отчёт по всем менеджерам
}
const periodState = new Map<number, PeriodState>();

interface AiSession {
  active: boolean;
  history: GeminiMessage[];
  systemContext: string;
}
const aiSessions = new Map<number, AiSession>();

// ---------------------------------------------------------------------------
// Helpers
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
      "❌ Siz avtorizatsiya qilinmagansiz.\n/start kiriting va 6 xonali kodingizni yuboring."
    );
    return null;
  }
  if (!manager.isActive) {
    await bot.sendMessage(
      msg.chat.id,
      "❌ Hisobingiz deaktivlashtirilgan. Administratorga murojaat qiling."
    );
    return null;
  }
  return manager;
}

async function requireAdmin(msg: TelegramBot.Message): Promise<boolean> {
  const ok = await isAdmin(String(msg.from!.id));
  if (!ok) await bot.sendMessage(msg.chat.id, "❌ Sizda administrator huquqlari yo'q.");
  return ok;
}

// ---------------------------------------------------------------------------
// Criteria helpers (new analysis schema)
// ---------------------------------------------------------------------------

const CRITERIA_LABELS: Record<string, string> = {
  contextScore:     "Kontekst",
  needsScore:       "Ehtiyojni aniqlash",
  painScore:        "Og'riqlarni topish",
  summaryScore:     "Rezyume",
  presentationScore:"Taqdimot",
  pointBScore:      "Nuqta B (natija)",
  closingScore:     "Yopish urinishi",
  objectionsScore:  "E'tirozlar",
  urgencyScore:     "Shoshilinchlik",
  agreementScore:   "Kelishuv",
};

function getWeakAreas(criteria: unknown): string[] {
  if (!criteria || typeof criteria !== "object") return [];
  const c = criteria as Record<string, unknown>;
  return Object.entries(CRITERIA_LABELS)
    .filter(([key]) => typeof c[key] === "number" && (c[key] as number) <= 5)
    .map(([, label]) => label);
}

function getStrongAreas(criteria: unknown): string[] {
  if (!criteria || typeof criteria !== "object") return [];
  const c = criteria as Record<string, unknown>;
  return Object.entries(CRITERIA_LABELS)
    .filter(([key]) => typeof c[key] === "number" && (c[key] as number) >= 8)
    .map(([, label]) => label);
}

function criteriaLine(criteria: unknown): string {
  if (!criteria || typeof criteria !== "object") return "";
  const c = criteria as Record<string, unknown>;
  return Object.entries(CRITERIA_LABELS)
    .map(([key, label]) => {
      const score = typeof c[key] === "number" ? c[key] as number : null;
      return score !== null ? `${label}: ${score}` : null;
    })
    .filter(Boolean)
    .join(", ");
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}s ${m}d` : `${m}d`;
}

/** Parses date in DD.MM.YYYY or YYYY-MM-DD format */
function parseDate(str: string): Date | null {
  str = str.trim();
  let d: Date | null = null;

  const dmyMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dmyMatch) {
    d = new Date(`${dmyMatch[3]}-${dmyMatch[2].padStart(2, "0")}-${dmyMatch[1].padStart(2, "0")}`);
  }

  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    d = new Date(str);
  }

  return d && !isNaN(d.getTime()) ? d : null;
}

const UZ_MONTHS = [
  "yanvar","fevral","mart","aprel","may","iyun",
  "iyul","avgust","sentabr","oktabr","noyabr","dekabr",
];
const UZ_MONTHS_CAP = [
  "Yanvar","Fevral","Mart","Aprel","May","Iyun",
  "Iyul","Avgust","Sentabr","Oktabr","Noyabr","Dekabr",
];

// ---------------------------------------------------------------------------
// Build report for date range
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
    return `📊 ${label} uchun hisobot\n\nBu davr uchun tahlil qilingan qo'ng'iroqlar topilmadi.`;
  }

  const scores = calls
    .map((c) => c.analysis?.overallScore)
    .filter((s): s is number => s !== null && s !== undefined);
  const avgScore = scores.length
    ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
    : "ma'lumot yo'q";
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
    `📊 ${label} uchun hisobot`,
    ``,
    `📞 Tahlil qilingan qo'ng'iroqlar: ${calls.length}`,
    `⏱ Jami vaqt: ${formatDuration(totalTalk)}`,
    `⭐ O'rtacha ball: ${avgScore}/100`,
    topStrong ? `\n💪 Kuchli tomonlar:\n${topStrong}` : "",
    topWeak ? `\n⚠️ O'sish sohalari:\n${topWeak}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function buildAdminReport(from: Date, to: Date, label: string): Promise<string> {
  const fromStart = new Date(from); fromStart.setHours(0, 0, 0, 0);
  const toEnd = new Date(to); toEnd.setHours(23, 59, 59, 999);

  const calls = await prisma.call.findMany({
    where: { startedAt: { gte: fromStart, lte: toEnd }, processingStatus: "processed" },
    include: { analysis: true, manager: true },
    orderBy: { startedAt: "desc" },
  });

  if (!calls.length) {
    return `📊 ${label} uchun umumiy hisobot\n\nBu davr uchun tahlil qilingan qo'ng'iroqlar topilmadi.`;
  }

  const totalTalk = calls.reduce((a, c) => a + c.durationSeconds, 0);
  const allScores = calls.map(c => c.analysis?.overallScore).filter((s): s is number => s !== null && s !== undefined);
  const avgScore = allScores.length ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1) : "—";

  // Рейтинг менеджеров
  const mgrMap = new Map<string, { total: number; count: number }>();
  for (const call of calls) {
    const name = call.manager?.name ?? "Noma'lum";
    const score = call.analysis?.overallScore;
    if (score === null || score === undefined) continue;
    const cur = mgrMap.get(name) ?? { total: 0, count: 0 };
    mgrMap.set(name, { total: cur.total + score, count: cur.count + 1 });
  }
  const mgrRating = [...mgrMap.entries()]
    .map(([name, { total, count }]) => ({ name, avg: total / count, count }))
    .sort((a, b) => b.avg - a.avg)
    .map((m, i) => `${i + 1}. ${m.name} — ${m.avg.toFixed(0)}/100 (${m.count} ta)`)
    .join("\n");

  // Топ слабых критериев
  const weakMap: Record<string, number> = {};
  for (const call of calls)
    for (const w of getWeakAreas(call.analysis?.criteria))
      weakMap[w] = (weakMap[w] ?? 0) + 1;
  const topWeak = Object.entries(weakMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w, n]) => `  • ${w} (${n}×)`)
    .join("\n");

  const managerCount = new Set(calls.map(c => c.managerId).filter(Boolean)).size;

  return [
    `📊 ${label} uchun umumiy hisobot`,
    ``,
    `👥 Menejerlar: ${managerCount} (jami ${calls.length} ta qo'ng'iroq)`,
    `⏱ Jami vaqt: ${formatDuration(totalTalk)}`,
    `⭐ O'rtacha ball: ${avgScore}/100`,
    `\n📈 Menejerlar reytingi:\n${mgrRating}`,
    topWeak ? `\n⚠️ Eng zaif kriteriyalar:\n${topWeak}` : "",
  ].filter(Boolean).join("\n");
}

function presetRange(preset: "day" | "week" | "month"): { from: Date; to: Date; label: string } {
  const now = new Date();
  const to = new Date(now);
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  if (preset === "week") from.setDate(from.getDate() - 6);
  else if (preset === "month") from.setDate(1);

  const dayStr = `${now.getDate()}-${UZ_MONTHS[now.getMonth()]}`;
  const label =
    preset === "day"
      ? `bugun, ${dayStr}`
      : preset === "week"
      ? "so'nggi 7 kun"
      : `${UZ_MONTHS_CAP[now.getMonth()]} ${now.getFullYear()}`;

  return { from, to, label };
}

// ---------------------------------------------------------------------------
// AI-coach system prompt
// ---------------------------------------------------------------------------

type AiPeriod = "day" | "week" | "month" | "30days";

function parseAskArg(arg: string): { period: AiPeriod; question: string } {
  const trimmed = arg.trim();
  const lower = trimmed.toLowerCase();

  // Uzbek keywords
  if (lower === "kun" || lower === "bugun") return { period: "day", question: "" };
  if (lower === "hafta" || lower === "7 kun") return { period: "week", question: "" };
  if (lower === "oy" || lower === "30 kun") return { period: "month", question: "" };

  // Russian keywords (backward compat)
  if (lower === "день" || lower === "сегодня") return { period: "day", question: "" };
  if (lower === "неделя" || lower === "7 дней") return { period: "week", question: "" };
  if (lower === "месяц" || lower === "30 дней") return { period: "month", question: "" };

  // Prefix: "/ask kun savol?" → period=day, question="savol?"
  const prefixMatch = trimmed.match(/^(kun|bugun|hafta|oy|день|сегодня|неделя|месяц)\s+(.+)$/i);
  if (prefixMatch) {
    const kw = prefixMatch[1].toLowerCase();
    const q = prefixMatch[2].trim();
    if (kw === "kun" || kw === "bugun" || kw === "день" || kw === "сегодня") return { period: "day", question: q };
    if (kw === "hafta" || kw === "неделя") return { period: "week", question: q };
    if (kw === "oy" || kw === "месяц") return { period: "month", question: q };
  }

  return { period: "30days", question: trimmed };
}

function periodLabel(period: AiPeriod): string {
  switch (period) {
    case "day":    return "bugun";
    case "week":   return "so'nggi 7 kun";
    case "month":  return "joriy oy";
    default:       return "so'nggi 30 kun";
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
    : "ma'lumot yo'q";

  const callLines = calls.length
    ? calls
        .map((c) => {
          const date = c.startedAt.toLocaleDateString("ru-RU");
          const score = c.analysis?.overallScore ?? "—";
          const summary = c.analysis?.summary ?? "";
          const criteria = criteriaLine(c.analysis?.criteria);
          const weak = getWeakAreas(c.analysis?.criteria).join(", ");
          const strong = getStrongAreas(c.analysis?.criteria).join(", ");
          return (
            `  • ${date} | ball ${score}/100` +
            (criteria ? `\n    Kriteriyalar: ${criteria}` : "") +
            (strong ? `\n    Kuchli: ${strong}` : "") +
            (weak ? `\n    Zaif: ${weak}` : "") +
            (summary ? `\n    Izoh: ${summary.slice(0, 300)}` : "")
          );
        })
        .join("\n")
    : `  ${label} uchun tahlil qilingan qo'ng'iroqlar topilmadi.`;

  return `Sen — tajribali AI sotish murabbiysisan. Sening vazifang — ${managerName} menejerni professional o'sishiga yordam berishdir.

ROLING VA USLUBINGIZ:
- Nastavnik sifatida gapir: qo'llab-quvvatlaysan, lekin halol va aniq bo'l
- Aniq misollar va texnikalar bilan amaliy maslahatlar ber
- FAQAT menejerni haqiqiy qo'ng'iroq ma'lumotlariga asoslan — faktlarni to'qima
- Javoblar qisqa va mazmuнli (3–6 gap), bo'sh gaplarsiz
- Menejerga "sen" deb murojaat qil, iliq lekin professional tarzda
- Ma'lumot yetarli bo'lmasa — buni ochiq ayt
- MUHIM: salomlashuvlarni hech qachon ishlatma ("Salom", "Assalomu alaykum" va h.k.) — sen allaqachon suhbatdasan, salomlashish faqat bir marta bo'ldi
- MUHIM: har doim O'ZBEK TILIDA (lotin alifbosi) javob ber

MENEJERNI MA'LUMOTLARI: ${label.toUpperCase()}
Ism: ${managerName}
Tahlil qilingan qo'ng'iroqlar: ${calls.length}
O'rtacha ball: ${avg}/100

Qo'ng'iroqlar bo'yicha batafsil:
${callLines}

Barcha javob va tavsiyalaring uchun shu ma'lumotlardan foydalан.`;
}

// ---------------------------------------------------------------------------
// /start — greeting and authentication
// ---------------------------------------------------------------------------

bot.onText(/\/start$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const tgId = String(msg.from!.id);
  const manager = await getManager(tgId);

  if (manager) {
    await bot.sendMessage(
      msg.chat.id,
      `👋 Salom, *${manager.name}*!\n\n` +
        `📊 *Hisobotlar:*\n` +
        `/report — bugun\n` +
        `/week — hafta\n` +
        `/month — oy\n` +
        `/period — ixtiyoriy davr\n\n` +
        `🤖 *AI-murabbiy:*\n` +
        `/ask — so'nggi 30 kun\n` +
        `/ask kun — faqat bugun\n` +
        `/ask hafta — 7 kun\n` +
        `/ask oy — joriy oy\n\n` +
        `📋 *Boshqa:*\n` +
        `/errors — mening tez-tez xatolarim`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Админам не нужен код — показываем admin меню
  if (await isAdmin(tgId)) {
    await bot.sendMessage(
      msg.chat.id,
      `👋 Salom, Admin!\n\nBarcha buyruqlarni ko'rish uchun /help kiriting.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  awaitingCode.add(msg.from!.id);
  await bot.sendMessage(
    msg.chat.id,
    `👋 Salom!\n\nBoshlash uchun *6 xonali kodni* kiriting.\nUni menejerlar jadvalidan topishingiz mumkin (rahbaringizdan so'rang).`,
    { parse_mode: "Markdown" }
  );
});

// ---------------------------------------------------------------------------
// /help — command reference
// ---------------------------------------------------------------------------

bot.onText(/\/help$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const tgId = String(msg.from!.id);
  const admin = await isAdmin(tgId);
  const manager = await getManager(tgId);

  if (admin) {
    await bot.sendMessage(
      msg.chat.id,
      `🔑 *Administrator buyruqlari*\n\n` +

        `*Menejerlar:*\n` +
        `/managers — barcha menejerlar ro'yxati\n` +
        `/sync\\_managers — OnlinePBX dan sinxronlash va Google Sheet yangilash\n` +
        `/reset\\_code <amo\\_id> — menejер uchun yangi kod yaratish\n\n` +

        `*Administratorlar:*\n` +
        `/admins — barcha administratorlarni ko'rish\n` +
        `/add\\_admin <telegram\\_id> — foydalanuvchini administrator qilish\n` +
        `/remove\\_admin <telegram\\_id> — administrator huquqlarini olish\n\n` +

        `*Qo'ng'iroqlar tahlili:*\n` +
        `/analyze\\_deal <deal\\_id> — bitim bo'yicha so'nggi qo'ng'iroqni tahlil qilish\n` +
        `/sync\\_history — qo'ng'iroqlar tarixini sinxronlash (so'nggi 7 kun)\n\n` +

        `*Hisobotlar (jamoa bo'yicha):*\n` +
        `/report — bugungi hisobot\n` +
        `/week — so'nggi 7 kun\n` +
        `/month — joriy oy\n` +
        `/period — ixtiyoriy sana diapazoni\n` +
        `/errors — 30 kunlik zaif kriteriyalar`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (manager) {
    await bot.sendMessage(
      msg.chat.id,
      `📋 *Mavjud buyruqlar*\n\n` +

        `*Hisobotlar:*\n` +
        `/report — bugungi hisobot\n` +
        `/week — so'nggi 7 kun\n` +
        `/month — joriy oy\n` +
        `/period — ixtiyoriy sana diapazoni\n\n` +

        `*Xatolar tahlili:*\n` +
        `/errors — so'nggi 30 kunlik eng ko'p xatolar\n\n` +

        `*AI-murabbiy:*\n` +
        `/ask — dialog rejimiga kirish (30 kun ma'lumotlari)\n` +
        `/ask kun — faqat bugungi ma'lumotlar\n` +
        `/ask hafta — 7 kunlik ma'lumotlar\n` +
        `/ask oy — joriy oy ma'lumotlari\n` +
        `/ask <savol> — savolni darhol berish\n` +
        `/stop\\_ai — AI-murabbiy rejimidan chiqish`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    `ℹ️ Botga kirish uchun /start kiriting va ko'rsatmalarni bajaring.`
  );
});

// ---------------------------------------------------------------------------
// Text message handler: activation code, /period dates, AI-coach dialog
// ---------------------------------------------------------------------------

bot.on("message", async (msg) => {
  if (!msg.text || !msg.from) return;
  if (msg.text.startsWith("/")) return;

  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;

  const userId = msg.from.id;
  const tgId = String(userId);

  // ── State 1: Activation code entry ───────────────────────────────────────
  if (awaitingCode.has(userId)) {
    const text = msg.text.trim();
    if (!/^\d{6}$/.test(text)) {
      await bot.sendMessage(msg.chat.id, "Kod 6 raqamdan iborat bo'lishi kerak. Qayta urinib ko'ring.");
      return;
    }

    const link = await prisma.telegramLink.findUnique({
      where: { oneTimeCode: text },
      include: { manager: true },
    });

    if (!link || link.status !== "issued") {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Kod noto'g'ri yoki allaqachon ishlatilgan. Yangi kod olish uchun administratorga murojaat qiling."
      );
      return;
    }

    if (!link.manager.isActive) {
      await bot.sendMessage(msg.chat.id, "❌ Bu hisob deaktivlashtirilgan.");
      awaitingCode.delete(userId);
      return;
    }

    const existing = await prisma.telegramLink.findFirst({
      where: { telegramUserId: tgId, status: "used" },
    });
    if (existing && existing.managerId !== link.managerId) {
      await bot.sendMessage(msg.chat.id, "⚠️ Bu Telegram allaqachon boshqa menejerg bog'langan.");
      awaitingCode.delete(userId);
      return;
    }

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
      `✅ Tayyor! Siz *${link.manager.name}* sifatida kirdingiz.\n\nMavjud buyruqlarni ko'rish uchun /start kiriting.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ── State 2: /period date input ───────────────────────────────────────────
  if (periodState.has(userId)) {
    const state = periodState.get(userId)!;
    const date = parseDate(msg.text.trim());

    if (!date) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Sanani aniqlab bo'lmadi. *KK.OO.YYYY* formatida kiriting, masalan: `10.03.2026`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (state.step === "from") {
      periodState.set(userId, { step: "to", from: date });
      const d = date;
      const dateStr = `${d.getDate().toString().padStart(2,"0")}.${(d.getMonth()+1).toString().padStart(2,"0")}.${d.getFullYear()}`;
      await bot.sendMessage(
        msg.chat.id,
        `✅ Boshi: *${dateStr}*\n\nEndi *oxirgi sana* kiriting:`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const from = state.from!;
    const to = date;
    periodState.delete(userId);

    if (to < from) {
      await bot.sendMessage(msg.chat.id, "❌ Oxirgi sana boshidan oldin bo'la olmaydi.");
      return;
    }

    await bot.sendMessage(msg.chat.id, "⏳ Hisobot tuzilmoqda...");
    const fmt = (d: Date) => `${d.getDate().toString().padStart(2,"0")}.${(d.getMonth()+1).toString().padStart(2,"0")}.${d.getFullYear()}`;
    const label = `${fmt(from)} — ${fmt(to)}`;

    if (state.adminMode) {
      await bot.sendMessage(msg.chat.id, await buildAdminReport(from, to, label));
      return;
    }

    const manager = await getManager(tgId);
    if (!manager) {
      await bot.sendMessage(msg.chat.id, "❌ Siz avtorizatsiya qilinmagansiz.");
      return;
    }
    await bot.sendMessage(msg.chat.id, await buildReport(manager.id, from, to, label));
    return;
  }

  // ── State 3: AI-coach dialog ──────────────────────────────────────────────
  const session = aiSessions.get(userId);
  if (session?.active) {
    const question = msg.text.trim();
    await bot.sendChatAction(msg.chat.id, "typing");

    session.history.push({ role: "user", parts: [{ text: question }] });

    const answer = await askGeminiWithHistory(session.history, session.systemContext);

    session.history.push({ role: "model", parts: [{ text: answer }] });

    if (session.history.length > 40) {
      session.history = session.history.slice(-40);
    }

    await bot.sendMessage(msg.chat.id, answer);
    return;
  }
});

// ---------------------------------------------------------------------------
// /report, /week, /month — preset period reports
// ---------------------------------------------------------------------------

bot.onText(/\/report$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const tgId = String(msg.from!.id);
  const { from, to, label } = presetRange("day");
  await bot.sendMessage(msg.chat.id, "⏳ Hisobot tuzilmoqda...");
  if (await isAdmin(tgId) && !(await getManager(tgId))) {
    return void await bot.sendMessage(msg.chat.id, await buildAdminReport(from, to, label));
  }
  const manager = await requireManager(msg);
  if (!manager) return;
  await bot.sendMessage(msg.chat.id, await buildReport(manager.id, from, to, label));
});

bot.onText(/\/week$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const tgId = String(msg.from!.id);
  const { from, to, label } = presetRange("week");
  await bot.sendMessage(msg.chat.id, "⏳ Hisobot tuzilmoqda...");
  if (await isAdmin(tgId) && !(await getManager(tgId))) {
    return void await bot.sendMessage(msg.chat.id, await buildAdminReport(from, to, label));
  }
  const manager = await requireManager(msg);
  if (!manager) return;
  await bot.sendMessage(msg.chat.id, await buildReport(manager.id, from, to, label));
});

bot.onText(/\/month$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const tgId = String(msg.from!.id);
  const { from, to, label } = presetRange("month");
  await bot.sendMessage(msg.chat.id, "⏳ Hisobot tuzilmoqda...");
  if (await isAdmin(tgId) && !(await getManager(tgId))) {
    return void await bot.sendMessage(msg.chat.id, await buildAdminReport(from, to, label));
  }
  const manager = await requireManager(msg);
  if (!manager) return;
  await bot.sendMessage(msg.chat.id, await buildReport(manager.id, from, to, label));
});

// ---------------------------------------------------------------------------
// /period — custom date range
// ---------------------------------------------------------------------------

bot.onText(/\/period$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const tgId = String(msg.from!.id);
  const adminMode = await isAdmin(tgId) && !(await getManager(tgId));
  if (!adminMode) {
    const manager = await requireManager(msg);
    if (!manager) return;
  }
  periodState.set(msg.from!.id, { step: "from", adminMode });
  await bot.sendMessage(
    msg.chat.id,
    `📅 Davr *boshlanish sanasini* KK.OO.YYYY formatida kiriting:\n\nMasalan: \`01.03.2026\``,
    { parse_mode: "Markdown" }
  );
});

// ---------------------------------------------------------------------------
// /errors — top mistakes for 30 days
// ---------------------------------------------------------------------------

bot.onText(/\/errors$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const tgId = String(msg.from!.id);
  const adminMode = await isAdmin(tgId) && !(await getManager(tgId));

  const from = new Date();
  from.setDate(from.getDate() - 30);

  let calls: Awaited<ReturnType<typeof prisma.call.findMany<{ include: { analysis: true } }>>>;
  if (adminMode) {
    calls = await prisma.call.findMany({
      where: { startedAt: { gte: from }, processingStatus: "processed" },
      include: { analysis: true },
    });
  } else {
    const manager = await requireManager(msg);
    if (!manager) return;
    calls = await prisma.call.findMany({
      where: { managerId: manager.id, startedAt: { gte: from }, processingStatus: "processed" },
      include: { analysis: true },
    });
  }

  const weakMap: Record<string, number> = {};
  for (const call of calls)
    for (const w of getWeakAreas(call.analysis?.criteria))
      weakMap[w] = (weakMap[w] ?? 0) + 1;

  if (!Object.keys(weakMap).length) {
    await bot.sendMessage(msg.chat.id, "✅ So'nggi 30 kunda xatolar topilmadi!");
    return;
  }

  const sorted = Object.entries(weakMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w, count], i) => `${i + 1}. ${w} (${count}×)`)
    .join("\n");

  await bot.sendMessage(
    msg.chat.id,
    `⚠️ 30 kunlik eng ko'p xatolar (${calls.length} qo'ng'iroq):\n\n${sorted}`
  );
});

// ---------------------------------------------------------------------------
// /ask — AI-coach dialog mode
// ---------------------------------------------------------------------------

bot.onText(/\/ask(.*)/, async (msg, match) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const manager = await requireManager(msg);
  if (!manager) return;

  const userId = msg.from!.id;
  const rawArg = match![1].trim();
  const { period, question: inlineQuestion } = parseAskArg(rawArg);
  const label = periodLabel(period);

  await bot.sendMessage(
    msg.chat.id,
    `⏳ ${label} uchun ma'lumotlar yuklanmoqda...`
  );
  const systemContext = await buildAiSystemPrompt(manager.id, manager.name, period);

  const history: GeminiMessage[] = [];

  const activationText =
    `🤖 *AI-murabbiy faol!*\n\n` +
    `📅 Tahlil davri: *${label}*\n` +
    `Savollaringizni bering — men butun suhbatni eslayman.\n\n` +
    `Davrni o'zgartirish: /ask kun · /ask hafta · /ask oy\n` +
    `Chiqish: /stop\\_ai`;

  if (inlineQuestion) {
    history.push({ role: "user", parts: [{ text: inlineQuestion }] });
    const answer = await askGeminiWithHistory(history, systemContext);
    history.push({ role: "model", parts: [{ text: answer }] });

    aiSessions.set(userId, { active: true, history, systemContext });

    await bot.sendMessage(
      msg.chat.id,
      `🤖 *AI-murabbiy faol* (davr: *${label}*).\nChiqish uchun: /stop\\_ai\n\n${answer}`,
      { parse_mode: "Markdown" }
    );
  } else {
    aiSessions.set(userId, { active: true, history, systemContext });
    await bot.sendMessage(msg.chat.id, activationText, { parse_mode: "Markdown" });
  }
});

// ---------------------------------------------------------------------------
// /stop_ai — exit AI-coach mode
// ---------------------------------------------------------------------------

bot.onText(/\/stop_ai$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const userId = msg.from!.id;
  const session = aiSessions.get(userId);

  if (!session?.active) {
    await bot.sendMessage(msg.chat.id, "ℹ️ AI-murabbiy allaqachon aktiv emas.");
    return;
  }

  const msgCount = Math.floor(session.history.length / 2);
  aiSessions.delete(userId);

  await bot.sendMessage(
    msg.chat.id,
    `✅ AI-murabbiy bilan suhbat yakunlandi. Sessiyada xabarlar: ${msgCount}.\n\nYangi seans uchun /ask kiriting.`
  );
});

// ---------------------------------------------------------------------------
// ADMIN: /sync_managers
// ---------------------------------------------------------------------------

bot.onText(/\/sync_managers$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  await bot.sendMessage(msg.chat.id, "⏳ OnlinePBX dan menejerlar sinxronlanmoqda...");

  try {
    const result = await syncManagersFromPbx();
    const sheetStatus = result.sheetUpdated
      ? `Google Sheet yangilandi ✓`
      : `⚠️ Google Sheet yangilanmadi: ${result.sheetError}`;
    await bot.sendMessage(
      msg.chat.id,
      `✅ Sinxronizatsiya yakunlandi:\n` +
        `• Yaratildi: ${result.created}\n` +
        `• Yangilandi: ${result.updated}\n` +
        `• Qayta faollashtirildi: ${result.reactivated}\n` +
        `• Deaktivlashtirildi: ${result.deactivated}\n` +
        `• PBX da jami: ${result.total}\n\n` +
        sheetStatus
    );
  } catch (err: any) {
    await bot.sendMessage(msg.chat.id, `❌ Sinxronizatsiya xatosi: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// ADMIN: /admins
// ---------------------------------------------------------------------------

bot.onText(/\/admins$/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  const admins = await prisma.botAdmin.findMany({ orderBy: { createdAt: "asc" } });
  const lines = [`👑 Superadmin: ${process.env.ADMIN_TELEGRAM_ID}`];

  if (admins.length) {
    lines.push(
      `\n🔑 Qo'shimcha:`,
      ...admins.map((a) => `• ${a.telegramUserId}${a.addedBy ? ` (qo'shdi: ${a.addedBy})` : ""}`)
    );
  } else {
    lines.push("\nQo'shimcha administratorlar yo'q.");
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
    await bot.sendMessage(msg.chat.id, "ℹ️ Allaqachon superadmin.");
    return;
  }

  await prisma.botAdmin.upsert({
    where: { telegramUserId: newId },
    update: { addedBy: String(msg.from!.id) },
    create: { telegramUserId: newId, addedBy: String(msg.from!.id) },
  });
  await bot.sendMessage(msg.chat.id, `✅ Foydalanuvchi ${newId} administrator qilindi.`);
});

// ---------------------------------------------------------------------------
// ADMIN: /remove_admin <id>
// ---------------------------------------------------------------------------

bot.onText(/\/remove_admin (\d+)/, async (msg, match) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  const targetId = match![1];
  if (targetId === process.env.ADMIN_TELEGRAM_ID) {
    await bot.sendMessage(msg.chat.id, "❌ Superadminni o'chirib bo'lmaydi.");
    return;
  }

  const deleted = await prisma.botAdmin.deleteMany({ where: { telegramUserId: targetId } });
  await bot.sendMessage(
    msg.chat.id,
    deleted.count
      ? `✅ Administrator ${targetId} o'chirildi.`
      : `ℹ️ Foydalanuvchi administrator emas.`
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
    await bot.sendMessage(msg.chat.id, `❌ amoCRM ID ${match![1]} bilan menejер topilmadi.`);
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    `✅ *${result.managerName}* uchun yangi kod:\n\n🔑 \`${result.code}\`\n\nEski bog'lanishlar o'chirildi.`,
    { parse_mode: "Markdown" }
  );
});

// ---------------------------------------------------------------------------
// ADMIN: /managers — manager list
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
    await bot.sendMessage(msg.chat.id, "Menejerlar yo'q. /sync_managers ishga tushiring.");
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
    await bot.sendMessage(msg.chat.id, `👥 Menejerlar:\n\n${lines.slice(i, i + 30).join("\n")}`);
  }
});

// ---------------------------------------------------------------------------
// ADMIN: /sync_history — синхронизация последних 7 дней
// ---------------------------------------------------------------------------

bot.onText(/\/sync_history/, async (msg) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 7);

  const fmt = (d: Date) => `${d.getDate().toString().padStart(2,"0")}.${(d.getMonth()+1).toString().padStart(2,"0")}.${d.getFullYear()}`;
  const fromStr = fmt(fromDate);
  const toStr = fmt(toDate);

  let syncJob;
  try {
    syncJob = await prisma.historySyncJob.create({
      data: { fromDate, toDate, status: "in_progress" },
    });
  } catch (err: any) {
    await bot.sendMessage(msg.chat.id, `❌ Vazifa yaratishda xato: ${err.message}`);
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    `⏳ Qo'ng'iroqlar tarixini sinxronlash boshlandi...\n\n📅 Davr: ${fromStr} — ${toStr}\n🆔 Job ID: ${syncJob.id}\n\nBu bir necha daqiqa olishi mumkin. Natijalar haqida xabar beraman.`
  );

  syncHistoryRange(fromDate, toDate, syncJob.id)
    .then(async (stats) => {
      try {
        await bot.sendMessage(
          msg.chat.id,
          `✅ Sinxronizatsiya yakunlandi (Job #${syncJob.id}):\n\n` +
            `📊 Skanerlandi: ${stats.scanned}\n` +
            `📥 Navbatga qo'shildi: ${stats.queued}\n` +
            `⏭ O'tkazib yuborildi (< 8 daq): ${stats.skippedShort}\n` +
            `⏭ O'tkazib yuborildi (ichki): ${stats.skippedInternal}\n` +
            `⏭ Allaqachon qayta ishlangan: ${stats.skippedDuplicate}\n` +
            (stats.errors > 0 ? `⚠️ Xatolar: ${stats.errors}\n` : "")
        );
      } catch {}
    })
    .catch(async (err: any) => {
      console.error("[Bot] sync_history failed:", err.message);
      try {
        await bot.sendMessage(
          msg.chat.id,
          `❌ Sinxronizatsiya xato bilan yakunlandi (Job #${syncJob.id}):\n${err.message}`
        );
      } catch {}
    });
});

// ---------------------------------------------------------------------------
// ADMIN: /analyze_deal <deal_id>
// ---------------------------------------------------------------------------

bot.onText(/\/analyze_deal (\d+)/, async (msg, match) => {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  if (!(await requireAdmin(msg))) return;

  const dealId = parseInt(match![1]);

  await bot.sendMessage(
    msg.chat.id,
    `⏳ Bitim #${dealId} uchun amoCRM dan qo'ng'iroq izlash...`
  );

  try {
    // Шаг 1: получаем примечания-звонки из сделки amoCRM
    const notes = await fetchDealCallNotes(dealId);

    const MIN_DURATION = 8 * 60; // 480 секунд
    const qualifying = notes.filter((n) => n.duration >= MIN_DURATION && n.recordUrl);

    if (!qualifying.length) {
      await bot.sendMessage(
        msg.chat.id,
        `❌ Bitim #${dealId} uchun yaroqli qo'ng'iroqlar topilmadi.\n\n` +
          `Jami izohlar: ${notes.length}\n` +
          `Shartlar: yozuv URL + davomiyligi ≥ 8 daqiqa`
      );
      return;
    }

    // Сортируем по длительности убывающей, берём топ-3
    qualifying.sort((a, b) => b.duration - a.duration);
    const toProcess = qualifying.slice(0, 3);

    await bot.sendMessage(
      msg.chat.id,
      `✅ ${qualifying.length} ta yaroqli qo'ng'iroq topildi.\n${toProcess.length} ta navbatga qo'yilmoqda...`
    );

    // Шаг 2: телефоны контакта (нужны если нет uniq в примечании)
    let contactPhones: string[] = [];

    let queued = 0;
    let alreadyExists = 0;
    let errors = 0;

    for (const note of toProcess) {
      try {
        let uuid = note.uniq;

        // Если нет UUID в примечании — ищем в OnlinePBX по дате + телефону
        if (!uuid) {
          const phoneToSearch = note.phone;
          if (phoneToSearch) {
            const pbxRecord = await findPbxRecordByDateAndPhone(note.createdAt, phoneToSearch);
            uuid = pbxRecord?.uuid ?? null;
          } else {
            // Пробуем контактный телефон
            if (!contactPhones.length) {
              contactPhones = await fetchDealContactPhones(dealId);
            }
            if (contactPhones.length) {
              const pbxRecord = await findPbxRecordByDateAndPhone(note.createdAt, contactPhones[0]);
              uuid = pbxRecord?.uuid ?? null;
            }
          }
        }

        // Генерируем синтетический ID если UUID так и не нашли
        if (!uuid) {
          uuid = `deal_${dealId}_note_${note.id}`;
        }

        // Шаг 3: проверка идемпотентности
        const existing = await prisma.call.findUnique({
          where: { externalId_source: { externalId: uuid, source: "onlinepbx" } },
        });

        if (existing) {
          alreadyExists++;
          // Перезапускаем анализ даже если запись существует
          await prisma.call.update({
            where: { id: existing.id },
            data: { processingStatus: "queued", manualTriggered: true, lastError: null },
          });
        }

        const externalPhone = note.phone ?? (contactPhones[0] ?? "");
        const direction = note.noteType === "call_out" ? "out" : ("in" as "in" | "out");
        const startTime = note.createdAt;
        const endTime = new Date(startTime.getTime() + note.duration * 1000);

        // Шаг 4: ставим в очередь
        await callProcessingQueue.add(
          `manual_deal_${uuid}`,
          {
            callExternalId: uuid,
            source: "onlinepbx" as const,
            receivedAt: new Date().toISOString(),
            manualTriggered: true,
            forceDealId: dealId,
            payload: {
              event: "call_end" as const,
              uuid,
              direction,
              caller: direction === "in" ? externalPhone : "",
              callee: direction === "out" ? externalPhone : "",
              start_time: startTime.toISOString().replace("T", " ").slice(0, 19),
              end_time: endTime.toISOString().replace("T", " ").slice(0, 19),
              duration: note.duration,
              status: "completed",
              record_url: note.recordUrl ?? undefined,
              internal_number: note.internalNumber ?? "",
              external_number: externalPhone,
            },
          },
          {
            jobId: `manual_deal_${uuid}_${Date.now()}`,
            attempts: 3,
            backoff: { type: "exponential", delay: 5000 },
          }
        );

        queued++;
        console.log(
          `[Bot] analyze_deal #${dealId}: queued note ${note.id} uuid=${uuid} duration=${note.duration}s`
        );
      } catch (err: any) {
        errors++;
        console.error(`[Bot] analyze_deal #${dealId} note ${note.id} error:`, err.message);
      }
    }

    await bot.sendMessage(
      msg.chat.id,
      `📊 Natija:\n` +
        `✅ Navbatga qo'yildi: ${queued}\n` +
        `♻️ Mavjud (qayta yuborildi): ${alreadyExists}\n` +
        `❌ Xatolar: ${errors}\n\n` +
        `Tahlil natijasi Google Sheets da paydo bo'ladi va bitim #${dealId} ga izoh qo'shiladi.`
    );
  } catch (err: any) {
    await bot.sendMessage(msg.chat.id, `❌ Xato: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Polling errors + graceful shutdown
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
