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

async function amoGet(path: string): Promise<any> {
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
    console.log(`[AmoSync] Fetching contact ${contactId} from amoCRM...`);
    const data = await amoGet(`/api/v4/contacts/${contactId}?with=leads`);
    const phones = extractPhones(data);
    const leadIds: number[] = data._embedded?.leads?.map((l: any) => l.id) ?? [];

    console.log(`[AmoSync] Contact ${contactId} "${data.name ?? "—"}": phones=${JSON.stringify(phones)}, leadIds=${JSON.stringify(leadIds)}`);

    const deals = leadIds.length ? await fetchDealsInfo(leadIds) : [];

    const qualifying = deals.filter((d) => isQualifyingDeal(d.pipelineId, d.statusId));
    console.log(
      `[AmoSync] Contact ${contactId}: total deals=${deals.length}, qualifying=${qualifying.length}` +
        (qualifying.length
          ? ` [${qualifying.map((d) => `deal#${d.id} p=${d.pipelineId} s=${d.statusId}`).join(", ")}]`
          : "")
    );

    await upsertPhoneMappingForContact(contactId, data.name ?? null, phones, deals);
    console.log(`[AmoSync] ✓ PhoneMapping updated for contact ${contactId}`);
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
    console.log(`[AmoWebhook] Resolving contacts for lead IDs: ${leadIds.join(", ")}`);
    for (const leadId of leadIds) {
      try {
        const data = await amoGet(`/api/v4/leads/${leadId}?with=contacts`);
        const embedded: any[] = data?._embedded?.contacts ?? [];
        embedded.forEach((c) => c?.id && contactIds.add(Number(c.id)));
        console.log(`[AmoWebhook] Lead ${leadId} → contacts: ${embedded.map((c) => c.id).join(", ") || "none"}`);
      } catch (err: any) {
        console.error(`[AmoWebhook] Failed to resolve contacts for lead ${leadId}:`, err.message);
      }
      await sleep(150);
    }
  }

  console.log(`[AmoWebhook] Contacts to sync: [${[...contactIds].join(", ")}] (total: ${contactIds.size})`);

  if (!contactIds.size) {
    console.log("[AmoWebhook] No contacts found in webhook body, nothing to sync");
    return;
  }

  for (const contactId of contactIds) {
    await syncContactById(contactId);
    await sleep(150);
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
