import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../config/database";
import { installSafeTelegramSender } from "./safeTelegram";

// Lazy singleton — создаём бота без polling только для отправки сообщений.
// Основной polling-экземпляр живёт в bot/index.ts.
let notifyBot: TelegramBot | null = null;

function getNotifyBot(): TelegramBot | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  if (!notifyBot) {
    notifyBot = installSafeTelegramSender(new TelegramBot(token, { polling: false }));
  }
  return notifyBot;
}

/**
 * Who gets a given admin notification.
 *
 * "primary" is the default: technical and diagnostic messages go only to the
 * operator who maintains the system. "all" is for the notifications every
 * administrator asked to see — whether a deal moved, and the daily reports.
 */
export type AdminAudience = "primary" | "all";

/** Falls back to the agreed operator ID when the variable is not configured. */
export const DEFAULT_PRIMARY_ADMIN_TELEGRAM_IDS = Object.freeze(["295612129"]);

export function resolvePrimaryAdminIds(
  environment: Record<string, string | undefined> = process.env,
): string[] {
  const configured = environment.PRIMARY_ADMIN_TELEGRAM_IDS?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return configured?.length ? configured : [...DEFAULT_PRIMARY_ADMIN_TELEGRAM_IDS];
}

async function allAdminIds(): Promise<string[]> {
  const ids: string[] = [];
  if (process.env.ADMIN_TELEGRAM_ID) ids.push(process.env.ADMIN_TELEGRAM_ID);
  const dbAdmins = await prisma.botAdmin.findMany({ select: { telegramUserId: true } });
  for (const admin of dbAdmins) {
    if (!ids.includes(admin.telegramUserId)) ids.push(admin.telegramUserId);
  }
  return ids;
}

/**
 * Resolves the recipient list. A primary admin who is not registered as a bot
 * admin still receives primary notifications: the list is the audience itself,
 * not a filter over registered admins.
 */
export async function adminRecipients(audience: AdminAudience): Promise<string[]> {
  if (audience === "all") return allAdminIds();
  return resolvePrimaryAdminIds();
}

export async function notifyAdminsWithFile(
  caption: string,
  content: string,
  filename: string,
  audience: AdminAudience = "primary"
): Promise<void> {
  const bot = getNotifyBot();
  if (!bot) return;

  const ids = await adminRecipients(audience);
  const buffer = Buffer.from(content, "utf-8");
  for (const id of ids) {
    try {
      await bot.sendDocument(id, buffer, { caption, parse_mode: "HTML" }, { filename, contentType: "text/plain" });
    } catch (err: any) {
      console.error(`[Bot] notifyAdminsWithFile failed for ${id}:`, err.message);
    }
  }
}

/**
 * Defaults to the primary audience on purpose: every existing diagnostic call
 * site becomes operator-only without being touched, and only the notifications
 * explicitly marked "all" reach every administrator.
 */
export async function notifyAdmins(text: string, audience: AdminAudience = "primary"): Promise<void> {
  const bot = getNotifyBot();
  if (!bot) return;

  const ids = await adminRecipients(audience);

  for (const id of ids) {
    try {
      await bot.sendMessage(id, text);
    } catch (err: any) {
      console.error(`[Bot] notifyAdmins failed for ${id}:`, err.message);
    }
  }
}
