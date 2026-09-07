import "dotenv/config";
import axios from "axios";
import { normalizeAmoCrmTenantBaseUrl } from "./amoCrmRateLimiter";
import { recordDealRevenue } from "./dealRevenueRecorder";
import { AMO_READ_MAX_ATTEMPTS, amoRetryDelayMs, isRetryableAmoStatus } from "./amoRetryPolicy";
import { prisma } from "../config/database";
import { markDealAsWon, markDealAsLost } from "./googleSheets";
import { callProcessingQueue } from "../queues/callProcessing";
import { notifyAdmins } from "../bot/notify";

// ---------------------------------------------------------------------------
// Конфигурация
// ---------------------------------------------------------------------------

const AMO_BASE_URL = process.env.AMOCRM_BASE_URL
  ? normalizeAmoCrmTenantBaseUrl(process.env.AMOCRM_BASE_URL)
  : undefined;
const AMO_ACCESS_TOKEN = process.env.AMOCRM_ACCESS_TOKEN;

// Pipeline IDs и qualifying stage IDs по воронкам
export const QUALIFYING_PIPELINE_IDS = [6909890, 8425422, 9055778, 9888398];

export const QUALIFYING_STAGE_IDS = new Set([
  58160726, 58160902, // Основная воронка: Квалифицирован, ОЖОП
  68567458, 68567462, // Стажёры:          Квалифицирован, ОЖОП
  78631750, 78631754, // DATA:              Квалифицирован, ОЖОП
  72917586, 72919958, // Exode:             Квалифицирован, ОЖОП
]);

// ---------------------------------------------------------------------------
// Вспомогательные утилиты
// ---------------------------------------------------------------------------

function amoHeaders() {
  return {
    Authorization: `Bearer ${AMO_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ---------------------------------------------------------------------------
// amoCRM request pacing is installed once by ./amoCrmRateLimiter. It is durable
// across service replicas and governs every axios request to an amoCRM tenant.
//
// The limiter paces our own traffic, but it cannot prevent amoCRM answering 429
// or 5xx anyway (other integrations share the account quota). Reads are
// therefore retried: a transient failure during a deal lookup used to end as
// "deal not found", and the call was skipped without analysis.
// ---------------------------------------------------------------------------

function amoErrorStatus(err: any): number | null {
  const status = Number(err?.response?.status);
  return Number.isInteger(status) ? status : null;
}

function reportForbidden(method: string, path: string): void {
  console.error(`[AmoCRM] 403 Forbidden on ${method} ${path}`);
  notifyAdmins(`⛔ amoCRM 403 Forbidden\n${method} ${path}\nСкорее всего запросы заблокированы.`).catch(() => {});
}

async function amoGet(path: string): Promise<any> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= AMO_READ_MAX_ATTEMPTS; attempt++) {
    try {
      const r = await axios.get(`${AMO_BASE_URL}${path}`, { headers: amoHeaders() });
      return r.data;
    } catch (err: any) {
      lastError = err;
      const status = amoErrorStatus(err);
      if (status === 403) {
        reportForbidden("GET", path);
        throw err;
      }
      if (attempt === AMO_READ_MAX_ATTEMPTS || !isRetryableAmoStatus(status)) throw err;
      const delay = amoRetryDelayMs(attempt, err?.response?.headers?.["retry-after"]);
      console.warn(`[AmoCRM] GET ${path} failed with ${status ?? "network error"}, retry ${attempt}/${AMO_READ_MAX_ATTEMPTS - 1} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Writes are never retried automatically: amoCRM may have applied a request
 * whose response was lost, and a blind repeat would duplicate a note or a task.
 */
async function amoPost(path: string, data: unknown): Promise<any> {
  try {
    const r = await axios.post(`${AMO_BASE_URL}${path}`, data, { headers: amoHeaders() });
    return r.data;
  } catch (err: any) {
    if (amoErrorStatus(err) === 403) reportForbidden("POST", path);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Нормализация телефона
// Приводим к формату 7XXXXXXXXXX (11 цифр, начинается с 7)
// ---------------------------------------------------------------------------

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  // Already full Uzbek: 998XXXXXXXXX (12 digits)
  if (digits.length === 12 && digits.startsWith("998")) {
    return digits;
  }
  // Local Uzbek 9-digit (e.g. 948123006 → 998948123006)
  if (digits.length === 9) {
    return "998" + digits;
  }
  // Russian 11-digit starting with 8 (e.g. 89001234567 → 79001234567)
  if (digits.length === 11 && digits.startsWith("8")) {
    return "7" + digits.slice(1);
  }
  // Russian 10-digit (e.g. 9001234567 → 79001234567)
  if (digits.length === 10) {
    return "7" + digits;
  }
  return digits;
}

// ---------------------------------------------------------------------------
// Проверка квалифицирующей стадии
// ---------------------------------------------------------------------------

export function isQualifyingDeal(pipelineId: number, stageId: number): boolean {
  return (
    QUALIFYING_PIPELINE_IDS.includes(pipelineId) &&
    QUALIFYING_STAGE_IDS.has(stageId)
  );
}

// ---------------------------------------------------------------------------
// Поиск сделки по номеру телефона в локальной таблице PhoneMapping
// ---------------------------------------------------------------------------

export async function lookupDealByPhone(rawPhone: string): Promise<{
  dealId: number;
  pipelineId: number;
  stageId: number;
} | null> {
  const normalized = normalizePhone(rawPhone);
  if (!normalized || normalized.length < 7) return null;

  const mapping = await prisma.phoneMapping.findUnique({
    where: { phoneNormalized: normalized },
    include: { lastDeal: true },
  });

  if (!mapping?.lastDeal) return null;

  return {
    dealId: mapping.lastDeal.id,
    pipelineId: mapping.lastDeal.pipelineId,
    stageId: mapping.lastDeal.statusId,
  };
}

// ---------------------------------------------------------------------------
// Fallback: поиск контакта по телефону напрямую в amoCRM + сохранение в БД
// ---------------------------------------------------------------------------

export async function lookupDealByPhoneFromAmo(rawPhone: string): Promise<{
  dealId: number;
  pipelineId: number;
  stageId: number;
} | null> {
  if (!AMO_BASE_URL || !AMO_ACCESS_TOKEN) return null;

  const normalized = normalizePhone(rawPhone);
  if (!normalized || normalized.length < 7) return null;

  let contacts: any[];
  try {
    const data = await amoGet(
      `/api/v4/contacts?query=${encodeURIComponent(normalized)}&with=leads&limit=250`
    );
    contacts = data?._embedded?.contacts ?? [];
  } catch (err: any) {
    console.error("[AmoSync] Fallback phone search failed:", err.message);
    return null;
  }

  if (!contacts.length) {
    return null; // контакт не найден → нужно уведомить
  }

  console.log(`[AmoSync] Fallback: found ${contacts.length} contact(s) for phone ${normalized}`);

  const contactIds = contacts.map((c: any) => c.id as number);

  // Собираем lead_id из _embedded.leads (может быть неполным для авто-контактов)
  const allLeadIds = new Set<number>();
  for (const c of contacts) {
    for (const l of c._embedded?.leads ?? []) {
      allLeadIds.add(l.id);
    }
  }

  // Дополнительно: прямой запрос сделок по contact_id — надёжнее чем _embedded.leads
  try {
    const filter = contactIds.map((id) => `filter[contacts_id][]=${id}`).join("&");
    const leadsData = await amoGet(`/api/v4/leads?${filter}&limit=250`);
    for (const l of leadsData?._embedded?.leads ?? []) {
      allLeadIds.add(l.id);
    }
  } catch (err: any) {
    console.warn("[AmoSync] Fallback leads-by-contact query failed:", err.message);
  }

  const deals = allLeadIds.size ? await fetchDealsInfo([...allLeadIds]) : [];

  // Сохраняем каждый контакт в локальную БД (lazy-sync)
  for (const c of contacts) {
    const phones = extractPhones(c);
    const contactDeals = deals.filter((d) =>
      (c._embedded?.leads ?? []).some((l: any) => l.id === d.id)
    );
    await upsertPhoneMappingForContact(
      c.id,
      c.name ?? null,
      phones.length ? phones : [rawPhone],
      contactDeals
    );
  }

  const sortedByDate = [...deals].sort(
    (a, b) => b.amoUpdatedAt.getTime() - a.amoUpdatedAt.getTime()
  );
  // Берём любую сделку — самую свежую (фильтр по воронке убран)
  const bestDeal = sortedByDate[0] ?? null;

  if (!bestDeal) {
    return null; // контакт есть, но сделок нет вообще
  }

  console.log(`[AmoSync] Fallback: found deal ${bestDeal.id} for phone ${normalized}`);
  return {
    dealId: bestDeal.id,
    pipelineId: bestDeal.pipelineId,
    stageId: bestDeal.statusId,
  };
}

// ---------------------------------------------------------------------------
// Извлечение телефонов из amoCRM контакта
// ---------------------------------------------------------------------------

function extractPhones(contact: any): string[] {
  const phones: string[] = [];
  const fields: any[] = contact.custom_fields_values ?? [];
  for (const field of fields) {
    if (
      field.field_type === "multitext" ||
      field.field_code === "PHONE" ||
      field.field_name === "Телефон"
    ) {
      for (const v of field.values ?? []) {
        if (v?.value) phones.push(String(v.value));
      }
    }
  }
  return phones;
}

// ---------------------------------------------------------------------------
// Получить информацию о сделках по массиву ID (max 50 за раз)
// ---------------------------------------------------------------------------

async function fetchDealsInfo(
  ids: number[]
): Promise<Array<{ id: number; pipelineId: number; statusId: number; amoUpdatedAt: Date; name: string | null }>> {
  if (!ids.length) return [];

  const results: any[] = [];
  const chunks = chunkArray(ids, 50);

  for (const chunk of chunks) {
    try {
      const filter = chunk.map((id) => `filter[id][]=${id}`).join("&");
      const data = await amoGet(`/api/v4/leads?${filter}&limit=50`);
      results.push(...(data?._embedded?.leads ?? []));
    } catch {
      // пустая страница — игнорируем
    }
    await sleep(150);
  }

  return results.map((l: any) => ({
    id: l.id,
    pipelineId: l.pipeline_id,
    statusId: l.status_id,
    amoUpdatedAt: new Date(l.updated_at * 1000),
    name: l.name ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Обновление PhoneMapping для одного контакта
// ---------------------------------------------------------------------------

async function upsertPhoneMappingForContact(
  contactId: number,
  contactName: string | null,
  phones: string[],
  deals: Array<{ id: number; pipelineId: number; statusId: number; amoUpdatedAt: Date; name: string | null }>
): Promise<void> {
  if (!phones.length) return;

  // Выбираем лучшую сделку:
  // 1. Первым приоритет — qualifying (нужная воронка + нужная стадия), свежайшая по дате
  // 2. Иначе — любая сделка из qualifying pipelines, свежайшая по дате
  const sortedByDate = [...deals].sort(
    (a, b) => b.amoUpdatedAt.getTime() - a.amoUpdatedAt.getTime()
  );
  const bestDeal =
    sortedByDate.find((d) => isQualifyingDeal(d.pipelineId, d.statusId)) ??
    sortedByDate.find((d) => QUALIFYING_PIPELINE_IDS.includes(d.pipelineId));

  // Гарантируем существование Contact в нашей БД
  await prisma.contact.upsert({
    where: { id: contactId },
    update: { name: contactName ?? undefined },
    create: { id: contactId, name: contactName },
  });

  // Гарантируем существование Deal в нашей БД
  if (bestDeal) {
    await prisma.deal.upsert({
      where: { id: bestDeal.id },
      update: {
        pipelineId: bestDeal.pipelineId,
        statusId: bestDeal.statusId,
        name: bestDeal.name,
        contactId,
      },
      create: {
        id: bestDeal.id,
        pipelineId: bestDeal.pipelineId,
        statusId: bestDeal.statusId,
        name: bestDeal.name,
        contactId,
      },
    });
  }

  // Обновляем PhoneMapping для каждого телефона контакта
  for (const rawPhone of phones) {
    if (!rawPhone) continue;
    const normalized = normalizePhone(rawPhone);
    if (!normalized || normalized.length < 7) continue;

    await prisma.phoneMapping.upsert({
      where: { phoneNormalized: normalized },
      update: {
        contactId,
        lastDealId: bestDeal?.id ?? null,
        lastDealUpdatedAt: bestDeal?.amoUpdatedAt ?? null,
      },
      create: {
        phoneNormalized: normalized,
        contactId,
        lastDealId: bestDeal?.id ?? null,
        lastDealUpdatedAt: bestDeal?.amoUpdatedAt ?? null,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Синхронизация одного контакта по ID (используется в вебхуке)
// ---------------------------------------------------------------------------

export async function syncContactById(contactId: number): Promise<void> {
  if (!AMO_BASE_URL || !AMO_ACCESS_TOKEN) return;

  try {
    const data = await amoGet(`/api/v4/contacts/${contactId}?with=leads`);
    const phones = extractPhones(data);
    const leadIds: number[] = data._embedded?.leads?.map((l: any) => l.id) ?? [];
    const deals = leadIds.length ? await fetchDealsInfo(leadIds) : [];
    await upsertPhoneMappingForContact(contactId, data.name ?? null, phones, deals);
  } catch (err: any) {
    console.error(`[AmoSync] Failed to sync contact ${contactId}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Массовая синхронизация контактов начиная с даты (первоначальная загрузка)
// ---------------------------------------------------------------------------

export async function syncContactsFromAmoCrm(fromDate: Date): Promise<{
  total: number;
  synced: number;
  errors: number;
}> {
  if (!AMO_BASE_URL || !AMO_ACCESS_TOKEN) {
    throw new Error("amoCRM credentials not configured");
  }

  const fromTs = Math.floor(fromDate.getTime() / 1000);
  let page = 1;
  let total = 0;
  let synced = 0;
  let errors = 0;

  console.log(`[AmoSync] Starting sync from ${fromDate.toISOString()}`);

  while (true) {
    let contacts: any[];

    try {
      const data = await amoGet(
        `/api/v4/contacts?with=leads&updated_at[from]=${fromTs}&limit=250&page=${page}`
      );
      contacts = data?._embedded?.contacts ?? [];
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 204 || status === 404) break; // нет больше данных
      console.error(`[AmoSync] Page ${page} request failed:`, err.message);
      break;
    }

    if (!contacts.length) break;
    total += contacts.length;

    for (const contact of contacts) {
      try {
        const phones = extractPhones(contact);
        if (!phones.length) continue;

        const leadIds: number[] =
          contact._embedded?.leads?.map((l: any) => l.id) ?? [];
        const deals = leadIds.length ? await fetchDealsInfo(leadIds) : [];

        await upsertPhoneMappingForContact(
          contact.id,
          contact.name ?? null,
          phones,
          deals
        );
        synced++;
      } catch (err: any) {
        errors++;
        console.error(`[AmoSync] Contact ${contact.id} error:`, err.message);
      }

      await sleep(100);
    }

    console.log(
      `[AmoSync] Page ${page}: processed ${contacts.length} contacts (synced=${synced}, errors=${errors})`
    );

    if (contacts.length < 250) break; // последняя страница
    page++;
    await sleep(200);
  }

  console.log(`[AmoSync] Done. total=${total} synced=${synced} errors=${errors}`);
  return { total, synced, errors };
}

// ---------------------------------------------------------------------------
// Повторная постановка в очередь пропущенных звонков по сделке
// ---------------------------------------------------------------------------

async function requeueSkippedCalls(dealId: number): Promise<void> {
  const calls = await prisma.call.findMany({
    where: { dealId, processingStatus: "skipped_stage" },
  });

  if (!calls.length) return;

  console.log(`[AmoWebhook] Requeueing ${calls.length} skipped call(s) for deal ${dealId}`);

  for (const call of calls) {
    const startedAt = call.startedAt.toISOString().replace("T", " ").slice(0, 19);
    const endedAt = call.endedAt.toISOString().replace("T", " ").slice(0, 19);

    await callProcessingQueue.add(`requeue_${call.externalId}`, {
      callExternalId: call.externalId,
      source: "onlinepbx" as const,
      receivedAt: new Date().toISOString(),
      manualTriggered: true,
      forceDealId: dealId,
      payload: {
        event: "call_end" as const,
        uuid: call.externalId,
        direction: call.direction as "in" | "out",
        caller: call.direction === "in" ? "" : "",
        callee: call.direction === "out" ? "" : "",
        start_time: startedAt,
        end_time: endedAt,
        duration: call.durationSeconds,
        status: call.status,
        record_url: call.recordUrl ?? undefined,
        external_number: "",
        internal_number: "",
      },
    });

    console.log(`[AmoWebhook] Requeued call ${call.externalId} for deal ${dealId}`);
  }
}

// ---------------------------------------------------------------------------
// Обработка вебхука от amoCRM (реалтайм обновление PhoneMapping)
// amoCRM шлёт URL-encoded тело: contacts[update][0][id]=123
// ---------------------------------------------------------------------------

export async function handleAmoCrmWebhook(body: any): Promise<void> {
  if (!AMO_BASE_URL || !AMO_ACCESS_TOKEN) {
    console.warn("[AmoWebhook] amoCRM credentials not configured, skipping");
    return;
  }

  // Проверяем смену стадии сделки на "Успешно завершена" (status_id=142)
  const updatedLeads: any[] = (() => {
    const items = body?.leads?.update;
    if (!items) return [];
    return Array.isArray(items) ? items : Object.values(items);
  })();

  for (const lead of updatedLeads) {
    const dealId = Number(lead?.id);
    const statusId = Number(lead?.status_id);
    const pipelineId = Number(lead?.pipeline_id);

    // Поступления фиксируем в любой воронке, а не только в квалифицирующих:
    // оплата остаётся оплатой независимо от того, где живёт сделка.
    if (Number.isInteger(dealId) && dealId > 0) {
      recordDealRevenue(dealId, pipelineId, statusId, {
        readLead: async (id) => await amoGet(`/api/v4/leads/${id}`),
      })
        .then((result) => {
          if (result.kind === "recorded") {
            console.log(
              `[AmoWebhook] Recorded ${result.revenueKind} revenue for deal ${dealId}:`,
              { amount: result.amount, managerId: result.managerId }
            );
          }
        })
        .catch((err) =>
          console.error(`[AmoWebhook] recordDealRevenue error for deal ${dealId}:`, err.message)
        );
    }

    if (QUALIFYING_PIPELINE_IDS.includes(pipelineId)) {
      if (statusId === 142) {
        console.log(`[AmoWebhook] Deal ${dealId} moved to won, marking ✅ in Sheets`);
        markDealAsWon(dealId).catch((err) =>
          console.error(`[AmoWebhook] markDealAsWon error for deal ${dealId}:`, err.message)
        );
      } else if (statusId === 143) {
        console.log(`[AmoWebhook] Deal ${dealId} moved to lost, marking ❌ in Sheets`);
        markDealAsLost(dealId).catch((err) =>
          console.error(`[AmoWebhook] markDealAsLost error for deal ${dealId}:`, err.message)
        );
      }

      // Если сделка перешла в квалифицирующую стадию — ставим в очередь
      // пропущенные ранее звонки (были skipped_stage когда стадия не подходила)
      if (isQualifyingDeal(pipelineId, statusId)) {
        requeueSkippedCalls(dealId).catch((err) =>
          console.error(`[AmoWebhook] requeueSkippedCalls error for deal ${dealId}:`, err.message)
        );
      }
    }
  }

  const contactIds = new Set<number>();

  // Контакты напрямую из вебхука
  for (const action of ["add", "update"]) {
    const items = body?.contacts?.[action];
    if (!items) continue;
    const arr: any[] = Array.isArray(items) ? items : Object.values(items);
    arr.forEach((c) => c?.id && contactIds.add(Number(c.id)));
  }

  // Сделки → получаем связанные контакты через API
  const leadIds: number[] = [];
  for (const action of ["add", "update"]) {
    const items = body?.leads?.[action];
    if (!items) continue;
    const arr: any[] = Array.isArray(items) ? items : Object.values(items);
    arr.forEach((l) => l?.id && leadIds.push(Number(l.id)));
  }

  if (leadIds.length) {
    for (const leadId of leadIds) {
      try {
        const data = await amoGet(`/api/v4/leads/${leadId}?with=contacts`);
        const embedded: any[] = data?._embedded?.contacts ?? [];
        embedded.forEach((c) => c?.id && contactIds.add(Number(c.id)));
      } catch (err: any) {
        console.error(`[AmoWebhook] Failed to resolve contacts for lead ${leadId}:`, err.message);
      }
      await sleep(150);
    }
  }

  if (!contactIds.size) return;

  for (const contactId of contactIds) {
    await syncContactById(contactId);
    await sleep(150);
  }
}

// ---------------------------------------------------------------------------
// Получение примечаний-звонков из сделки amoCRM
// ---------------------------------------------------------------------------

export interface AmoCrmCallNote {
  id: number;
  noteType: string; // "call_in" | "call_out" | "common" | ...
  createdAt: Date;
  duration: number; // секунды
  recordUrl: string | null;
  phone: string | null; // внешний номер телефона
  uniq: string | null; // UUID от OnlinePBX (если есть)
  internalNumber: string | null; // внутренний номер менеджера (из URL записи)
  /** Текст примечания. Для звонков часто пуст, для обычных заметок — содержимое. */
  text: string;
  /** Откуда пришло примечание: со сделки или со связанного контакта. */
  source: "lead" | "contact";
}

/** Примечание со ссылкой на запись — только такие можно поставить в анализ. */
export function isCallRecordingNote(note: AmoCrmCallNote): boolean {
  return note.recordUrl !== null;
}

/**
 * Декодирует base64-часть URL записи OnlinePBX и извлекает внутренний номер.
 * Формат URL: .../download_amocrm/{base64}_{подпись}/rec.mp3
 * base64 → JSON: {"u":"uuid","f":"101","t":"phone",...}
 */
function extractInternalNumberFromRecordUrl(url: string): string | null {
  try {
    const match = url.match(/\/download_amocrm\/([A-Za-z0-9+/=]+)_[^/]+\//);
    if (!match) return null;
    const parsed = JSON.parse(Buffer.from(match[1], "base64").toString("utf-8"));
    return parsed.f ? String(parsed.f) : null;
  } catch {
    return null;
  }
}

// Гарантирует существование сделки в локальной БД (upsert из amoCRM).
// Используется перед созданием Call с forceDealId.
export async function ensureDealInDb(dealId: number): Promise<void> {
  const existing = await prisma.deal.findUnique({ where: { id: dealId } });
  if (existing) return;

  const deals = await fetchDealsInfo([dealId]);
  const deal = deals[0];
  if (!deal) {
    console.warn(`[AmoCRM] ensureDealInDb: deal ${dealId} not found in amoCRM`);
    return;
  }

  await prisma.deal.upsert({
    where: { id: deal.id },
    update: { pipelineId: deal.pipelineId, statusId: deal.statusId, name: deal.name },
    create: { id: deal.id, pipelineId: deal.pipelineId, statusId: deal.statusId, name: deal.name },
  });
}

/**
 * Возвращает ВСЕ примечания сущности, а не только звонки с записью.
 * Раньше здесь отбрасывались примечания без ссылки на запись, из-за чего
 * диагностика в боте показывала «примечаний нет» там, где они были.
 */
async function fetchNotesFromEntity(
  entityType: "leads" | "contacts",
  entityId: number
): Promise<AmoCrmCallNote[]> {
  const notes: AmoCrmCallNote[] = [];
  let page = 1;

  while (true) {
    let data: any;
    try {
      data = await amoGet(
        `/api/v4/${entityType}/${entityId}/notes?limit=250&page=${page}`
      );
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 204 || status === 404) break;
      throw err;
    }

    const items: any[] = data?._embedded?.notes ?? [];
    if (!items.length) break;

    for (const item of items) {
      const params = item.params ?? {};
      const recordUrl: string | null =
        params.link ??
        (params.text ? (params.text.match(/https?:\/\/\S+/) ?? [null])[0]?.replace(/["')\]>.,;]+$/, "") ?? null : null);

      // Parse duration: prefer params.duration, fallback to text "HH:MM:SS" or "MM:SS"
      let duration = Number(params.duration ?? 0);
      if (!duration) {
        const text: string = params.text ?? item.text ?? "";
        const timeMatch = text.match(/(\d{1,2}):(\d{2}):(\d{2})|(\d{1,2}):(\d{2})/);
        if (timeMatch) {
          if (timeMatch[1] !== undefined) {
            duration = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
          } else {
            duration = parseInt(timeMatch[4]) * 60 + parseInt(timeMatch[5]);
          }
        }
      }

      notes.push({
        id: item.id,
        noteType: item.note_type ?? "",
        createdAt: new Date((item.created_at ?? 0) * 1000),
        duration,
        recordUrl,
        phone: params.phone ?? null,
        uniq: params.uniq ?? null,
        internalNumber: recordUrl ? extractInternalNumberFromRecordUrl(recordUrl) : null,
        text: String(params.text ?? item.text ?? "").trim(),
        source: entityType === "leads" ? "lead" : "contact",
      });
    }

    if (items.length < 250) break;
    page++;
    await sleep(150);
  }

  return notes;
}

export async function fetchDealCallNotes(dealId: number): Promise<AmoCrmCallNote[]> {
  if (!AMO_BASE_URL || !AMO_ACCESS_TOKEN) return [];

  // Fetch notes from the lead itself
  const leadNotes = await fetchNotesFromEntity("leads", dealId);

  // Fetch contact IDs linked to this deal
  let contactIds: number[] = [];
  try {
    const dealData = await amoGet(`/api/v4/leads/${dealId}?with=contacts`);
    contactIds = (dealData?._embedded?.contacts ?? []).map((c: any) => c.id as number);
  } catch {
    // ignore, proceed with lead notes only
  }

  // Fetch notes from each contact
  const contactNoteArrays = await Promise.all(
    contactIds.map((cid) => fetchNotesFromEntity("contacts", cid).catch(() => [] as AmoCrmCallNote[]))
  );
  const contactNotes = contactNoteArrays.flat();

  // Merge, deduplicate by note ID
  const seen = new Set<number>();
  const allNotes: AmoCrmCallNote[] = [];
  for (const note of [...leadNotes, ...contactNotes]) {
    if (!seen.has(note.id)) {
      seen.add(note.id);
      allNotes.push(note);
    }
  }

  console.log(
    `[fetchDealCallNotes] deal=${dealId} lead_notes=${leadNotes.length} contact_notes=${contactNotes.length} ` +
    `contacts=${contactIds.join(",")} total=${allNotes.length} with_recording=${allNotes.filter(isCallRecordingNote).length}`
  );

  return allNotes;
}

export interface AmoCrmDealSummary {
  id: number;
  name: string | null;
  pipelineId: number | null;
  pipelineName: string | null;
  statusId: number | null;
  statusName: string | null;
  price: number | null;
  responsibleUserId: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  /** Заполненные пользовательские поля: имя поля → значения. */
  fields: Array<{ name: string; values: string[] }>;
  contacts: Array<{ id: number; name: string | null; phones: string[] }>;
}

function readLeadFieldValues(lead: any): Array<{ name: string; values: string[] }> {
  const raw = lead?.custom_fields_values;
  if (!Array.isArray(raw)) return [];
  const fields: Array<{ name: string; values: string[] }> = [];
  for (const field of raw) {
    const name = typeof field?.field_name === "string" ? field.field_name.trim() : "";
    if (!name || !Array.isArray(field?.values)) continue;
    const values = field.values
      .map((entry: any) => {
        const value = entry?.value;
        if (value === null || value === undefined) return "";
        return typeof value === "object" ? String(value.value ?? "") : String(value);
      })
      .map((value: string) => value.trim())
      .filter(Boolean);
    if (values.length) fields.push({ name, values });
  }
  return fields;
}

/**
 * Данные сделки из amoCRM: стадия, бюджет, заполненные поля и контакты.
 * Используется, когда по сделке нечего анализировать, но информация есть.
 */
/**
 * Названия воронки и её этапов. Показывать оператору «Этап: 58160726» бесполезно,
 * поэтому имена берутся из amoCRM, а не из захардкоженного списка.
 */
async function fetchPipelineNames(
  pipelineId: number,
): Promise<{ pipelineName: string | null; statusNames: Map<number, string> } | null> {
  try {
    const data = await amoGet(`/api/v4/leads/pipelines/${pipelineId}`);
    const statusNames = new Map<number, string>();
    for (const status of data?._embedded?.statuses ?? []) {
      const id = Number(status?.id);
      if (Number.isInteger(id) && typeof status?.name === "string") statusNames.set(id, status.name);
    }
    return { pipelineName: typeof data?.name === "string" ? data.name : null, statusNames };
  } catch {
    return null;
  }
}

/** Every pipeline with its statuses; used to discover revenue stages. */
export async function fetchAllPipelines(): Promise<unknown> {
  if (!AMO_BASE_URL || !AMO_ACCESS_TOKEN) throw new Error("amoCRM credentials are not configured");
  return amoGet("/api/v4/leads/pipelines");
}

export async function fetchDealSummary(dealId: number): Promise<AmoCrmDealSummary | null> {
  if (!AMO_BASE_URL || !AMO_ACCESS_TOKEN) return null;

  let lead: any;
  try {
    lead = await amoGet(`/api/v4/leads/${dealId}?with=contacts`);
  } catch {
    return null;
  }
  if (!lead?.id) return null;

  const contacts: AmoCrmDealSummary["contacts"] = [];
  for (const embedded of lead?._embedded?.contacts ?? []) {
    const contactId = Number(embedded?.id);
    if (!Number.isInteger(contactId)) continue;
    try {
      const contact = await amoGet(`/api/v4/contacts/${contactId}`);
      contacts.push({
        id: contactId,
        name: typeof contact?.name === "string" ? contact.name : null,
        phones: extractPhones(contact),
      });
      await sleep(150);
    } catch {
      contacts.push({ id: contactId, name: null, phones: [] });
    }
  }

  const pipelineId = Number.isInteger(Number(lead.pipeline_id)) ? Number(lead.pipeline_id) : null;
  const statusId = Number.isInteger(Number(lead.status_id)) ? Number(lead.status_id) : null;
  const names = pipelineId !== null ? await fetchPipelineNames(pipelineId) : null;

  return {
    id: Number(lead.id),
    name: typeof lead.name === "string" ? lead.name : null,
    pipelineId,
    pipelineName: names?.pipelineName ?? null,
    statusId,
    statusName: statusId !== null ? names?.statusNames.get(statusId) ?? null : null,
    price: Number.isFinite(Number(lead.price)) ? Number(lead.price) : null,
    responsibleUserId: Number.isInteger(Number(lead.responsible_user_id)) ? Number(lead.responsible_user_id) : null,
    createdAt: Number(lead.created_at) ? new Date(Number(lead.created_at) * 1000) : null,
    updatedAt: Number(lead.updated_at) ? new Date(Number(lead.updated_at) * 1000) : null,
    fields: readLeadFieldValues(lead),
    contacts,
  };
}

// ---------------------------------------------------------------------------
// Получение телефонов контактов из сделки amoCRM
// ---------------------------------------------------------------------------

export async function fetchDealContactPhones(dealId: number): Promise<string[]> {
  if (!AMO_BASE_URL || !AMO_ACCESS_TOKEN) return [];

  try {
    const data = await amoGet(`/api/v4/leads/${dealId}?with=contacts`);
    const contacts: any[] = data?._embedded?.contacts ?? [];

    const phones: string[] = [];
    for (const contact of contacts) {
      try {
        const contactData = await amoGet(`/api/v4/contacts/${contact.id}`);
        phones.push(...extractPhones(contactData));
        await sleep(150);
      } catch {}
    }
    return phones;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Запись примечания в сделку amoCRM
// ---------------------------------------------------------------------------

export async function addNoteToDeal(dealId: number, text: string): Promise<void> {
  if (!AMO_BASE_URL || !AMO_ACCESS_TOKEN) {
    console.warn("[AmoCRM] Credentials not configured, skipping note");
    return;
  }

  await amoPost(`/api/v4/leads/${dealId}/notes`, [{ note_type: "common", params: { text } }]);
}

// ---------------------------------------------------------------------------
// Проверка и восстановление webhook в amoCRM
// ---------------------------------------------------------------------------

const WEBHOOK_EVENTS = [
  "leads.update",
  "contacts.add",
  "contacts.update",
];

export async function checkAndRestoreAmoCrmWebhook(
  notifyFn: (text: string) => Promise<void>
): Promise<void> {
  if (!AMO_BASE_URL || !AMO_ACCESS_TOKEN) {
    console.warn("[AmoWebhook] Credentials not configured, skipping check");
    return;
  }

  const appBaseUrl = process.env.APP_BASE_URL;
  if (!appBaseUrl) {
    console.warn("[AmoWebhook] APP_BASE_URL not set, skipping check");
    return;
  }

  const webhookUrl = `${appBaseUrl}/webhooks/amocrm`;

  // Проверяем наличие хука
  const isRegistered = await isWebhookRegistered(webhookUrl);
  if (isRegistered) {
    console.log("[AmoWebhook] Webhook is registered, OK");
    return;
  }

  console.warn("[AmoWebhook] Webhook not found, attempting to register...");

  // Две попытки регистрации
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await sleep(attempt * 1000);
      await amoPost("/api/v4/webhooks", { destination: webhookUrl, settings: WEBHOOK_EVENTS });
      console.log(`[AmoWebhook] Webhook registered on attempt ${attempt}`);
      return;
    } catch (err: any) {
      console.error(`[AmoWebhook] Register attempt ${attempt} failed:`, err.message);
    }
  }

  // Обе попытки провалились
  console.error("[AmoWebhook] Failed to restore webhook after 2 attempts, notifying admins");
  await notifyFn(
    "⚠️ amoCRM webhook не найден и не удалось его зарегистрировать после 2 попыток.\n\n" +
    `URL: ${webhookUrl}\n\nПроверьте настройки amoCRM вручную.`
  );
}

async function isWebhookRegistered(webhookUrl: string): Promise<boolean> {
  try {
    const data = await amoGet("/api/v4/webhooks");
    const hooks: any[] = data?._embedded?.webhooks ?? [];
    return hooks.some((h) => h.destination === webhookUrl);
  } catch (err: any) {
    console.error("[AmoWebhook] Failed to fetch webhooks list:", err.message);
    return false;
  }
}
