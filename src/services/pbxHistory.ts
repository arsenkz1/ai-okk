import "dotenv/config";
import axios from "axios";
import { prisma } from "../config/database";
import { callProcessingQueue } from "../queues/callProcessing";
import type { OnlinePbxWebhookPayload } from "../queues/callProcessing";

// ---------------------------------------------------------------------------
// Типы ответа OnlinePBX mongo_history/search.json
// ---------------------------------------------------------------------------

interface PbxHistoryRecord {
  uuid: string;
  caller_id_name?: string | number;
  caller_id_number?: string | number;
  destination_number?: string | number;
  from_host?: string;
  to_host?: string;
  start_stamp?: number;   // unix timestamp (секунды)
  end_stamp?: number;     // unix timestamp (секунды)
  duration?: number;      // секунды (если возвращается API)
  hangup_cause?: string;
  direction?: string;
  // Поле записи звонка — API возвращает одно из них:
  download_path?: string;
  record_url?: string;
  record_path?: string;
  file?: string;
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** RFC 2822 дата для OnlinePBX API */
function toRfc2822(date: Date): string {
  return date.toUTCString(); // "Mon, 10 Mar 2026 00:00:00 GMT"
}

/** Определяет — короткий ли это номер (внутренний добавочный АТС) */
function isInternalNumber(num: string | number): boolean {
  return String(num).trim().replace(/\D/g, "").length <= 5;
}

/**
 * Извлекает URL записи из объекта звонка.
 * OnlinePBX может возвращать поле под разными именами.
 */
function extractRecordUrl(record: PbxHistoryRecord): string | null {
  const raw =
    record.record_url ??
    record.download_path ??
    record.record_path ??
    record.file ??
    null;

  if (!raw) return null;

  const str = String(raw).trim();
  if (!str || str === "null" || str === "false") return null;

  // Если уже полный URL — возвращаем как есть
  if (str.startsWith("http")) return str;

  // Иначе строим URL через API домен OnlinePBX
  const domain = process.env.ONLINEPBX_DOMAIN ?? "pbx18476.onpbx.ru";
  return `https://api2.onlinepbx.ru/${domain}/calls-records/download/${str}`;
}

/**
 * Нормализует запись истории в формат, совместимый с нашим webhook payload.
 */
function normalizeHistoryRecord(
  record: PbxHistoryRecord
): OnlinePbxWebhookPayload | null {
  const callerRaw = String(record.caller_id_number ?? "");
  const destRaw = String(record.destination_number ?? "");

  const startStamp = record.start_stamp ?? 0;
  const endStamp = record.end_stamp ?? startStamp;
  const duration =
    record.duration != null
      ? record.duration
      : Math.max(0, endStamp - startStamp);

  let internal_number: string;
  let external_number: string;
  let direction: "in" | "out";

  if (isInternalNumber(callerRaw) && !isInternalNumber(destRaw)) {
    // Исходящий: менеджер звонит клиенту
    internal_number = callerRaw;
    external_number = destRaw;
    direction = "out";
  } else if (!isInternalNumber(callerRaw) && isInternalNumber(destRaw)) {
    // Входящий: клиент звонит менеджеру
    internal_number = destRaw;
    external_number = callerRaw;
    direction = "in";
  } else {
    // Оба внутренних или оба внешних — пропускаем (внутренние звонки)
    return null;
  }

  const startedAt = new Date(startStamp * 1000);

  return {
    event: "call_end",
    uuid: record.uuid,
    direction,
    caller: direction === "out" ? internal_number : external_number,
    callee: direction === "out" ? external_number : internal_number,
    start_time: startedAt.toISOString().replace("T", " ").slice(0, 19),
    end_time: new Date(endStamp * 1000).toISOString().replace("T", " ").slice(0, 19),
    duration,
    status: record.hangup_cause === "NORMAL_CLEARING" || !record.hangup_cause ? "completed" : "failed",
    record_url: extractRecordUrl(record) ?? undefined,
    from_domain: record.from_host,
    to_domain: record.to_host,
    internal_number,
    external_number,
  };
}

// ---------------------------------------------------------------------------
// Запрос к OnlinePBX API
// ---------------------------------------------------------------------------

/**
 * Получает список звонков из OnlinePBX за указанный период.
 * dateFrom/dateTo — границы запроса (включительно).
 * count — максимальное количество записей (до 500).
 */
export async function fetchPbxHistory(
  dateFrom: Date,
  dateTo: Date,
  count = 500
): Promise<PbxHistoryRecord[]> {
  const auth = process.env.ONLINEPBX_PBX_AUTH;
  const domain = process.env.ONLINEPBX_DOMAIN ?? "pbx18476.onpbx.ru";

  if (!auth) throw new Error("ONLINEPBX_PBX_AUTH is not set");

  const url = `https://api2.onlinepbx.ru/${domain}/mongo_history/search.json`;

  const body = {
    date_from: toRfc2822(dateFrom),
    date_to: toRfc2822(dateTo),
    count,
  };

  console.log("[PbxHistory] Fetching:", {
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString(),
    count,
  });

  const response = await axios.post(url, body, {
    headers: {
      "x-pbx-authentication": auth,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: 30_000,
  });

  if (response.data?.status !== "1") {
    throw new Error(
      `OnlinePBX API error: ${JSON.stringify(response.data).slice(0, 200)}`
    );
  }

  const data = response.data?.data;
  if (!Array.isArray(data)) return [];

  console.log("[PbxHistory] Got", data.length, "records");
  return data as PbxHistoryRecord[];
}

// ---------------------------------------------------------------------------
// Основной процесс синхронизации
// ---------------------------------------------------------------------------

export interface HistorySyncStats {
  scanned: number;
  queued: number;
  skippedShort: number;
  skippedNoDeal: number;
  skippedDuplicate: number;
  skippedInternal: number;
  errors: number;
}

const MIN_DURATION_SECONDS = 8 * 60; // 8 минут

/**
 * Синхронизирует звонки за диапазон дат из OnlinePBX в очередь обработки.
 * Итерирует день за днём. Уважает идемпотентность (не дублирует уже обработанные).
 *
 * @param fromDate  Начало диапазона (inclusive)
 * @param toDate    Конец диапазона (inclusive)
 * @param jobId     ID записи HistorySyncJob в БД для обновления прогресса
 */
export async function syncHistoryRange(
  fromDate: Date,
  toDate: Date,
  jobId: number
): Promise<HistorySyncStats> {
  const stats: HistorySyncStats = {
    scanned: 0,
    queued: 0,
    skippedShort: 0,
    skippedNoDeal: 0,
    skippedDuplicate: 0,
    skippedInternal: 0,
    errors: 0,
  };

  // Итерация день за днём
  const cursor = new Date(fromDate);
  cursor.setHours(0, 0, 0, 0);

  const endDay = new Date(toDate);
  endDay.setHours(23, 59, 59, 999);

  while (cursor <= endDay) {
    const dayStart = new Date(cursor);
    const dayEnd = new Date(cursor);
    dayEnd.setHours(23, 59, 59, 999);

    try {
      const records = await fetchPbxHistory(dayStart, dayEnd, 500);
      stats.scanned += records.length;

      for (const record of records) {
        try {
          // --- Фильтр 1: Длительность >= 8 минут ---
          const startStamp = record.start_stamp ?? 0;
          const endStamp = record.end_stamp ?? startStamp;
          const duration =
            record.duration != null
              ? record.duration
              : Math.max(0, endStamp - startStamp);

          if (duration < MIN_DURATION_SECONDS) {
            stats.skippedShort++;
            continue;
          }

          // --- Фильтр 2: Только внешние звонки (не внутренние) ---
          const normalized = normalizeHistoryRecord(record);
          if (!normalized) {
            stats.skippedInternal++;
            continue;
          }

          // --- Фильтр 3: Идемпотентность — пропускаем уже обработанные ---
          const existing = await prisma.call.findUnique({
            where: {
              externalId_source: {
                externalId: record.uuid,
                source: "onlinepbx",
              },
            },
          });

          if (existing) {
            stats.skippedDuplicate++;
            continue;
          }

          // --- Ставим в очередь обработки ---
          await callProcessingQueue.add(
            `history:${record.uuid}`,
            {
              callExternalId: record.uuid,
              source: "onlinepbx" as const,
              payload: normalized,
              receivedAt: new Date().toISOString(),
              manualTriggered: false,
            },
            {
              jobId: `history:${record.uuid}`,
              attempts: 3,
              backoff: { type: "exponential", delay: 5000 },
            }
          );

          stats.queued++;
        } catch (err: any) {
          console.error("[PbxHistory] Error processing record:", record.uuid, err.message);
          stats.errors++;
        }
      }

      // Обновляем прогресс в БД
      await prisma.historySyncJob.update({
        where: { id: jobId },
        data: {
          totalCallsScanned: stats.scanned,
          totalQueued: stats.queued,
          totalSkippedShort: stats.skippedShort,
          totalNoDeal: stats.skippedNoDeal + stats.skippedInternal,
          status: "in_progress",
        },
      });
    } catch (err: any) {
      console.error("[PbxHistory] Failed to fetch day:", dayStart.toISOString(), err.message);
      stats.errors++;
    }

    // Следующий день
    cursor.setDate(cursor.getDate() + 1);

    // Небольшая пауза между запросами к API (rate-limit OnlinePBX: 5 req/sec)
    await new Promise((r) => setTimeout(r, 300));
  }

  // Финальное обновление статуса
  await prisma.historySyncJob.update({
    where: { id: jobId },
    data: {
      totalCallsScanned: stats.scanned,
      totalQueued: stats.queued,
      totalSkippedShort: stats.skippedShort,
      totalNoDeal: stats.skippedNoDeal + stats.skippedInternal,
      status: stats.errors > 0 && stats.scanned === 0 ? "failed" : "completed",
    },
  });

  return stats;
}
