import TelegramBot from "node-telegram-bot-api";

export type SendMessageFn = (
  chatId: TelegramBot.ChatId,
  text: string,
  options?: TelegramBot.SendMessageOptions
) => Promise<TelegramBot.Message>;

type ParseModeOptions = { parse_mode?: unknown };

function getErrorText(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const anyErr = err as {
    message?: unknown;
    code?: unknown;
    response?: { body?: { description?: unknown } };
  };
  return [
    anyErr.code,
    anyErr.message,
    anyErr.response?.body?.description,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

export function isTelegramParseError(err: unknown): boolean {
  const text = getErrorText(err).toLowerCase();
  return (
    text.includes("etelegram") &&
    (text.includes("can't parse entities") ||
      text.includes("can't parse message text") ||
      text.includes("parse entities"))
  );
}

function withoutParseMode<T extends ParseModeOptions>(options?: T): T | undefined {
  if (!options || options.parse_mode === undefined) return options;
  const fallbackOptions = { ...options };
  delete fallbackOptions.parse_mode;
  return fallbackOptions;
}

export async function sendTelegramMessageSafely(
  sendMessage: SendMessageFn,
  chatId: TelegramBot.ChatId,
  text: string,
  options?: TelegramBot.SendMessageOptions
): Promise<TelegramBot.Message> {
  try {
    return await sendMessage(chatId, text, options);
  } catch (err) {
    if (options?.parse_mode && isTelegramParseError(err)) {
      console.warn(
        `[Bot] Telegram parse_mode=${options.parse_mode} failed; retrying message without parse_mode: ${getErrorText(err)}`
      );
      return sendMessage(chatId, text, withoutParseMode(options));
    }

    throw err;
  }
}

export function installSafeTelegramSender(bot: TelegramBot): TelegramBot {
  const patchedBot = bot as TelegramBot & { __safeTelegramSenderInstalled?: boolean };
  if (patchedBot.__safeTelegramSenderInstalled) return bot;

  const rawSendMessage = bot.sendMessage.bind(bot) as SendMessageFn;
  patchedBot.sendMessage = ((chatId, text, options) =>
    sendTelegramMessageSafely(rawSendMessage, chatId, text, options)) as TelegramBot["sendMessage"];

  patchedBot.__safeTelegramSenderInstalled = true;
  return patchedBot;
}
