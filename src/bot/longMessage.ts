import TelegramBot from "node-telegram-bot-api";

/**
 * Splits a message across Telegram's per-message limit.
 *
 * The deal summary carries every filled field and note text, so it routinely
 * exceeds one message. Splitting happens on line boundaries where possible: a
 * cut through the middle of a field value would be unreadable.
 */

export const TELEGRAM_MESSAGE_LIMIT = 4096;

export function splitTelegramMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return text.length > 0 ? [text] : [];

  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of text.split("\n")) {
    // A single line longer than the limit has no line boundary to use, so it is
    // cut at the limit rather than dropped.
    if (line.length > limit) {
      flush();
      for (let offset = 0; offset < line.length; offset += limit) {
        chunks.push(line.slice(offset, offset + limit));
      }
      continue;
    }
    if (current.length + line.length + 1 > limit) flush();
    current = current.length > 0 ? `${current}\n${line}` : line;
  }

  flush();
  return chunks;
}

export async function sendLongMessage(
  bot: Pick<TelegramBot, "sendMessage">,
  chatId: TelegramBot.ChatId,
  text: string,
  options?: TelegramBot.SendMessageOptions,
): Promise<void> {
  for (const chunk of splitTelegramMessage(text)) {
    await bot.sendMessage(chatId, chunk, options ?? {});
  }
}
