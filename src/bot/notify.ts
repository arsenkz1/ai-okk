import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../config/database";

// Lazy singleton — создаём бота без polling только для отправки сообщений.
// Основной polling-экземпляр живёт в bot/index.ts.
let notifyBot: TelegramBot | null = null;

function getNotifyBot(): TelegramBot | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  if (!notifyBot) {
    notifyBot = new TelegramBot(token, { polling: false });
  }
  return notifyBot;
}

export async function notifyAdminsWithFile(
  caption: string,
  content: string,
  filename: string
): Promise<void> {
  const bot = getNotifyBot();
  if (!bot) return;

  const ids: string[] = [];
  if (process.env.ADMIN_TELEGRAM_ID) ids.push(process.env.ADMIN_TELEGRAM_ID);
  const dbAdmins = await prisma.botAdmin.findMany({ select: { telegramUserId: true } });
  for (const a of dbAdmins) {
    if (!ids.includes(a.telegramUserId)) ids.push(a.telegramUserId);
  }

  const buffer = Buffer.from(content, "utf-8");
  for (const id of ids) {
    try {
      await bot.sendDocument(id, buffer, { caption, parse_mode: "HTML" }, { filename, contentType: "text/plain" });
    } catch (err: any) {
      console.error(`[Bot] notifyAdminsWithFile failed for ${id}:`, err.message);
    }
  }
}

export async function notifyAdmins(text: string): Promise<void> {
  const bot = getNotifyBot();
  if (!bot) return;

  const ids: string[] = [];

  if (process.env.ADMIN_TELEGRAM_ID) {
    ids.push(process.env.ADMIN_TELEGRAM_ID);
  }

  const dbAdmins = await prisma.botAdmin.findMany({ select: { telegramUserId: true } });
  for (const a of dbAdmins) {
    if (!ids.includes(a.telegramUserId)) ids.push(a.telegramUserId);
  }

  for (const id of ids) {
    try {
      await bot.sendMessage(id, text);
    } catch (err: any) {
      console.error(`[Bot] notifyAdmins failed for ${id}:`, err.message);
    }
  }
}
