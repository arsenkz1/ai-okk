import "dotenv/config";
import axios from "axios";
import { prisma } from "../config/database";

// ---------------------------------------------------------------------------
// Конфигурация
// ---------------------------------------------------------------------------

const AMO_BASE_URL = process.env.AMOCRM_BASE_URL;
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
// Rate limiter: не более 2 запросов в секунду к amoCRM
// ---------------------------------------------------------------------------

let lastAmoRequestAt = 0;
const AMO_MIN_INTERVAL_MS = 500; // 1000ms / 2 req

async function amoGet(path: string): Promise<any> {
  const now = Date.now();
  const wait = lastAmoRequestAt + AMO_MIN_INTERVAL_MS - now;
  if (wait > 0) await sleep(wait);
  lastAmoRequestAt = Date.now();

  const r = await axios.get(`${AMO_BASE_URL}${path}`, { headers: amoHeaders() });
  return r.data;
}

// ---------------------------------------------------------------------------
// Нормализация телефона
// Приводим к формату 7XXXXXXXXXX (11 цифр, начинается с 7)
// ---------------------------------------------------------------------------

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) {
    return "7" + digits.slice(1);
  }
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

  console.log(`[AmoSync] Fallback: searching contact by phone ${normalized} in amoCRM`);

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
    console.log(`[AmoSync] Fallback: no contacts found for phone ${normalized}`);
    return null;
  }

  console.log(`[AmoSync] Fallback: found ${contacts.length} contact(s) for phone ${normalized}`);

  // Собираем все lead_id со всех контактов (дедупликация)
  const allLeadIds = new Set<number>();
  for (const c of contacts) {
    for (const l of c._embedded?.leads ?? []) {
      allLeadIds.add(l.id);
    }
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
  const bestDeal =
    sortedByDate.find((d) => isQualifyingDeal(d.pipelineId, d.statusId)) ??
    sortedByDate.find((d) => QUALIFYING_PIPELINE_IDS.includes(d.pipelineId));

  if (!bestDeal) {
    console.log(`[AmoSync] Fallback: ${contacts.length} contact(s) found but no qualifying deal for phone ${normalized}`);
    return null;
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
// Обработка вебхука от amoCRM (реалтайм обновление PhoneMapping)
// amoCRM шлёт URL-encoded тело: contacts[update][0][id]=123
// ---------------------------------------------------------------------------

export async function handleAmoCrmWebhook(body: any): Promise<void> {
  if (!AMO_BASE_URL || !AMO_ACCESS_TOKEN) {
    console.warn("[AmoWebhook] amoCRM credentials not configured, skipping");
    return;
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
  noteType: string; // "call_in" | "call_out"
  createdAt: Date;
  duration: number; // секунды
  recordUrl: string | null;
  phone: string | null; // внешний номер телефона
  uniq: string | null; // UUID от OnlinePBX (если есть)
  internalNumber: string | null; // внутренний номер менеджера (из URL записи)
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

export async function fetchDealCallNotes(dealId: number): Promise<AmoCrmCallNote[]> {
  if (!AMO_BASE_URL || !AMO_ACCESS_TOKEN) return [];

  const notes: AmoCrmCallNote[] = [];
  let page = 1;

  while (true) {
    let data: any;
    try {
      data = await amoGet(
        `/api/v4/leads/${dealId}/notes?filter[note_type][]=call_in&filter[note_type][]=call_out&limit=250&page=${page}`
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
      const recordUrl: string | null = params.link ?? null;
      notes.push({
        id: item.id,
        noteType: item.note_type ?? "",
        createdAt: new Date((item.created_at ?? 0) * 1000),
        duration: Number(params.duration ?? 0),
        recordUrl,
        phone: params.phone ?? null,
        uniq: params.uniq ?? null,
        internalNumber: recordUrl ? extractInternalNumberFromRecordUrl(recordUrl) : null,
      });
    }

    if (items.length < 250) break;
    page++;
    await sleep(150);
  }

  return notes;
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

  await axios.post(
    `${AMO_BASE_URL}/api/v4/leads/${dealId}/notes`,
    [{ note_type: "common", params: { text } }],
    { headers: amoHeaders() }
  );
}
