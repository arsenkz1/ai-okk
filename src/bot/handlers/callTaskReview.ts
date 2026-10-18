import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import { almatyPresetDueAt, parseAlmatyDateTimeInput } from "../../services/almatyTime";
import { executeReviewedCallTaskProposal } from "../../services/callTaskAutomation";
import { getCallTaskAutomationRuntime } from "../../services/callTaskAutomationRuntime";
import { isCallTaskReviewer, parseCallTaskReviewCallback } from "../callTaskReviewNotifications";
import { defineAction } from "../actions/registry";
import { registerCommandActions } from "../actions/dispatch";
import { defineInputHandler } from "../inputHandlers";
import { pendingInput } from "../pendingInput";
import { cancelKeyboard } from "../keyboards/cancel";

function resultText(result: Awaited<ReturnType<typeof executeReviewedCallTaskProposal>>): string {
  if (result.kind === "confirmed") return `✅ Задача #${result.taskId} и примечание созданы.`;
  if (result.kind === "existing") return "ℹ️ Это предложение уже обработано.";
  if (result.kind === "dry_run") return "ℹ️ Сейчас включён безопасный dry-run: задача не создана.";
  if (result.kind === "task_not_created") return "⚠️ Сделка больше не подходит для задачи. Ничего не создано.";
  if (result.kind === "uncertain") return "⚠️ Ответ amoCRM неоднозначен. Повторно задачу не отправляли; проверьте журнал.";
  if (result.kind === "disabled") return "ℹ️ Автоматизация задач выключена.";
  return `ℹ️ Предложение не обработано: ${result.kind}.`;
}

async function approveProposal(
  approvalToken: string,
  dueAt: Date,
  reviewerTelegramUserId: string,
): Promise<Awaited<ReturnType<typeof executeReviewedCallTaskProposal>>> {
  const runtime = getCallTaskAutomationRuntime();
  if (!runtime.config.enabled) return { kind: "disabled" };
  const action = await runtime.dependencies.ledger.getActionByApprovalToken(approvalToken);
  if (!action || action.status !== "proposed" || action.decision !== "review") {
    return { kind: "existing", actionId: action?.id ?? "unknown" };
  }
  const call = await prisma.call.findUnique({
    where: { id: action.callId },
    select: { manager: { select: { amoUserId: true } } },
  });
  if (!call) return { kind: "task_not_created", actionId: action.id };
  return executeReviewedCallTaskProposal({
    action,
    dueAt,
    reviewerTelegramUserId,
    managerAmoUserId: call.manager?.amoUserId ?? null,
  }, runtime.dependencies);
}

async function rejectProposal(approvalToken: string, reviewerTelegramUserId: string): Promise<"rejected" | "existing" | "disabled"> {
  const runtime = getCallTaskAutomationRuntime();
  if (!runtime.config.enabled) return "disabled";
  const action = await runtime.dependencies.ledger.getActionByApprovalToken(approvalToken);
  if (!action || action.status !== "proposed" || action.decision !== "review") return "existing";
  const rejected = await runtime.dependencies.ledger.rejectProposal(action.id, reviewerTelegramUserId, new Date());
  return rejected ? "rejected" : "existing";
}

async function isAuthorized(queryOrMessage: { from?: TelegramBot.User }, bot: TelegramBot, chatId: number): Promise<string | null> {
  const telegramUserId = queryOrMessage.from ? String(queryOrMessage.from.id) : null;
  if (telegramUserId && await isCallTaskReviewer(telegramUserId)) return telegramUserId;
  await bot.sendMessage(chatId, "❌ У вас нет прав администратора или РОП для этой операции.");
  return null;
}

export const TASK_DUE_PROMPT = "Укажите срок в формате YYYY-MM-DD ЧЧ:ММ (время Алматы), например 2026-08-05 15:00.";
export const TASK_DUE_ERROR_TEXT = "❌ Нужна будущая дата в формате YYYY-MM-DD ЧЧ:ММ (Алматы). Попробуйте ещё раз.";

// The typed deadline after "Указать срок" on a proposal card: the same path
// as /call_task_time, without copying the token by hand.
defineInputHandler("task_due", async ({ bot, chatId, userId, telegramUserId, text, input, pending }) => {
  const dueAt = parseAlmatyDateTimeInput(text.trim());
  if (!dueAt || dueAt.getTime() <= Date.now()) {
    await bot.sendMessage(chatId, TASK_DUE_ERROR_TEXT, { reply_markup: cancelKeyboard() });
    return;
  }
  await pending.cancel(userId);
  if (!(await isCallTaskReviewer(telegramUserId))) {
    await bot.sendMessage(chatId, "❌ У вас нет прав администратора или РОП для этой операции.");
    return;
  }
  const token = String(input.payload.token ?? "");
  try {
    const result = await approveProposal(token, dueAt, telegramUserId);
    await bot.sendMessage(chatId, resultText(result));
  } catch (error) {
    console.error("[CallTaskAutomation] Typed proposal deadline failed", { approvalToken: token, reason: error instanceof Error ? error.message : "unknown error" });
    await bot.sendMessage(chatId, "⚠️ Не удалось обработать срок. Повторная задача не отправлялась.");
  }
});

export function registerCallTaskReviewHandlers(bot: TelegramBot): void {
  bot.on("callback_query", async (query) => {
    const callback = parseCallTaskReviewCallback(query.data);
    if (!callback || !query.message) return;
    const chatId = query.message.chat.id;
    const reviewerTelegramUserId = await isAuthorized(query, bot, chatId);
    if (!reviewerTelegramUserId) {
      await bot.answerCallbackQuery(query.id, { text: "Нет доступа", show_alert: true });
      return;
    }

    try {
      if (callback.command === "custom") {
        await bot.answerCallbackQuery(query.id);
        await pendingInput.expect(query.from.id, "task_due", { token: callback.approvalToken });
        await bot.sendMessage(chatId, TASK_DUE_PROMPT, { reply_markup: cancelKeyboard() });
        return;
      }
      if (callback.command === "reject") {
        const rejected = await rejectProposal(callback.approvalToken, reviewerTelegramUserId);
        await bot.answerCallbackQuery(query.id, { text: rejected === "rejected" ? "Предложение отклонено" : "Уже обработано" });
        if (rejected === "rejected") await bot.sendMessage(chatId, "✅ Задача не будет создана.");
        return;
      }

      const dueAt = almatyPresetDueAt(callback.command, new Date());
      if (!dueAt || dueAt.getTime() <= Date.now()) {
        await bot.answerCallbackQuery(query.id, { text: "Этот срок уже прошёл — укажите дату вручную", show_alert: true });
        return;
      }
      const result = await approveProposal(callback.approvalToken, dueAt, reviewerTelegramUserId);
      await bot.answerCallbackQuery(query.id, { text: resultText(result), show_alert: result.kind === "uncertain" });
      await bot.sendMessage(chatId, resultText(result));
    } catch (error) {
      console.error("[CallTaskAutomation] Telegram proposal callback failed", {
        approvalToken: callback.approvalToken,
        reason: error instanceof Error ? error.message : "unknown error",
      });
      await bot.answerCallbackQuery(query.id, { text: "Не удалось обработать. Повторная задача не отправлялась.", show_alert: true });
    }
  });

  defineAction({
    id: "call_task_time", section: "users", roles: [], denyText: undefined, label: "AI-vazifa muddati", commandOnly: true, helpHidden: true,
    command: { pattern: /^\/call_task_time\s+([A-Za-z0-9_-]{12,48})\s+(.+)$/, usage: "/call_task_time <token> <YYYY-MM-DD ЧЧ:ММ>", description: "срок AI-задачи с карточки" },
    async run(ctx) {
      const msg = ctx.message!;
    const reviewerTelegramUserId = await isAuthorized(msg, bot, msg.chat.id);
    if (!reviewerTelegramUserId) return;
    const dueAt = parseAlmatyDateTimeInput(ctx.args[1]);
    if (!dueAt || dueAt.getTime() <= Date.now()) {
      await bot.sendMessage(msg.chat.id, "❌ Нужна будущая дата в формате: /call_task_time TOKEN YYYY-MM-DD ЧЧ:ММ (Алматы).");
      return;
    }
    try {
      const result = await approveProposal(ctx.args[0], dueAt, reviewerTelegramUserId);
      await bot.sendMessage(msg.chat.id, resultText(result));
    } catch (error) {
      console.error("[CallTaskAutomation] Manual proposal deadline failed", {
        approvalToken: ctx.args[0],
        reason: error instanceof Error ? error.message : "unknown error",
      });
      await bot.sendMessage(msg.chat.id, "⚠️ Не удалось обработать срок. Повторная задача не отправлялась.");
    }
    },
  });

  registerCommandActions(bot, [
    "call_task_time",
  ]);
}
