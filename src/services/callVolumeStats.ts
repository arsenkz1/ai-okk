// Type-only: pbxHistory creates the BullMQ call queue at import time, so the
// module is pulled in lazily inside the fetcher rather than at load.
import type { PbxHistoryRecord } from "./pbxHistory";

/**
 * Connected/missed call volume per manager, derived from OnlinePBX history.
 *
 * The call-processing pipeline only stores conversations longer than six
 * minutes, so the database cannot answer "how many calls were there" at all.
 * History is therefore the source for volume, while scores keep coming from the
 * analyzed calls in the database.
 */

/** A single day can exceed the default page size, so ask for a much larger page. */
export const CALL_VOLUME_HISTORY_PAGE_SIZE = 5000;

export interface ManagerCallVolume {
  total: number;
  connected: number;
  missed: number;
  talkSeconds: number;
}

export function emptyCallVolume(): ManagerCallVolume {
  return { total: 0, connected: 0, missed: 0, talkSeconds: 0 };
}

function digitsOnly(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function isInternalNumber(value: unknown): boolean {
  return digitsOnly(value).length <= 5;
}

/**
 * A call counts as connected when someone actually talked. `user_talk_time` is
 * the only field that distinguishes a ringing-then-dropped call from a real
 * conversation; when it is absent we fall back to a positive duration.
 */
export function isConnectedRecord(record: PbxHistoryRecord): boolean {
  const talkTime = Number(record.user_talk_time);
  if (Number.isFinite(talkTime)) return talkTime > 0;
  const duration = Number(record.duration);
  return Number.isFinite(duration) && duration > 0;
}

/**
 * Picks the manager extension of an external call, or null for internal
 * extension-to-extension calls, which are not sales activity.
 */
export function internalExtensionOf(record: PbxHistoryRecord): string | null {
  const caller = digitsOnly(record.caller_id_number);
  const destination = digitsOnly(record.destination_number);
  if (isInternalNumber(caller) && !isInternalNumber(destination)) return caller;
  if (!isInternalNumber(caller) && isInternalNumber(destination)) return destination;
  return null;
}

function talkSecondsOf(record: PbxHistoryRecord): number {
  const talkTime = Number(record.user_talk_time);
  if (Number.isFinite(talkTime) && talkTime > 0) return Math.round(talkTime);
  const duration = Number(record.duration);
  return Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0;
}

/**
 * Aggregates history records per manager. `extensionToManagerId` maps an
 * OnlinePBX internal number to a manager; records for unknown extensions are
 * dropped rather than attributed to anyone.
 */
export function aggregateCallVolume(
  records: readonly PbxHistoryRecord[],
  extensionToManagerId: ReadonlyMap<string, number>,
): Map<number, ManagerCallVolume> {
  const byManager = new Map<number, ManagerCallVolume>();
  const seenUuids = new Set<string>();

  for (const record of records) {
    // OnlinePBX can return the same leg twice across page boundaries.
    if (record.uuid) {
      if (seenUuids.has(record.uuid)) continue;
      seenUuids.add(record.uuid);
    }

    const extension = internalExtensionOf(record);
    if (extension === null) continue;
    const managerId = extensionToManagerId.get(extension);
    if (managerId === undefined) continue;

    const volume = byManager.get(managerId) ?? emptyCallVolume();
    volume.total += 1;
    if (isConnectedRecord(record)) {
      volume.connected += 1;
      volume.talkSeconds += talkSecondsOf(record);
    } else {
      volume.missed += 1;
    }
    byManager.set(managerId, volume);
  }

  return byManager;
}

export interface CallVolumeFetchResult {
  byManager: Map<number, ManagerCallVolume>;
  /** True when the page cap was reached and the day may be under-counted. */
  possiblyTruncated: boolean;
}

export type FetchPbxHistoryFn = (
  from: Date,
  to: Date,
  count: number,
) => Promise<PbxHistoryRecord[]>;

const loadPbxHistory: FetchPbxHistoryFn = async (from, to, count) => {
  const { fetchPbxHistory } = await import("./pbxHistory");
  return fetchPbxHistory(from, to, count);
};

export async function fetchCallVolumeForRange(
  from: Date,
  to: Date,
  extensionToManagerId: ReadonlyMap<string, number>,
  fetchHistory: FetchPbxHistoryFn = loadPbxHistory,
): Promise<CallVolumeFetchResult> {
  const records = await fetchHistory(from, to, CALL_VOLUME_HISTORY_PAGE_SIZE);
  return {
    byManager: aggregateCallVolume(records, extensionToManagerId),
    possiblyTruncated: records.length >= CALL_VOLUME_HISTORY_PAGE_SIZE,
  };
}
