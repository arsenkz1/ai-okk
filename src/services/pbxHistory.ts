import "dotenv/config";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as tarStream from "tar-stream";
import { prisma } from "../config/database";
import { callProcessingQueue } from "../queues/callProcessing";
import type { OnlinePbxWebhookPayload } from "../queues/callProcessing";

// ---------------------------------------------------------------------------
// Типы ответа OnlinePBX mongo_history/search.json
// ---------------------------------------------------------------------------

export interface PbxHistoryRecord {
  uuid: string;
  caller_id_name?: string | number;
  caller_id_number?: string | number;
  destination_number?: string | number;
  from_host?: string;
  to_host?: string;
  start_stamp?: number;   // unix timestamp (секунды)
  end_stamp?: number;     // unix timestamp (секунды)
  duration?: number;      // секунды
  user_talk_time?: number;
  hangup_cause?: string;
  accountcode?: string;
  gateway?: string;
  quality_score?: number;
  events?: unknown[];
}

// ---------------------------------------------------------------------------
// Rate limiter для OnlinePBX API (лимит 3 RPS, используем 2 для запаса)
// ---------------------------------------------------------------------------

class PbxRateLimiter {
  private queue: Array<() => void> = [];
  private lastCallAt = 0;
  private readonly minInterval: number; // мс между запросами
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(requestsPerSecond: number) {
    this.minInterval = Math.ceil(1000 / requestsPerSecond);
  }

  /** Вызывай перед каждым HTTP-запросом к OnlinePBX API */
  throttle(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.schedule();
    });
  }

  private schedule() {
    if (this.timer !== null) return;
    const now = Date.now();
    const wait = Math.max(0, this.lastCallAt + this.minInterval - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.queue.length) return;
      this.lastCallAt = Date.now();
      const next = this.queue.shift()!;
      next();
      if (this.queue.length) this.schedule();
    }, wait);
  }
}

const pbxLimiter = new PbxRateLimiter(2); // 2 req/sec (лимит API = 3 RPS)

// ---------------------------------------------------------------------------
// Временная директория для MP3-файлов из TAR
// ---------------------------------------------------------------------------

const TEMP_DIR = path.join(process.cwd(), "tmp", "recordings");

function ensureTempDir(): void {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** RFC 2822 дата для OnlinePBX API */
function toRfc2822(date: Date): string {
  return date.toUTCString();
}

/** Определяет — короткий ли это номер (внутренний добавочный АТС) */
function isInternalNumber(num: string | number): boolean {
  return String(num).trim().replace(/\D/g, "").length <= 5;
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
    internal_number = callerRaw;
    external_number = destRaw;
    direction = "out";
  } else if (!isInternalNumber(callerRaw) && isInternalNumber(destRaw)) {
    internal_number = destRaw;
    external_number = callerRaw;
    direction = "in";
  } else {
    return null; // внутренний или непонятный звонок
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
    from_domain: record.from_host,
    to_domain: record.to_host,
    internal_number,
    external_number,
  };
}

// ---------------------------------------------------------------------------
// Запрос к OnlinePBX API: метаданные звонков
// ---------------------------------------------------------------------------

export async function fetchPbxHistory(
  dateFrom: Date,
  dateTo: Date,
  count = 500
): Promise<PbxHistoryRecord[]> {
  const auth = process.env.ONLINEPBX_PBX_AUTH;
  const domain = process.env.ONLINEPBX_DOMAIN ?? "pbx18476.onpbx.ru";

  if (!auth) throw new Error("ONLINEPBX_PBX_AUTH is not set");

  const url = `https://api2.onlinepbx.ru/${domain}/mongo_history/search.json`;

  console.log("[PbxHistory] Fetching metadata:", {
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString(),
    count,
  });

  await pbxLimiter.throttle();

  const response = await axios.post(
    url,
    { date_from: toRfc2822(dateFrom), date_to: toRfc2822(dateTo), count },
    {
      headers: {
        "x-pbx-authentication": auth,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 30_000,
    }
  );

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
// Поиск записи в истории OnlinePBX по дате и телефону
// ---------------------------------------------------------------------------

function normPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return "7" + digits.slice(1);
  if (digits.length === 10) return "7" + digits;
  return digits;
}

export async function findPbxRecordByDateAndPhone(
  date: Date,
  phone: string
): Promise<{ uuid: string; duration: number } | null> {
  const normalizedPhone = normPhone(phone);
  if (!normalizedPhone || normalizedPhone.length < 7) return null;

  // Ищем ±2 часа вокруг даты звонка
  const dateFrom = new Date(date.getTime() - 2 * 60 * 60 * 1000);
  const dateTo = new Date(date.getTime() + 2 * 60 * 60 * 1000);

  try {
    const records = await fetchPbxHistory(dateFrom, dateTo, 200);
    for (const record of records) {
      const callerNorm = normPhone(String(record.caller_id_number ?? ""));
      const destNorm = normPhone(String(record.destination_number ?? ""));
      if (callerNorm === normalizedPhone || destNorm === normalizedPhone) {
        return {
          uuid: record.uuid,
          duration: record.duration ?? 0,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Запрос к OnlinePBX API: TAR URL (download: true)
// ---------------------------------------------------------------------------

async function fetchDayTarUrl(dateFrom: Date, dateTo: Date): Promise<string | null> {
  const auth = process.env.ONLINEPBX_PBX_AUTH;
  const domain = process.env.ONLINEPBX_DOMAIN ?? "pbx18476.onpbx.ru";

  if (!auth) return null;

  const url = `https://api2.onlinepbx.ru/${domain}/mongo_history/search.json`;

  try {
    await pbxLimiter.throttle();

    const response = await axios.post(
      url,
      { date_from: toRfc2822(dateFrom), date_to: toRfc2822(dateTo), download: true },
      {
        headers: {
          "x-pbx-authentication": auth,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 30_000,
      }
    );

    if (response.data?.status !== "1") return null;

    const tarUrl = response.data?.data;
    if (typeof tarUrl !== "string" || !tarUrl.startsWith("http")) return null;

    console.log("[PbxHistory] Got TAR URL:", tarUrl.slice(0, 80) + "...");
    return tarUrl;
  } catch (err: any) {
    console.error("[PbxHistory] Failed to get TAR URL:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Скачивание и извлечение нужных MP3 из TAR-архива
// ---------------------------------------------------------------------------

/**
 * Скачивает TAR по URL и извлекает MP3-файлы, UUID которых входят в qualifying set.
 * Filename format: YY.MM.DD-HH_mm_ss_{internal}_{external}_{uuid}.mp3
 * Возвращает Map: uuid → абсолютный путь к локальному файлу.
 */
async function extractQualifyingMp3s(
  tarUrl: string,
  qualifyingUuids: Set<string>
): Promise<Map<string, string>> {
  ensureTempDir();

  const uuidToPath = new Map<string, string>();
  const auth = process.env.ONLINEPBX_PBX_AUTH;

  console.log(
    "[PbxHistory] Downloading TAR archive for",
    qualifyingUuids.size,
    "qualifying calls..."
  );

  const tarResponse = await axios.get(tarUrl, {
    responseType: "stream",
    timeout: 180_000,
    headers: auth ? { "x-pbx-authentication": auth } : {},
  });

  await new Promise<void>((resolve, reject) => {
    const extractor = tarStream.extract();

    extractor.on("entry", (header, stream, next) => {
      const entryName = path.basename(header.name ?? "");

      // Матчим UUID в конце имени файла: ..._{uuid}.mp3
      const uuidMatch = entryName.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.mp3$/i
      );

      if (uuidMatch && qualifyingUuids.has(uuidMatch[1])) {
        const uuid = uuidMatch[1];
        const destPath = path.join(TEMP_DIR, `${uuid}.mp3`);
        const writeStream = fs.createWriteStream(destPath);

        stream.pipe(writeStream);

        writeStream.on("finish", () => {
          uuidToPath.set(uuid, destPath);
          console.log("[PbxHistory] Extracted:", uuid);
          next();
        });

        writeStream.on("error", (err) => {
          console.error("[PbxHistory] Failed to write MP3:", uuid, err.message);
          next();
        });
      } else {
        // Пропускаем ненужные файлы
        stream.resume();
        stream.on("end", next);
      }
    });

    extractor.on("finish", resolve);
    extractor.on("error", reject);

    tarResponse.data.pipe(extractor);
  });

  console.log(
    "[PbxHistory] Extraction done:",
    uuidToPath.size,
    "/",
    qualifyingUuids.size,
    "files extracted"
  );

  return uuidToPath;
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

const MIN_DURATION_SECONDS = 6 * 60; // 6 минут

/**
 * Синхронизирует звонки за диапазон дат из OnlinePBX в очередь обработки.
 * Для каждого дня:
 *   1. Получает метаданные звонков
 *   2. Фильтрует qualifying (длина ≥ 8 мин, внешние, не дубли)
 *   3. Скачивает TAR-архив и извлекает нужные MP3 во временную папку
 *   4. Ставит jobs в очередь с localFilePath
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

  const cursor = new Date(fromDate);
  cursor.setHours(0, 0, 0, 0);

  const endDay = new Date(toDate);
  endDay.setHours(23, 59, 59, 999);

  while (cursor <= endDay) {
    const dayStart = new Date(cursor);
    const dayEnd = new Date(cursor);
    dayEnd.setHours(23, 59, 59, 999);

    const dayLabel = dayStart.toISOString().slice(0, 10);
    console.log("[PbxHistory] Processing day:", dayLabel);

    try {
      const records = await fetchPbxHistory(dayStart, dayEnd, 500);
      stats.scanned += records.length;

      // ---- Фаза 1: фильтрация qualifying звонков ----
      const qualifying: Array<{ record: PbxHistoryRecord; normalized: OnlinePbxWebhookPayload }> = [];

      for (const record of records) {
        try {
          const startStamp = record.start_stamp ?? 0;
          const endStamp = record.end_stamp ?? startStamp;
          const duration =
            record.duration != null
              ? record.duration
              : Math.max(0, endStamp - startStamp);

          // Фильтр: длительность ≥ 6 минут
          if (duration < MIN_DURATION_SECONDS) {
            stats.skippedShort++;
            continue;
          }

          // Фильтр: только внешние звонки
          const normalized = normalizeHistoryRecord(record);
          if (!normalized) {
            stats.skippedInternal++;
            continue;
          }

          // Фильтр: идемпотентность
          const existing = await prisma.call.findUnique({
            where: {
              externalId_source: {
                externalId: record.uuid,
                source: "onlinepbx",
              },
            },
          });

          if (existing) {
            // Re-queue failed calls only if within last 7 days (recording still available)
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            if (existing.processingStatus === "failed" && existing.startedAt > sevenDaysAgo) {
              await prisma.call.update({
                where: { id: existing.id },
                data: { processingStatus: "queued", lastError: null },
              });
              // fall through to qualifying.push below
            } else {
              stats.skippedDuplicate++;
              continue;
            }
          }

          qualifying.push({ record, normalized });
        } catch (err: any) {
          console.error("[PbxHistory] Error filtering record:", record.uuid, err.message);
          stats.errors++;
        }
      }

      console.log(
        `[PbxHistory] Day ${dayLabel}: ${qualifying.length} qualifying calls (of ${records.length} scanned)`
      );

      if (qualifying.length === 0) {
        // Пропускаем TAR-скачивание если нет qualifying звонков
        cursor.setDate(cursor.getDate() + 1);
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }

      // ---- Фаза 2: скачивание TAR и извлечение MP3 ----
      const qualifyingUuids = new Set(qualifying.map((q) => q.record.uuid));
      let uuidToPath = new Map<string, string>();

      const tarUrl = await fetchDayTarUrl(dayStart, dayEnd);

      if (tarUrl) {
        try {
          uuidToPath = await extractQualifyingMp3s(tarUrl, qualifyingUuids);
        } catch (err: any) {
          console.error(
            "[PbxHistory] Failed to extract TAR for day",
            dayLabel,
            ":",
            err.message
          );
          // Продолжаем без аудио — transcription будет пропущена
        }
      } else {
        console.warn(
          "[PbxHistory] No TAR URL for day",
          dayLabel,
          "— calls will be queued without audio"
        );
      }

      // ---- Фаза 3: постановка jobs в очередь ----
      for (const { record, normalized } of qualifying) {
        try {
          const localFilePath = uuidToPath.get(record.uuid);

          await callProcessingQueue.add(
            `history_${record.uuid}`,
            {
              callExternalId: record.uuid,
              source: "onlinepbx" as const,
              payload: normalized,
              receivedAt: new Date().toISOString(),
              manualTriggered: false,
              localFilePath,
            },
            {
              jobId: `history_${record.uuid}`,
              attempts: 3,
              backoff: { type: "exponential", delay: 5000 },
            }
          );

          stats.queued++;
        } catch (err: any) {
          console.error("[PbxHistory] Error queuing record:", record.uuid, err.message);
          stats.errors++;
        }
      }
    } catch (err: any) {
      console.error("[PbxHistory] Failed to process day:", dayLabel, err.message);
      stats.errors++;
    }

    // Обновляем прогресс в БД
    try {
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
    } catch (dbErr: any) {
      console.error("[PbxHistory] DB update error:", dbErr.message);
    }

    cursor.setDate(cursor.getDate() + 1);
    await new Promise((r) => setTimeout(r, 500)); // rate-limit: ~2 req/sec
  }

  // Финальный статус
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
