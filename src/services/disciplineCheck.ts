import { prisma } from "../config/database";
import { getAmoUserRoleId, setAmoUserRole, AMO_RESTRICTED_ROLE_ID } from "./amoRights";

const MIN_SESSION_WORDS = 10;

export async function runDisciplineCheck(
  sendFn: (chatId: string, text: string) => Promise<void>
): Promise<{ restricted: number; skipped: number; errors: number }> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const managers = await prisma.manager.findMany({
    where: {
      isActive: true,
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
      const sessionsToday = await prisma.aiTrainerSession.findMany({
        where: { managerId: manager.id, createdAt: { gte: todayStart } },
        select: { question: true },
      });
      const hasValidSession = sessionsToday.some(
        (s) => s.question.split(/\s+/).filter(Boolean).length >= MIN_SESSION_WORDS
      );
      if (hasValidSession) {
        skipped++;
        continue;
      }

      const currentRoleId = await getAmoUserRoleId(manager.amoUserId!);
      if (!currentRoleId) {
        console.warn(`[Discipline] Could not fetch role for manager ${manager.id}, skipping`);
        errors++;
        continue;
      }

      // Skip if already on restricted role (safety check)
      if (currentRoleId === AMO_RESTRICTED_ROLE_ID) {
        skipped++;
        continue;
      }

      await setAmoUserRole(manager.amoUserId!, AMO_RESTRICTED_ROLE_ID);
      await prisma.manager.update({
        where: { id: manager.id },
        data: {
          isAmoCrmRestricted: true,
          amoRightsBeforeRestriction: { roleId: currentRoleId },
        },
      });

      const chatId = manager.telegramLinks[0]?.telegramUserId;
      if (chatId) {
        await sendFn(
          chatId,
          "🔒 Ваш доступ в amoCRM ограничен — вы видите только свои лиды.\n" +
            "Для восстановления пройдите AI-сессию: /ask\n" +
            "_(Отправьте осмысленный вопрос минимум из 10 слов)_"
        ).catch((e) =>
          console.error(`[Discipline] Notify failed for manager ${manager.id}:`, e.message)
        );
      }

      restricted++;
      console.log(`[Discipline] Restricted manager ${manager.id} (${manager.name}), savedRoleId=${currentRoleId}`);
    } catch (err: any) {
      console.error(`[Discipline] Error processing manager ${manager.id}:`, err.message);
      errors++;
    }
  }

  return { restricted, skipped, errors };
}
