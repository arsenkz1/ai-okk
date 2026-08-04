import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import { almatyPresetDueAt, parseAlmatyDateTimeInput } from "../../services/almatyTime";
import { executeReviewedCallTaskProposal } from "../../services/callTaskAutomation";
import { getCallTaskAutomationRuntime } from "../../services/callTaskAutomationRuntime";
import { isCallTaskReviewer, parseCallTaskReviewCallback } from "../callTaskReviewNotifications";

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
        await bot.sendMessage(
          chatId,
          `Укажите срок: /call_task_time ${callback.approvalToken} 2026-08-05 15:00\nВремя — Алматы.`,
        );
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

  bot.onText(/^\/call_task_time\s+([A-Za-z0-9_-]{12,48})\s+(.+)$/, async (msg, match) => {
    const reviewerTelegramUserId = await isAuthorized(msg, bot, msg.chat.id);
    if (!reviewerTelegramUserId) return;
    const dueAt = parseAlmatyDateTimeInput(match![2]);
    if (!dueAt || dueAt.getTime() <= Date.now()) {
      await bot.sendMessage(msg.chat.id, "❌ Нужна будущая дата в формате: /call_task_time TOKEN YYYY-MM-DD ЧЧ:ММ (Алматы).");
      return;
    }
    try {
      const result = await approveProposal(match![1], dueAt, reviewerTelegramUserId);
      await bot.sendMessage(msg.chat.id, resultText(result));
    } catch (error) {
      console.error("[CallTaskAutomation] Manual proposal deadline failed", {
        approvalToken: match![1],
        reason: error instanceof Error ? error.message : "unknown error",
      });
      await bot.sendMessage(msg.chat.id, "⚠️ Не удалось обработать срок. Повторная задача не отправлялась.");
    }
  });
}
