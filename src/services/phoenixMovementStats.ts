import { prisma } from "../config/database";
import { INACTIVITY_SOURCE_PIPELINES, TARGET_PIPELINE_ID } from "./leadInactivityPolicy";
import { pipelineLabel } from "./dealDossier";

/**
 * How many deals the inactivity worker moved into the Phoenix (trainee)
 * pipeline, broken down by the pipeline they came from.
 *
 * The source of truth is the confirmed move audit, not the watch table: a watch
 * row is overwritten by later activity, while an audit row is the durable
 * record that a move actually happened.
 */

export interface PhoenixMovementRow {
  pipelineId: number;
  pipelineName: string;
  count: number;
}

export interface PhoenixMovementStats {
  rows: PhoenixMovementRow[];
  total: number;
  /** Moves whose amoCRM outcome could not be confirmed and need a human. */
  uncertain: number;
}

const PIPELINE_NAMES: ReadonlyMap<number, string> = new Map(
  INACTIVITY_SOURCE_PIPELINES.map(({ pipelineId, name }): [number, string] => [pipelineId, name]),
);

export function phoenixSourceName(pipelineId: number | null): string {
  if (pipelineId === null) return "воронка неизвестна";
  return PIPELINE_NAMES.get(pipelineId) ?? pipelineLabel(pipelineId);
}

export async function loadPhoenixMovements(range: { from: Date; to: Date }): Promise<PhoenixMovementStats> {
  const audits = await prisma.leadInactivityMoveAudit.findMany({
    where: {
      targetPipelineId: TARGET_PIPELINE_ID,
      outcome: { in: ["confirmed", "uncertain"] },
      // completedAt marks when the outcome became final; createdAt only marks
      // when the attempt was reserved.
      completedAt: { gte: range.from, lt: range.to },
    },
    select: { outcome: true, sourcePipelineId: true },
  });

  const counter = new Map<number | null, number>();
  let uncertain = 0;
  for (const audit of audits) {
    if (audit.outcome === "uncertain") {
      uncertain += 1;
      continue;
    }
    const key = audit.sourcePipelineId ?? null;
    counter.set(key, (counter.get(key) ?? 0) + 1);
  }

  const rows: PhoenixMovementRow[] = [...counter.entries()]
    .map(([pipelineId, count]) => ({
      pipelineId: pipelineId ?? 0,
      pipelineName: phoenixSourceName(pipelineId),
      count,
    }))
    .sort((left, right) => right.count - left.count || left.pipelineName.localeCompare(right.pipelineName));

  return { rows, total: rows.reduce((sum, row) => sum + row.count, 0), uncertain };
}

/** Renders the Phoenix block; every source pipeline is listed with its count. */
export function formatPhoenixMovements(stats: PhoenixMovementStats): string[] {
  if (stats.total === 0 && stats.uncertain === 0) {
    return ["🔥 Феникс (стажёр): переводов не было"];
  }

  const lines = [`🔥 Феникс (стажёр): ${stats.total} сделок`];
  for (const row of stats.rows) {
    lines.push(`• ${row.pipelineName}: ${row.count}`);
  }
  if (stats.uncertain > 0) {
    lines.push(`⚠️ Неподтверждённых переводов: ${stats.uncertain} — требуется проверка вручную`);
  }
  return lines;
}
