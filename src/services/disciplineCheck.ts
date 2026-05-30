import { Prisma } from "../generated/prisma/client";
import { prisma } from "../config/database";
import {
  MIN_DISCIPLINE_MESSAGES_PER_DAY,
  MIN_DISCIPLINE_MESSAGE_WORDS,
} from "../config/disciplinePilot";
import {
  AmoRoleRights,
  restrictAmoRoleNewLeadAccess,
  restoreAmoRoleRights,
} from "./amoRights";
import { notifyAdmins } from "../bot/notify";

function startOfToday(): Date {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return todayStart;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export async function countValidAiMessagesToday(managerId: number): Promise<number> {
  const sessionsToday = await prisma.aiTrainerSession.findMany({
    where: { managerId, createdAt: { gte: startOfToday() } },
    select: { question: true },
  });

  return sessionsToday.filter((session) => countWords(session.question) >= MIN_DISCIPLINE_MESSAGE_WORDS).length;
}

export async function maybeRestorePilotManagerAccess(
  managerId: number
): Promise<boolean> {
  const manager = await prisma.manager.findUnique({ where: { id: managerId } });
  if (!manager?.isDisciplinePilot || !manager.isAmoCrmRestricted || !manager.amoRoleId) {
    return false;
  }

  const validMessages = await countValidAiMessagesToday(managerId);
  if (validMessages < MIN_DISCIPLINE_MESSAGES_PER_DAY) {
    return false;
  }

  const savedRights = manager.amoRightsBeforeRestriction as AmoRoleRights | null;
  if (!savedRights) {
    throw new Error(`Missing saved role rights snapshot for manager ${manager.id}`);
  }

  await restoreAmoRoleRights(manager.amoRoleId, savedRights);
  await prisma.manager.update({
    where: { id: manager.id },
    data: {
      isAmoCrmRestricted: false,
      amoRightsBeforeRestriction: Prisma.DbNull,
    },
  });

  return true;
}

export async function runDisciplineCheck(
  sendFn: (chatId: string, text: string) => Promise<void>
): Promise<{ restricted: number; skipped: number; errors: number }> {
  const managers = await prisma.manager.findMany({
    where: {
      isActive: true,
      isDisciplinePilot: true,
      isAmoCrmRestricted: false,
      amoUserId: { not: null },
    },
    include: {
      telegramLinks: { where: { status: "used" }, take: 1 },
    },
  });

  let restricted = 0;
  let skipped = 0;
  let errors = 0;

  for (const manager of managers) {
    try {
      const validMessages = await countValidAiMessagesToday(manager.id);
      if (validMessages >= MIN_DISCIPLINE_MESSAGES_PER_DAY) {
        skipped++;
        continue;
      }

      if (!manager.amoRoleId) {
        const reason = `Pilot manager ${manager.name} (${manager.id}) has no amoRoleId`;
        console.warn(`[Discipline] ${reason}`);
        await notifyAdmins(`⚠️ ${reason}`).catch(() => {});
        errors++;
        continue;
      }

      const { originalRights } = await restrictAmoRoleNewLeadAccess(manager.amoUserId!, manager.amoRoleId);
      await prisma.manager.update({
        where: { id: manager.id },
        data: {
          isAmoCrmRestricted: true,
          amoRightsBeforeRestriction: originalRights as unknown as Prisma.InputJsonValue,
        },
      });

      const chatId = manager.telegramLinks[0]?.telegramUserId;
      if (chatId) {
        await sendFn(
          chatId,
          `Cheklov: amoCRM dagi kirish huquqingiz vaqtincha cheklandi: "Yangi lid" bosqichlari yashirildi.\n` +
            `Bugun soat 11:00 gacha normani bajarmagansiz.\n` +
            `Kirishni tiklash uchun AI-sessiyada ${MIN_DISCIPLINE_MESSAGES_PER_DAY} ta mazmunli xabar yuboring,\n` +
            `har biri kamida ${MIN_DISCIPLINE_MESSAGE_WORDS} ta so'z bo'lsin. Normani bajarganingizdan keyin kirish avtomatik tiklanadi.`
        ).catch((e) =>
          console.error(`[Discipline] Notify failed for manager ${manager.id}:`, e.message)
        );
      }

      restricted++;
      console.log(
        `[Discipline] Restricted pilot manager ${manager.id} (${manager.name}), roleId=${manager.amoRoleId}`
      );
    } catch (err: any) {
      console.error(`[Discipline] Error processing manager ${manager.id}:`, err.message);
      await notifyAdmins(
        `⚠️ Discipline restriction failed for ${manager.name} (${manager.amoUserId ?? manager.id})\n${err.message}`
      ).catch(() => {});
      errors++;
    }
  }

  return { restricted, skipped, errors };
}
