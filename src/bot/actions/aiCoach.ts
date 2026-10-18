import { prisma } from "../../config/database";
import type { GeminiMessage } from "../../services/aiAnalysis";
import { aiSessions, roleFlowState, supervisorAiSessions } from "../state";
import { criteriaLine, getStrongAreas, getWeakAreas } from "../reportText";
import { defineAction } from "./registry";

/**
 * The manager's AI coach: /ask opens a session over their own calls, the free
 * text handler feeds it, /stop_ai closes it.
 *
 * The Gemini client is imported when a session starts, not when this module
 * loads: the registry has to be loadable in tests without an API key.
 */

export type AiPeriod = "day" | "week" | "month" | "30days";

export function parseAskArg(arg: string): { period: AiPeriod; question: string } {
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

  // Prefix: "/ask_kun savol?" → period=day, question="savol?"
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

/** `/ask_kun …`, `/ask_hafta …`, `/ask_oy …` arrive as the tail after `/ask`. */
export function parseAskArgWithAliases(arg: string): { period: AiPeriod; question: string } {
  const normalized = arg
    .trim()
    .replace(/^_+/, "")
    .replace(/^ask_kun\b/i, "kun")
    .replace(/^ask_hafta\b/i, "hafta")
    .replace(/^ask_oy\b/i, "oy");
  return parseAskArg(normalized);
}

export function periodLabel(period: AiPeriod): string {
  switch (period) {
    case "day":    return "bugun";
    case "week":   return "so'nggi 7 kun";
    case "month":  return "joriy oy";
    default:       return "so'nggi 30 kun";
  }
}

export function periodDateRange(period: AiPeriod, now = new Date()): { from: Date; to: Date } {
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

export async function buildAiSystemPrompt(
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
- Javoblar qisqa va mazmunli (3–6 gap), bo'sh gaplarsiz
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

Barcha javob va tavsiyalaring uchun shu ma'lumotlardan foydalan.`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

defineAction({
  id: "ask", section: "ai", roles: ["manager"], label: "AI-murabbiyni boshlash",
  variants: [
    { label: "Boshlash (30 kun)" },
    { label: "Kun", arg: "kun" },
    { label: "Hafta", arg: "hafta" },
    { label: "Oy", arg: "oy" },
  ],
  // One pattern carries /ask, /ask_kun, /ask_hafta and /ask_oy; the tail is
  // parsed as the period. Anchored, so /ask_manager (a team-lead command)
  // and "/askanything" no longer start a session.
  command: {
    pattern: /^\/ask((?:_(?:kun|hafta|oy))?(?:\s[\s\S]*)?)$/, usage: "/ask [savol]", description: "AI-murabbiy bilan suhbat (30 kun)",
    menu: [
      { command: "ask", description: "AI-murabbiy: so'nggi 30 kun" },
      { command: "ask_kun", description: "AI-murabbiy: faqat bugun" },
      { command: "ask_hafta", description: "AI-murabbiy: 7 kun" },
      { command: "ask_oy", description: "AI-murabbiy: joriy oy" },
    ],
  },
  async run(ctx) {
    // The manager role is only granted to an active linked manager.
    const manager = ctx.access.manager!;
    const { askGeminiWithHistory } = await import("../../services/aiAnalysis");

    const userId = ctx.userId;
    const rawArg = (ctx.args[0] ?? "").trim();
    const { period, question: inlineQuestion } = parseAskArgWithAliases(rawArg);
    const label = periodLabel(period);

    await ctx.bot.sendMessage(
      ctx.chatId,
      `⏳ ${label} uchun ma'lumotlar yuklanmoqda...`
    );
    const systemContext = await buildAiSystemPrompt(manager.id, manager.name, period);

    const history: GeminiMessage[] = [];

    const activationText =
      `🤖 *AI-murabbiy faol!*\n\n` +
      `📅 Tahlil davri: *${label}*\n` +
      `Savollaringizni bering — men butun suhbatni eslayman.\n\n` +
      `Davrni o'zgartirish: /ask_kun · /ask_hafta · /ask_oy\n` +
      `Chiqish: /stop\\_ai`;

    if (inlineQuestion) {
      history.push({ role: "user", parts: [{ text: inlineQuestion }] });
      const answer = await askGeminiWithHistory(history, systemContext);
      history.push({ role: "model", parts: [{ text: answer }] });

      await aiSessions.set(userId, { active: true, history, systemContext, managerId: manager.id, period });

      await ctx.bot.sendMessage(
        ctx.chatId,
        `🤖 *AI-murabbiy faol* (davr: *${label}*).\nChiqish uchun: /stop\\_ai\n\n${answer}`,
        { parse_mode: "Markdown" }
      );
    } else {
      await aiSessions.set(userId, { active: true, history, systemContext, managerId: manager.id, period });
      await ctx.bot.sendMessage(ctx.chatId, activationText, { parse_mode: "Markdown" });
    }
  },
});

defineAction({
  id: "stop_ai", section: "ai", roles: [], label: "AI-murabbiyni to'xtatish",
  // On the keyboard only while there is something to stop.
  showWhen: async ({ userId }) => (await aiSessions.get(userId))?.active === true || (await supervisorAiSessions.get(userId))?.active === true,
  command: { pattern: /\/stop_ai$/, usage: "/stop_ai", description: "AI-murabbiy rejimidan chiqish" },
  async run(ctx) {
    const userId = ctx.userId;
    const session = await aiSessions.get(userId);
    const supSession = await supervisorAiSessions.get(userId);
    const flow = await roleFlowState.get(userId);

    if (!session?.active && !supSession?.active && !flow) {
      await ctx.bot.sendMessage(ctx.chatId, "ℹ️ AI-murabbiy allaqachon aktiv emas.");
      return;
    }

    let msgCount = 0;
    if (supSession?.active) {
      msgCount = Math.floor(supSession.history.length / 2);
      await supervisorAiSessions.delete(userId);
    }
    if (session?.active) {
      msgCount = Math.floor(session.history.length / 2);
      await aiSessions.delete(userId);
    }
    if (flow) await roleFlowState.delete(userId);

    await ctx.bot.sendMessage(
      ctx.chatId,
      `✅ AI-murabbiy bilan suhbat yakunlandi. Sessiyada xabarlar: ${msgCount}.\n\nYangi seans uchun /ask kiriting.`
    );
  },
});
