import type TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import { summarizeError } from "../../services/errorSummary";
import { hasRole, resolveAccess, type Access, type BotRole } from "../access";
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
const KNOWN_ROLES: ReadonlySet<BotRole> = new Set<BotRole>(["admin", "rop", "teamlead", "manager"]);

/** The global switch: `BOT_KEYBOARDS_ENABLED`. */
export function keyboardsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ENABLED_VALUES.has((env.BOT_KEYBOARDS_ENABLED ?? "").trim().toLowerCase());
}

/**
 * `BOT_KEYBOARDS_ROLES`: a staged rollout. When set, only users holding one of
 * the listed roles get the keyboard; the rest keep commands until the list
 * grows. Empty or unset means everyone.
 */
export function keyboardRolloutRoles(env: NodeJS.ProcessEnv = process.env): Set<BotRole> | null {
  const raw = (env.BOT_KEYBOARDS_ROLES ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const roles = new Set(raw.filter((part): part is BotRole => KNOWN_ROLES.has(part as BotRole)));
  return roles.size > 0 ? roles : null;
}

/** Whether this user gets the keyboard right now. */
export function keyboardsEnabledFor(access: Access, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!keyboardsEnabled(env) || access.roles.size === 0) return false;
  const rollout = keyboardRolloutRoles(env);
  return rollout === null || hasRole(access, ...rollout);
}

/** Sections this user may open, in menu order; empty sections are hidden. */
export function mainMenuSections(access: Access): SectionDefinition[] {
  return SECTIONS.filter((section) => (
    (section.roles.length === 0 || hasRole(access, ...section.roles))
    && visibleActions(access, section.id).length > 0
  ));
}

export function buildMainMenu(access: Access): TelegramBot.ReplyKeyboardMarkup {
  const sections = mainMenuSections(access);
  const body = sections.filter((section) => section.id !== "help");
  const help = sections.find((section) => section.id === "help");

  const keyboard: TelegramBot.KeyboardButton[][] = [];
  for (let index = 0; index < body.length; index += 2) {
    keyboard.push(body.slice(index, index + 2).map((section) => ({ text: section.label })));
  }
  if (help) keyboard.push([{ text: help.label }]);

  return { keyboard, resize_keyboard: true, is_persistent: true };
}

export type MainMenuMarkup = TelegramBot.ReplyKeyboardMarkup | TelegramBot.ReplyKeyboardRemove;

/** What to attach to a message: the menu, or an order to drop any old keyboard. */
export function mainMenuMarkup(access: Access, enabled: boolean = keyboardsEnabledFor(access)): MainMenuMarkup {
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
  const access = await resolveAccess(telegramUserId);
  // A role change may move the user into or out of the rollout; either way
  // the message carries the right markup (menu or removal).
  return sendMainMenu(bot, chatId, access, text);
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
