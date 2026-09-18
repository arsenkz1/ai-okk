import { almatyCalendarDay } from "./leadInactivityDailyCap";
import {
  countByPipeline,
  moveSweepCandidates,
  selectSweepCandidates,
  type SweepCandidate,
  type SweepMoveDependencies,
  type SweepMoveResult,
} from "./inactivitySweep";
import type { AmoInactivityLead } from "./leadInactivityAmoClient";
import { phoenixSourceName } from "./phoenixMovementStats";

/**
 * Unattended nightly reconciliation: every lead idle for 3+ days moves to
 * Phoenix, whether or not the worker ever held a watch for it.
 *
 * Because nobody confirms this run, it refuses to start unless everything the
 * worker itself requires is true — enabled, production mode, not stopped — and
 * it runs once per Almaty day even with several replicas or a restart.
 */

export const NIGHTLY_SWEEP_DAY_SETTING_KEY = "lead_inactivity.nightly_sweep_day";

export type NightlySweepSkipReason = "worker_disabled" | "testing_mode" | "stopped" | "already_ran_today";

export type NightlySweepResult =
  | { kind: "skipped"; reason: NightlySweepSkipReason }
  | { kind: "nothing_to_move"; scanned: number }
  | { kind: "swept"; scanned: number; candidates: number; result: SweepMoveResult };

export interface NightlySweepDependencies extends SweepMoveDependencies {
  environment?: Record<string, string | undefined>;
  isStopped(): Promise<boolean>;
  /** Atomically claims the day; false when another replica or run already has. */
  claimDay(day: string): Promise<boolean>;
  listEligibleLeads(): Promise<AmoInactivityLead[]>;
  now?: () => Date;
}

export async function runNightlyInactivitySweep(dependencies: NightlySweepDependencies): Promise<NightlySweepResult> {
  const environment = dependencies.environment ?? process.env;
  if (environment.AMOCRM_INACTIVITY_WORKER_ENABLED?.trim().toLowerCase() !== "true") {
    return { kind: "skipped", reason: "worker_disabled" };
  }
  // Testing mode exists to cap real moves at five deals; an unbounded nightly
  // sweep would silently void that cap, so only explicit production mode runs.
  if (environment.TESTING_LEADS_MOVEMENT?.trim().toLowerCase() !== "false") {
    return { kind: "skipped", reason: "testing_mode" };
  }
  if (await dependencies.isStopped()) return { kind: "skipped", reason: "stopped" };

  const now = dependencies.now?.() ?? new Date();
  if (!await dependencies.claimDay(almatyCalendarDay(now))) return { kind: "skipped", reason: "already_ran_today" };

  const leads = await dependencies.listEligibleLeads();
  const candidates = selectSweepCandidates(leads, now);
  if (candidates.length === 0) return { kind: "nothing_to_move", scanned: leads.length };

  const result = await moveSweepCandidates(candidates, dependencies);
  return { kind: "swept", scanned: leads.length, candidates: candidates.length, result };
}

export interface NightlySweepDayDatabase {
  leadInactivitySetting: {
    createMany(args: { data: Array<{ key: string; value: string }>; skipDuplicates: boolean }): Promise<{ count: number }>;
    updateMany(args: { where: { key: string; value: { not: string } }; data: { value: string } }): Promise<{ count: number }>;
  };
}

/**
 * One row holds the last swept day. Either statement succeeding for exactly one
 * caller is what makes the claim atomic across replicas.
 */
export async function claimNightlySweepDay(day: string, database: NightlySweepDayDatabase): Promise<boolean> {
  const created = await database.leadInactivitySetting.createMany({
    data: [{ key: NIGHTLY_SWEEP_DAY_SETTING_KEY, value: day }],
    skipDuplicates: true,
  });
  if (created.count === 1) return true;
  const advanced = await database.leadInactivitySetting.updateMany({
    where: { key: NIGHTLY_SWEEP_DAY_SETTING_KEY, value: { not: day } },
    data: { value: day },
  });
  return advanced.count === 1;
}

/** What every administrator sees: which deals moved, by pipeline and by ID. */
export function formatSweepMovedSummary(title: string, moved: readonly SweepCandidate[]): string {
  const lines = [
    `🔥 ${title}: переведено в Феникс ${moved.length} сделок`,
    ...countByPipeline(moved).map(({ pipelineId, count }) => `• ${phoenixSourceName(pipelineId)}: ${count}`),
    "",
    moved.map((candidate) => `#${candidate.leadId}`).join(" "),
  ];
  return lines.join("\n");
}

/** Full outcome for the operator, including everything that did NOT move. */
export function formatNightlySweepReport(result: NightlySweepResult): string | null {
  if (result.kind === "skipped") return null;
  if (result.kind === "nothing_to_move") {
    return `🌙 Сверка неактивности 22:00: лидов без касаний 3+ дней нет (проверено: ${result.scanned}).`;
  }
  const { result: sweep } = result;
  const lines = [
    `🌙 Сверка неактивности 22:00: переведено ${sweep.moved} из ${result.candidates} (проверено: ${result.scanned})`,
  ];
  if (sweep.skippedRecentTouch > 0) lines.push(`• пропущено — по истории было касание за последние 3 дня: ${sweep.skippedRecentTouch}`);
  if (sweep.notMoved > 0) lines.push(`• не переведены — сделка изменилась между проверкой и переносом: ${sweep.notMoved}`);
  if (sweep.guardFailed > 0) lines.push(`• ⚠️ не удалось проверить историю, сделки не тронуты: ${sweep.guardFailed}`);
  if (sweep.uncertain > 0) lines.push(`• ⚠️ неопределённый ответ amoCRM: ${sweep.uncertain} — проверьте сделку вручную`);
  if (sweep.stoppedAt) {
    const left = result.candidates - sweep.stoppedAt.index;
    lines.push(
      sweep.stoppedAt.reason === "uncertain"
        ? `⛔ Остановлено после неопределённого ответа; не обработано: ${left}. Продолжит завтрашняя сверка.`
        : `⛔ Остановлено командой /inactivity_off; не обработано: ${left}.`,
    );
  }
  return lines.join("\n");
}
