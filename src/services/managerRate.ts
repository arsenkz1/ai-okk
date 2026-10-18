import { prisma } from "../config/database";

/**
 * A manager's fixed monthly rate for the salary calculator. Administrators
 * set it for anyone; a team lead only for members of their own team.
 */

export async function getManagerFixedRate(managerId: number): Promise<number | null> {
  const manager = await prisma.manager.findUnique({ where: { id: managerId }, select: { fixedMonthlyRate: true } });
  return manager?.fixedMonthlyRate === null || manager?.fixedMonthlyRate === undefined ? null : Number(manager.fixedMonthlyRate);
}

export interface RateTarget {
  id: number;
  name: string;
  teamId: number | null;
  role: string;
}

export async function findRateTargetByAmoId(amoUserId: number): Promise<RateTarget | null> {
  return prisma.manager.findUnique({ where: { amoUserId }, select: { id: true, name: true, teamId: true, role: true } });
}

/** Ids of the teams a lead runs: the one they head and, if any, the one they belong to. */
export async function teamIdsLedBy(lead: { id: number; teamId: number | null }): Promise<number[]> {
  const teams = await prisma.team.findMany({
    where: { OR: [{ teamLeadId: lead.id }, ...(lead.teamId ? [{ id: lead.teamId }] : [])] },
    select: { id: true },
  });
  return teams.map((team) => team.id);
}

/** Pure: may this lead, running these teams, set the rate of this manager? */
export function leadMaySetRate(ledTeamIds: readonly number[], target: Pick<RateTarget, "teamId">): boolean {
  return target.teamId !== null && ledTeamIds.includes(target.teamId);
}

export async function setManagerFixedRate(managerId: number, amount: number): Promise<void> {
  await prisma.manager.update({ where: { id: managerId }, data: { fixedMonthlyRate: BigInt(Math.round(amount)) } });
}

/** Active members with an amoCRM id of the teams a lead runs, for the picker. */
export async function loadTeamMembersForRate(lead: { id: number; teamId: number | null }): Promise<Array<{ amoUserId: number; name: string }>> {
  const teamIds = await teamIdsLedBy(lead);
  if (teamIds.length === 0) return [];
  const rows = await prisma.manager.findMany({
    where: { teamId: { in: teamIds }, isActive: true, amoUserId: { not: null } },
    orderBy: { name: "asc" },
    select: { amoUserId: true, name: true },
  });
  return rows.flatMap((row) => (row.amoUserId === null ? [] : [{ amoUserId: row.amoUserId, name: row.name }]));
}
