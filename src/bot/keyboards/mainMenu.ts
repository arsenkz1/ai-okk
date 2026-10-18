import type TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import { summarizeError } from "../../services/errorSummary";
import { hasRole, resolveAccess, type Access } from "../access";
import { SECTIONS, visibleActions, type SectionDefinition } from "../actions/registry";

/**
 * The persistent reply keyboard: one button per section the user may open.
 *
 * It is attached to the messages a user gets at the moments their role is
 * known or has just changed: /start, a successful code link, a role change.
 * Behind `BOT_KEYBOARDS_ENABLED`; while the flag is off every such message
 * carries `remove_keyboard` instead, which is how the rollout is undone.
 */

const ENABLED_VALUES = new Set(["true", "1", "yes", "on"]);

export function keyboardsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ENABLED_VALUES.has((env.BOT_KEYBOARDS_ENABLED ?? "").trim().toLowerCase());
}

/** Sections this user may open, in menu order; empty sections are hidden. */
export function mainMenuSections(access: Access): SectionDefinition[] {
  return SECTIONS.filter((section) => (
    (section.roles.length === 0 || hasRole(access, ...section.roles))
    && visibleActions(access, section.id).length > 0
  ));
}

export const DASHBOARD_LABEL = "Dashboard";
export const DEFAULT_DASHBOARD_URL = "https://qadam-dogovor.uz/reports/tg/";

/** The admin dashboard, opened as a Telegram Mini App from the keyboard. */
export function dashboardUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ADMIN_DASHBOARD_URL?.trim();
  return configured && /^https:\/\//.test(configured) ? configured : DEFAULT_DASHBOARD_URL;
}

export function buildMainMenu(access: Access, env: NodeJS.ProcessEnv = process.env): TelegramBot.ReplyKeyboardMarkup {
  const sections = mainMenuSections(access);
  const body = sections.filter((section) => section.id !== "help");
  const help = sections.find((section) => section.id === "help");

  const keyboard: TelegramBot.KeyboardButton[][] = [];
  // Administrators get the dashboard first, on its own row: a Mini App button
  // opens the page inside Telegram and sends no text, so the router never
  // sees it.
  if (access.isAdmin) keyboard.push([{ text: DASHBOARD_LABEL, web_app: { url: dashboardUrl(env) } }]);
  for (let index = 0; index < body.length; index += 2) {
    keyboard.push(body.slice(index, index + 2).map((section) => ({ text: section.label })));
  }
  if (help) keyboard.push([{ text: help.label }]);

  return { keyboard, resize_keyboard: true, is_persistent: true };
}

export type MainMenuMarkup = TelegramBot.ReplyKeyboardMarkup | TelegramBot.ReplyKeyboardRemove;

/** What to attach to a message: the menu, or an order to drop any old keyboard. */
export function mainMenuMarkup(access: Access, enabled: boolean = keyboardsEnabled()): MainMenuMarkup {
  if (!enabled || access.roles.size === 0) return { remove_keyboard: true };
  return buildMainMenu(access);
}

export const ROLE_CHANGED_TEXT = "Rolingiz yangilandi, menyu ham yangilandi.";

type MenuBot = Pick<TelegramBot, "sendMessage">;

/** Sends a message carrying the menu; a Telegram error is logged, not thrown. */
export async function sendMainMenu(bot: MenuBot, chatId: number, access: Access, text: string): Promise<boolean> {
  try {
    await bot.sendMessage(chatId, text, { reply_markup: mainMenuMarkup(access) });
    return true;
  } catch (error) {
    console.warn(`[MainMenu] send failed for chat ${chatId}:`, summarizeError(error));
    return false;
  }
}

/**
 * After someone else changed this user's role. Only with keyboards on: a
 * keyboard can only travel with a message, and no message is sent otherwise.
 */
export async function refreshMainMenuForTelegramUser(bot: MenuBot, telegramUserId: string, text = ROLE_CHANGED_TEXT): Promise<boolean> {
  if (!keyboardsEnabled()) return false;
  const chatId = Number(telegramUserId);
  if (!Number.isSafeInteger(chatId)) return false;
  return sendMainMenu(bot, chatId, await resolveAccess(telegramUserId), text);
}

export async function refreshMainMenuForManager(bot: MenuBot, managerId: number, text = ROLE_CHANGED_TEXT): Promise<boolean> {
  if (!keyboardsEnabled()) return false;
  const link = await prisma.telegramLink.findFirst({
    where: { managerId, status: "used" },
    select: { telegramUserId: true },
  });
  if (!link?.telegramUserId) return false;
  return refreshMainMenuForTelegramUser(bot, link.telegramUserId, text);
}
