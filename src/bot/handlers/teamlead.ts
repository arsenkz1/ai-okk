import TelegramBot from "node-telegram-bot-api";
import { prisma } from "../../config/database";
import {
  getTeamRating,
  getTeamMistakes,
  buildManagerCard,
  ManagerWithScore,
} from "../../services/teamStats";
import { roleFlowState, teamLeadManageFlowState, TeamLeadManageMode } from "../state";

type TeamLeadManager = Awaited<
  ReturnType<typeof prisma.manager.findUniqueOrThrow>
> & { team: { id: number; name: string; teamLeadId: number | null } | null };

type TeamMemberOption = {
  id: number;
  name: string;
  teamId: number | null;
  ownerLabel: string | null;
  selectable: boolean;
};

const PAGE_SIZE = 10;

async function getTeamLead(telegramUserId: string): Promise<TeamLeadManager | null> {
  const link = await prisma.telegramLink.findFirst({
    where: { telegramUserId, status: "used" },
    include: { manager: { include: { team: true } } },
  });
  const mgr = link?.manager as TeamLeadManager | undefined;
  if (!mgr || mgr.role !== "TEAMLEAD") return null;
  return mgr;
}

async function requireTeamLead(
  bot: TelegramBot,
  msg: TelegramBot.Message
): Promise<TeamLeadManager | null> {
  const tl = await getTeamLead(String(msg.from!.id));
  if (!tl) {
    await bot.sendMessage(msg.chat.id, "❌ Sizda TeamLead huquqi yo'q.");
    return null;
  }
  if (!tl.isActive) {
    await bot.sendMessage(msg.chat.id, "❌ Hisobingiz deaktiv qilingan.");
    return null;
  }
  return tl;
}

async function requireTeamAssignment(
  bot: TelegramBot,
  chatId: number,
  tl: TeamLeadManager | null
): Promise<TeamLeadManager | null> {
  if (!tl) return null;
  if (tl.teamId) return tl;

  await bot.sendMessage(
    chatId,
    "ℹ️ Sizga hali jamoa biriktirilmagan. Administratorga murojaat qiling."
  );
  return null;
}

function formatRating(items: ManagerWithScore[]): string {
  if (!items.length) return "Ishtirokchilar topilmadi.";
  return items
    .map(({ manager, avgScore }, i) => {
      const score = avgScore != null ? `${avgScore}/100` : "ma'lumot yo'q";
      return `${i + 1}. ${manager.name} — ${score}`;
    })
    .join("\n");
}

async function sendInChunks(bot: TelegramBot, chatId: number, text: string) {
  const maxLength = 4096;
  if (text.length <= maxLength) {
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    return;
  }

  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    if ((chunk + "\n" + line).length > maxLength) {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }

  if (chunk) {
    await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
  }
}

async function getOwnerLabelsByTeamId(
  teamIds: number[]
): Promise<Map<number, string>> {
  if (!teamIds.length) return new Map();

  const teams = await prisma.team.findMany({
    where: { id: { in: teamIds } },
    select: { id: true, teamLeadId: true, name: true },
  });

  const teamLeadIds = teams
    .map((team) => team.teamLeadId)
    .filter((id): id is number => id != null);

  const teamLeads = teamLeadIds.length
    ? await prisma.manager.findMany({
        where: { id: { in: teamLeadIds } },
        select: { id: true, name: true, amoUserId: true },
      })
    : [];

  const teamLeadMap = new Map(teamLeads.map((tl) => [tl.id, tl]));
  const ownerLabelMap = new Map<number, string>();

  for (const team of teams) {
    const tl = team.teamLeadId ? teamLeadMap.get(team.teamLeadId) : null;
    if (tl?.name) {
      ownerLabelMap.set(team.id, tl.name);
      continue;
    }
    if (tl?.amoUserId) {
      ownerLabelMap.set(team.id, `amoID ${tl.amoUserId}`);
      continue;
    }
    ownerLabelMap.set(team.id, team.name);
  }

  return ownerLabelMap;
}

async function getAddCandidates(
  tl: TeamLeadManager
): Promise<TeamMemberOption[]> {
  const managers = await prisma.manager.findMany({
    where: { role: "MANAGER", isActive: true },
    select: { id: true, name: true, teamId: true },
    orderBy: { name: "asc" },
  });

  const teamIds = managers
    .map((manager) => manager.teamId)
    .filter((teamId): teamId is number => teamId != null);

  const ownerLabelMap = await getOwnerLabelsByTeamId([...new Set(teamIds)]);

  return managers.map((manager) => {
    if (manager.teamId == null) {
      return {
        id: manager.id,
        name: manager.name,
        teamId: null,
        ownerLabel: null,
        selectable: true,
      };
    }

    return {
      id: manager.id,
      name: manager.name,
      teamId: manager.teamId,
      ownerLabel:
        manager.teamId === tl.teamId
          ? "Sizning jamoangiz"
          : `TL: ${ownerLabelMap.get(manager.teamId) ?? `jamoa ${manager.teamId}`}`,
      selectable: false,
    };
  });
}

async function getRemoveCandidates(
  tl: TeamLeadManager
): Promise<TeamMemberOption[]> {
  const managers = await prisma.manager.findMany({
    where: { teamId: tl.teamId, role: "MANAGER", isActive: true },
    select: { id: true, name: true, teamId: true },
    orderBy: { name: "asc" },
  });

  return managers.map((manager) => ({
    id: manager.id,
    name: manager.name,
    teamId: manager.teamId,
    ownerLabel: null,
    selectable: true,
  }));
}

async function getCandidatesForMode(
  mode: TeamLeadManageMode,
  tl: TeamLeadManager
): Promise<TeamMemberOption[]> {
  return mode === "add" ? getAddCandidates(tl) : getRemoveCandidates(tl);
}

function buildSelectionKeyboard(
  mode: TeamLeadManageMode,
  candidates: TeamMemberOption[],
  page: number,
  selectedIds: number[]
): TelegramBot.InlineKeyboardButton[][] {
  const totalPages = Math.max(1, Math.ceil(candidates.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const pageItems = candidates.slice(start, start + PAGE_SIZE);
  const keyboard: TelegramBot.InlineKeyboardButton[][] = [];

  for (const candidate of pageItems) {
    let label = candidate.name;
    if (candidate.selectable) {
      label = `${selectedIds.includes(candidate.id) ? "✅" : "⬜"} ${candidate.name}`;
    } else {
      label = `🔒 ${candidate.name}${candidate.ownerLabel ? ` — ${candidate.ownerLabel}` : ""}`;
    }

    keyboard.push([
      {
        text: label,
        callback_data: candidate.selectable
          ? `tl_manage:${mode}:toggle:${candidate.id}`
          : `tl_manage:${mode}:blocked:${candidate.id}`,
      },
    ]);
  }

  const navRow: TelegramBot.InlineKeyboardButton[] = [];
  if (safePage > 0) {
    navRow.push({ text: "⬅️", callback_data: `tl_manage:${mode}:page:${safePage - 1}` });
  }
  if (safePage < totalPages - 1) {
    navRow.push({ text: "➡️", callback_data: `tl_manage:${mode}:page:${safePage + 1}` });
  }
  if (navRow.length) keyboard.push(navRow);

  keyboard.push([{ text: "Davom etish", callback_data: `tl_manage:${mode}:next` }]);
  keyboard.push([{ text: "Bekor qilish", callback_data: `tl_manage:${mode}:cancel` }]);
  return keyboard;
}

function buildConfirmationKeyboard(
  mode: TeamLeadManageMode
): TelegramBot.InlineKeyboardButton[][] {
  return [
    [{ text: "Tasdiqlash", callback_data: `tl_manage:${mode}:confirm` }],
    [{ text: "Ortga", callback_data: `tl_manage:${mode}:back` }],
    [{ text: "Bekor qilish", callback_data: `tl_manage:${mode}:cancel` }],
  ];
}

async function renderManageSelection(
  bot: TelegramBot,
  message: TelegramBot.Message,
  tl: TeamLeadManager,
  mode: TeamLeadManageMode
) {
  const userId = Number(message.from?.id ?? 0);
  const state = teamLeadManageFlowState.get(userId);
  const flow = state && state.mode === mode ? state : {
    mode,
    stage: "selecting" as const,
    page: 0,
    selectedManagerIds: [],
    sourceTeamLeadManagerId: tl.id,
  };
  teamLeadManageFlowState.set(userId, flow);

  const candidates = await getCandidatesForMode(mode, tl);
  const totalPages = Math.max(1, Math.ceil(candidates.length / PAGE_SIZE));
  flow.page = Math.min(Math.max(flow.page, 0), totalPages - 1);

  const totalFree = candidates.filter((candidate) => candidate.selectable).length;
  const selectedCount = flow.selectedManagerIds.length;
  const title = mode === "add" ? "Jamoaga menejer qo'shish" : "Jamoangizdan menejer chiqarish";
  const note =
    mode === "add" && totalFree === 0
      ? "\n\nHozircha biriktirish uchun bo'sh menejer yo'q. Band menejerlar faqat ma'lumot uchun ko'rsatilgan."
      : "";

  const text =
    `*${title}*\n\n` +
    `Sahifa: ${flow.page + 1}/${totalPages}\n` +
    `Tanlanganlar: ${selectedCount}${note}`;

  await bot.sendMessage(message.chat.id, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: buildSelectionKeyboard(mode, candidates, flow.page, flow.selectedManagerIds),
    },
  });
}

async function editSelectionMessage(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  tl: TeamLeadManager,
  mode: TeamLeadManageMode
) {
  const state = teamLeadManageFlowState.get(query.from.id);
  if (!query.message || !state) return;

  const candidates = await getCandidatesForMode(mode, tl);
  const totalPages = Math.max(1, Math.ceil(candidates.length / PAGE_SIZE));
  state.page = Math.min(Math.max(state.page, 0), totalPages - 1);

  const totalFree = candidates.filter((candidate) => candidate.selectable).length;
  const title = mode === "add" ? "Jamoaga menejer qo'shish" : "Jamoangizdan menejer chiqarish";
  const note =
    mode === "add" && totalFree === 0
      ? "\n\nHozircha biriktirish uchun bo'sh menejer yo'q. Band menejerlar faqat ma'lumot uchun ko'rsatilgan."
      : "";

  await bot.editMessageText(
    `*${title}*\n\nSahifa: ${state.page + 1}/${totalPages}\nTanlanganlar: ${state.selectedManagerIds.length}${note}`,
    {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buildSelectionKeyboard(
          mode,
          candidates,
          state.page,
          state.selectedManagerIds
        ),
      },
    }
  );
}

async function editConfirmationMessage(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  tl: TeamLeadManager,
  mode: TeamLeadManageMode
) {
  const state = teamLeadManageFlowState.get(query.from.id);
  if (!query.message || !state) return;

  const candidates = await getCandidatesForMode(mode, tl);
  const selected = candidates.filter((candidate) =>
    state.selectedManagerIds.includes(candidate.id)
  );

  const title = mode === "add" ? "Biriktirishni tasdiqlang" : "Chiqarishni tasdiqlang";
  const actionHint =
    mode === "add"
      ? "Quyidagi menejerlar sizning jamoangizga biriktiriladi:"
      : "Quyidagi menejerlar sizning jamoangizdan chiqariladi:";
  const list = selected.map((candidate) => `• ${candidate.name}`).join("\n");

  await bot.editMessageText(`*${title}*\n\n${actionHint}\n${list}`, {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buildConfirmationKeyboard(mode) },
  });
}

async function finishManageFlow(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  tl: TeamLeadManager,
  mode: TeamLeadManageMode
) {
  const state = teamLeadManageFlowState.get(query.from.id);
  if (!query.message || !state) return;

  const where =
    mode === "add"
      ? {
          id: { in: state.selectedManagerIds },
          role: "MANAGER" as const,
          isActive: true,
          teamId: null,
        }
      : {
          id: { in: state.selectedManagerIds },
          role: "MANAGER" as const,
          isActive: true,
          teamId: tl.teamId,
        };

  const affectedManagers = await prisma.manager.findMany({
    where,
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  if (!affectedManagers.length) {
    teamLeadManageFlowState.delete(query.from.id);
    await bot.editMessageText("ℹ️ O'zgartirish uchun mos menejer topilmadi.", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    });
    return;
  }

  await prisma.manager.updateMany({
    where: { id: { in: affectedManagers.map((manager) => manager.id) } },
    data: { teamId: mode === "add" ? tl.teamId : null },
  });

  teamLeadManageFlowState.delete(query.from.id);
  const header =
    mode === "add"
      ? "✅ Quyidagi menejerlar jamoangizga biriktirildi:"
      : "✅ Quyidagi menejerlar jamoangizdan chiqarildi:";
  const list = affectedManagers.map((manager) => `• ${manager.name}`).join("\n");

  await bot.editMessageText(`${header}\n\n${list}`, {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
  });
}

function removeSelectedId(ids: number[], managerId: number): number[] {
  return ids.filter((id) => id !== managerId);
}

export function registerTeamLeadHandlers(bot: TelegramBot) {
  bot.onText(/\/team$/, async (msg) => {
    const tl = await requireTeamAssignment(bot, msg.chat.id, await requireTeamLead(bot, msg));
    if (!tl) return;

    const rating = await getTeamRating(tl.teamId!, 7);
    if (!rating.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoangizda hozircha menejerlar yo'q.");
      return;
    }

    const text = `👥 *Sizning jamoangiz (7 kun):*\n\n${formatRating(rating)}`;
    await sendInChunks(bot, msg.chat.id, text);
  });

  bot.onText(/\/team_rating$/, async (msg) => {
    const tl = await requireTeamAssignment(bot, msg.chat.id, await requireTeamLead(bot, msg));
    if (!tl) return;

    const rating = await getTeamRating(tl.teamId!, 7);
    if (!rating.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoada menejerlar yo'q.");
      return;
    }

    const text = `📊 *Jamoa reytingi (7 kun):*\n\n${formatRating(rating)}`;
    await sendInChunks(bot, msg.chat.id, text);
  });

  bot.onText(/\/team_mistakes$/, async (msg) => {
    const tl = await requireTeamAssignment(bot, msg.chat.id, await requireTeamLead(bot, msg));
    if (!tl) return;

    const mistakes = await getTeamMistakes(tl.teamId!, 7, 10);
    if (!mistakes.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Oxirgi 7 kun bo'yicha xatolar topilmadi.");
      return;
    }

    const lines = mistakes.map((m, i) => `${i + 1}. ${m.mistake} — ${m.count} marta`);
    await sendInChunks(
      bot,
      msg.chat.id,
      `⚠️ *Jamoaning ko'p uchraydigan xatolari (7 kun):*\n\n${lines.join("\n")}`
    );
  });

  bot.onText(/\/team_add$/, async (msg) => {
    const tl = await requireTeamAssignment(bot, msg.chat.id, await requireTeamLead(bot, msg));
    if (!tl) return;

    const candidates = await getAddCandidates(tl);
    if (!candidates.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Hozircha faol menejerlar topilmadi.");
      return;
    }

    teamLeadManageFlowState.set(msg.from!.id, {
      mode: "add",
      stage: "selecting",
      page: 0,
      selectedManagerIds: [],
      sourceTeamLeadManagerId: tl.id,
    });

    await renderManageSelection(bot, msg, tl, "add");
  });

  bot.onText(/\/team_remove$/, async (msg) => {
    const tl = await requireTeamAssignment(bot, msg.chat.id, await requireTeamLead(bot, msg));
    if (!tl) return;

    const candidates = await getRemoveCandidates(tl);
    if (!candidates.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoangizda chiqarish uchun menejer yo'q.");
      return;
    }

    teamLeadManageFlowState.set(msg.from!.id, {
      mode: "remove",
      stage: "selecting",
      page: 0,
      selectedManagerIds: [],
      sourceTeamLeadManagerId: tl.id,
    });

    await renderManageSelection(bot, msg, tl, "remove");
  });

  bot.onText(/\/team_manager$/, async (msg) => {
    const tl = await requireTeamAssignment(bot, msg.chat.id, await requireTeamLead(bot, msg));
    if (!tl) return;

    const members = await prisma.manager.findMany({
      where: { teamId: tl.teamId, role: "MANAGER", isActive: true },
      orderBy: { name: "asc" },
    });

    if (!members.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoada menejerlar yo'q.");
      return;
    }

    const keyboard = members.map((m) => [{ text: m.name, callback_data: `tl_card:${m.id}` }]);
    await bot.sendMessage(msg.chat.id, "Menejerni tanlang:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  bot.onText(/\/ask_manager$/, async (msg) => {
    const tl = await requireTeamAssignment(bot, msg.chat.id, await requireTeamLead(bot, msg));
    if (!tl) return;

    const members = await prisma.manager.findMany({
      where: { teamId: tl.teamId, role: "MANAGER", isActive: true },
      orderBy: { name: "asc" },
    });

    if (!members.length) {
      await bot.sendMessage(msg.chat.id, "ℹ️ Jamoada menejerlar yo'q.");
      return;
    }

    const keyboard = members.map((m) => [{ text: m.name, callback_data: `tl_ask:${m.id}` }]);
    await bot.sendMessage(msg.chat.id, "AI tahlil uchun menejerni tanlang:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  bot.on("callback_query", async (query) => {
    if (!query.data || !query.message) return;
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (data.startsWith("tl_manage:")) {
      const tl = await getTeamLead(String(userId));
      const assignedTl = await requireTeamAssignment(bot, chatId, tl);
      if (!assignedTl) {
        await bot.answerCallbackQuery(query.id);
        return;
      }

      const flow = teamLeadManageFlowState.get(userId);
      const [, mode, action, value] = data.split(":") as [
        string,
        TeamLeadManageMode,
        string,
        string | undefined
      ];

      if (!flow || flow.mode !== mode || flow.sourceTeamLeadManagerId !== assignedTl.id) {
        await bot.answerCallbackQuery(query.id, {
          text: "Bu oynaning muddati tugagan. Buyruqni qayta ishga tushiring.",
        });
        return;
      }

      if (action === "blocked") {
        await bot.answerCallbackQuery(query.id, {
          text: "Bu menejer allaqachon boshqa TeamLeadga biriktirilgan.",
        });
        return;
      }

      if (action === "toggle") {
        const managerId = Number(value);
        const candidates = await getCandidatesForMode(mode, assignedTl);
        const candidate = candidates.find((item) => item.id === managerId);
        if (!candidate?.selectable) {
          await bot.answerCallbackQuery(query.id, {
            text: "Bu menejerni tanlab bo'lmaydi.",
          });
          return;
        }

        flow.selectedManagerIds = flow.selectedManagerIds.includes(managerId)
          ? removeSelectedId(flow.selectedManagerIds, managerId)
          : [...flow.selectedManagerIds, managerId];
        flow.stage = "selecting";
        await bot.answerCallbackQuery(query.id);
        await editSelectionMessage(bot, query, assignedTl, mode);
        return;
      }

      if (action === "page") {
        flow.page = Number(value) || 0;
        flow.stage = "selecting";
        await bot.answerCallbackQuery(query.id);
        await editSelectionMessage(bot, query, assignedTl, mode);
        return;
      }

      if (action === "next") {
        if (!flow.selectedManagerIds.length) {
          await bot.answerCallbackQuery(query.id, {
            text: "Davom etishdan oldin kamida bitta menejerni tanlang.",
          });
          return;
        }

        flow.stage = "confirming";
        await bot.answerCallbackQuery(query.id);
        await editConfirmationMessage(bot, query, assignedTl, mode);
        return;
      }

      if (action === "back") {
        flow.stage = "selecting";
        await bot.answerCallbackQuery(query.id);
        await editSelectionMessage(bot, query, assignedTl, mode);
        return;
      }

      if (action === "cancel") {
        teamLeadManageFlowState.delete(userId);
        await bot.answerCallbackQuery(query.id);
        await bot.editMessageText("❌ Amal bekor qilindi.", {
          chat_id: chatId,
          message_id: query.message.message_id,
        });
        return;
      }

      if (action === "confirm") {
        await bot.answerCallbackQuery(query.id);
        await finishManageFlow(bot, query, assignedTl, mode);
        return;
      }
    }

    if (data.startsWith("tl_card:")) {
      const tl = await getTeamLead(String(userId));
      const assignedTl = await requireTeamAssignment(bot, chatId, tl);
      if (!assignedTl) {
        await bot.answerCallbackQuery(query.id);
        return;
      }

      const managerId = parseInt(data.split(":")[1], 10);
      const manager = await prisma.manager.findFirst({
        where: { id: managerId, teamId: assignedTl.teamId, role: "MANAGER", isActive: true },
      });

      if (!manager) {
        await bot.answerCallbackQuery(query.id, { text: "Menejer topilmadi." });
        return;
      }

      await bot.answerCallbackQuery(query.id);

      const card = await buildManagerCard(managerId);
      const score = card.avgScore != null ? `${card.avgScore}/100` : "ma'lumot yo'q";
      const strengths = card.strengths.length ? card.strengths.join(", ") : "ma'lumot yo'q";
      const weaknesses = card.weaknesses.length ? card.weaknesses.join(", ") : "ma'lumot yo'q";

      const text =
        `👤 *${card.name}*\n` +
        `⭐ Ball: ${score} (7 kun)\n` +
        `🏆 Jamoadagi o'rni: ${card.rankInTeam} / ${card.teamSize}\n\n` +
        `💪 Kuchli tomonlari: ${strengths}\n` +
        `⚠️ O'sish nuqtalari: ${weaknesses}`;

      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
      return;
    }

    if (data.startsWith("tl_ask:")) {
      const tl = await getTeamLead(String(userId));
      const assignedTl = await requireTeamAssignment(bot, chatId, tl);
      if (!assignedTl) {
        await bot.answerCallbackQuery(query.id);
        return;
      }

      const managerId = parseInt(data.split(":")[1], 10);
      const manager = await prisma.manager.findFirst({
        where: { id: managerId, teamId: assignedTl.teamId, role: "MANAGER", isActive: true },
      });

      if (!manager) {
        await bot.answerCallbackQuery(query.id, { text: "Menejer topilmadi." });
        return;
      }

      await bot.answerCallbackQuery(query.id);
      roleFlowState.set(userId, {
        step: "awaiting_sup_question",
        data: {
          targetManagerId: managerId,
          targetManagerName: manager.name,
          supervisorRole: "TEAMLEAD",
        },
      });

      await bot.sendMessage(
        chatId,
        `🤖 *${manager.name}* haqida savol yozing (kamida 10 ta so'z):\n\nMasalan: "${manager.name} ning oxirgi haftadagi asosiy xatolari qaysilar?"\n\nChiqish uchun: /stop_ai`,
        { parse_mode: "Markdown" }
      );
    }
  });
}
