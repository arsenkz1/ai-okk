import { prisma } from "../config/database";
import type { ManagerCallVolume } from "./callVolumeStats";
import { emptyCallVolume } from "./callVolumeStats";

/**
 * Records every call_end webhook, including the short and unanswered calls the
 * analysis pipeline drops.
 *
 * This is the primary source for call volume: it needs no OnlinePBX
 * credentials, so an expired session key can no longer turn a busy day into a
 * reported zero. The history API stays as the fallback for days that predate
 * this log or for deliveries that were missed.
 */

export interface PbxCallLogEntry {
  uuid: string;
  direction: string;
  internalNumber: string | null;
  externalNumber: string | null;
  startedAt: Date;
  callSeconds: number;
  talkSeconds: number;
  hangupCause: string | null;
}

function digitsOnly(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits || null;
}

function nonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

/**
 * Builds a log entry from the raw webhook body. Talk time and total length are
 * kept apart: their difference is what tells an answered call from a missed one,
 * and the normalized payload collapses them into a single `duration`.
 */
export function buildPbxCallLogEntry(raw: unknown, receivedAt: Date): PbxCallLogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (body.event !== "call_end") return null;
  const uuid = typeof body.uuid === "string" ? body.uuid.trim() : "";
  if (!uuid) return null;

  const callSeconds = nonNegativeInt(body.call_duration ?? body.duration);
  const talkSeconds = nonNegativeInt(body.dialog_duration ?? body.user_talk_time);
  const startedAtSeconds = Number(body.date ?? body.start_stamp);
  const startedAt = Number.isFinite(startedAtSeconds) && startedAtSeconds > 0
    ? new Date(startedAtSeconds * 1000)
    : receivedAt;

  const caller = digitsOnly(body.caller);
  const callee = digitsOnly(body.callee);
  const direction = String(body.direction ?? "").toLowerCase() === "outbound" ? "out" : "in";
  const internalNumber = direction === "out" ? caller : callee;
  const externalNumber = direction === "out" ? callee : caller;

  return {
    uuid,
    direction,
    internalNumber,
    externalNumber,
    startedAt,
    // A call cannot have talked longer than it lasted; trust the larger value
    // as the total so a malformed payload cannot produce negative ringing time.
    callSeconds: Math.max(callSeconds, talkSeconds),
    talkSeconds,
    hangupCause: typeof body.hangup_cause === "string" ? body.hangup_cause : null,
  };
}

/** Stores one entry; a repeated delivery of the same call is a no-op. */
export async function recordPbxCallLog(
  entry: PbxCallLogEntry,
  receivedAt: Date,
  database: Pick<typeof prisma, "pbxCallLog"> = prisma,
): Promise<void> {
  await database.pbxCallLog.createMany({
    data: [{ ...entry, receivedAt }],
    skipDuplicates: true,
  });
}

/**
 * Aggregates logged calls per manager. Returns null when the period predates
 * the log entirely, so the caller can fall back to the history API instead of
 * reporting a zero it cannot stand behind.
 */
export async function loadCallVolumeFromLog(
  range: { from: Date; to: Date },
  extensionToManagerId: ReadonlyMap<string, number>,
  database: Pick<typeof prisma, "pbxCallLog"> = prisma,
): Promise<Map<number, ManagerCallVolume> | null> {
  const rows = await database.pbxCallLog.findMany({
    where: { startedAt: { gte: range.from, lt: range.to } },
    select: { internalNumber: true, talkSeconds: true },
  });
  if (rows.length === 0) return null;

  const byManager = new Map<number, ManagerCallVolume>();
  for (const row of rows) {
    const managerId = row.internalNumber ? extensionToManagerId.get(row.internalNumber) : undefined;
    if (managerId === undefined) continue;

    const volume = byManager.get(managerId) ?? emptyCallVolume();
    volume.total += 1;
    if (row.talkSeconds > 0) {
      volume.connected += 1;
      volume.talkSeconds += row.talkSeconds;
    } else {
      volume.missed += 1;
    }
    byManager.set(managerId, volume);
  }
  return byManager;
}
