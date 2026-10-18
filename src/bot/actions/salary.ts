import { bold, escapeHtml, formatMoney } from "../../services/performanceReport";
import {
  findRateTargetByAmoId,
  getManagerFixedRate,
  leadMaySetRate,
  loadTeamMembersForRate,
  setManagerFixedRate,
  teamIdsLedBy,
} from "../../services/managerRate";
import { parsePlanAmount } from "../../services/salesPlan";
import { calculateSalary } from "../../services/salaryCalculator";
import { isLinkedAs, type Access } from "../access";
import { defineInputHandler, type InputContext } from "../inputHandlers";
import { cancelKeyboard } from "../keyboards/cancel";
import { managerItems, pickerItemsFor, showPicker, type PickerItem } from "../keyboards/managerPicker";
import { actionCallback } from "../keyboards/menuCallbacks";
import { ADMIN_DENY_TEXT } from "./admin";
import { dispatchAnswer } from "./inputFlows";
import { parsePageToken } from "./pickerFlows";
import { defineAction } from "./registry";
import type { ActionContext, ActionDefinition } from "./types";

/**
 * The salary calculator for sales managers, and the two commands that keep
 * their fixed monthly rate: an administrator sets it for anyone, a team lead
 * for members of their own team.
 */

export const RATE_MISSING_TEXT = "Sizning fikslangan stavkangiz hali belgilanmagan. Administrator yoki tim-lid uni /set_rate orqali belgilashi kerak.";
export const CALCULATOR_FOR_MANAGERS_TEXT = "Kalkulyator hozircha faqat menejerlar (MOP) uchun: tim-lid va ROP maoshi boshqa qoidalar bilan hisoblanadi.";
export const DAYS_PROMPT = "Davr ichida necha kun ishladingiz? Raqam yuboring, masalan: 5";
export const DAYS_ERROR_TEXT = "Kunlar soni 1 dan 31 gacha bo'lgan butun son bo'lishi kerak. Qaytadan yuboring.";
export const PLAN_PROMPT = "Shu davr uchun rejangiz (so'mda), masalan: 30000000";
export const PLAN_ERROR_TEXT = "Reja noto'g'ri. Faqat raqamlar, masalan: 30000000. Qaytadan yuboring.";
export const FACT_PROMPT = "Shu davr uchun fakt sotuvlar (so'mda, amoCRM bo'yicha). Sotuv bo'lmagan bo'lsa 0 yuboring.";
export const FACT_ERROR_TEXT = "Fakt noto'g'ri. Faqat raqamlar, masalan: 25041000 yoki 0. Qaytadan yuboring.";
export const RATE_PROMPT = "Oylik fikslangan stavkani so'mda yuboring, masalan: 2500000";
export const RATE_ERROR_TEXT = "Stavka noto'g'ri. Faqat raqamlar, masalan: 2500000. Qaytadan yuboring.";

const isSalesManager = (access: Access): boolean => access.manager !== null && isLinkedAs(access.manager, "manager");

export function parseWorkedDays(text: string): number | null {
  const value = text.trim();
  if (!/^\d{1,2}$/.test(value)) return null;
  const days = Number(value);
  return days >= 1 && days <= 31 ? days : null;
}

/** Like the plan amount, but zero is a valid fact. */
export function parseFactAmount(text: string): number | null {
  const digits = text.trim().replace(/[\s']/g, "");
  if (!/^\d{1,15}$/.test(digits)) return null;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

export function formatSalaryResult(input: { fixedMonthlyRate: number; workedDays: number; plan: number; fact: number }): string {
  const result = calculateSalary(input);
  return [
    bold("Maosh hisob-kitobi (dastlabki)"),
    `Stavka: ${formatMoney(input.fixedMonthlyRate)} · Kunlar: ${input.workedDays}`,
    `Reja: ${formatMoney(input.plan)} · Fakt: ${formatMoney(input.fact)} (${percent(result.planRatio)})`,
    `Smena narxi: ${formatMoney(result.shiftCost)} (koeffitsient ${percent(result.shiftCoefficient)})`,
    `Oklad: ${formatMoney(result.baseSalary)}`,
    `Bonus: ${percent(result.bonusRate)} = ${formatMoney(result.bonus)}`,
    bold(`Jami: ${formatMoney(result.total)}`),
    "",
    "Qo'lda qo'shiladigan bonus va jarimalar hisobga olinmagan.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /salary — three typed answers, then the figure
// ---------------------------------------------------------------------------

defineAction({
  id: "salary", section: "reports", order: 110, roles: ["manager"], label: "Maosh kalkulyatori",
  showWhen: ({ access }) => isSalesManager(access),
  command: { pattern: /^\/salary$/, usage: "/salary", description: "haftalik maoshni hisoblash (kunlar, reja, fakt)" },
  async run(ctx) {
    if (!isSalesManager(ctx.access)) {
      await ctx.bot.sendMessage(ctx.chatId, CALCULATOR_FOR_MANAGERS_TEXT);
      return;
    }
    const rate = await getManagerFixedRate(ctx.access.manager!.id);
    if (rate === null) {
      await ctx.bot.sendMessage(ctx.chatId, RATE_MISSING_TEXT);
      return;
    }
    await ctx.pending.expect(ctx.userId, "salary_days", { rate });
    await ctx.bot.sendMessage(ctx.chatId, DAYS_PROMPT, { reply_markup: cancelKeyboard() });
  },
});

defineInputHandler("salary_days", async ({ bot, chatId, userId, text, input, pending }) => {
  const days = parseWorkedDays(text);
  if (days === null) {
    await bot.sendMessage(chatId, DAYS_ERROR_TEXT, { reply_markup: cancelKeyboard() });
    return;
  }
  await pending.expect(userId, "salary_plan", { ...input.payload, days });
  await bot.sendMessage(chatId, PLAN_PROMPT, { reply_markup: cancelKeyboard() });
});

defineInputHandler("salary_plan", async ({ bot, chatId, userId, text, input, pending }) => {
  const plan = parsePlanAmount(text);
  if (plan === null) {
    await bot.sendMessage(chatId, PLAN_ERROR_TEXT, { reply_markup: cancelKeyboard() });
    return;
  }
  await pending.expect(userId, "salary_fact", { ...input.payload, plan });
  await bot.sendMessage(chatId, FACT_PROMPT, { reply_markup: cancelKeyboard() });
});

defineInputHandler("salary_fact", async ({ bot, chatId, userId, text, input, pending }) => {
  const fact = parseFactAmount(text);
  if (fact === null) {
    await bot.sendMessage(chatId, FACT_ERROR_TEXT, { reply_markup: cancelKeyboard() });
    return;
  }
  await pending.cancel(userId);
  const { rate, days, plan } = input.payload as { rate: number; days: number; plan: number };
  await bot.sendMessage(chatId, formatSalaryResult({ fixedMonthlyRate: Number(rate), workedDays: Number(days), plan: Number(plan), fact }), { parse_mode: "HTML" });
});

// ---------------------------------------------------------------------------
// Setting a rate: pick the manager, type the amount
// ---------------------------------------------------------------------------

type Collect = NonNullable<ActionDefinition["collect"]>;

/** Position 0 from a list, then the amount typed; the list depends on who asks. */
function createRateCollect(actionId: string, items: (ctx: ActionContext) => Promise<PickerItem[]>, title: string): Collect {
  return async (ctx) => {
    const [first] = ctx.args;
    if (ctx.args.length >= 2) return "done";
    if (first === undefined || parsePageToken(first) !== null) {
      const page = parsePageToken(first);
      await showPicker(ctx, {
        title,
        items: () => items(ctx),
        page: page ?? 1,
        edit: page !== null,
        emptyText: "Stavka belgilash uchun menejer topilmadi.",
        callbacks: { pick: (value) => actionCallback(actionId, value), page: (next) => actionCallback(actionId, `p${next}`) },
      });
      return "waiting";
    }
    await ctx.pending.expect(ctx.userId, "rate_amount", { action: actionId, args: [first] });
    await ctx.bot.sendMessage(ctx.chatId, RATE_PROMPT, { reply_markup: cancelKeyboard() });
    return "waiting";
  };
}

defineInputHandler("rate_amount", async (ctx: InputContext) => {
  const amount = parsePlanAmount(ctx.text);
  if (amount === null) {
    await ctx.bot.sendMessage(ctx.chatId, RATE_ERROR_TEXT, { reply_markup: cancelKeyboard() });
    return;
  }
  await ctx.pending.cancel(ctx.userId);
  await dispatchAnswer(ctx, String(amount));
});

async function applyRate(ctx: ActionContext, scope: "admin" | "teamlead"): Promise<void> {
  const amoUserId = Number(ctx.args[0]);
  const amount = parsePlanAmount(ctx.args[1] ?? "");
  if (!Number.isInteger(amoUserId) || amount === null) {
    await ctx.bot.sendMessage(ctx.chatId, `Summa noto'g'ri. Masalan: ${scope === "admin" ? "/set_rate" : "/team_rate"} 12695650 2500000`);
    return;
  }
  const target = await findRateTargetByAmoId(amoUserId);
  if (!target) {
    await ctx.bot.sendMessage(ctx.chatId, `amoCRM ID ${amoUserId} bo'yicha menejer topilmadi.`);
    return;
  }
  if (scope === "teamlead") {
    const lead = ctx.access.manager!;
    if (!leadMaySetRate(await teamIdsLedBy({ id: lead.id, teamId: lead.teamId }), target)) {
      await ctx.bot.sendMessage(ctx.chatId, `${escapeHtml(target.name)} sizning jamoangizda emas.`, { parse_mode: "HTML" });
      return;
    }
  }
  await setManagerFixedRate(target.id, amount);
  await ctx.bot.sendMessage(ctx.chatId, `${bold(escapeHtml(target.name))} uchun fikslangan stavka: ${formatMoney(amount)} so'm/oy.`, { parse_mode: "HTML" });
}

defineAction({
  id: "set_rate", section: "users", order: 23, roles: ["admin"], denyText: ADMIN_DENY_TEXT, label: "Stavka belgilash",
  collect: createRateCollect("set_rate", () => pickerItemsFor({ kind: "managers" })(), "Stavka: menejerni tanlang"),
  command: { pattern: /^\/set_rate\s+(\d+)\s+([\d\s']+)$/, usage: "/set_rate <amo_id> <summa>", description: "menejerning oylik fikslangan stavkasi" },
  run: (ctx) => applyRate(ctx, "admin"),
});

defineAction({
  id: "team_rate", section: "team", order: 110, roles: ["teamlead"], denyText: "❌ Sizda TeamLead huquqi yo'q.", label: "Jamoa: stavka belgilash",
  collect: createRateCollect(
    "team_rate",
    async (ctx) => managerItems(await loadTeamMembersForRate({ id: ctx.access.manager!.id, teamId: ctx.access.manager!.teamId })),
    "Stavka: jamoangizdagi menejerni tanlang",
  ),
  command: { pattern: /^\/team_rate\s+(\d+)\s+([\d\s']+)$/, usage: "/team_rate <amo_id> <summa>", description: "jamoangizdagi menejerning oylik fikslangan stavkasi" },
  run: (ctx) => applyRate(ctx, "teamlead"),
});
