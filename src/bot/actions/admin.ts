import { prisma } from "../../config/database";
import { Prisma } from "../../generated/prisma/client";
import type { AmoRoleRights } from "../../services/amoRights";
import { formatDealSummaryReport } from "../../services/dealSummaryReport";
import { findLinkedManager } from "../access";
import { sendLongMessage } from "../longMessage";
import { createStepsCollect } from "./pickerFlows";
import { defineAction } from "./registry";

/**
 * Administrator commands: people, admins, call history, deal analysis and the
 * discipline test switches.
 *
 * Heavy services are imported inside `run`: `amocrm` and `pbxHistory` pull the
 * BullMQ queue at import time, and the registry must stay loadable in tests.
 */

export const ADMIN_DENY_TEXT = "❌ Sizda administrator huquqlari yo'q.";

const ADMIN = { roles: ["admin"] as const, denyText: ADMIN_DENY_TEXT };

// ---------------------------------------------------------------------------
// Synchronisation
// ---------------------------------------------------------------------------

defineAction({
  id: "sync_managers", section: "sync", order: 10, roles: [...ADMIN.roles], denyText: ADMIN.denyText, label: "PBX menejerlar",
  command: { pattern: /\/sync_managers$/, usage: "/sync_managers", description: "OnlinePBX dan sinxronlash va Google Sheet yangilash" },
  async run(ctx) {
    const { syncManagersFromPbx } = await import("../../services/managerSync");
    await ctx.bot.sendMessage(ctx.chatId, "⏳ OnlinePBX dan menejerlar sinxronlanmoqda...");

    try {
      const result = await syncManagersFromPbx();
      const sheetStatus = result.sheetUpdated
        ? `Google Sheet yangilandi ✓`
        : `⚠️ Google Sheet yangilanmadi: ${result.sheetError}`;
      await ctx.bot.sendMessage(
        ctx.chatId,
        `✅ Sinxronizatsiya yakunlandi:\n` +
          `• Yaratildi: ${result.created}\n` +
          `• Yangilandi: ${result.updated}\n` +
          `• Qayta faollashtirildi: ${result.reactivated}\n` +
          `• Deaktivlashtirildi: ${result.deactivated}\n` +
          `• PBX da jami: ${result.total}\n\n` +
          sheetStatus
      );
    } catch (err: any) {
      await ctx.bot.sendMessage(ctx.chatId, `❌ Sinxronizatsiya xatosi: ${err.message}`);
    }
  },
});

defineAction({
  id: "sync_history", section: "sync", order: 11, roles: [...ADMIN.roles], denyText: ADMIN.denyText, label: "Qo'ng'iroqlar tarixi",
  command: { pattern: /\/sync_history/, usage: "/sync_history", description: "qo'ng'iroqlar tarixini sinxronlash (so'nggi 7 kun)" },
  async run(ctx) {
    const { syncHistoryRange } = await import("../../services/pbxHistory");
    const { bot, chatId } = ctx;

    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 7);

    const fmt = (d: Date) => `${d.getDate().toString().padStart(2,"0")}.${(d.getMonth()+1).toString().padStart(2,"0")}.${d.getFullYear()}`;
    const fromStr = fmt(fromDate);
    const toStr = fmt(toDate);

    let syncJob;
    try {
      syncJob = await prisma.historySyncJob.create({
        data: { fromDate, toDate, status: "in_progress" },
      });
    } catch (err: any) {
      await bot.sendMessage(chatId, `❌ Vazifa yaratishda xato: ${err.message}`);
      return;
    }

    await bot.sendMessage(
      chatId,
      `⏳ Qo'ng'iroqlar tarixini sinxronlash boshlandi...\n\n📅 Davr: ${fromStr} — ${toStr}\n🆔 Job ID: ${syncJob.id}\n\nBu bir necha daqiqa olishi mumkin. Natijalar haqida xabar beraman.`
    );

    syncHistoryRange(fromDate, toDate, syncJob.id)
      .then(async (stats) => {
        try {
          await bot.sendMessage(
            chatId,
            `✅ Sinxronizatsiya yakunlandi (Job #${syncJob.id}):\n\n` +
              `📊 Skanerlandi: ${stats.scanned}\n` +
              `📥 Navbatga qo'shildi: ${stats.queued}\n` +
              `⏭ O'tkazib yuborildi (< 8 daq): ${stats.skippedShort}\n` +
              `⏭ O'tkazib yuborildi (ichki): ${stats.skippedInternal}\n` +
              `⏭ Allaqachon qayta ishlangan: ${stats.skippedDuplicate}\n` +
              (stats.errors > 0 ? `⚠️ Xatolar: ${stats.errors}\n` : "")
          );
        } catch {}
      })
      .catch(async (err: any) => {
        console.error("[Bot] sync_history failed:", err.message);
        try {
          await bot.sendMessage(
            chatId,
            `❌ Sinxronizatsiya xato bilan yakunlandi (Job #${syncJob.id}):\n${err.message}`
          );
        } catch {}
      });
  },
});

// ---------------------------------------------------------------------------
// People and administrators
// ---------------------------------------------------------------------------

defineAction({
  id: "managers", section: "users", order: 10, roles: [...ADMIN.roles], denyText: ADMIN.denyText, label: "Menejerlar",
  command: { pattern: /\/managers$/, usage: "/managers", description: "barcha menejerlar ro'yxati" },
  async run(ctx) {
    const managers = await prisma.manager.findMany({
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      include: {
        telegramLinks: {
          where: { status: { in: ["issued", "used"] } },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!managers.length) {
      await ctx.bot.sendMessage(ctx.chatId, "Menejerlar yo'q. /sync_managers ishga tushiring.");
      return;
    }

    const lines = managers.map((m) => {
      const usedLink = m.telegramLinks.find((l) => l.status === "used");
      const issuedLink = m.telegramLinks.find((l) => l.status === "issued");
      const status = usedLink ? "✅" : issuedLink ? "⏳" : "❌";
      const active = m.isActive ? "" : " 🚫";
      return `${status}${active} ${m.name} (uid: ${m.internalNumber ?? "—"}, amo: ${m.amoUserId ?? "—"})`;
    });

    for (let i = 0; i < lines.length; i += 30) {
      await ctx.bot.sendMessage(ctx.chatId, `👥 Menejerlar:\n\n${lines.slice(i, i + 30).join("\n")}`);
    }
  },
});

defineAction({
  id: "manager_ids", section: "users", order: 11, roles: [...ADMIN.roles], denyText: ADMIN.denyText, label: "amoID ro'yxati",
  command: { pattern: /\/manager_ids$/, usage: "/manager_ids", description: "amoID larni nusxalash uchun qulay ro'yxat" },
  async run(ctx) {
    const managers = await prisma.manager.findMany({
      where: { amoUserId: { not: null } },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      select: {
        name: true,
        amoUserId: true,
        isActive: true,
        role: true,
      },
    });

    if (!managers.length) {
      await ctx.bot.sendMessage(ctx.chatId, "AmoID bilan menejerlar topilmadi.");
      return;
    }

    const lines = managers.map((manager) => {
      const activeMark = manager.isActive ? "" : " [inactive]";
      return `${manager.amoUserId} - ${manager.name} (${manager.role})${activeMark}`;
    });

    for (let i = 0; i < lines.length; i += 40) {
      await ctx.bot.sendMessage(ctx.chatId, `AmoID ro'yxati:\n\n${lines.slice(i, i + 40).join("\n")}`);
    }
  },
});

defineAction({
  id: "admins", section: "users", order: 12, roles: [...ADMIN.roles], denyText: ADMIN.denyText, label: "Adminlar",
  command: { pattern: /\/admins$/, usage: "/admins", description: "barcha administratorlarni ko'rish" },
  async run(ctx) {
    const admins = await prisma.botAdmin.findMany({ orderBy: { createdAt: "asc" } });
    const lines = [`👑 Superadmin: ${process.env.ADMIN_TELEGRAM_ID}`];

    if (admins.length) {
      lines.push(
        `\n🔑 Qo'shimcha:`,
        ...admins.map((a) => `• ${a.telegramUserId}${a.addedBy ? ` (qo'shdi: ${a.addedBy})` : ""}`)
      );
    } else {
      lines.push("\nQo'shimcha administratorlar yo'q.");
    }

    await ctx.bot.sendMessage(ctx.chatId, lines.join("\n"));
  },
});

defineAction({
  id: "add_admin", section: "users", order: 21, roles: [...ADMIN.roles], denyText: ADMIN.denyText, label: "Admin qo'shish",
  input: { kind: "telegram_id", prompt: "Yangi administratorning Telegram ID raqamini yuboring:" },
  command: { pattern: /\/add_admin (\d+)/, usage: "/add_admin <telegram_id>", description: "foydalanuvchini administrator qilish" },
  async run(ctx) {
    const newId = ctx.args[0];
    if (newId === process.env.ADMIN_TELEGRAM_ID) {
      await ctx.bot.sendMessage(ctx.chatId, "ℹ️ Allaqachon superadmin.");
      return;
    }

    await prisma.botAdmin.upsert({
      where: { telegramUserId: newId },
      update: { addedBy: ctx.telegramUserId },
      create: { telegramUserId: newId, addedBy: ctx.telegramUserId },
    });
    await ctx.bot.sendMessage(ctx.chatId, `✅ Foydalanuvchi ${newId} administrator qilindi.`);
  },
});

defineAction({
  id: "remove_admin", section: "users", order: 22, roles: [...ADMIN.roles], denyText: ADMIN.denyText, label: "Adminni olib tashlash", dangerous: true,
  input: { kind: "telegram_id", prompt: "Olib tashlanadigan administratorning Telegram ID raqamini yuboring:" },
  command: { pattern: /\/remove_admin (\d+)/, usage: "/remove_admin <telegram_id>", description: "administrator huquqlarini olish" },
  async run(ctx) {
    const targetId = ctx.args[0];
    if (targetId === process.env.ADMIN_TELEGRAM_ID) {
      await ctx.bot.sendMessage(ctx.chatId, "❌ Superadminni o'chirib bo'lmaydi.");
      return;
    }

    const deleted = await prisma.botAdmin.deleteMany({ where: { telegramUserId: targetId } });
    await ctx.bot.sendMessage(
      ctx.chatId,
      deleted.count
        ? `✅ Administrator ${targetId} o'chirildi.`
        : `ℹ️ Foydalanuvchi administrator emas.`
    );
  },
});

defineAction({
  id: "reset_code", section: "users", order: 20, roles: [...ADMIN.roles], denyText: ADMIN.denyText, label: "Kod qayta berish", dangerous: true,
  collect: createStepsCollect("reset_code", [{ kind: "managers", title: "Kod qayta beriladigan menejerni tanlang" }]),
  confirmLabel: ([amoUserId]) => `amoCRM ID ${amoUserId}`,
  command: { pattern: /\/reset_code (\d+)/, usage: "/reset_code <amo_id>", description: "menejer uchun yangi kod yaratish" },
  async run(ctx) {
    const { resetManagerCode } = await import("../../services/managerSync");
    const result = await resetManagerCode(parseInt(ctx.args[0]));
    if (!result) {
      await ctx.bot.sendMessage(ctx.chatId, `❌ amoCRM ID ${ctx.args[0]} bilan menejer topilmadi.`);
      return;
    }

    await ctx.bot.sendMessage(
      ctx.chatId,
      `✅ *${result.managerName}* uchun yangi kod:\n\n🔑 \`${result.code}\`\n\nEski bog'lanishlar o'chirildi.`,
      { parse_mode: "Markdown" }
    );
  },
});

// ---------------------------------------------------------------------------
// Deal analysis
// ---------------------------------------------------------------------------

defineAction({
  id: "analyze_deal", section: "users", order: 40, roles: [...ADMIN.roles], denyText: ADMIN.denyText, label: "Bitimni tahlil qilish",
  input: { kind: "deal_id", prompt: "Tahlil uchun bitim ID raqamini yuboring:" },
  command: { pattern: /\/analyze_deal (\d+)/, usage: "/analyze_deal <deal_id>", description: "bitim bo'yicha so'nggi qo'ng'iroqni tahlil qilish" },
  async run(ctx) {
    const [{ fetchDealCallNotes, fetchDealContactPhones, fetchDealSummary }, { findPbxRecordByDateAndPhone }, { callProcessingQueue }] = await Promise.all([
      import("../../services/amocrm"),
      import("../../services/pbxHistory"),
      import("../../queues/callProcessing"),
    ]);
    const { bot, chatId } = ctx;
    const dealId = parseInt(ctx.args[0]);

    await bot.sendMessage(
      chatId,
      `⏳ Bitim #${dealId} uchun amoCRM dan qo'ng'iroq izlash...`
    );

    try {
      // Шаг 1: получаем примечания-звонки из сделки amoCRM
      const notes = await fetchDealCallNotes(dealId);

      const MIN_DURATION = 6 * 60; // 360 секунд
      const qualifying = notes.filter((n) => n.duration >= MIN_DURATION && n.recordUrl);

      if (!qualifying.length) {
        // Анализировать нечего, но данные по сделке обычно есть — показываем их
        // вместо тупика: стадия, бюджет, заполненные поля и тексты примечаний.
        const summary = await fetchDealSummary(dealId);
        await sendLongMessage(
          bot,
          chatId,
          formatDealSummaryReport({ summary, notes, dealId, minCallSeconds: MIN_DURATION }),
        );
        return;
      }

      // Сортируем по длительности убывающей, берём топ-3
      qualifying.sort((a, b) => b.duration - a.duration);
      const toProcess = qualifying.slice(0, 3);

      await bot.sendMessage(
        chatId,
        `✅ ${qualifying.length} ta yaroqli qo'ng'iroq topildi.\n${toProcess.length} ta navbatga qo'yilmoqda...`
      );

      // Шаг 2: телефоны контакта (нужны если нет uniq в примечании)
      let contactPhones: string[] = [];

      let queued = 0;
      let alreadyExists = 0;
      let errors = 0;

      for (const note of toProcess) {
        try {
          let uuid = note.uniq;

          // Если нет UUID в примечании — ищем в OnlinePBX по дате + телефону
          if (!uuid) {
            const phoneToSearch = note.phone;
            if (phoneToSearch) {
              const pbxRecord = await findPbxRecordByDateAndPhone(note.createdAt, phoneToSearch);
              uuid = pbxRecord?.uuid ?? null;
            } else {
              // Пробуем контактный телефон
              if (!contactPhones.length) {
                contactPhones = await fetchDealContactPhones(dealId);
              }
              if (contactPhones.length) {
                const pbxRecord = await findPbxRecordByDateAndPhone(note.createdAt, contactPhones[0]);
                uuid = pbxRecord?.uuid ?? null;
              }
            }
          }

          // Генерируем синтетический ID если UUID так и не нашли
          if (!uuid) {
            uuid = `deal_${dealId}_note_${note.id}`;
          }

          // Шаг 3: проверка идемпотентности
          const existing = await prisma.call.findUnique({
            where: { externalId_source: { externalId: uuid, source: "onlinepbx" } },
          });

          if (existing) {
            alreadyExists++;
            // Перезапускаем анализ даже если запись существует
            await prisma.call.update({
              where: { id: existing.id },
              data: { processingStatus: "queued", manualTriggered: true, lastError: null },
            });
          }

          const externalPhone = note.phone ?? (contactPhones[0] ?? "");
          const direction = note.noteType === "call_out" ? "out" : ("in" as "in" | "out");
          const startTime = note.createdAt;
          const endTime = new Date(startTime.getTime() + note.duration * 1000);

          // Шаг 4: ставим в очередь
          await callProcessingQueue.add(
            `manual_deal_${uuid}`,
            {
              callExternalId: uuid,
              source: "onlinepbx" as const,
              receivedAt: new Date().toISOString(),
              manualTriggered: true,
              forceDealId: dealId,
              payload: {
                event: "call_end" as const,
                uuid,
                direction,
                caller: direction === "in" ? externalPhone : "",
                callee: direction === "out" ? externalPhone : "",
                start_time: startTime.toISOString().replace("T", " ").slice(0, 19),
                end_time: endTime.toISOString().replace("T", " ").slice(0, 19),
                duration: note.duration,
                status: "completed",
                record_url: note.recordUrl ?? undefined,
                internal_number: note.internalNumber ?? "",
                external_number: externalPhone,
              },
            },
            {
              jobId: `manual_deal_${uuid}_${Date.now()}`,
              attempts: 3,
              backoff: { type: "exponential", delay: 5000 },
            }
          );

          queued++;
          console.log(
            `[Bot] analyze_deal #${dealId}: queued note ${note.id} uuid=${uuid} duration=${note.duration}s`
          );
        } catch (err: any) {
          errors++;
          console.error(`[Bot] analyze_deal #${dealId} note ${note.id} error:`, err.message);
        }
      }

      await bot.sendMessage(
        chatId,
        `📊 Natija:\n` +
          `✅ Navbatga qo'yildi: ${queued}\n` +
          `♻️ Mavjud (qayta yuborildi): ${alreadyExists}\n` +
          `❌ Xatolar: ${errors}\n\n` +
          `Tahlil natijasi Google Sheets da paydo bo'ladi va bitim #${dealId} ga izoh qo'shiladi.`
      );
    } catch (err: any) {
      await bot.sendMessage(chatId, `❌ Xato: ${err.message}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Debug and discipline test switches (commands only)
// ---------------------------------------------------------------------------

defineAction({
  id: "check_tg", section: "users", order: 90, roles: [...ADMIN.roles], denyText: ADMIN.denyText, label: "Telegram ID tekshirish", commandOnly: true,
  command: { pattern: /\/check_tg (.+)/, usage: "/check_tg <tg_id>", description: "BDDagi bog'lanishni tekshirish" },
  async run(ctx) {
    const tgId = ctx.args[0];

    const links = await prisma.telegramLink.findMany({
      where: { telegramUserId: tgId },
      include: { manager: true },
    });

    if (!links.length) {
      await ctx.bot.sendMessage(ctx.chatId, `❌ telegramUserId=${tgId} uchun umuman TelegramLink topilmadi.`);
      return;
    }

    const lines = links.map((l) =>
      `• status=${l.status} managerId=${l.managerId} name=${l.manager.name} amoId=${l.manager.amoUserId ?? "—"} active=${l.manager.isActive}`
    );
    await ctx.bot.sendMessage(ctx.chatId, `${tgId} uchun TelegramLink yozuvlari:\n${lines.join("\n")}`);
  },
});

defineAction({
  id: "test_restrict", section: "users", order: 91, roles: [...ADMIN.roles], denyText: ADMIN.denyText, label: "Cheklash (test)", commandOnly: true, dangerous: true,
  command: { pattern: /\/test_restrict (.+)/, usage: "/test_restrict <tg_id>", description: "menejerni cheklash" },
  async run(ctx) {
    const { getAmoUserRoleId, restrictAmoRoleNewLeadAccess } = await import("../../services/amoRights");
    const { bot, chatId } = ctx;
    const tgId = ctx.args[0];
    console.log(`[test_restrict] tgId=${tgId}`);
    await bot.sendMessage(chatId, `🔍 tg_id=${tgId} bo'yicha menejer qidirilmoqda...`);

    const manager = await findLinkedManager(tgId);
    if (!manager) {
      console.log(`[test_restrict] Manager not found for tgId=${tgId}`);
      await bot.sendMessage(chatId, `❌ Telegram ID ${tgId} bo'lgan menejer bazada topilmadi.`);
      return;
    }
    console.log(`[test_restrict] Found manager: id=${manager.id} name=${manager.name} amoUserId=${manager.amoUserId} isRestricted=${manager.isAmoCrmRestricted}`);
    await bot.sendMessage(chatId, `✅ Menejer: ${manager.name} (amoId=${manager.amoUserId}, restricted=${manager.isAmoCrmRestricted})`);

    if (!manager.amoUserId) {
      await bot.sendMessage(chatId, `❌ ${manager.name} uchun amoCRM user ID yo'q.`);
      return;
    }
    if (manager.isAmoCrmRestricted) {
      await bot.sendMessage(chatId, `⚠️ ${manager.name} allaqachon cheklangan.`);
      return;
    }

    if (!manager.amoRoleId) {
      await bot.sendMessage(chatId, `❌ ${manager.name} uchun amoRoleId saqlanmagan.`);
      return;
    }

    await bot.sendMessage(chatId, `🔍 amoCRM dan joriy rol so'ralmoqda (userId=${manager.amoUserId})...`);
    const currentRoleId = await getAmoUserRoleId(manager.amoUserId);
    console.log(`[test_restrict] getAmoUserRoleId result: ${currentRoleId}`);

    if (!currentRoleId) {
      await bot.sendMessage(chatId, `❌ ${manager.name} uchun amoCRM dan role_id olib bo'lmadi.\nServer loglarini tekshiring, API javobi o'sha yerda bo'ladi.`);
      return;
    }
    await bot.sendMessage(
      chatId,
      `✅ Joriy rol: ${currentRoleId}\n🔄 ${manager.name} uchun "Yangi lid" bosqichlari yashirilmoqda...`
    );

    try {
      const { originalRights } = await restrictAmoRoleNewLeadAccess(
        manager.amoUserId,
        manager.amoRoleId
      );
      console.log(
        `[test_restrict] restrictAmoRoleNewLeadAccess OK: amoUserId=${manager.amoUserId} roleId=${manager.amoRoleId}`
      );

      await prisma.manager.update({
        where: { id: manager.id },
        data: {
          isAmoCrmRestricted: true,
          amoRightsBeforeRestriction: originalRights as unknown as Prisma.InputJsonValue,
        },
      });
      console.log(
        `[test_restrict] DB updated: manager ${manager.id} isAmoCrmRestricted=true savedRoleRights=true`
      );

      await bot.sendMessage(
        chatId,
        `✅ [TEST] ${manager.name} uchun cheklov qo'llandi:\n` +
          `• Role ID: ${manager.amoRoleId}\n` +
          `• Yashirilgan bosqichlar: Yangi lid\n\n` +
          `Menejer /ask orqali normani bajargach kirish huquqini tiklaydi.`
      );
    } catch (err: any) {
      const status = err.response?.status;
      const errMsg = err.message ?? "unknown error";
      const detail = err.response?.data
        ? (typeof err.response.data === "string"
            ? err.response.data.slice(0, 200)
            : JSON.stringify(err.response.data).slice(0, 200))
        : "";
      console.error(`[test_restrict] FAILED: status=${status} msg=${errMsg} detail=${detail}`);
      await bot.sendMessage(
        chatId,
        `❌ Cheklovni qo'llashda xatolik yuz berdi:\n${errMsg}${detail ? `\n${detail}` : ""}`
      );
      return;
    }
  },
});

defineAction({
  id: "test_restore", section: "users", order: 92, roles: [...ADMIN.roles], denyText: ADMIN.denyText, label: "Tiklash (test)", commandOnly: true,
  command: { pattern: /\/test_restore (.+)/, usage: "/test_restore <tg_id>", description: "menejerni tiklash" },
  async run(ctx) {
    const { restoreAmoRoleRights } = await import("../../services/amoRights");
    const { bot, chatId } = ctx;
    const tgId = ctx.args[0];
    const manager = await findLinkedManager(tgId);

    if (!manager) {
      await bot.sendMessage(chatId, `❌ Telegram ID ${tgId} bo'lgan menejer topilmadi.`);
      return;
    }
    if (!manager.isAmoCrmRestricted) {
      await bot.sendMessage(chatId, `⚠️ ${manager.name} hozir cheklanmagan.`);
      return;
    }

    if (!manager.amoRoleId) {
      await bot.sendMessage(chatId, `❌ ${manager.name} uchun amoRoleId saqlanmagan.`);
      return;
    }

    const saved = manager.amoRightsBeforeRestriction as AmoRoleRights | null;

    if (!saved) {
      await bot.sendMessage(chatId, `❌ ${manager.name} uchun saqlangan huquqlar topilmadi.`);
      return;
    }

    await restoreAmoRoleRights(manager.amoRoleId, saved);
    await prisma.manager.update({
      where: { id: manager.id },
      data: { isAmoCrmRestricted: false, amoRightsBeforeRestriction: Prisma.DbNull },
    });

    await bot.sendMessage(
      chatId,
      `✅ [TEST] ${manager.name} ning huquqlari tiklandi.`
    );
  },
});
