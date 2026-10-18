import type TelegramBot from "node-telegram-bot-api";
import type { Access, BotRole } from "../access";

/**
 * One bot action, whatever triggers it.
 *
 * A command, a reply-keyboard button and an inline button all end in the same
 * `run`. The definition carries everything the menus and `/help` need, so a
 * command and its button can never drift apart.
 */

export type SectionId = "reports" | "ai" | "team" | "company" | "phoenix" | "users" | "sync" | "help";

export type ActionSource = "command" | "button" | "callback";

export interface ActionContext {
  bot: TelegramBot;
  chatId: number;
  userId: number;
  telegramUserId: string;
  access: Access;
  /** Command capture groups, button payload or callback argument, trimmed. */
  args: string[];
  source: ActionSource;
  /** The triggering message; absent for callbacks whose message is gone. */
  message?: TelegramBot.Message;
}

export interface MenuCommand {
  /** Command name without the slash: lowercase letters, digits, underscores. */
  command: string;
  description: string;
}

export interface ActionCommand {
  pattern: RegExp;
  /** How it is typed, for `/help`: `/set_plan <amo_id> <summa>`. */
  usage: string;
  description: string;
  /**
   * Entries for Telegram's "/" menu when one pattern answers several commands
   * (`/ask_kun`, `/rating_off`). Defaults to the first word of `usage`.
   */
  menu?: MenuCommand[];
}

export interface ActionDefinition {
  /** Stable identifier; for commands it is the command name without the slash. */
  id: string;
  section: SectionId;
  /**
   * Roles that may run it. Every active linked manager holds `manager`, so
   * `["admin", "manager"]` means "anyone linked, plus admins". An empty list
   * means no check at all (usage hints).
   */
  roles: BotRole[];
  /** Button caption. */
  label: string;
  command?: ActionCommand;
  /** Stays a command; never placed on a keyboard. */
  commandOnly?: boolean;
  /** Needs a yes/no confirmation before `run` when triggered from a button. */
  dangerous?: boolean;
  /**
   * Denial text for a caller without the role; a function may pick it from
   * the caller's state. Otherwise the text is chosen by link state.
   */
  denyText?: string | ((access: Access) => string);
  run(ctx: ActionContext): Promise<void>;
}
