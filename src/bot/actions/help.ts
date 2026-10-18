import { hasRole, type Access } from "../access";
import { awaitingCode } from "../state";
import { syncCommandMenu } from "../commandMenu";
import { keyboardsEnabledFor, mainMenuMarkup, mainMenuSections } from "../keyboards/mainMenu";
import { allActions, defineAction, isAllowed, visibleActions } from "./registry";
import type { ActionDefinition } from "./types";

/**
 * /start and /help. Help is generated from the action registry; the start
 * greeting adapts to whether the keyboard is on.
 */

export const UNLINKED_HELP_TEXT = `ℹ️ Botga kirish uchun /start kiriting va ko'rsatmalarni bajaring.`;
export const COMMAND_ONLY_HEADER = "Faqat buyruq bilan:";
export const KEYBOARD_HINT = "Pastdagi menyu tugmalari shu buyruqlarni ochadi.";

export function helpHeader(access: Access): string {
  if (access.isAdmin) return "🔑 Administrator buyruqlari";
  if (hasRole(access, "rop")) return "📈 ROP buyruqlari";
  if (hasRole(access, "teamlead")) return "👥 TeamLead buyruqlari";
  return "📋 Mavjud buyruqlar";
}

function buttonNames(action: ActionDefinition): string {
  return action.variants?.length ? action.variants.map((variant) => variant.label).join(", ") : action.label;
}

/** `/cmd - description` for each command the action answers to. */
export function commandLines(action: ActionDefinition, keyboards: boolean): string[] {
  const command = action.command;
  if (!command) return [];
  const lines = command.menu
    ? command.menu.map((entry) => `/${entry.command} - ${entry.description}`)
    : [`${command.usage} - ${command.description}`];
  if (keyboards && !action.commandOnly) lines[0] += ` (tugma: ${buttonNames(action)})`;
  return lines;
}

/**
 * Help is built from the registry, so it lists exactly what this user may
 * run: sections with their commands, then the commands that have no button.
 */
export function helpTextFor(access: Access, keyboards: boolean = keyboardsEnabledFor(access)): string {
  if (access.roles.size === 0) return UNLINKED_HELP_TEXT;

  const lines: string[] = [helpHeader(access), ""];
  if (keyboards) lines.push(KEYBOARD_HINT, "");

  for (const section of mainMenuSections(access)) {
    const actions = visibleActions(access, section.id).filter((action) => action.command && !action.helpHidden);
    if (actions.length === 0) continue;
    lines.push(`${section.label}:`);
    for (const action of actions) lines.push(...commandLines(action, keyboards));
    lines.push("");
  }

  const commandOnly = allActions().filter((action) => (
    action.commandOnly && action.command && !action.helpHidden && isAllowed(action, access)
  ));
  if (commandOnly.length > 0) {
    lines.push(COMMAND_ONLY_HEADER);
    for (const action of commandOnly) lines.push(...commandLines(action, false));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export const START_ADMIN_TEXT = `👋 Salom, Admin!\n\nBarcha buyruqlarni ko'rish uchun /help kiriting.`;
export const START_CODE_PROMPT_TEXT =
  `👋 Salom!\n\nBoshlash uchun 6 xonali kodni kiriting.\nUni menejerlar jadvalidan topishingiz mumkin (rahbaringizdan so'rang).`;

export function startManagerText(name: string, keyboards: boolean): string {
  // With the keyboard on screen the greeting points at it; without it the
  // historical command list stays.
  if (keyboards) return `👋 Salom, ${name}!\n\nPastdagi menyudan kerakli bo'limni tanlang.\nBarcha buyruqlar: /help`;
  return (
    `👋 Salom, ${name}!\n\n` +
    `📊 Hisobotlar:\n` +
    `/report — bugun\n` +
    `/week — hafta\n` +
    `/month — oy\n` +
    `/period — ixtiyoriy davr\n\n` +
    `🤖 AI-murabbiy:\n` +
    `/ask — so'nggi 30 kun\n` +
    `/ask_kun — faqat bugun\n` +
    `/ask_hafta — 7 kun\n` +
    `/ask_oy — joriy oy\n\n` +
    `📋 Boshqa:\n` +
    `/errors — mening tez-tez xatolarim`
  );
}

/**
 * A linked manager (active or not) is greeted by name; an administrator
 * without a link gets the admin greeting; anyone else is asked for a code.
 */
export function startReply(access: Access, keyboards: boolean = keyboardsEnabledFor(access)): { text: string; awaitCode: boolean } {
  if (access.manager) return { text: startManagerText(access.manager.name, keyboards), awaitCode: false };
  if (access.isAdmin) return { text: START_ADMIN_TEXT, awaitCode: false };
  return { text: START_CODE_PROMPT_TEXT, awaitCode: true };
}

defineAction({
  id: "start", section: "help", roles: [], label: "Start", commandOnly: true, helpHidden: true,
  command: { pattern: /\/start$/, usage: "/start", description: "boshlash va kirish" },
  async run(ctx) {
    const reply = startReply(ctx.access);
    if (reply.awaitCode) awaitingCode.add(ctx.userId);
    await ctx.bot.sendMessage(ctx.chatId, reply.text, { reply_markup: mainMenuMarkup(ctx.access) });
    await syncCommandMenu(ctx.bot, ctx.chatId, ctx.access);
  },
});

defineAction({
  id: "help", section: "help", roles: [], label: "Buyruqlar ro'yxati",
  command: { pattern: /\/help$/, usage: "/help", description: "buyruqlar ro'yxati" },
  async run(ctx) {
    await ctx.bot.sendMessage(ctx.chatId, helpTextFor(ctx.access));
  },
});
