import type TelegramBot from "node-telegram-bot-api";
import { resolveAccess, type Access } from "../access";
import { claimUpdate } from "../dedupe";
import { summarizeError } from "../../services/errorSummary";
import { getAction, isAllowed } from "./registry";
import type { ActionContext, ActionDefinition } from "./types";

/**
 * Runs an action for a Telegram update: deduplicates, resolves who is asking,
 * checks the role once, then calls `run`. Every trigger goes through here.
 */

export const NOT_LINKED_TEXT = "❌ Siz avtorizatsiya qilinmagansiz.\n/start kiriting va 6 xonali kodingizni yuboring.";
export const DEACTIVATED_TEXT = "❌ Hisobingiz deaktivlashtirilgan. Administratorga murojaat qiling.";
export const NO_RIGHTS_TEXT = "❌ Sizda bu buyruq uchun huquq yo'q.";

export function denialText(action: ActionDefinition, access: Access): string {
  const custom = typeof action.denyText === "function" ? action.denyText(access) : action.denyText;
  if (custom) return custom;
  if (!access.manager) return NOT_LINKED_TEXT;
  if (!access.manager.isActive) return DEACTIVATED_TEXT;
  return NO_RIGHTS_TEXT;
}

export async function execute(action: ActionDefinition, ctx: ActionContext): Promise<void> {
  if (!isAllowed(action, ctx.access)) {
    await ctx.bot.sendMessage(ctx.chatId, denialText(action, ctx.access));
    return;
  }
  await action.run(ctx);
}

function commandArgs(match: RegExpExecArray | null | undefined): string[] {
  return (match ?? []).slice(1).filter((part): part is string => typeof part === "string").map((part) => part.trim());
}

export async function runCommand(
  bot: TelegramBot,
  actionId: string,
  msg: TelegramBot.Message,
  match: RegExpExecArray | null | undefined,
): Promise<void> {
  if (!(await claimUpdate(msg.chat.id, msg.message_id))) return;
  const action = getAction(actionId);
  const telegramUserId = String(msg.from!.id);
  const access = await resolveAccess(telegramUserId);
  await execute(action, {
    bot,
    chatId: msg.chat.id,
    userId: msg.from!.id,
    telegramUserId,
    access,
    args: commandArgs(match),
    source: "command",
    message: msg,
  });
}

/** Registers the command pattern of each listed action on the bot. */
export function registerCommandActions(bot: Pick<TelegramBot, "onText">, ids: readonly string[]): void {
  for (const id of ids) {
    const action = getAction(id);
    if (!action.command) throw new Error(`bot action "${id}" has no command to register`);
    bot.onText(action.command.pattern, (msg, match) => {
      void runCommand(bot as TelegramBot, id, msg, match).catch((error) => {
        console.error(`[BotAction] ${id} failed:`, summarizeError(error));
      });
    });
  }
}
