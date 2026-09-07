import { prisma } from "../config/database";
import { classifyRevenueStage, type RevenueKind, type RevenueStageRef } from "./salesRevenuePolicy";

/**
 * Discovers the revenue-bearing stages of every amoCRM pipeline and keeps them
 * in the database for the webhook to consult.
 *
 * The IDs cannot be hardcoded: only UZUM's "Часть оплачена" was ever known, so
 * part-payments in every other pipeline were silently invisible to the report.
 */

export interface DiscoveredRevenueStage {
  pipelineId: number;
  statusId: number;
  kind: RevenueKind;
  pipelineName: string;
  statusName: string;
}

export interface RevenueStageSyncResult {
  pipelines: number;
  stages: DiscoveredRevenueStage[];
  /** Stored stages amoCRM no longer has; they are removed. */
  removed: number;
}

/**
 * Extracts revenue stages out of the amoCRM pipelines payload. Kept pure so the
 * classification is testable against a real response shape.
 */
export function collectRevenueStages(pipelinesPayload: unknown): {
  pipelines: number;
  stages: DiscoveredRevenueStage[];
} {
  const pipelines = (pipelinesPayload as { _embedded?: { pipelines?: unknown } } | null)?._embedded?.pipelines;
  if (!Array.isArray(pipelines)) throw new Error("amoCRM pipelines response is malformed");

  const stages: DiscoveredRevenueStage[] = [];
  for (const rawPipeline of pipelines) {
    const pipeline = rawPipeline as {
      id?: unknown;
      name?: unknown;
      _embedded?: { statuses?: unknown };
    } | null;
    const pipelineId = Number(pipeline?.id);
    if (!Number.isInteger(pipelineId) || pipelineId <= 0) continue;
    const pipelineName = typeof pipeline?.name === "string" ? pipeline.name.trim() : `#${pipelineId}`;

    const statuses = pipeline?._embedded?.statuses;
    if (!Array.isArray(statuses)) continue;

    for (const rawStatus of statuses) {
      const status = rawStatus as { id?: unknown; name?: unknown; type?: unknown } | null;
      const statusId = Number(status?.id);
      const statusName = typeof status?.name === "string" ? status.name.trim() : "";
      if (!Number.isInteger(statusId) || statusId <= 0 || !statusName) continue;

      const statusType = Number.isInteger(Number(status?.type)) ? Number(status?.type) : null;
      const kind = classifyRevenueStage({ statusId, statusName, statusType });
      if (kind) stages.push({ pipelineId, statusId, kind, pipelineName, statusName });
    }
  }

  return { pipelines: pipelines.length, stages };
}

export interface SyncRevenueStagesDependencies {
  fetchPipelines: () => Promise<unknown>;
  now?: () => Date;
  database?: Pick<typeof prisma, "revenueStage">;
}

export async function syncRevenueStages(
  dependencies: SyncRevenueStagesDependencies,
): Promise<RevenueStageSyncResult> {
  const database = dependencies.database ?? prisma;
  const syncedAt = dependencies.now?.() ?? new Date();
  const { pipelines, stages } = collectRevenueStages(await dependencies.fetchPipelines());

  for (const stage of stages) {
    await database.revenueStage.upsert({
      where: { pipelineId_statusId: { pipelineId: stage.pipelineId, statusId: stage.statusId } },
      update: {
        kind: stage.kind,
        pipelineName: stage.pipelineName,
        statusName: stage.statusName,
        syncedAt,
      },
      create: { ...stage, syncedAt },
    });
  }

  // A stage renamed or deleted in amoCRM must stop counting as revenue, so
  // anything this pass did not see is dropped.
  const removed = await database.revenueStage.deleteMany({ where: { syncedAt: { lt: syncedAt } } });
  return { pipelines, stages, removed: removed.count };
}

export async function loadRevenueStages(
  database: Pick<typeof prisma, "revenueStage"> = prisma,
): Promise<RevenueStageRef[]> {
  const rows = await database.revenueStage.findMany({
    select: { pipelineId: true, statusId: true, kind: true },
  });
  return rows.map((row) => ({
    pipelineId: row.pipelineId,
    statusId: row.statusId,
    kind: row.kind as RevenueKind,
  }));
}

export function formatRevenueStageSync(result: RevenueStageSyncResult): string {
  const won = result.stages.filter((stage) => stage.kind === "won");
  const partial = result.stages.filter((stage) => stage.kind === "partial");

  const lines = [
    "✅ Этапы поступлений синхронизированы",
    "",
    `Воронок просмотрено: ${result.pipelines}`,
    `Найдено этапов: ${result.stages.length} (успешно: ${won.length}, часть оплачена: ${partial.length})`,
  ];

  if (partial.length > 0) {
    lines.push("", "💰 Часть оплачена:");
    for (const stage of partial) {
      lines.push(`• ${stage.pipelineName} — «${stage.statusName}» (${stage.statusId})`);
    }
  } else {
    // Without this line an empty revenue report looks like a bug rather than a
    // pipeline that simply has no such stage.
    lines.push("", "⚠️ Этап «Часть оплачена» не найден ни в одной воронке — проверьте название этапа в amoCRM.");
  }

  if (result.removed > 0) lines.push("", `🗑 Удалено устаревших этапов: ${result.removed}`);
  return lines.join("\n");
}
