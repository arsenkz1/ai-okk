import type TelegramBot from "node-telegram-bot-api";
import { resolveAccess, type Access } from "../access";
import { claimUpdate } from "../dedupe";
import { cancelKeyboard } from "../keyboards/cancel";
import { pendingInput as defaultPendingInput, type PendingInputService } from "../pendingInput";
import { summarizeError } from "../../services/errorSummary";
import { getAction, isAllowed } from "./registry";
import type { ActionContext, ActionDefinition } from "./types";

/**
 * Runs an action for a Telegram update: deduplicates, resolves who is asking,
 * checks the role once, then calls `run`. Every trigger goes through here.
 */

const dispatchDeps: {
  pendingInput: PendingInputService;
  resolveAccess: (telegramUserId: string) => Promise<Access>;
  claimUpdate: (chatId: number, messageId: number) => Promise<boolean>;
} = { pendingInput: defaultPendingInput, resolveAccess, claimUpdate };

/** Tests swap the Redis-backed question store and the database lookup for fakes. */
export function configureDispatch(overrides: Partial<typeof dispatchDeps>): void {
  Object.assign(dispatchDeps, overrides);
}

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

/** `<…>` placeholders in the usage line are the arguments a run cannot do without. */
export function requiredArgCount(usage: string): number {
  return (usage.match(/<[^>]+>/g) ?? []).length;
}

export function usageText(action: ActionDefinition): string {
  return `Foydalanish: ${action.command?.usage ?? `/${action.id}`}`;
}

/** True while a non-command trigger has fewer arguments than the command needs. */
export function needsMoreArgs(action: ActionDefinition, args: readonly string[]): boolean {
  return action.command !== undefined && args.length < requiredArgCount(action.command.usage);
}

export async function execute(action: ActionDefinition, ctx: ActionContext): Promise<void> {
  if (!isAllowed(action, ctx.access)) {
    await ctx.bot.sendMessage(ctx.chatId, denialText(action, ctx.access));
    return;
  }
  // A command always arrives with its arguments matched; a button may not.
  // An action with a multi-step collector lets it decide; one that knows the
  // single value to ask for asks; any other answers with the usage line
  // instead of running on an empty argument.
  if (ctx.source !== "command") {
    if (action.collect) {
      if ((await action.collect(ctx)) === "waiting") return;
    } else if (needsMoreArgs(action, ctx.args)) {
      if (action.input) {
        await ctx.pending.expect(ctx.userId, action.input.kind, { action: action.id });
        await ctx.bot.sendMessage(ctx.chatId, action.input.prompt, { reply_markup: cancelKeyboard() });
        return;
      }
      await ctx.bot.sendMessage(ctx.chatId, usageText(action));
      return;
    }
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
  if (!(await dispatchDeps.claimUpdate(msg.chat.id, msg.message_id))) return;
  const action = getAction(actionId);
  const telegramUserId = String(msg.from!.id);
  const access = await dispatchDeps.resolveAccess(telegramUserId);
  await execute(action, {
    bot,
    chatId: msg.chat.id,
    userId: msg.from!.id,
    telegramUserId,
    access,
    args: commandArgs(match),
    source: "command",
    message: msg,
    pending: dispatchDeps.pendingInput,
  });
}

/**
 * A reply-keyboard tap. The message handler has already deduplicated the
 * update, so this must not claim it again.
 */
export async function runFromButton(
  bot: TelegramBot,
  actionId: string,
  msg: TelegramBot.Message,
  args: string[] = [],
): Promise<void> {
  const action = getAction(actionId);
  const telegramUserId = String(msg.from!.id);
  const access = await dispatchDeps.resolveAccess(telegramUserId);
  await execute(action, {
    bot,
    chatId: msg.chat.id,
    userId: msg.from!.id,
    telegramUserId,
    access,
    args,
    source: "button",
    message: msg,
    pending: dispatchDeps.pendingInput,
  });
}

export interface CallbackRunParams {
  chatId: number;
  userId: number;
  telegramUserId: string;
  access: Access;
  args: string[];
  message?: TelegramBot.Message;
}

/** An inline-button tap. Access is resolved by the caller, which also answers the query. */
export async function runFromCallback(bot: TelegramBot, actionId: string, params: CallbackRunParams): Promise<void> {
  await execute(getAction(actionId), { bot, source: "callback", pending: dispatchDeps.pendingInput, ...params });
}

/** The typed answer to a question an action asked. */
export async function runFromInput(bot: TelegramBot, actionId: string, params: CallbackRunParams): Promise<void> {
  await execute(getAction(actionId), { bot, source: "input", pending: dispatchDeps.pendingInput, ...params });
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
