import { prisma } from "../config/database";

type Manager = Awaited<ReturnType<typeof prisma.manager.findUniqueOrThrow>>;

export interface ManagerWithScore {
  manager: Manager;
  avgScore: number | null;
}

export interface ManagerCard {
  name: string;
  avgScore: number | null;
  rankInTeam: number;
  teamSize: number;
  strengths: string[];
  weaknesses: string[];
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function getManagerAvgScore(
  managerId: number,
  days = 7
): Promise<number | null> {
  const from = daysAgo(days);
  const calls = await prisma.call.findMany({
    where: { managerId, processingStatus: "processed", startedAt: { gte: from } },
    include: { analysis: true },
  });
  const scores = calls
    .map((c) => c.analysis?.overallScore)
    .filter((s): s is number => s != null);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export async function getTeamRating(
  teamId: number,
  days = 7
): Promise<ManagerWithScore[]> {
  const managers = await prisma.manager.findMany({
    where: { teamId, isActive: true },
    orderBy: { name: "asc" },
  });
  const results: ManagerWithScore[] = await Promise.all(
    managers.map(async (m) => ({
      manager: m,
      avgScore: await getManagerAvgScore(m.id, days),
    }))
  );
  return results.sort((a, b) => {
    if (a.avgScore == null && b.avgScore == null) return 0;
    if (a.avgScore == null) return 1;
    if (b.avgScore == null) return -1;
    return b.avgScore - a.avgScore;
  });
}

export async function getAllManagerRating(days = 7): Promise<ManagerWithScore[]> {
  const managers = await prisma.manager.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
  const results: ManagerWithScore[] = await Promise.all(
    managers.map(async (m) => ({
      manager: m,
      avgScore: await getManagerAvgScore(m.id, days),
    }))
  );
  return results.sort((a, b) => {
    if (a.avgScore == null && b.avgScore == null) return 0;
    if (a.avgScore == null) return 1;
    if (b.avgScore == null) return -1;
    return b.avgScore - a.avgScore;
  });
}

async function aggregateMistakes(
  managerIds: number[],
  days: number,
  top: number
): Promise<Array<{ mistake: string; count: number }>> {
  if (!managerIds.length) return [];
  const from = daysAgo(days);
  const calls = await prisma.call.findMany({
    where: {
      managerId: { in: managerIds },
      processingStatus: "processed",
      startedAt: { gte: from },
    },
    include: { analysis: { select: { weaknesses: true } } },
  });
  const counter = new Map<string, number>();
  for (const call of calls) {
    const weaknesses = call.analysis?.weaknesses as string[] | null;
    if (!Array.isArray(weaknesses)) continue;
    for (const w of weaknesses) {
      if (typeof w === "string" && w.trim()) {
        counter.set(w, (counter.get(w) ?? 0) + 1);
      }
    }
  }
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([mistake, count]) => ({ mistake, count }));
}

export async function getTeamMistakes(
  teamId: number,
  days = 7,
  top = 10
): Promise<Array<{ mistake: string; count: number }>> {
  const managers = await prisma.manager.findMany({
    where: { teamId, isActive: true },
    select: { id: true },
  });
  return aggregateMistakes(managers.map((m) => m.id), days, top);
}

export async function getAllMistakes(
  days = 7,
  top = 10
): Promise<Array<{ mistake: string; count: number }>> {
  const managers = await prisma.manager.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  return aggregateMistakes(managers.map((m) => m.id), days, top);
}

export async function buildManagerCard(managerId: number): Promise<ManagerCard> {
  const manager = await prisma.manager.findUniqueOrThrow({ where: { id: managerId } });
  const avgScore = await getManagerAvgScore(managerId, 7);

  let rankInTeam = 1;
  let teamSize = 1;
  if (manager.teamId) {
    const teamRating = await getTeamRating(manager.teamId, 7);
    teamSize = teamRating.length;
    const idx = teamRating.findIndex((r) => r.manager.id === managerId);
    rankInTeam = idx >= 0 ? idx + 1 : teamSize;
  }

  const from = daysAgo(7);
  const calls = await prisma.call.findMany({
    where: { managerId, processingStatus: "processed", startedAt: { gte: from } },
    include: { analysis: { select: { strengths: true, weaknesses: true } } },
  });

  const strengthCounter = new Map<string, number>();
  const weaknessCounter = new Map<string, number>();
  for (const call of calls) {
    const s = call.analysis?.strengths as string[] | null;
    const w = call.analysis?.weaknesses as string[] | null;
    if (Array.isArray(s)) s.forEach((x) => strengthCounter.set(x, (strengthCounter.get(x) ?? 0) + 1));
    if (Array.isArray(w)) w.forEach((x) => weaknessCounter.set(x, (weaknessCounter.get(x) ?? 0) + 1));
  }

  const topStrengths = [...strengthCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s]) => s);
  const topWeaknesses = [...weaknessCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);

  return {
    name: manager.name,
    avgScore,
    rankInTeam,
    teamSize,
    strengths: topStrengths,
    weaknesses: topWeaknesses,
  };
}
