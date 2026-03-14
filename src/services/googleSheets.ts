import "dotenv/config";
import { google, sheets_v4 } from "googleapis";
import { prisma } from "../config/database";

let sheetsClient: sheets_v4.Sheets | null = null;

function getSheetsClient(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;

  const projectId = process.env.GOOGLE_PROJECT_ID;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Google Sheets credentials are not configured");
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

export const SHEET_HEADERS = [
  "Дата/Время",        // A
  "UUID",              // B
  "Телефон клиента",   // C
  "Длительность",      // D
  "Сделка ID",         // E
  "Менеджер",          // F
  "Текущий контекст",  // G
  "Выявил потребность",// H
  "Вытащил Боли",      // I
  "Резюме",            // J
  "Презентация",       // K
  "Точка Б + продукт", // L
  "Попытка закрытия",  // M
  "Отработка возражений", // N
  "Срочность",         // O
  "Договорённость след шаг", // P
  "Комментарии по обучению", // Q
  "Сумма баллов",      // R
  "Ссылка на запись",  // S
  "Сделка закрыта?",   // T
];

/**
 * Записывает строку заголовков если лист пустой.
 */
export async function ensureSheetHeader(): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tabName = process.env.GOOGLE_SHEETS_TAB_NAME || "Sheet1";
  if (!spreadsheetId) return;

  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A1:A1`,
  });

  const firstCell = res.data.values?.[0]?.[0];
  if (firstCell) return; // заголовок уже есть

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [SHEET_HEADERS] },
  });
}

async function markDealInSheet(dealId: number, mark: string): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tabName = process.env.GOOGLE_SHEETS_TAB_NAME || "Sheet1";
  if (!spreadsheetId) return;

  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!E:E`,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const rows = res.data.values ?? [];
  const rowIndex = rows.findIndex((r) => r[0] === `#${dealId}`);
  if (rowIndex === -1) {
    console.log(`[Sheets] markDeal: row for deal ${dealId} not found`);
    return;
  }

  const sheetRow = rowIndex + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!T${sheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[mark]] },
  });

  console.log(`[Sheets] deal ${dealId} marked ${mark} at row ${sheetRow}`);
}

/**
 * Находит строку по dealId в колонке E (HYPERLINK с display "#dealId")
 * и ставит ✅ в колонку T ("Сделка закрыта?").
 */
export async function markDealAsWon(dealId: number): Promise<void> {
  await markDealInSheet(dealId, "✅");
}

export async function markDealAsLost(dealId: number): Promise<void> {
  await markDealInSheet(dealId, "❌");
}

export async function appendCallRowToSheet(row: (string | number | null)[]) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.warn("GOOGLE_SHEETS_SPREADSHEET_ID is not set, skipping Sheets sync");
    return;
  }

  const sheets = getSheetsClient();
  const tabName = process.env.GOOGLE_SHEETS_TAB_NAME || "Sheet1";

  await ensureSheetHeader();

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A:T`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

/**
 * Перезаписывает вкладку менеджеров в Google Sheets.
 * Читает всех менеджеров из БД и пишет актуальный список.
 */
export async function writeManagersToSheet(): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tabName = process.env.GOOGLE_SHEETS_MANAGERS_TAB || "Менеджеры";

  if (!spreadsheetId) {
    console.warn("GOOGLE_SHEETS_SPREADSHEET_ID is not set, skipping managers sheet");
    return;
  }

  const sheets = getSheetsClient();

  // Гарантируем существование вкладки
  await ensureSheet(sheets, spreadsheetId, tabName);

  // Получаем всех менеджеров с их активными TelegramLink
  const managers = await prisma.manager.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    include: {
      // Берём все активные ссылки чтобы выбрать правильную
      telegramLinks: {
        where: { status: { in: ["issued", "used"] } },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  const header = [
    "Имя",
    "amoCRM ID",
    "Внутр. номер АТС",
    "Код",
    "Telegram ID",
    "Статус привязки",
    "Активен",
  ];

  const rows = managers.map((m) => {
    // Приоритет: used > issued (не затирать активацию новым кодом)
    const usedLink = m.telegramLinks.find((l) => l.status === "used");
    const issuedLink = m.telegramLinks.find((l) => l.status === "issued");
    const link = usedLink ?? issuedLink;

    const code = issuedLink ? issuedLink.oneTimeCode : "—";
    const tg = usedLink?.telegramUserId ?? "—";
    const linkStatus = usedLink
      ? "✅ привязан"
      : issuedLink
      ? "⏳ ожидает"
      : "❌ нет кода";
    const active = m.isActive ? "✅" : "🚫 уволен";
    void link; // использован выше через usedLink/issuedLink

    return [
      m.name,
      m.amoUserId ?? "—",
      m.internalNumber ?? "—",
      code,
      tg,
      linkStatus,
      active,
    ];
  });

  // Очищаем вкладку и записываем заново
  const range = `${tabName}!A1:G${rows.length + 1}`;

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${tabName}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: {
      values: [header, ...rows],
    },
  });
}

async function ensureSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string
): Promise<void> {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const exists = meta.data.sheets?.some((s) => s.properties?.title === title);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title } } }],
        },
      });
    }
  } catch {
    // ignore — вкладка уже может существовать
  }
}

