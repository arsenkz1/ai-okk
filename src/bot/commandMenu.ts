import type TelegramBot from "node-telegram-bot-api";
import { prisma } from "../config/database";
import { summarizeError } from "../services/errorSummary";
import { resolveAccess, type Access } from "./access";
import { allActions, getAction, isAllowed, SECTIONS } from "./actions/registry";
import type { ActionDefinition, MenuCommand } from "./actions/types";

/**
 * Telegram's "/" menu, per chat and per role.
 *
 * The list is built from the action registry, so it cannot drift from what
 * the bot actually answers to. Telegram caches it on the client; it is set
 * when a user starts, links an account or changes role.
 */

const COMMAND_NAME = /^[a-z0-9_]{1,32}$/;
const MAX_DESCRIPTION = 256;
const MAX_COMMANDS = 100;

type MenuBot = Pick<TelegramBot, "setMyCommands">;

function menuEntries(action: ActionDefinition): MenuCommand[] {
  const command = action.command;
  if (!command) return [];
  if (command.menu) return command.menu;
  return [{ command: command.usage.split(/\s+/)[0].replace(/^\//, ""), description: command.description }];
}

const sectionOrder = new Map(SECTIONS.map((section, index) => [section.id, index]));

/** What a user with this access sees after typing "/". */
export function commandMenuFor(access: Access): MenuCommand[] {
  // An unlinked account can only start and read the help.
  const actions = access.roles.size === 0
    ? [getAction("start"), getAction("help")]
    : allActions()
      .filter((action) => action.command && !action.commandOnly && isAllowed(action, access))
      .sort((left, right) => (sectionOrder.get(left.section) ?? 0) - (sectionOrder.get(right.section) ?? 0));

  const seen = new Set<string>();
  const menu: MenuCommand[] = [];
  for (const action of actions) {
    for (const entry of menuEntries(action)) {
      if (seen.has(entry.command)) continue;
      if (!COMMAND_NAME.test(entry.command)) {
        console.warn(`[CommandMenu] skipping "${entry.command}" of ${action.id}: not a valid Telegram command name`);
        continue;
      }
      seen.add(entry.command);
      menu.push({ command: entry.command, description: entry.description.slice(0, MAX_DESCRIPTION) });
    }
  }
  return menu.slice(0, MAX_COMMANDS);
}

/** Sets the menu for one private chat. Never throws: a menu is a courtesy. */
export async function syncCommandMenu(bot: MenuBot, chatId: number, access: Access): Promise<boolean> {
  try {
    await bot.setMyCommands(commandMenuFor(access), { scope: { type: "chat", chat_id: chatId } });
    return true;
  } catch (error) {
    console.warn(`[CommandMenu] sync failed for chat ${chatId}:`, summarizeError(error));
    return false;
  }
}

/** A private chat's id is the user's Telegram id. */
export async function syncCommandMenuForTelegramUser(bot: MenuBot, telegramUserId: string): Promise<boolean> {
  const chatId = Number(telegramUserId);
  if (!Number.isSafeInteger(chatId)) return false;
  return syncCommandMenu(bot, chatId, await resolveAccess(telegramUserId));
}

/** After a role change made by someone else: find the manager's linked chat. */
export async function syncCommandMenuForManager(bot: MenuBot, managerId: number): Promise<boolean> {
  const link = await prisma.telegramLink.findFirst({
    where: { managerId, status: "used" },
    select: { telegramUserId: true },
  });
  if (!link?.telegramUserId) return false;
  return syncCommandMenuForTelegramUser(bot, link.telegramUserId);
}

/** The default scope: what a chat sees before it has its own menu. */
export const DEFAULT_MENU_ACCESS: Access = Object.freeze({
  telegramUserId: "",
  isAdmin: false,
  manager: null,
  roles: new Set(["manager"] as const),
});

export async function installDefaultCommandMenu(bot: MenuBot): Promise<boolean> {
  try {
    await bot.setMyCommands(commandMenuFor(DEFAULT_MENU_ACCESS), { scope: { type: "default" } });
    return true;
  } catch (error) {
    console.warn("[CommandMenu] default menu failed:", summarizeError(error));
    return false;
  }
}
