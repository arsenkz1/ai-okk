import type TelegramBot from "node-telegram-bot-api";

/**
 * The admin dashboard, opened as a Telegram Mini App. It sits in the
 * "Hisobotlar" section as an inline button for administrators only.
 */

export const DASHBOARD_LABEL = "Dashboard";
export const DEFAULT_DASHBOARD_URL = "https://qadam-dogovor.uz/reports/tg/";

export function dashboardUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ADMIN_DASHBOARD_URL?.trim();
  return configured && /^https:\/\//.test(configured) ? configured : DEFAULT_DASHBOARD_URL;
}

/** A Mini App button opens the page inside Telegram and sends no callback. */
export function dashboardInlineButton(env: NodeJS.ProcessEnv = process.env): TelegramBot.InlineKeyboardButton {
  return { text: DASHBOARD_LABEL, web_app: { url: dashboardUrl(env) } };
}
