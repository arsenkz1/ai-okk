import { isLinkedAs, type Access } from "../access";
import { awaitingCode } from "../state";
import { syncCommandMenu } from "../commandMenu";
import { mainMenuMarkup } from "../keyboards/mainMenu";
import { defineAction } from "./registry";

/**
 * /start and /help. The texts are the historical hand-written blocks; S15 of
 * the keyboard migration replaces them with text generated from the registry.
 */

export const ADMIN_HELP_TEXT =
  `🔑 Administrator buyruqlari\n\n` +
  `Menejerlar:\n` +
  "/managers - barcha menejerlar ro'yxati\n" +
  "/manager_ids - amoID larni nusxalash uchun qulay ro'yxat\n" +
  "/sync_managers - OnlinePBX dan sinxronlash va Google Sheet yangilash\n" +
  "/reset_code <amo_id> - menejer uchun yangi kod yaratish\n\n" +
  `Administratorlar:\n` +
  "/admins - barcha administratorlarni ko'rish\n" +
  "/add_admin <telegram_id> - foydalanuvchini administrator qilish\n" +
  "/remove_admin <telegram_id> - administrator huquqlarini olish\n\n" +
  `Qo'ng'iroqlar tahlili:\n` +
  "/analyze_deal <deal_id> - bitim bo'yicha so'nggi qo'ng'iroqni tahlil qilish\n" +
  "/sync_history - qo'ng'iroqlar tarixini sinxronlash (so'nggi 7 kun)\n\n" +
  `Hisobotlar (jamoa bo'yicha):\n` +
  "/report - bugungi hisobot\n" +
  "/week - so'nggi 7 kun\n" +
  "/month - joriy oy\n" +
  "/period - ixtiyoriy sana oralig'i\n" +
  "/errors - 30 kunlik zaif kriteriyalar\n" +
  "/team_stats - qo'ng'iroq/tushum/reja hisoboti\n" +
  "/deal <id> - bitim bo'yicha ma'lumotnoma\n\n" +
  `Rejalar:\n` +
  "/set_plan <amo_id> <summa> [YYYY-MM] - oylik reja belgilash\n" +
  "/plans [YYYY-MM] - barcha rejalar\n\n" +
  `Hisobot sozlamalari:\n` +
  "/rating_list - kim reytingda, kim chiqarilgan\n" +
  "/rating_off <amo_id> - reytingdan chiqarish (jamoa, HR, xizmat hisoblari)\n" +
  "/rating_on <amo_id> - reytingga qaytarish\n" +
  "/call_status [kun] - qo'ng'iroqlar nega tahlil qilinmadi\n" +
  "/sync_stages - amoCRM voronkalaridan tushum bosqichlarini sinxronlash\n" +
  "/inactivity_status - Feniks vorkeri nega ishlamayapti\n" +
  "/inactivity_lead <id> - aniq bitim nega Feniksga o'tmagan\n" +
  "/inactivity_off - Feniksga ko'chirishni to'liq to'xtatish (navbat tozalanadi)\n" +
  "/inactivity_on - yoqish va 3+ kun tegilmagan lidlarni ko'chirishni taklif qilish\n" +
  "/inactivity_limit_on - kuniga 100 ta ko'chirish limitini yoqish\n" +
  "/inactivity_limit_off - kunlik limitni o'chirish (cheklovsiz)\n" +
  "/inactivity_limit - limit holatini ko'rish\n\n" +
  `ROP - reyting va analitika:\n` +
  "/teams - barcha jamoalar\n" +
  "/all_rating - menejerlarning umumiy reytingi (7 kun)\n" +
  "/all_mistakes - kompaniya bo'yicha xatolar\n" +
  "/rop_team_rating - aniq jamoa reytingi\n" +
  "/rop_team_mistakes - aniq jamoa xatolari\n" +
  "/rop_manager - menejer kartasi\n" +
  "/rop_ask - menejer haqida AI-savol\n\n" +
  `ROP - jamoa boshqaruvi:\n` +
  "/set_role <tg_id> <manager|teamlead|rop> - rol tayinlash\n" +
  "/set_teamlead <amo_id> - jamoa yaratish va TL tayinlash\n" +
  "/add_to_team <mgr_amo_id> <tl_amo_id> - jamoaga qo'shish\n" +
  "/remove_from_team <amo_id> - jamoadan chiqarish\n" +
  "/delete_team <team_id> - jamoani butunlay o'chirish\n" +
  "/teams_list - barcha jamoalar ro'yxati\n\n" +
  `Intizom testi:\n` +
  "/test_restrict <tg_id> - menejerni cheklash\n" +
  "/test_restore <tg_id> - menejerni tiklash\n" +
  "/check_tg <tg_id> - BDDagi bog'lanishni tekshirish";

export const TEAMLEAD_HELP_TEXT =
  `👥 TeamLead buyruqlari\n\n` +
  `Shaxsiy buyruqlar:\n` +
  "/report - bugungi hisobot\n" +
  "/week - so'nggi 7 kun\n" +
  "/month - joriy oy\n" +
  "/period - ixtiyoriy sana oralig'i\n" +
  "/errors - so'nggi 30 kunlik eng ko'p xatolar\n" +
  "/my_stats - qo'ng'iroq/tushum/reja hisobotim\n" +
  "/team_stats - jamoa hisoboti\n" +
  "/deal <id> - bitim bo'yicha ma'lumotnoma\n" +
  "/ask - dialog rejimiga kirish (30 kun ma'lumotlari)\n" +
  "/ask_kun - faqat bugungi ma'lumotlar\n" +
  "/ask_hafta - 7 kunlik ma'lumotlar\n" +
  "/ask_oy - joriy oy ma'lumotlari\n" +
  "/stop_ai - AI-murabbiy rejimidan chiqish\n\n" +
  `Jamoa buyruqlari:\n` +
  "/team - o'z jamoangizni ko'rish\n" +
  "/team_rating - jamoa reytingi\n" +
  "/team_mistakes - jamoa xatolari\n" +
  "/team_add - menejerlarni jamoaga biriktirish\n" +
  "/team_remove - menejerlarni jamoadan chiqarish\n" +
  "/team_manager - jamoa menejeri kartasi\n" +
  "/ask_manager - jamoa menejeri haqida AI-savol";

export const MANAGER_HELP_TEXT =
  `📋 Mavjud buyruqlar\n\n` +
  `Hisobotlar:\n` +
  "/report - bugungi hisobot\n" +
  "/week - so'nggi 7 kun\n" +
  "/month - joriy oy\n" +
  "/period - ixtiyoriy sana oralig'i\n\n" +
  `Xatolar tahlili:\n` +
  "/errors - so'nggi 30 kunlik eng ko'p xatolar\n" +
  "/my_stats - qo'ng'iroq/tushum/reja hisobotim\n" +
  "/deal <id> - bitim bo'yicha ma'lumotnoma\n\n" +
  `AI-murabbiy:\n` +
  "/ask - dialog rejimiga kirish (30 kun ma'lumotlari)\n" +
  "/ask_kun - faqat bugungi ma'lumotlar\n" +
  "/ask_hafta - 7 kunlik ma'lumotlar\n" +
  "/ask_oy - joriy oy ma'lumotlari\n" +
  "/ask <savol> - savolni darhol berish\n" +
  "/stop_ai - AI-murabbiy rejimidan chiqish";

export const UNLINKED_HELP_TEXT = `ℹ️ Botga kirish uchun /start kiriting va ko'rsatmalarni bajaring.`;

/** Admin first, then team lead, then any linked manager: the historical order. */
export function helpTextFor(access: Access): string {
  if (access.isAdmin) return ADMIN_HELP_TEXT;
  if (access.manager && isLinkedAs(access.manager, "teamlead")) return TEAMLEAD_HELP_TEXT;
  if (access.manager) return MANAGER_HELP_TEXT;
  return UNLINKED_HELP_TEXT;
}

export const START_ADMIN_TEXT = `👋 Salom, Admin!\n\nBarcha buyruqlarni ko'rish uchun /help kiriting.`;
export const START_CODE_PROMPT_TEXT =
  `👋 Salom!\n\nBoshlash uchun 6 xonali kodni kiriting.\nUni menejerlar jadvalidan topishingiz mumkin (rahbaringizdan so'rang).`;

export function startManagerText(name: string): string {
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
export function startReply(access: Access): { text: string; awaitCode: boolean } {
  if (access.manager) return { text: startManagerText(access.manager.name), awaitCode: false };
  if (access.isAdmin) return { text: START_ADMIN_TEXT, awaitCode: false };
  return { text: START_CODE_PROMPT_TEXT, awaitCode: true };
}

defineAction({
  id: "start", section: "help", roles: [], label: "Start", commandOnly: true,
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
