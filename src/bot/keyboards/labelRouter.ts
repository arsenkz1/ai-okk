import type TelegramBot from "node-telegram-bot-api";
import { resolveAccess, type Access } from "../access";
import { runFromButton } from "../actions/dispatch";
import { helpTextFor } from "../actions/help";
import { allActions, CANCEL_LABEL, SECTIONS, visibleActions, type SectionDefinition } from "../actions/registry";
import { pendingInput, type PendingInputService } from "../pendingInput";
import { mainMenuMarkup } from "./mainMenu";
import { EMPTY_SECTION_TEXT, sectionKeyboard, sectionTitle } from "./menuCallbacks";

/**
 * Turns the text of a reply-keyboard button back into what it stands for.
 *
 * A tap arrives as an ordinary text message, so this runs first in the text
 * handler. A button behaves like the command it stands for: it does not
 * cancel a date dialog or an AI session. Only the cancel button does that.
 */

export type LabelHit =
  | { kind: "section"; section: SectionDefinition }
  | { kind: "action"; id: string }
  | { kind: "cancel" };

export function resolveLabel(text: string): LabelHit | null {
  const label = text.trim();
  if (!label) return null;
  if (label === CANCEL_LABEL) return { kind: "cancel" };
  const section = SECTIONS.find((candidate) => candidate.label === label);
  if (section) return { kind: "section", section };
  const action = allActions().find((candidate) => !candidate.commandOnly && candidate.label === label);
  return action ? { kind: "action", id: action.id } : null;
}

export const CANCELLED_TEXT = "Bekor qilindi.";

export interface LabelRouterDependencies {
  pendingInput: Pick<PendingInputService, "cancel">;
  resolveAccess: (telegramUserId: string) => Promise<Access>;
}

export async function handleLabelHit(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  hit: LabelHit,
  deps: LabelRouterDependencies = { pendingInput, resolveAccess },
): Promise<void> {
  const chatId = msg.chat.id;
  const userId = msg.from!.id;

  if (hit.kind === "cancel") {
    await deps.pendingInput.cancel(userId);
    await bot.sendMessage(chatId, CANCELLED_TEXT);
    return;
  }

  if (hit.kind === "action") {
    await runFromButton(bot, hit.id, msg);
    return;
  }

  const access = await deps.resolveAccess(String(userId));
  if (hit.section.id === "help") {
    // "Yordam" doubles as the way to get the keyboard back.
    await bot.sendMessage(chatId, helpTextFor(access), { reply_markup: mainMenuMarkup(access) });
    return;
  }
  const keyboard = await sectionKeyboard(access, hit.section, userId);
  if (keyboard.inline_keyboard.length === 0) {
    await bot.sendMessage(chatId, `${sectionTitle(hit.section)}\n${EMPTY_SECTION_TEXT}`, { parse_mode: "HTML" });
    return;
  }
  await bot.sendMessage(chatId, sectionTitle(hit.section), { parse_mode: "HTML", reply_markup: keyboard });
}
