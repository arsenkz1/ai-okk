import { prisma } from "../config/database";
import { loadManagerPerformance } from "../services/performanceData";
import { deliverTeamPerformance, type TeamReportFile } from "../services/teamPerformanceDelivery";
import { amoUserIdMap } from "../services/amoDailyFacts";
import { buildCompanyTeam } from "../services/companyPerformance";

/**
 * The company report every administrator receives once a day.
 *
 * Administrators who are not the primary operator see only this and the
 * deal-move alerts, so this report has to stand on its own: call volume,
 * revenue, plan progress, and how many deals moved into Phoenix from which
 * pipeline.
 */

export interface AdminDailyReportResult {
  sent: boolean;
  managers: number;
  phoenixMoves: number;
  /** True when the manager table went out as an Excel file rather than in the text. */
  membersInFile: boolean;
}

function yesterdayRange(now: Date): { from: Date; to: Date; label: string } {
  const to = new Date(now);
  to.setHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - 1);
  return {
    from,
    to,
    label: `Kecha (${from.getDate()}.${String(from.getMonth() + 1).padStart(2, "0")})`,
  };
}

export interface SendAdminDailyReportDependencies {
  send: (text: string) => Promise<void>;
  /** Delivers the manager table as a file; without it the managers stay in the text. */
  sendFile?: (file: TeamReportFile) => Promise<void>;
  now?: () => Date;
}

export async function sendAdminDailyReport(
  dependencies: SendAdminDailyReportDependencies,
): Promise<AdminDailyReportResult> {
  const { from, to, label } = yesterdayRange(dependencies.now?.() ?? new Date());
  const managers = await prisma.manager.findMany({ where: { isActive: true }, select: { id: true, amoUserId: true } });

  const performance = await loadManagerPerformance({
    managerIds: managers.map((manager) => manager.id),
    range: { from, to },
  });

  const { team, phoenixTotal: phoenixMoves } = await buildCompanyTeam({
    title: "Kompaniya",
    label,
    range: { from, to },
    performance,
    amoUserIdByManagerId: amoUserIdMap(managers),
    logPrefix: "[AdminDailyReport]",
  });
  const { membersInFile } = await deliverTeamPerformance({
    team,
    sendText: dependencies.send,
    sendFile: dependencies.sendFile,
    logPrefix: "[AdminDailyReport]",
  });
  return { sent: true, managers: managers.length, phoenixMoves, membersInFile };
}
