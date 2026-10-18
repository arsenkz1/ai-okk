import type TelegramBot from "node-telegram-bot-api";
import { almatyPlanMonth, formatPlanMonth, parsePlanAmount, type PlanMonth } from "../../services/salesPlan";
import { defineInputHandler } from "../inputHandlers";
import { cancelKeyboard } from "../keyboards/cancel";
import { pickerItemsFor, showManagerPicker, showPicker, type ManagerFilter, type PickerSource } from "../keyboards/managerPicker";
import { actionCallback } from "../keyboards/menuCallbacks";
import type { ActionContext, ActionDefinition } from "./types";

/**
 * Reusable multi-step collectors for actions whose arguments come from
 * buttons: a manager from a paged list, one option from a short list, and
 * the plan chain (manager, then a typed amount, then a month).
 *
 * Several arguments travel in one callback packed with "_": every value here
 * is digits or `YYYY-MM`, so the separator is unambiguous.
 */

export const PACK_SEPARATOR = "_";
export const splitPacked = (arg: string): string[] => arg.split(PACK_SEPARATOR);
export const packArgs = (parts: readonly string[]): string => parts.join(PACK_SEPARATOR);

const PAGE_TOKEN = /^p(\d{1,3})$/;

export function parsePageToken(token: string | undefined): number | null {
  const matched = token === undefined ? null : PAGE_TOKEN.exec(token);
  return matched ? Number(matched[1]) : null;
}

type Collect = NonNullable<ActionDefinition["collect"]>;

/**
 * Argument number `position` is a manager's amoCRM id, chosen from the list.
 * Arguments before it are already known (a variant, for example) and are
 * carried along in every callback.
 */
export function createPickManagerCollect(actionId: string, options: { position: number; title: string; filter?: ManagerFilter }): Collect {
  return async (ctx) => {
    const prefix = ctx.args.slice(0, options.position);
    const token = ctx.args[options.position];
    const page = parsePageToken(token);
    if (token !== undefined && page === null) return "done";
    await showManagerPicker(ctx, {
      title: options.title,
      page: page ?? 1,
      edit: page !== null,
      filter: options.filter,
      callbacks: {
        pick: (amoUserId) => actionCallback(actionId, packArgs([...prefix, String(amoUserId)])),
        page: (next) => actionCallback(actionId, packArgs([...prefix, `p${next}`])),
      },
    });
    return "waiting";
  };
}

export interface ChoiceOption {
  label: string;
  value: string;
}

const CHOICES_PER_ROW = 2;

export function choiceKeyboard(actionId: string, prefix: readonly string[], options: readonly ChoiceOption[]): TelegramBot.InlineKeyboardMarkup {
  const buttons = options.map((option) => ({ text: option.label, callback_data: actionCallback(actionId, packArgs([...prefix, option.value])) }));
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let index = 0; index < buttons.length; index += CHOICES_PER_ROW) rows.push(buttons.slice(index, index + CHOICES_PER_ROW));
  return { inline_keyboard: rows };
}

/** Argument number `position` is one of a few options, offered as buttons. */
export function createChoiceCollect(actionId: string, options: { position: number; title: string; options: () => ChoiceOption[] }): Collect {
  return async (ctx) => {
    if (ctx.args.length > options.position) return "done";
    await ctx.bot.sendMessage(ctx.chatId, options.title, { reply_markup: choiceKeyboard(actionId, ctx.args.slice(0, options.position), options.options()) });
    return "waiting";
  };
}

export type CollectStep =
  | ({ title: string } & PickerSource)
  | { kind: "choice"; title: string; options: () => ChoiceOption[] };

/**
 * One argument per step, in order: a paged list or a short choice. Every
 * callback carries the arguments gathered so far, packed with "_".
 */
export function createStepsCollect(actionId: string, steps: readonly CollectStep[]): Collect {
  return async (ctx) => {
    let position = ctx.args.length;
    const last = ctx.args[ctx.args.length - 1];
    if (position > 0 && parsePageToken(last) !== null) position -= 1;
    if (position >= steps.length) return "done";

    const step = steps[position];
    const prefix = ctx.args.slice(0, position);
    const callbacks = {
      pick: (value: string) => actionCallback(actionId, packArgs([...prefix, value])),
      page: (next: number) => actionCallback(actionId, packArgs([...prefix, `p${next}`])),
    };
    if (step.kind === "choice") {
      await ctx.bot.sendMessage(ctx.chatId, step.title, { reply_markup: choiceKeyboard(actionId, prefix, step.options()) });
      return "waiting";
    }
    const page = position < ctx.args.length ? parsePageToken(ctx.args[position]) : null;
    await showPicker(ctx, { title: step.title, items: pickerItemsFor(step), page: page ?? 1, edit: page !== null, callbacks });
    return "waiting";
  };
}

export const ROLE_OPTIONS: ChoiceOption[] = [
  { label: "Menejer", value: "manager" },
  { label: "TeamLead", value: "teamlead" },
  { label: "ROP", value: "rop" },
];

export const DAY_OPTIONS: ChoiceOption[] = [1, 3, 7, 14].map((days) => ({ label: `${days} kun`, value: String(days) }));

export function shiftPlanMonth({ year, month }: PlanMonth, delta: number): PlanMonth {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Months offered when setting a plan: this one and the next. */
export function planTargetMonthOptions(now = new Date()): ChoiceOption[] {
  const current = almatyPlanMonth(now);
  return [
    { label: `${formatPlanMonth(current)} (joriy)`, value: formatPlanMonth(current) },
    { label: `${formatPlanMonth(shiftPlanMonth(current, 1))} (keyingi)`, value: formatPlanMonth(shiftPlanMonth(current, 1)) },
  ];
}

/** Months offered when reading plans: last, this and next. */
export function planViewMonthOptions(now = new Date()): ChoiceOption[] {
  const current = almatyPlanMonth(now);
  return [
    { label: `${formatPlanMonth(shiftPlanMonth(current, -1))} (o'tgan)`, value: formatPlanMonth(shiftPlanMonth(current, -1)) },
    { label: `${formatPlanMonth(current)} (joriy)`, value: formatPlanMonth(current) },
    { label: `${formatPlanMonth(shiftPlanMonth(current, 1))} (keyingi)`, value: formatPlanMonth(shiftPlanMonth(current, 1)) },
  ];
}

export const PLAN_AMOUNT_PROMPT = "Reja summasini so'mda yuboring, masalan: 50000000";
export const PLAN_AMOUNT_ERROR_TEXT = "Summa noto'g'ri. Faqat raqamlar, masalan: 50000000. Qaytadan yuboring.";
export const PLAN_MONTH_PROMPT = "Qaysi oy uchun?";

/**
 * Plan chain: manager (list), amount (typed), month (two buttons). The final
 * callback packs all three, so `run` gets the same arguments as the command.
 */
export function createSetPlanCollect(actionId: string): Collect {
  const pickManager = createPickManagerCollect(actionId, { position: 0, title: "Reja: menejerni tanlang" });
  return async (ctx) => {
    const [amoUserId, amount] = ctx.args;
    if (ctx.args.length >= 3) return "done";
    if (amoUserId === undefined || parsePageToken(amoUserId) !== null) return pickManager(ctx);
    if (amount === undefined) {
      await ctx.pending.expect(ctx.userId, "plan_amount", { action: actionId, amoUserId });
      await ctx.bot.sendMessage(ctx.chatId, PLAN_AMOUNT_PROMPT, { reply_markup: cancelKeyboard() });
      return "waiting";
    }
    await ctx.bot.sendMessage(ctx.chatId, PLAN_MONTH_PROMPT, { reply_markup: choiceKeyboard(actionId, [amoUserId, amount], planTargetMonthOptions()) });
    return "waiting";
  };
}

defineInputHandler("plan_amount", async ({ bot, chatId, userId, text, input, pending }) => {
  const amount = parsePlanAmount(text);
  if (amount === null) {
    await bot.sendMessage(chatId, PLAN_AMOUNT_ERROR_TEXT, { reply_markup: cancelKeyboard() });
    return;
  }
  await pending.cancel(userId);
  const actionId = String(input.payload.action ?? "");
  const amoUserId = String(input.payload.amoUserId ?? "");
  await bot.sendMessage(chatId, PLAN_MONTH_PROMPT, { reply_markup: choiceKeyboard(actionId, [amoUserId, String(amount)], planTargetMonthOptions()) });
});
