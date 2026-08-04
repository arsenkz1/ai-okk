import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../config/database";
import type { CallTaskAutomationNotifier, CallTaskAutomationResult } from "../services/callTaskAutomation";
import type { CallTaskAutomationAction } from "../services/callTaskAutomationLedger";
import { installSafeTelegramSender } from "./safeTelegram";

export type CallTaskReviewCommand = "today_18" | "tomorrow_10" | "custom" | "reject";

export interface CallTaskProposalDisplay {
  approvalToken: string;
  dealId: number;
  taskText: string | null;
  evidence: string | null;
}

export interface CallTaskReviewKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

const CALLBACK_PREFIX = "cta";
const CALLBACK_TOKEN = /^[A-Za-z0-9_-]{12,48}$/;
const CALLBACK_COMMANDS = new Set<CallTaskReviewCommand>(["today_18", "tomorrow_10", "custom", "reject"]);

export function buildCallTaskProposalKeyboard(approvalToken: string): CallTaskReviewKeyboard {
  if (!CALLBACK_TOKEN.test(approvalToken)) throw new Error("invalid call-task approval token");
  const callback = (command: CallTaskReviewCommand) => `${CALLBACK_PREFIX}:${approvalToken}:${command}`;
  return {
    inline_keyboard: [
      [
        { text: "Сегодня 18:00", callback_data: callback("today_18") },
        { text: "Завтра 10:00", callback_data: callback("tomorrow_10") },
      ],
      [
        { text: "Указать срок", callback_data: callback("custom") },
        { text: "Не создавать", callback_data: callback("reject") },
      ],
    ],
  };
}

export function parseCallTaskReviewCallback(value: string | undefined): { approvalToken: string; command: CallTaskReviewCommand } | null {
  if (!value) return null;
  const match = /^cta:([A-Za-z0-9_-]{12,48}):(today_18|tomorrow_10|custom|reject)$/.exec(value);
  if (!match || !CALLBACK_TOKEN.test(match[1]) || !CALLBACK_COMMANDS.has(match[2] as CallTaskReviewCommand)) return null;
  return { approvalToken: match[1], command: match[2] as CallTaskReviewCommand };
}

function dealUrl(baseUrl: string | undefined, dealId: number): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return `${url.origin}/leads/detail/${dealId}`;
  } catch {
    return null;
  }
}

export function buildCallTaskProposalText(action: CallTaskProposalDisplay, amoBaseUrl = process.env.AMOCRM_BASE_URL): string {
  if (!action.taskText || !action.evidence) throw new Error("incomplete call-task proposal cannot be notified");
  const link = dealUrl(amoBaseUrl, action.dealId);
  return [
    "Нужно выбрать срок для AI-задачи по звонку",
    link ? `Сделка: #${action.dealId} — ${link}` : `Сделка: #${action.dealId}`,
    `Действие: ${action.taskText}`,
    `Основание: ${action.evidence}`,
    "Выберите срок по времени Алматы или укажите его вручную.",
  ].join("\n\n");
}

export interface CallTaskReviewerDatabase {
  botAdmin: {
    findMany(args: { select: { telegramUserId: true } }): Promise<Array<{ telegramUserId: string | null }>>;
    findUnique(args: { where: { telegramUserId: string } }): Promise<{ telegramUserId: string | null } | null>;
  };
  telegramLink: {
    findMany(args: unknown): Promise<Array<{ telegramUserId: string | null }>>;
    findFirst(args: unknown): Promise<{ telegramUserId: string | null } | null>;
  };
}

function configuredAdminId(): string | null {
  const value = process.env.ADMIN_TELEGRAM_ID?.trim();
  return value || null;
}

export async function listCallTaskReviewerIds(database: CallTaskReviewerDatabase = prisma): Promise<string[]> {
  const [admins, rops] = await Promise.all([
    database.botAdmin.findMany({ select: { telegramUserId: true } }),
    database.telegramLink.findMany({
      where: { status: "used", manager: { isActive: true, role: "ROP" } },
      select: { telegramUserId: true },
    }),
  ]);
  const result = new Set<string>();
  const configured = configuredAdminId();
  if (configured) result.add(configured);
  for (const item of [...admins, ...rops]) {
    if (item.telegramUserId) result.add(item.telegramUserId);
  }
  return [...result];
}

export async function isCallTaskReviewer(
  telegramUserId: string,
  database: CallTaskReviewerDatabase = prisma,
): Promise<boolean> {
  if (telegramUserId === configuredAdminId()) return true;
  const [admin, rop] = await Promise.all([
    database.botAdmin.findUnique({ where: { telegramUserId } }),
    database.telegramLink.findFirst({
      where: { telegramUserId, status: "used", manager: { isActive: true, role: "ROP" } },
      select: { telegramUserId: true },
    }),
  ]);
  return Boolean(admin || rop);
}

let notificationBot: TelegramBot | null = null;

function getNotificationBot(): TelegramBot | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  if (!notificationBot) notificationBot = installSafeTelegramSender(new TelegramBot(token, { polling: false }));
  return notificationBot;
}

async function sendToReviewers(
  text: string,
  options: { reply_markup?: CallTaskReviewKeyboard } = {},
  database: CallTaskReviewerDatabase = prisma,
): Promise<void> {
  const bot = getNotificationBot();
  if (!bot) return;
  const recipients = await listCallTaskReviewerIds(database);
  for (const recipient of recipients) {
    try {
      await bot.sendMessage(recipient, text, {
        disable_web_page_preview: true,
        reply_markup: options.reply_markup,
      });
    } catch (error) {
      console.error("[CallTaskAutomation] Telegram reviewer notification failed", {
        recipient,
        reason: error instanceof Error ? error.message : "unknown error",
      });
    }
  }
}

function testResultText(action: CallTaskAutomationAction, result: CallTaskAutomationResult): string {
  const summary = result.kind === "confirmed"
    ? `Созданы задача #${result.taskId} и примечание.`
    : result.kind === "review_pending"
      ? "Нужно выбрать срок."
      : result.kind === "no_action"
        ? "Следующее действие не подтверждено — ничего не создано."
        : `Результат: ${result.kind}.`;
  return [
    "Тест AI-задач по звонкам",
    `Сделка: #${action.dealId}`,
    action.taskText ? `Действие: ${action.taskText}` : "Действие: не определено",
    summary,
  ].join("\n");
}

export function createCallTaskReviewNotifier(
  database: CallTaskReviewerDatabase = prisma,
): CallTaskAutomationNotifier {
  return {
    async notifyProposal(action): Promise<void> {
      await sendToReviewers(
        buildCallTaskProposalText(action),
        { reply_markup: buildCallTaskProposalKeyboard(action.approvalToken) },
        database,
      );
    },
    async notifyTestResult({ action, result }): Promise<void> {
      await sendToReviewers(testResultText(action, result), {}, database);
    },
  };
}
