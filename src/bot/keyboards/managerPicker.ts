import type TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import { formatManagerDisplayName } from "../../services/managerDisplayName";
import type { ActionContext } from "../actions/types";

/**
 * A paged list of things as inline buttons: managers, linked Telegram users,
 * teams. The caller decides what a tap means: it supplies the callback for a
 * chosen item and for a page turn.
 */

export const PICKER_PAGE_SIZE = 8;
export const MANAGER_PAGE_SIZE = PICKER_PAGE_SIZE;
const BUTTONS_PER_ROW = 2;

export interface PickerItem {
  /** Goes into the callback: digits or `[A-Za-z0-9_-]`, never a packed separator. */
  value: string;
  label: string;
}

export interface PickerManager {
  amoUserId: number;
  name: string;
}

export interface PickerCallbacks {
  pick: (value: string) => string;
  page: (page: number) => string;
}

export interface PickerPage {
  markup: TelegramBot.InlineKeyboardMarkup;
  page: number;
  pages: number;
}

export function pickerKeyboard(items: readonly PickerItem[], requestedPage: number, callbacks: PickerCallbacks): PickerPage {
  const pages = Math.max(1, Math.ceil(items.length / PICKER_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), pages);
  const slice = items.slice((page - 1) * PICKER_PAGE_SIZE, page * PICKER_PAGE_SIZE);

  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let index = 0; index < slice.length; index += BUTTONS_PER_ROW) {
    rows.push(slice.slice(index, index + BUTTONS_PER_ROW).map((item) => ({ text: item.label, callback_data: callbacks.pick(item.value) })));
  }
  if (pages > 1) {
    const nav: TelegramBot.InlineKeyboardButton[] = [];
    if (page > 1) nav.push({ text: "‹", callback_data: callbacks.page(page - 1) });
    nav.push({ text: `${page}/${pages}`, callback_data: callbacks.page(page) });
    if (page < pages) nav.push({ text: "›", callback_data: callbacks.page(page + 1) });
    rows.push(nav);
  }
  return { markup: { inline_keyboard: rows }, page, pages };
}

export const managerItems = (managers: readonly PickerManager[]): PickerItem[] => (
  managers.map((manager) => ({ value: String(manager.amoUserId), label: formatManagerDisplayName(manager.name) }))
);

export function managerPickerKeyboard(
  managers: readonly PickerManager[],
  requestedPage: number,
  callbacks: { pick: (amoUserId: number) => string; page: (page: number) => string },
): PickerPage {
  return pickerKeyboard(managerItems(managers), requestedPage, { pick: (value) => callbacks.pick(Number(value)), page: callbacks.page });
}

export interface ManagerFilter {
  role?: "MANAGER" | "TEAMLEAD" | "ROP";
}

export async function loadPickerManagers(filter: ManagerFilter = {}): Promise<PickerManager[]> {
  const rows = await prisma.manager.findMany({
    where: { isActive: true, amoUserId: { not: null }, ...(filter.role ? { role: filter.role } : {}) },
    orderBy: { name: "asc" },
    select: { amoUserId: true, name: true },
  });
  return rows.flatMap((row) => (row.amoUserId === null ? [] : [{ amoUserId: row.amoUserId, name: row.name }]));
}

/** Telegram accounts linked to an active manager, labelled by the manager. */
export async function loadLinkedUsers(): Promise<PickerItem[]> {
  const links = await prisma.telegramLink.findMany({
    where: { status: "used", telegramUserId: { not: null }, manager: { isActive: true } },
    select: { telegramUserId: true, manager: { select: { name: true, role: true } } },
    orderBy: { manager: { name: "asc" } },
  });
  return links.flatMap((link) => (
    link.telegramUserId === null ? [] : [{ value: link.telegramUserId, label: `${formatManagerDisplayName(link.manager.name)} (${link.manager.role})` }]
  ));
}

export async function loadTeams(): Promise<PickerItem[]> {
  const teams = await prisma.team.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
  return teams.map((team) => ({ value: String(team.id), label: team.name }));
}

const pickerDeps = {
  loadManagers: loadPickerManagers,
  loadLinkedUsers,
  loadTeams,
};

/** Tests replace the database queries. */
export function configureManagerPicker(overrides: Partial<typeof pickerDeps>): void {
  Object.assign(pickerDeps, overrides);
}

export const NO_MANAGERS_TEXT = "Faol menejerlar topilmadi.";
export const NO_ITEMS_TEXT = "Tanlash uchun hech narsa yo'q.";

export interface ShowPickerOptions {
  title: string;
  items: () => Promise<PickerItem[]>;
  page: number;
  callbacks: PickerCallbacks;
  /** Redraw the message under the tapped page button instead of sending a new one. */
  edit: boolean;
  emptyText?: string;
}

export async function showPicker(ctx: ActionContext, options: ShowPickerOptions): Promise<void> {
  const items = await options.items();
  if (items.length === 0) {
    await ctx.bot.sendMessage(ctx.chatId, options.emptyText ?? NO_ITEMS_TEXT);
    return;
  }
  const { markup } = pickerKeyboard(items, options.page, options.callbacks);
  if (options.edit && ctx.message) {
    try {
      await ctx.bot.editMessageReplyMarkup(markup, { chat_id: ctx.chatId, message_id: ctx.message.message_id });
      return;
    } catch {
      // The message may be too old to edit; fall through to a fresh one.
    }
  }
  await ctx.bot.sendMessage(ctx.chatId, options.title, { reply_markup: markup });
}

export type PickerSource =
  | { kind: "managers"; filter?: ManagerFilter }
  | { kind: "linkedUsers" }
  | { kind: "teams" };

export function pickerItemsFor(source: PickerSource): () => Promise<PickerItem[]> {
  switch (source.kind) {
    case "managers": return async () => managerItems(await pickerDeps.loadManagers(source.filter ?? {}));
    case "linkedUsers": return () => pickerDeps.loadLinkedUsers();
    case "teams": return () => pickerDeps.loadTeams();
  }
}

export interface ShowManagerPickerOptions {
  title: string;
  page: number;
  callbacks: { pick: (amoUserId: number) => string; page: (page: number) => string };
  edit: boolean;
  filter?: ManagerFilter;
}

export async function showManagerPicker(ctx: ActionContext, options: ShowManagerPickerOptions): Promise<void> {
  await showPicker(ctx, {
    title: options.title,
    items: pickerItemsFor({ kind: "managers", filter: options.filter }),
    page: options.page,
    edit: options.edit,
    emptyText: NO_MANAGERS_TEXT,
    callbacks: { pick: (value) => options.callbacks.pick(Number(value)), page: options.callbacks.page },
  });
}
