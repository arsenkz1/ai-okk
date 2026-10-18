import type TelegramBot from "node-telegram-bot-api";
import { resolveAccess as resolveAccessFromDb, type Access } from "../access";
import { defineInputHandler, type InputContext } from "../inputHandlers";
import { cancelKeyboard } from "../keyboards/cancel";
import { confirmKeyboard, confirmText } from "../keyboards/menuCallbacks";
import type { PendingInputKind } from "../pendingInput";
import { runFromInput } from "./dispatch";
import { getAction } from "./registry";

/**
 * Answers to the simple questions: an id typed as text. The answer is checked
 * against the same shape the command accepts, then handed to the action that
 * asked. A dangerous action is confirmed with the value in the button, so the
 * confirmation is about something concrete.
 */

const flowDeps: { resolveAccess: (telegramUserId: string) => Promise<Access> } = { resolveAccess: resolveAccessFromDb };

/** Tests replace the database lookup. */
export function configureInputFlows(overrides: Partial<typeof flowDeps>): void {
  Object.assign(flowDeps, overrides);
}

export async function dispatchAnswer(ctx: InputContext, value: string): Promise<void> {
  const actionId = String(ctx.input.payload.action ?? "");
  const action = getAction(actionId);
  const access = await flowDeps.resolveAccess(ctx.telegramUserId);
  if (action.dangerous) {
    await ctx.bot.sendMessage(ctx.chatId, confirmText(action, value), { parse_mode: "HTML", reply_markup: confirmKeyboard(action, value) });
    return;
  }
  await runFromInput(ctx.bot as TelegramBot, action.id, {
    chatId: ctx.chatId,
    userId: ctx.userId,
    telegramUserId: ctx.telegramUserId,
    access,
    args: [value],
    message: ctx.msg,
  });
}

export const ID_INPUT_RULES: Record<Extract<PendingInputKind, "deal_id" | "lead_id" | "telegram_id">, { pattern: RegExp; errorText: string }> = {
  deal_id: { pattern: /^\d{4,12}$/, errorText: "Bitim ID faqat raqamlardan iborat bo'ladi, masalan: 26199367. Qaytadan yuboring." },
  lead_id: { pattern: /^\d{4,12}$/, errorText: "Bitim ID faqat raqamlardan iborat bo'ladi, masalan: 26199367. Qaytadan yuboring." },
  telegram_id: { pattern: /^\d{5,15}$/, errorText: "Telegram ID faqat raqamlardan iborat bo'ladi, masalan: 295612129. Qaytadan yuboring." },
};

for (const [kind, rule] of Object.entries(ID_INPUT_RULES) as Array<[keyof typeof ID_INPUT_RULES, { pattern: RegExp; errorText: string }]>) {
  defineInputHandler(kind, async (ctx) => {
    const value = ctx.text.trim();
    if (!rule.pattern.test(value)) {
      // The question stays open: the user just types again.
      await ctx.bot.sendMessage(ctx.chatId, rule.errorText, { reply_markup: cancelKeyboard() });
      return;
    }
    await ctx.pending.cancel(ctx.userId);
    await dispatchAnswer(ctx, value);
  });
}
