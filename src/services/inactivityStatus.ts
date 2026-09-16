import { prisma } from "../config/database";
import { getInactivityMovementSwitch } from "./inactivityMovementSwitch";
import { almatyDailyMovementBucket, dailyMovementLimitForBucket } from "./leadInactivityDailyCap";
import {
  ACTIVATION_BOUNDARY_SETTING_KEY,
  DAILY_MOVEMENT_OPERATIONAL_START_DATE_SETTING_KEY,
  PRODUCTION_BASELINE_COMPLETED_SETTING_KEY,
  TESTING_LEADS_MOVEMENT_LIMIT,
} from "./leadInactivityStore";

/**
 * Why the inactivity worker is or is not moving leads right now.
 *
 * "It looks like it isn't working" has half a dozen distinct causes, each of
 * which is visible in the database but nowhere else: the worker is off, it is
 * in testing mode with its five slots spent, the production baseline never
 * completed, the daily cap is exhausted, an uncertain outcome stopped a pass,
 * or nothing is due yet. This turns those into one answer.
 */

export interface InactivityStatusSnapshot {
  workerEnabled: boolean;
  /** Operator pause switch; independent of the environment flag. */
  movementPaused: boolean;
  /** True once the operator switched moves on: the 100-per-day cap is off. */
  dailyCapDisabled: boolean;
  /** null when the mode variable is missing or malformed. */
  testingMode: boolean | null;
  activationBoundary: Date | null;
  baselineComplete: boolean;
  operationalStartDate: string | null;
  watchesByState: Record<string, number>;
  dueNow: number;
  dailyBucket: string | null;
  dailyLimit: number | null;
  dailyUsed: number;
  auditsLast24h: Record<string, number>;
  testSlotsUsed: number;
}

export function readInactivityWorkerEnv(
  environment: Record<string, string | undefined> = process.env,
): { workerEnabled: boolean; testingMode: boolean | null } {
  const enabled = environment.AMOCRM_INACTIVITY_WORKER_ENABLED?.trim().toLowerCase() === "true";
  const rawMode = environment.TESTING_LEADS_MOVEMENT?.trim().toLowerCase();
  const testingMode = rawMode === "true" ? true : rawMode === "false" ? false : null;
  return { workerEnabled: enabled, testingMode };
}

export async function loadInactivityStatus(
  now = new Date(),
  environment: Record<string, string | undefined> = process.env,
): Promise<InactivityStatusSnapshot> {
  const { workerEnabled, testingMode } = readInactivityWorkerEnv(environment);

  const [movementSwitch, settings, states, dueNow, audits, testSlots] = await Promise.all([
    getInactivityMovementSwitch(),
    prisma.leadInactivitySetting.findMany({
      where: {
        key: {
          in: [
            ACTIVATION_BOUNDARY_SETTING_KEY,
            PRODUCTION_BASELINE_COMPLETED_SETTING_KEY,
            DAILY_MOVEMENT_OPERATIONAL_START_DATE_SETTING_KEY,
          ],
        },
      },
    }),
    prisma.leadInactivityWatch.groupBy({ by: ["state"], _count: { _all: true } }),
    prisma.leadInactivityWatch.count({ where: { state: "watching", dueAt: { lte: now } } }),
    prisma.leadInactivityMoveAudit.groupBy({
      by: ["outcome"],
      where: { createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
      _count: { _all: true },
    }),
    prisma.leadInactivityTestSlot.count({ where: { state: { in: ["confirmed", "uncertain"] } } }),
  ]);

  const setting = (key: string): string | null => settings.find((row) => row.key === key)?.value ?? null;
  const boundaryRaw = setting(ACTIVATION_BOUNDARY_SETTING_KEY);
  const activationBoundary = boundaryRaw && !Number.isNaN(new Date(boundaryRaw).getTime()) ? new Date(boundaryRaw) : null;
  const operationalStartDate = setting(DAILY_MOVEMENT_OPERATIONAL_START_DATE_SETTING_KEY);

  let dailyBucket: string | null = null;
  let dailyLimit: number | null = null;
  let dailyUsed = 0;
  if (operationalStartDate) {
    try {
      dailyBucket = almatyDailyMovementBucket(now, operationalStartDate);
      dailyLimit = dailyMovementLimitForBucket(dailyBucket);
      dailyUsed = await prisma.leadInactivityDailyMovementSlot.count({
        where: { bucketDate: dailyBucket, state: { in: ["reserved", "confirmed", "uncertain"] } },
      });
    } catch {
      dailyBucket = null;
    }
  }

  return {
    workerEnabled,
    movementPaused: movementSwitch.paused,
    dailyCapDisabled: movementSwitch.dailyCapDisabled,
    testingMode,
    activationBoundary,
    baselineComplete: setting(PRODUCTION_BASELINE_COMPLETED_SETTING_KEY) !== null,
    operationalStartDate,
    watchesByState: Object.fromEntries(states.map((row) => [row.state, row._count._all])),
    dueNow,
    dailyBucket,
    dailyLimit,
    dailyUsed,
    auditsLast24h: Object.fromEntries(audits.map((row) => [row.outcome, row._count._all])),
    testSlotsUsed: testSlots,
  };
}

/**
 * Names the first thing that stops leads from moving, in the order the worker
 * itself checks them. Returns null when nothing is blocking.
 */
export function diagnoseInactivity(status: InactivityStatusSnapshot): string | null {
  if (!status.workerEnabled) {
    return "Воркер выключен: AMOCRM_INACTIVITY_WORKER_ENABLED не равен true — переводов не будет вообще.";
  }
  if (status.movementPaused) {
    return "Переводы остановлены командой /inactivity_off: очередь сброшена, новые касания не отслеживаются. Включить: /inactivity_on.";
  }
  if (status.testingMode === null) {
    return "TESTING_LEADS_MOVEMENT не задан или задан не true/false — воркер падает при старте.";
  }
  if (status.testingMode) {
    if (status.testSlotsUsed >= TESTING_LEADS_MOVEMENT_LIMIT) {
      return `Тестовый режим: все ${TESTING_LEADS_MOVEMENT_LIMIT} тестовых слотов израсходованы, дальше переводов не будет. Для боевого режима нужен TESTING_LEADS_MOVEMENT=false.`;
    }
    return `Тестовый режим: потолок ${TESTING_LEADS_MOVEMENT_LIMIT} сделок всего, использовано ${status.testSlotsUsed}.`;
  }
  if (!status.activationBoundary) {
    return "Не инициализирована граница активации — события лидов игнорируются. Нужен lead-inactivity:activate.";
  }
  if (!status.baselineComplete) {
    return "Боевой режим заблокирован: production baseline не завершён. Каждый проход воркера падает. Нужен lead-inactivity:baseline-production.";
  }
  if ((status.watchesByState.uncertain ?? 0) > 0) {
    return `Есть ${status.watchesByState.uncertain} лидов в состоянии uncertain — они выпали из очереди навсегда, и любой uncertain обрывает проход. Требуется ручной разбор.`;
  }
  if (!status.dailyCapDisabled && status.dailyLimit !== null && status.dailyUsed >= status.dailyLimit) {
    return `Суточный лимит исчерпан: ${status.dailyUsed}/${status.dailyLimit}. Очередь возобновится в 14:00 по Алматы.`;
  }
  if ((status.watchesByState.watching ?? 0) === 0) {
    return "Нет ни одного лида под наблюдением: вебхуки от amoCRM не приходят или подписка не создана. Проверьте AMOCRM_INACTIVITY_WEBHOOK_SECRET и lead-inactivity:subscribe.";
  }
  if (status.dueNow === 0) {
    return null;
  }
  const failed = status.auditsLast24h.failed ?? 0;
  if (failed > 0 && (status.auditsLast24h.confirmed ?? 0) === 0) {
    return `За сутки ${failed} неудачных попыток и ни одного подтверждённого перевода — смотрите логи воркера, скорее всего amoCRM отвечает ошибкой.`;
  }
  return null;
}

function formatAlmaty(value: Date): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const field = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${field.day}.${field.month}.${field.year} ${field.hour}:${field.minute}`;
}

export function formatInactivityStatus(status: InactivityStatusSnapshot): string {
  const mode = status.testingMode === null
    ? "режим не задан"
    : status.testingMode
      ? `тестовый (лимит ${TESTING_LEADS_MOVEMENT_LIMIT}, использовано ${status.testSlotsUsed})`
      : "боевой";
  const states = ["watching", "leased", "moved", "outside_scope", "skipped", "uncertain"];

  const lines = [
    "🔥 Неактивность → Феникс",
    "",
    `Воркер: ${status.workerEnabled ? "включён" : "выключен"} · ${mode}`,
    `Переводы: ${status.movementPaused ? "⏸ остановлены командой" : "▶️ разрешены"}`,
    `Граница активации: ${status.activationBoundary ? formatAlmaty(status.activationBoundary) : "не задана"}`,
    `Baseline: ${status.baselineComplete ? "завершён" : "не завершён"}`,
    "",
    "Лиды под наблюдением:",
    ...states.map((state) => `• ${state}: ${status.watchesByState[state] ?? 0}`),
    `• к переводу прямо сейчас: ${status.dueNow}`,
    "",
    status.dailyCapDisabled
      ? `Суточный лимит: снят оператором (за сегодня переведено ${status.dailyUsed})`
      : status.dailyBucket
        ? `Суточный лимит (${status.dailyBucket}): ${status.dailyUsed}/${status.dailyLimit}`
        : "Суточный лимит: операционная дата не задана",
    "",
    "За последние 24 часа:",
    ...(Object.keys(status.auditsLast24h).length
      ? Object.entries(status.auditsLast24h).map(([outcome, count]) => `• ${outcome}: ${count}`)
      : ["• попыток не было"]),
  ];

  const diagnosis = diagnoseInactivity(status);
  lines.push("", diagnosis ? `💡 ${diagnosis}` : "✅ Блокировок нет: воркер работает, переводы идут по мере наступления сроков.");
  return lines.join("\n");
}
