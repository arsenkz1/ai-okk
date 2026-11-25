import { prisma } from "../config/database";
import {
  dailyLeadInactivityMovementLimit,
  isValidDailyMovementLimit,
  MAX_DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT,
} from "./leadInactivityDailyCap";

/**
 * Durable on/off switch for Phoenix inactivity moves.
 *
 * An environment flag cannot do this job: turning moves off must take effect
 * on the very next worker pass, not after a redeploy. The switch lives in the
 * same settings table as the worker's other state and is read every pass, so
 * "off" is honoured within a minute across every replica.
 *
 * It is a full stop, not a pause. Turning it off clears every active watch,
 * and while it is off the webhook records nothing — so no 72-hour clock keeps
 * running in the background. Turning it back on starts from a clean slate: a
 * lead is watched again only from its next touch, and nothing that "ripened"
 * during the stop moves the moment the switch flips.
 */

export const INACTIVITY_MOVEMENT_PAUSED_SETTING_KEY = "lead_inactivity.movement_paused";

export interface InactivityMovementSwitchState {
  paused: boolean;
  /**
   * True once the operator has switched moves on through the bot: from then on
   * the 100-per-day cap no longer applies. Never set by anything else.
   */
  dailyCapDisabled: boolean;
  /**
   * True once the cap was set by /inactivity_limit_on|off. From then on
   * /inactivity_on no longer lifts it on its own: the explicit choice wins.
   */
  dailyCapExplicit: boolean;
  /**
   * The per-day number set with /inactivity_limit N; null until someone sets
   * one, and then LEAD_INACTIVITY_DAILY_LIMIT or the default applies.
   */
  dailyLimit: number | null;
  /** Who flipped it and when; null when it has never been touched. */
  changedBy: string | null;
  changedAt: Date | null;
}

interface StoredSwitch {
  paused: boolean;
  dailyCapDisabled?: boolean;
  dailyCapExplicit?: boolean;
  dailyLimit?: number | null;
  changedBy: string | null;
  changedAt: string;
}

const UNTOUCHED: InactivityMovementSwitchState = {
  paused: false,
  dailyCapDisabled: false,
  dailyCapExplicit: false,
  dailyLimit: null,
  changedBy: null,
  changedAt: null,
};

function parseStored(raw: string | null): InactivityMovementSwitchState {
  if (!raw) return UNTOUCHED;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSwitch>;
    const changedAt = typeof parsed.changedAt === "string" ? new Date(parsed.changedAt) : null;
    return {
      paused: parsed.paused === true,
      dailyCapDisabled: parsed.dailyCapDisabled === true,
      dailyCapExplicit: parsed.dailyCapExplicit === true,
      // An out-of-range number falls back to the env/default limit rather
      // than breaking every pass that reads it.
      dailyLimit: isValidDailyMovementLimit(parsed.dailyLimit) ? parsed.dailyLimit : null,
      changedBy: typeof parsed.changedBy === "string" ? parsed.changedBy : null,
      changedAt: changedAt && !Number.isNaN(changedAt.getTime()) ? changedAt : null,
    };
  } catch {
    // A corrupt value must fail towards "running with the cap": a paused worker
    // that cannot be un-paused is worse than one that keeps its agreed
    // behaviour, and the cap is the conservative side of that behaviour.
    return UNTOUCHED;
  }
}

export interface InactivityMovementSwitchDatabase {
  leadInactivitySetting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>;
    upsert(args: {
      where: { key: string };
      update: { value: string };
      create: { key: string; value: string };
    }): Promise<unknown>;
  };
  leadInactivityWatch: {
    updateMany(args: {
      where: { state: { in: string[] } };
      data: { state: string; stoppedAt: Date; lastFailureReason: string; leaseToken: null; leaseExpiresAt: null };
    }): Promise<{ count: number }>;
  };
}

/** Watch states that still lead to a move; everything else is already final. */
const ACTIVE_WATCH_STATES = ["watching", "leased"];
export const STOPPED_BY_OPERATOR_REASON = "stopped by operator switch";

/**
 * Drops every active watch. A lead cleared here is not lost: its next amoCRM
 * touch creates a fresh watch with a fresh 72-hour clock, once the switch is
 * back on.
 */
export async function clearActiveInactivityWatches(
  database: InactivityMovementSwitchDatabase = prisma,
  now = new Date(),
): Promise<number> {
  const result = await database.leadInactivityWatch.updateMany({
    where: { state: { in: ACTIVE_WATCH_STATES } },
    data: {
      state: "skipped",
      stoppedAt: now,
      lastFailureReason: STOPPED_BY_OPERATOR_REASON,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  return result.count;
}

export async function getInactivityMovementSwitch(
  database: InactivityMovementSwitchDatabase = prisma,
): Promise<InactivityMovementSwitchState> {
  const row = await database.leadInactivitySetting.findUnique({
    where: { key: INACTIVITY_MOVEMENT_PAUSED_SETTING_KEY },
  });
  return parseStored(row?.value ?? null);
}

export async function isInactivityMovementPaused(
  database: InactivityMovementSwitchDatabase = prisma,
): Promise<boolean> {
  return (await getInactivityMovementSwitch(database)).paused;
}

export async function isInactivityDailyCapDisabled(
  database: InactivityMovementSwitchDatabase = prisma,
): Promise<boolean> {
  return (await getInactivityMovementSwitch(database)).dailyCapDisabled;
}

/** The number from the bot, else LEAD_INACTIVITY_DAILY_LIMIT, else the default. */
export function effectiveDailyLimit(
  state: Pick<InactivityMovementSwitchState, "dailyLimit">,
  env: Record<string, string | undefined> = process.env,
): number {
  return state.dailyLimit ?? dailyLeadInactivityMovementLimit(env);
}

/** Read on every worker pass and sweep, so a new number applies within a minute. */
export async function getInactivityDailyMovementLimit(
  database: InactivityMovementSwitchDatabase = prisma,
): Promise<number> {
  return effectiveDailyLimit(await getInactivityMovementSwitch(database));
}

export interface SetInactivityMovementResult extends InactivityMovementSwitchState {
  /** Watches cleared by a stop; always 0 when turning on. */
  clearedWatches: number;
}

/**
 * Flips the switch. The flag is written first so a worker pass or a webhook
 * racing with the stop sees "off" before the queue is cleared, and cannot
 * re-create a watch in the gap.
 */
export async function setInactivityMovementPaused(
  paused: boolean,
  changedBy: string,
  database: InactivityMovementSwitchDatabase = prisma,
  now = new Date(),
): Promise<SetInactivityMovementResult> {
  // Switching on through the bot lifts the daily cap, unless the operator has
  // set the cap explicitly with /inactivity_limit_on|off — then that choice
  // stays. Switching off leaves the cap as it was.
  const previous = await getInactivityMovementSwitch(database);
  const dailyCapDisabled = paused || previous.dailyCapExplicit ? previous.dailyCapDisabled : true;
  await writeSwitch(database, {
    paused,
    dailyCapDisabled,
    dailyCapExplicit: previous.dailyCapExplicit,
    dailyLimit: previous.dailyLimit,
    changedBy,
    changedAt: now.toISOString(),
  });
  const clearedWatches = paused ? await clearActiveInactivityWatches(database, now) : 0;
  return {
    paused,
    dailyCapDisabled,
    dailyCapExplicit: previous.dailyCapExplicit,
    dailyLimit: previous.dailyLimit,
    changedBy,
    changedAt: now,
    clearedWatches,
  };
}

async function writeSwitch(database: InactivityMovementSwitchDatabase, stored: StoredSwitch): Promise<void> {
  const value = JSON.stringify(stored);
  await database.leadInactivitySetting.upsert({
    where: { key: INACTIVITY_MOVEMENT_PAUSED_SETTING_KEY },
    update: { value },
    create: { key: INACTIVITY_MOVEMENT_PAUSED_SETTING_KEY, value },
  });
}

/**
 * Turns the daily cap on or off without touching whether moves run or the
 * number. The worker reads it on every pass, so it applies within a minute.
 */
export async function setInactivityDailyCap(
  enabled: boolean,
  changedBy: string,
  database: InactivityMovementSwitchDatabase = prisma,
  now = new Date(),
): Promise<InactivityMovementSwitchState> {
  const previous = await getInactivityMovementSwitch(database);
  const state: InactivityMovementSwitchState = {
    paused: previous.paused,
    dailyCapDisabled: !enabled,
    dailyCapExplicit: true,
    dailyLimit: previous.dailyLimit,
    changedBy,
    changedAt: now,
  };
  await writeStateSwitch(database, state);
  return state;
}

/**
 * Sets the per-day number and switches the cap on: whoever types a number
 * means it to apply. Moves themselves are left as they are.
 */
export async function setInactivityDailyLimit(
  limit: number,
  changedBy: string,
  database: InactivityMovementSwitchDatabase = prisma,
  now = new Date(),
): Promise<InactivityMovementSwitchState> {
  if (!isValidDailyMovementLimit(limit)) {
    throw new Error(`лимит должен быть от 1 до ${MAX_DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT}`);
  }
  const previous = await getInactivityMovementSwitch(database);
  const state: InactivityMovementSwitchState = {
    paused: previous.paused,
    dailyCapDisabled: false,
    dailyCapExplicit: true,
    dailyLimit: limit,
    changedBy,
    changedAt: now,
  };
  await writeStateSwitch(database, state);
  return state;
}

async function writeStateSwitch(database: InactivityMovementSwitchDatabase, state: InactivityMovementSwitchState): Promise<void> {
  await writeSwitch(database, {
    paused: state.paused,
    dailyCapDisabled: state.dailyCapDisabled,
    dailyCapExplicit: state.dailyCapExplicit,
    dailyLimit: state.dailyLimit,
    changedBy: state.changedBy,
    changedAt: (state.changedAt ?? new Date()).toISOString(),
  });
}

export function formatInactivityDailyCap(
  state: InactivityMovementSwitchState,
  today: { limit: number | null; used: number } | null = null,
): string {
  const who = state.changedBy && state.changedAt
    ? ` (изменил ${state.changedBy}, ${formatAlmaty(state.changedAt)})`
    : "";
  const limit = today?.limit ?? effectiveDailyLimit(state);
  const source = typeof state.dailyLimit === "number" ? "задано в боте" : "по умолчанию";
  const lines = [
    state.dailyCapDisabled
      ? `Суточный лимит переводов в Феникс СНЯТ${who}. Воркер, сверка 22:00 и массовый перенос переводят всех просроченных без ограничения.`
      : `Суточный лимит переводов в Феникс ВКЛЮЧЁН${who}: не больше ${limit} в сутки (${source}), остальные ждут следующих суток.`,
  ];
  if (today) lines.push(`Уже переведено за текущие сутки: ${today.used}.`);
  if (state.paused) lines.push("Сами переводы сейчас остановлены (/inactivity_off); настройка применится после /inactivity_on.");
  if (!state.dailyCapDisabled) {
    lines.push("Лимит общий: воркер, сверка 22:00 и массовый перенос по /inactivity_on расходуют один счётчик. Сутки считаются с 14:00 до 14:00 по Алматы.");
  }
  lines.push(`Задать своё число: /inactivity_limit 30 (от 1 до ${MAX_DAILY_LEAD_INACTIVITY_MOVEMENT_LIMIT}); лимит при этом включается.`);
  return lines.join("\n");
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

export function formatInactivityMovementSwitch(
  state: InactivityMovementSwitchState & { clearedWatches?: number },
): string {
  const who = state.changedBy && state.changedAt
    ? ` (изменил ${state.changedBy}, ${formatAlmaty(state.changedAt)})`
    : "";
  if (state.paused) {
    const cleared = state.clearedWatches !== undefined ? ` Снято с отслеживания лидов: ${state.clearedWatches}.` : "";
    return `⛔ Переводы в Феникс ОСТАНОВЛЕНЫ${who}.${cleared} Новые касания не отслеживаются. Включение начнёт отсчёт заново.`;
  }
  const cap = state.dailyCapDisabled ? " Суточный лимит снят." : "";
  return `▶️ Переводы в Феникс включены${who}.${cap} Лиды берутся под наблюдение со следующего касания.`;
}
