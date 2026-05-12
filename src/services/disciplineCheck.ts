import { prisma } from "../config/database";
import { getAmoUserRoleId, setAmoUserRole, AMO_RESTRICTED_ROLE_ID } from "./amoRights";

const MIN_SESSION_WORDS = 10;

export async function runDisciplineCheck(
  sendFn: (chatId: string, text: string) => Promise<void>
): Promise<{ restricted: number; skipped: number; errors: number }> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Only process active managers not already restricted
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
      // Check if manager has a valid AI session today (>=10 words)
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

      // Save current role before restricting (don't overwrite if already restricted — guarded by query filter above)
      const currentRoleId = await getAmoUserRoleId(manager.amoUserId!);
      if (!currentRoleId) {
        console.warn(`[Discipline] Could not fetch role for manager ${manager.id}, skipping`);
        errors++;
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
          "🔒 Ваш доступ в amoCRM ограничен — роль изменена до конца дня.\n" +
            "Для восстановления пройдите AI-сессию: /ask\n" +
            "_(Отправьте осмысленный вопрос минимум из 10 слов)_"
        ).catch((e) =>
          console.error(`[Discipline] Notify failed for manager ${manager.id}:`, e.message)
        );
      }

      restricted++;
      console.log(`[Discipline] Restricted manager ${manager.id} (${manager.name}), saved roleId=${currentRoleId}`);
    } catch (err: any) {
      console.error(`[Discipline] Error processing manager ${manager.id}:`, err.message);
      errors++;
    }
  }

  return { restricted, skipped, errors };
}
