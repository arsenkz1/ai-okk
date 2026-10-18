import type TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import {
  canViewDealDossier,
  formatDealDossier,
  loadDealDossier,
  type DealDossierViewer,
} from "../../services/dealDossier";
import { findLinkedManager, isBotAdmin, isLinkedAs } from "../access";
import { NOT_LINKED_TEXT } from "./dispatch";
import { defineAction } from "./registry";

/**
 * Deal dossier: /deal <id>, or a bare deal id typed into the chat.
 */

async function resolveDealDossierViewer(telegramUserId: string): Promise<DealDossierViewer | null> {
  if (await isBotAdmin(telegramUserId)) return { role: "ADMIN", managerId: null };

  const manager = await findLinkedManager(telegramUserId);
  if (!manager || !manager.isActive) return null;
  if (isLinkedAs(manager, "rop")) return { role: "ROP", managerId: manager.id };
  if (!isLinkedAs(manager, "teamlead")) return { role: "MANAGER", managerId: manager.id };

  // A team lead may lead a team without being a member of it, so the team is
  // resolved from the Team row rather than from their own teamId.
  const teams = await prisma.team.findMany({
    where: { OR: [{ teamLeadId: manager.id }, ...(manager.teamId ? [{ id: manager.teamId }] : [])] },
    select: { members: { select: { id: true } } },
  });
  return {
    role: "TEAMLEAD",
    managerId: manager.id,
    teamManagerIds: teams.flatMap((team) => team.members.map((member) => member.id)),
  };
}

export async function sendDealDossier(
  bot: Pick<TelegramBot, "sendMessage">,
  chatId: number,
  telegramUserId: string,
  dealId: number,
): Promise<void> {
  const viewer = await resolveDealDossierViewer(telegramUserId);
  if (!viewer) {
    await bot.sendMessage(chatId, NOT_LINKED_TEXT);
    return;
  }

  const dossier = await loadDealDossier(dealId);
  if (!dossier) {
    await bot.sendMessage(chatId, `❌ Bitim #${dealId} bazada topilmadi.`);
    return;
  }

  // A manager with no calls on the deal is told the same thing as for a missing
  // deal: the reply must not confirm that someone else's deal exists.
  if (!canViewDealDossier(viewer, dossier.calls)) {
    await bot.sendMessage(chatId, `❌ Bitim #${dealId} bazada topilmadi.`);
    return;
  }

  await bot.sendMessage(chatId, formatDealDossier(dossier), { disable_web_page_preview: true });
}

export const DEAL_USAGE_TEXT = "ℹ️ Foydalanish: /deal <bitim ID>\nYoki shunchaki bitim ID raqamini yuboring.";

defineAction({
  id: "deal", section: "reports", roles: ["admin", "manager"], label: "Bitim",
  // Inactive managers always got the "not authorized" text here, not the
  // "deactivated" one; kept so the reply does not change.
  denyText: NOT_LINKED_TEXT,
  input: { kind: "deal_id", prompt: "Bitim ID raqamini yuboring:" },
  command: { pattern: /^\/deal(?:@\w+)?\s+(\d{4,12})$/, usage: "/deal <id>", description: "bitim bo'yicha ma'lumotnoma" },
  run: (ctx) => sendDealDossier(ctx.bot, ctx.chatId, ctx.telegramUserId, parseInt(ctx.args[0], 10)),
});

defineAction({
  id: "deal_usage", section: "reports", roles: [], label: "Bitim (foydalanish)", commandOnly: true, helpHidden: true,
  command: { pattern: /^\/deal(?:@\w+)?$/, usage: "/deal", description: "foydalanish bo'yicha eslatma" },
  async run(ctx) {
    await ctx.bot.sendMessage(ctx.chatId, DEAL_USAGE_TEXT);
  },
});
