import { prisma } from "../config/database";

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
  /** Who flipped it and when; null when it has never been touched. */
  changedBy: string | null;
  changedAt: Date | null;
}

interface StoredSwitch {
  paused: boolean;
  changedBy: string | null;
  changedAt: string;
}

function parseStored(raw: string | null): InactivityMovementSwitchState {
  if (!raw) return { paused: false, changedBy: null, changedAt: null };
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSwitch>;
    const changedAt = typeof parsed.changedAt === "string" ? new Date(parsed.changedAt) : null;
    return {
      paused: parsed.paused === true,
      changedBy: typeof parsed.changedBy === "string" ? parsed.changedBy : null,
      changedAt: changedAt && !Number.isNaN(changedAt.getTime()) ? changedAt : null,
    };
  } catch {
    // A corrupt value must fail towards "running": a paused worker that cannot
    // be un-paused is worse than one that keeps its agreed behaviour.
    return { paused: false, changedBy: null, changedAt: null };
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
  const stored: StoredSwitch = { paused, changedBy, changedAt: now.toISOString() };
  const value = JSON.stringify(stored);
  await database.leadInactivitySetting.upsert({
    where: { key: INACTIVITY_MOVEMENT_PAUSED_SETTING_KEY },
    update: { value },
    create: { key: INACTIVITY_MOVEMENT_PAUSED_SETTING_KEY, value },
  });
  const clearedWatches = paused ? await clearActiveInactivityWatches(database, now) : 0;
  return { paused, changedBy, changedAt: now, clearedWatches };
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
  return `▶️ Переводы в Феникс включены${who}. Лиды берутся под наблюдение со следующего касания.`;
}
