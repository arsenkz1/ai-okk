import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../config/database";
import {
  askGeminiWithHistory,
  GeminiMessage,
} from "../services/aiAnalysis";
import {
  MIN_DISCIPLINE_MESSAGES_PER_DAY,
  MIN_DISCIPLINE_MESSAGE_WORDS,
} from "../config/disciplinePilot";
import { writeManagersToSheet } from "../services/googleSheets";
import { countValidAiMessagesToday, maybeRestorePilotManagerAccess } from "../services/disciplineCheck";
import { supervisorAiSessions, roleFlowState } from "./state";
import { buildSupervisorAiPrompt } from "./supervisorAi";
import { registerAdminRoleHandlers } from "./handlers/adminRoles";
import { registerTeamLeadHandlers } from "./handlers/teamlead";
import { registerRopHandlers } from "./handlers/rop";
import { registerCallTaskReviewHandlers } from "./handlers/callTaskReview";
import { registerPerformanceHandlers } from "./handlers/performance";
import { installSafeTelegramSender } from "./safeTelegram";
import { findLinkedManager, resolveAccess } from "./access";
import { claimUpdate } from "./dedupe";
import { installDefaultCommandMenu, syncCommandMenu } from "./commandMenu";
import { mainMenuMarkup } from "./keyboards/mainMenu";
import { aiSessions, awaitingCode, periodState } from "./state";
import "./actions";
import { parseDate } from "./reportText";
import { registerCommandActions } from "./actions/dispatch";
import { buildReport, sendAdminReport } from "./actions/reports";
import { sendDealDossier } from "./actions/deal";

// ---------------------------------------------------------------------------
// Bot initialization
// ---------------------------------------------------------------------------

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

export const bot = installSafeTelegramSender(new TelegramBot(token, { polling: true }));
console.log("[Bot] Telegram bot started (polling)");
// The "/" menu every chat sees until it gets its own, role-specific one.
void installDefaultCommandMenu(bot);

// ---------------------------------------------------------------------------
// Admin notifications
// ---------------------------------------------------------------------------

export { notifyAdmins } from "./notify";

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

    const access = await resolveAccess(tgId);
    await bot.sendMessage(
      msg.chat.id,
      `✅ Tayyor! Siz *${link.manager.name}* sifatida kirdingiz.\n\nMavjud buyruqlarni ko'rish uchun /start kiriting.`,
      { parse_mode: "Markdown", reply_markup: mainMenuMarkup(access) }
    );
    await syncCommandMenu(bot, msg.chat.id, access);
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
      await sendAdminReport(bot, msg.chat.id, from, to, label);
      return;
    }

    const manager = await findLinkedManager(tgId);
    if (!manager) {
      await bot.sendMessage(msg.chat.id, "❌ Siz avtorizatsiya qilinmagansiz.");
      return;
    }
    await bot.sendMessage(msg.chat.id, await buildReport(manager.id, from, to, label), { parse_mode: "HTML" });
    return;
  }

  // ── State 3: Supervisor AI dialog (TeamLead/ROP asking about a manager) ──
  const supSession = supervisorAiSessions.get(userId);
  if (supSession?.active) {
    const question = msg.text.trim();
    await bot.sendChatAction(msg.chat.id, "typing");
    supSession.history.push({ role: "user", parts: [{ text: question }] });
    const answer = await askGeminiWithHistory(supSession.history, supSession.systemContext);
    supSession.history.push({ role: "model", parts: [{ text: answer }] });
    if (supSession.history.length > 40) supSession.history = supSession.history.slice(-40);
    await bot.sendMessage(msg.chat.id, answer);
    return;
  }

  // ── State 3.5: Awaiting supervisor question (after manager picker) ────────
  const flow = roleFlowState.get(userId);
  if (flow?.step === "awaiting_sup_question") {
    const question = msg.text.trim();
    const words = question.split(/\s+/).filter(Boolean);
    if (words.length < 10) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Savol kamida 10 ta so'zdan iborat bo'lishi kerak. Yana urinib ko'ring."
      );
      return;
    }

    const { targetManagerId, targetManagerName, supervisorRole } = flow.data as {
      targetManagerId: number;
      targetManagerName: string;
      supervisorRole: "TEAMLEAD" | "ROP";
    };

    roleFlowState.delete(userId);
    await bot.sendChatAction(msg.chat.id, "typing");

    const systemContext = await buildSupervisorAiPrompt(
      targetManagerId,
      targetManagerName as string,
      supervisorRole
    );
    const history: GeminiMessage[] = [{ role: "user", parts: [{ text: question }] }];
    const answer = await askGeminiWithHistory(history, systemContext);
    history.push({ role: "model", parts: [{ text: answer }] });

    supervisorAiSessions.set(userId, {
      active: true,
      targetManagerId,
      targetManagerName: targetManagerName as string,
      history,
      systemContext,
    });

    await bot.sendMessage(
      msg.chat.id,
      `🤖 *${targetManagerName} haqida AI:*\n\n${answer}\n\n_Keyingi savollarni berishda davom eting yoki chiqish uchun /stop\\_ai ni bosing._`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ── State 4: AI-coach dialog (manager talking about themselves) ───────────
  const session = aiSessions.get(userId);
  if (session?.active) {
    const question = msg.text.trim();
    const wordCount = question.split(/\s+/).filter(Boolean).length;
    await bot.sendChatAction(msg.chat.id, "typing");

    session.history.push({ role: "user", parts: [{ text: question }] });

    const answer = await askGeminiWithHistory(session.history, session.systemContext);

    session.history.push({ role: "model", parts: [{ text: answer }] });

    if (session.history.length > 40) {
      session.history = session.history.slice(-40);
    }

    await bot.sendMessage(msg.chat.id, answer);

    // Session counts for discipline only if question is long enough
    if (wordCount >= MIN_DISCIPLINE_MESSAGE_WORDS) {
      await prisma.aiTrainerSession.create({
        data: { managerId: session.managerId, question, answer, period: session.period },
      }).catch((e: Error) => console.error("[AiSession] Save failed:", e.message));

      // Restore amoCRM role rights once the pilot manager reaches the daily threshold.
      try {
        const restored = await maybeRestorePilotManagerAccess(session.managerId);
        if (restored) {
          const validMessages = await countValidAiMessagesToday(session.managerId);
          await bot.sendMessage(msg.chat.id, "✅ amoCRM dagi kirish huquqingiz tiklandi.");
          console.log(
            `[Discipline] Restored amoCRM access for manager ${session.managerId} after ${validMessages}/${MIN_DISCIPLINE_MESSAGES_PER_DAY} valid AI messages`
          );
        }
      } catch (e: any) {
        console.error("[Discipline] Restore failed:", e.message);
      }
    }

    return;
  }

  // ── State 5: bare amoCRM deal ID ──────────────────────────────────────────
  // Last in the chain on purpose: every stateful flow above, the AI coach
  // included, keeps its own numeric input.
  const bareDealId = msg.text.trim();
  if (/^\d{4,12}$/.test(bareDealId)) {
    await sendDealDossier(bot, msg.chat.id, tgId, parseInt(bareDealId, 10));
    return;
  }
});

// ---------------------------------------------------------------------------
// Polling errors + graceful shutdown
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Role-based handlers
// ---------------------------------------------------------------------------

// Commands live in the action registry; the same entries will back the
// keyboard buttons.
registerCommandActions(bot, [
  "start", "help", "report", "week", "month", "period", "errors", "deal", "deal_usage", "ask", "stop_ai",
  "sync_managers", "sync_history", "managers", "manager_ids", "admins", "add_admin", "remove_admin", "reset_code",
  "analyze_deal", "check_tg", "test_restrict", "test_restore",
]);
registerAdminRoleHandlers(bot);
registerTeamLeadHandlers(bot);
registerRopHandlers(bot);
registerCallTaskReviewHandlers(bot);
registerPerformanceHandlers(bot);

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
