import type TelegramBot from "node-telegram-bot-api";
import { pendingInput as defaultPendingInput, type PendingInput, type PendingInputKind, type PendingInputService, type PendingLookup } from "./pendingInput";

/**
 * What to do with a text message that answers a pending question. Each input
 * kind has one handler, defined next to the action that asks the question.
 */

export interface InputContext {
  bot: TelegramBot;
  msg: TelegramBot.Message;
  chatId: number;
  userId: number;
  telegramUserId: string;
  text: string;
  input: PendingInput;
  pending: PendingInputService;
}

export type InputHandler = (ctx: InputContext) => Promise<void>;

const handlers = new Map<PendingInputKind, InputHandler>();

export function defineInputHandler(kind: PendingInputKind, handler: InputHandler): void {
  if (handlers.has(kind)) throw new Error(`input handler for "${kind}" is defined twice`);
  handlers.set(kind, handler);
}

export function hasInputHandler(kind: PendingInputKind): boolean {
  return handlers.has(kind);
}

export const INPUT_EXPIRED_TEXT = "Vaqt tugadi. Tugmani qaytadan bosing.";

/**
 * Routes the message to the handler of the pending kind. Returns false when
 * the message was not consumed and the text handler should go on.
 */
export async function handlePendingInput(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  lookup: PendingLookup,
  pending: PendingInputService = defaultPendingInput,
): Promise<boolean> {
  if (lookup.state === "none") return false;
  const chatId = msg.chat.id;
  if (lookup.state === "expired") {
    await bot.sendMessage(chatId, INPUT_EXPIRED_TEXT);
    return true;
  }
  const handler = handlers.get(lookup.input.kind);
  const userId = msg.from!.id;
  if (!handler) {
    console.error(`[PendingInput] no handler for kind "${lookup.input.kind}"; dropping it`);
    await pending.cancel(userId);
    return false;
  }
  await handler({
    bot,
    msg,
    chatId,
    userId,
    telegramUserId: String(userId),
    text: msg.text ?? "",
    input: lookup.input,
    pending,
  });
  return true;
}
