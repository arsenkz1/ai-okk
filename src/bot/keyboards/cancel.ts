import type TelegramBot from "node-telegram-bot-api";
import { CANCEL_LABEL } from "../actions/registry";

/** `m:cancel`: drops the question the bot is waiting on. */
export const CANCEL_CALLBACK = "m:cancel";

export const cancelCallback = (): string => CANCEL_CALLBACK;

/** Under every question the bot asks: one button that drops the question. */
export function cancelKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: CANCEL_LABEL, callback_data: CANCEL_CALLBACK }]] };
}
