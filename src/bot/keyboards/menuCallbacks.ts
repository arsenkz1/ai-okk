import type TelegramBot from "node-telegram-bot-api";
import { summarizeError } from "../../services/errorSummary";
import { bold, escapeHtml } from "../../services/performanceReport";
import { resolveAccess as resolveAccessFromDb, type Access } from "../access";
import { needsMoreArgs, runFromCallback } from "../actions/dispatch";
import { getAction, SECTIONS, visibleActions, type SectionDefinition } from "../actions/registry";
import type { ActionDefinition, SectionId } from "../actions/types";
import { claimCallback as claimCallbackInRedis, claimCallbackAction as claimCallbackActionInRedis } from "../dedupe";
import { pendingInput } from "../pendingInput";

/**
 * Inline buttons of the menu: `m:<action>[:<arg>]`, `m:sec:<section>`,
 * `m:<action>:yes[:<arg>]`, `m:<action>:no`.
 *
 * Other callback handlers in the bot own other prefixes (`tl_`, `rop_`,
 * `phx:`, `admin_delete_team_`, call-task tokens); this one ignores
 * everything that is not `m:`, and they ignore `m:`.
 */

export const MENU_CALLBACK_PREFIX = "m:";
const MAX_CALLBACK_BYTES = 64;
const PART = /^[A-Za-z0-9_-]+$/;

export type MenuCallback =
  | { kind: "section"; sectionId: SectionId }
  | { kind: "cancel" }
  | { kind: "action"; actionId: string; arg: string | null; decision: "yes" | "no" | null };

export function parseMenuCallback(data: string | undefined): MenuCallback | null {
  if (!data || !data.startsWith(MENU_CALLBACK_PREFIX) || Buffer.byteLength(data) > MAX_CALLBACK_BYTES) return null;
  const parts = data.slice(MENU_CALLBACK_PREFIX.length).split(":");
  if (parts.length === 0 || parts.length > 3 || !parts.every((part) => PART.test(part))) return null;

  if (parts[0] === "cancel") return parts.length === 1 ? { kind: "cancel" } : null;

  if (parts[0] === "sec") {
    const section = SECTIONS.find((candidate) => candidate.id === parts[1]);
    return section && parts.length === 2 ? { kind: "section", sectionId: section.id } : null;
  }

  const [actionId, second, third] = parts;
  if (second === "yes") return { kind: "action", actionId, arg: third ?? null, decision: "yes" };
  if (second === "no") return parts.length === 2 ? { kind: "action", actionId, arg: null, decision: "no" } : null;
  if (parts.length === 3) return null;
  return { kind: "action", actionId, arg: second ?? null, decision: null };
}

function encode(...parts: string[]): string {
  const data = MENU_CALLBACK_PREFIX + parts.join(":");
  if (!parts.every((part) => PART.test(part)) || Buffer.byteLength(data) > MAX_CALLBACK_BYTES) {
    throw new Error(`menu callback "${data}" is not a valid callback_data`);
  }
  return data;
}

export const sectionCallback = (sectionId: SectionId): string => encode("sec", sectionId);
export { cancelCallback, cancelKeyboard } from "./cancel";
export const actionCallback = (actionId: string, arg?: string): string => (arg === undefined ? encode(actionId) : encode(actionId, arg));
export const confirmCallback = (actionId: string, decision: "yes" | "no", arg?: string): string => (
  decision === "no" || arg === undefined ? encode(actionId, decision) : encode(actionId, decision, arg)
);

const BUTTONS_PER_ROW = 2;

export function sectionKeyboard(access: Access, section: SectionDefinition, userId?: number): TelegramBot.InlineKeyboardMarkup {
  const buttons: TelegramBot.InlineKeyboardButton[] = [];
  for (const action of visibleActions(access, section.id)) {
    // A conditional button needs to know who is looking; without a user it stays hidden.
    if (action.showWhen && (userId === undefined || !action.showWhen({ userId, access }))) continue;
    if (action.variants) {
      for (const variant of action.variants) buttons.push({ text: variant.label, callback_data: actionCallback(action.id, variant.arg) });
    } else {
      buttons.push({ text: action.label, callback_data: actionCallback(action.id) });
    }
  }
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let index = 0; index < buttons.length; index += BUTTONS_PER_ROW) rows.push(buttons.slice(index, index + BUTTONS_PER_ROW));
  return { inline_keyboard: rows };
}

export function sectionTitle(section: SectionDefinition): string {
  return bold(section.label);
}

export const EMPTY_SECTION_TEXT = "Bu bo'limda siz uchun buyruqlar yo'q.";

export function confirmKeyboard(action: ActionDefinition, arg?: string): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "Ha", callback_data: confirmCallback(action.id, "yes", arg) },
      { text: "Yo'q", callback_data: confirmCallback(action.id, "no") },
    ]],
  };
}

export function confirmText(action: ActionDefinition, value?: string): string {
  return `${bold(action.label)}${value ? `: ${escapeHtml(value)}` : ""}\nTasdiqlaysizmi?`;
}

export const CONFIRM_DECLINED_TEXT = "Bekor qilindi.";
export const IN_PROGRESS_TEXT = "Bajarilmoqda…";
export const UNKNOWN_BUTTON_TEXT = "Bu tugma eskirgan.";
export const FAILED_TEXT = "Xatolik yuz berdi. Qaytadan urinib ko'ring.";

export interface MenuCallbackDependencies {
  claimCallback: (queryId: string) => Promise<boolean>;
  claimCallbackAction: (chatId: number, messageId: number, data: string) => Promise<boolean>;
  resolveAccess: (telegramUserId: string) => Promise<Access>;
  cancelPendingInput: (userId: number) => Promise<boolean>;
}

const defaultDependencies: MenuCallbackDependencies = {
  claimCallback: claimCallbackInRedis,
  claimCallbackAction: claimCallbackActionInRedis,
  resolveAccess: resolveAccessFromDb,
  cancelPendingInput: (userId) => pendingInput.cancel(userId),
};

type MenuBot = Pick<TelegramBot, "on" | "answerCallbackQuery" | "sendMessage" | "editMessageText" | "editMessageReplyMarkup">;

export function registerMenuCallbackHandler(bot: MenuBot, dependencies: Partial<MenuCallbackDependencies> = {}): void {
  const deps = { ...defaultDependencies, ...dependencies };

  bot.on("callback_query", async (query) => {
    const parsed = parseMenuCallback(query.data);
    if (!parsed) return;

    // Exactly one answer per tap, whatever happens below.
    let answered = false;
    const answer = async (options?: Partial<TelegramBot.AnswerCallbackQueryOptions>): Promise<void> => {
      if (answered) return;
      answered = true;
      await bot.answerCallbackQuery(query.id, options).catch(() => {});
    };

    try {
      if (!(await deps.claimCallback(query.id))) return await answer();
      const message = query.message;
      if (!message) return await answer({ text: UNKNOWN_BUTTON_TEXT });
      const chatId = message.chat.id;

      if (parsed.kind === "cancel") {
        await deps.cancelPendingInput(query.from.id);
        await answer();
        await bot.editMessageText(CONFIRM_DECLINED_TEXT, { chat_id: chatId, message_id: message.message_id }).catch(() => {});
        return;
      }

      const telegramUserId = String(query.from.id);
      const access = await deps.resolveAccess(telegramUserId);

      if (parsed.kind === "section") {
        const section = SECTIONS.find((candidate) => candidate.id === parsed.sectionId)!;
        const keyboard = sectionKeyboard(access, section, query.from.id);
        await answer();
        await bot.editMessageText(keyboard.inline_keyboard.length ? sectionTitle(section) : `${sectionTitle(section)}\n${EMPTY_SECTION_TEXT}`, {
          chat_id: chatId, message_id: message.message_id, parse_mode: "HTML", reply_markup: keyboard,
        });
        return;
      }

      let action: ActionDefinition;
      try {
        action = getAction(parsed.actionId);
      } catch {
        return await answer({ text: UNKNOWN_BUTTON_TEXT });
      }

      if (parsed.decision === "no") {
        await answer();
        await bot.editMessageText(CONFIRM_DECLINED_TEXT, { chat_id: chatId, message_id: message.message_id });
        return;
      }

      const args = parsed.arg === null ? [] : (action.decodeArg ? action.decodeArg(parsed.arg) : [parsed.arg]);

      // A dangerous action is confirmed once its arguments are complete, so
      // the question names what will happen; until then it keeps collecting.
      if (action.dangerous && parsed.decision !== "yes" && !needsMoreArgs(action, args)) {
        await answer();
        const label = action.confirmLabel ? action.confirmLabel(args) : (parsed.arg ?? undefined);
        await bot.sendMessage(chatId, confirmText(action, label), { parse_mode: "HTML", reply_markup: confirmKeyboard(action, parsed.arg ?? undefined) });
        return;
      }

      if (!(await deps.claimCallbackAction(chatId, message.message_id, query.data ?? ""))) {
        return await answer({ text: IN_PROGRESS_TEXT });
      }

      await answer();
      if (parsed.decision === "yes") {
        // The confirmation is spent: no second "yes" from the same card.
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: message.message_id }).catch(() => {});
      }
      await runFromCallback(bot as TelegramBot, action.id, {
        chatId,
        userId: query.from.id,
        telegramUserId,
        access,
        args,
        // The message under the button was sent by the bot, so its `from` is
        // the bot. Action bodies written for commands read the user from
        // `msg.from`; they get the person who tapped.
        message: { ...message, from: query.from },
      });
    } catch (error) {
      console.error("[MenuCallback] failed:", summarizeError(error));
      await answer({ text: FAILED_TEXT, show_alert: true });
    } finally {
      await answer();
    }
  });
}
