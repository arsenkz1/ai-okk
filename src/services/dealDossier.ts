import { prisma } from "../config/database";
import { INACTIVITY_SOURCE_PIPELINES } from "./leadInactivityPolicy";

/**
 * Deal dossier for the Telegram bot: every analyzed call on one amoCRM deal,
 * the mistakes that repeated across them, and the AI recommendations from the
 * most recent call. Formatting is kept pure so the reviewer-visible text is
 * unit-testable without a database.
 */

export const DEAL_DOSSIER_MAX_CALLS = 5;
export const DEAL_DOSSIER_MAX_MISTAKES = 5;

/** Pipeline names already known to the codebase; unknown IDs render as numbers. */
const PIPELINE_NAMES: ReadonlyMap<number, string> = new Map([
  ...INACTIVITY_SOURCE_PIPELINES.map(({ pipelineId, name }): [number, string] => [pipelineId, name]),
  [8425422, "WB"],
  [10630306, "Бухгалтерия"],
  [10734414, "AI"],
  [9055770, "Феникс"],
]);

export interface DealDossierCall {
  id: number;
  managerId: number | null;
  startedAt: Date;
  durationSeconds: number;
  managerName: string | null;
  overallScore: number | null;
  weaknesses: string[];
  clientRecommendations: string[];
  managerRecommendations: string[];
  recordUrl: string | null;
}

export interface DealDossier {
  dealId: number;
  dealName: string | null;
  pipelineId: number | null;
  statusId: number | null;
  contactName: string | null;
  phones: string[];
  calls: DealDossierCall[];
  analyzedCalls: number;
  avgScore: number | null;
  topMistakes: Array<{ mistake: string; count: number }>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * `recommendations` is stored as `{ client, manager }` by the call worker. Rows
 * written before that column was populated simply yield empty lists.
 */
function readRecommendations(value: unknown): { client: string[]; manager: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { client: [], manager: [] };
  const raw = value as Record<string, unknown>;
  return { client: asStringArray(raw.client), manager: asStringArray(raw.manager) };
}

export function pipelineLabel(pipelineId: number | null | undefined): string {
  if (typeof pipelineId !== "number") return "—";
  return PIPELINE_NAMES.get(pipelineId) ?? `#${pipelineId}`;
}

export async function loadDealDossier(dealId: number): Promise<DealDossier | null> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      contact: { select: { name: true } },
      phoneMappings: { select: { phoneNormalized: true }, take: 5 },
    },
  });

  const calls = await prisma.call.findMany({
    where: { dealId },
    include: {
      analysis: { select: { overallScore: true, weaknesses: true, recommendations: true } },
      manager: { select: { id: true, name: true } },
    },
    orderBy: { startedAt: "desc" },
  });

  // A deal with no local row can still be reported on when its calls are known.
  if (!deal && calls.length === 0) return null;

  const dossierCalls: DealDossierCall[] = calls.map((call) => {
    const recommendations = readRecommendations(call.analysis?.recommendations);
    return {
      id: call.id,
      managerId: call.manager?.id ?? null,
      startedAt: call.startedAt,
      durationSeconds: call.durationSeconds,
      managerName: call.manager?.name ?? null,
      overallScore: call.analysis?.overallScore ?? null,
      weaknesses: asStringArray(call.analysis?.weaknesses),
      clientRecommendations: recommendations.client,
      managerRecommendations: recommendations.manager,
      recordUrl: call.recordUrl,
    };
  });

  const scores = dossierCalls
    .map((call) => call.overallScore)
    .filter((score): score is number => typeof score === "number");

  const mistakeCounter = new Map<string, number>();
  for (const call of dossierCalls) {
    for (const mistake of call.weaknesses) {
      mistakeCounter.set(mistake, (mistakeCounter.get(mistake) ?? 0) + 1);
    }
  }

  return {
    dealId,
    dealName: deal?.name ?? null,
    pipelineId: deal?.pipelineId ?? null,
    statusId: deal?.statusId ?? null,
    contactName: deal?.contact?.name ?? null,
    phones: deal?.phoneMappings.map((mapping) => mapping.phoneNormalized) ?? [],
    calls: dossierCalls,
    analyzedCalls: scores.length,
    avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    topMistakes: [...mistakeCounter.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, DEAL_DOSSIER_MAX_MISTAKES)
      .map(([mistake, count]) => ({ mistake, count })),
  };
}

export type DealDossierViewerRole = "ADMIN" | "ROP" | "TEAMLEAD" | "MANAGER";

export interface DealDossierViewer {
  role: DealDossierViewerRole;
  managerId: number | null;
  /** Manager IDs the viewer supervises; only consulted for TEAMLEAD. */
  teamManagerIds?: readonly number[];
}

/**
 * Admins and ROPs see every deal. A team lead sees a deal only when one of the
 * calls on it belongs to their team, and a manager only their own calls — the
 * dossier exposes call scores, so it must not widen who can read them.
 */
export function canViewDealDossier(
  viewer: DealDossierViewer,
  calls: readonly Pick<DealDossierCall, "managerId">[],
): boolean {
  if (viewer.role === "ADMIN" || viewer.role === "ROP") return true;
  if (viewer.managerId === null) return false;
  const allowed = new Set<number>([viewer.managerId]);
  if (viewer.role === "TEAMLEAD") {
    for (const managerId of viewer.teamManagerIds ?? []) allowed.add(managerId);
  }
  return calls.some((call) => call.managerId !== null && allowed.has(call.managerId));
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}d ${rest}s` : `${rest}s`;
}

function formatDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const field = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${field.day}.${field.month} ${field.hour}:${field.minute}`;
}

export function formatDealDossier(dossier: DealDossier): string {
  const lines: string[] = [`🗂 Bitim #${dossier.dealId}`];
  if (dossier.dealName) lines.push(dossier.dealName);

  const client = [dossier.contactName, dossier.phones[0]].filter(Boolean).join(" · ");
  if (client) lines.push(`👤 ${client}`);
  if (dossier.pipelineId !== null) {
    lines.push(`📂 Voronka: ${pipelineLabel(dossier.pipelineId)} · Bosqich: ${dossier.statusId ?? "—"}`);
  }
  lines.push(`🔗 https://qadamsales.amocrm.ru/leads/detail/${dossier.dealId}`);

  if (dossier.calls.length === 0) {
    lines.push("", "📞 Bu bitim bo'yicha tahlil qilingan qo'ng'iroq yo'q.");
    return lines.join("\n");
  }

  lines.push(
    "",
    `📞 Qo'ng'iroqlar: ${dossier.calls.length}` +
    (dossier.avgScore !== null ? ` · ⭐ O'rtacha ball: ${dossier.avgScore}/100` : ""),
  );

  if (dossier.topMistakes.length > 0) {
    lines.push("", "⚠️ Takrorlangan xatolar:");
    for (const { mistake, count } of dossier.topMistakes) {
      lines.push(count > 1 ? `• ${mistake} (${count}×)` : `• ${mistake}`);
    }
  }

  // Recommendations come from the most recent call that produced any: older
  // advice is usually superseded by what happened on the latest conversation.
  const latestWithAdvice = dossier.calls.find(
    (call) => call.clientRecommendations.length > 0 || call.managerRecommendations.length > 0,
  );
  if (latestWithAdvice) {
    if (latestWithAdvice.clientRecommendations.length > 0) {
      lines.push("", "🤖 Mijoz bo'yicha keyingi qadamlar:");
      lines.push(...latestWithAdvice.clientRecommendations.map((item) => `• ${item}`));
    }
    if (latestWithAdvice.managerRecommendations.length > 0) {
      lines.push("", "🤖 Menejerga tavsiyalar:");
      lines.push(...latestWithAdvice.managerRecommendations.map((item) => `• ${item}`));
    }
  }

  lines.push("", "🕘 Qo'ng'iroqlar tarixi:");
  for (const call of dossier.calls.slice(0, DEAL_DOSSIER_MAX_CALLS)) {
    const score = call.overallScore !== null ? `${Math.round(call.overallScore)}/100` : "tahlil yo'q";
    const manager = call.managerName ? ` · ${call.managerName}` : "";
    lines.push(`• ${formatDate(call.startedAt)} · ${formatDuration(call.durationSeconds)} · ${score}${manager}`);
  }
  if (dossier.calls.length > DEAL_DOSSIER_MAX_CALLS) {
    lines.push(`… yana ${dossier.calls.length - DEAL_DOSSIER_MAX_CALLS} ta qo'ng'iroq`);
  }

  return lines.join("\n");
}
