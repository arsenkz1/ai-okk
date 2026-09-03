import type { AmoCrmCallNote, AmoCrmDealSummary } from "./amocrm";
import { pipelineLabel } from "./dealDossier";

/**
 * Renders what amoCRM knows about a deal when there is no call to analyze.
 *
 * `/analyze_deal` used to dead-end here with "no notes found", which was both
 * unhelpful and wrong: notes without a recording were dropped before being
 * counted. This shows the deal's own data and the notes that do exist.
 */

export const DEAL_SUMMARY_MAX_NOTES = 10;
export const DEAL_SUMMARY_NOTE_TEXT_LIMIT = 300;

export interface DealSummaryReportInput {
  summary: AmoCrmDealSummary | null;
  notes: readonly AmoCrmCallNote[];
  dealId: number;
  minCallSeconds: number;
}

export interface NoteBreakdown {
  total: number;
  withRecording: number;
  longEnough: number;
  callNotes: number;
  textNotes: number;
  longestCallSeconds: number | null;
}

function isCallNote(note: AmoCrmCallNote): boolean {
  return note.noteType.startsWith("call_") || note.recordUrl !== null;
}

/** Counts notes by what actually blocks analysis, so the diagnosis is honest. */
export function summarizeNotes(
  notes: readonly AmoCrmCallNote[],
  minCallSeconds: number,
): NoteBreakdown {
  const withRecording = notes.filter((note) => note.recordUrl !== null);
  const callNotes = notes.filter(isCallNote);
  const durations = callNotes.map((note) => note.duration).filter((duration) => duration > 0);
  return {
    total: notes.length,
    withRecording: withRecording.length,
    longEnough: withRecording.filter((note) => note.duration >= minCallSeconds).length,
    callNotes: callNotes.length,
    textNotes: notes.filter((note) => !isCallNote(note) && note.text.length > 0).length,
    longestCallSeconds: durations.length > 0 ? Math.max(...durations) : null,
  };
}

/** Names the single reason no call could be analyzed, in the operator's terms. */
export function diagnoseNoAnalyzableCall(breakdown: NoteBreakdown, minCallSeconds: number): string {
  const minutes = Math.round(minCallSeconds / 60);
  if (breakdown.total === 0) {
    return "У сделки и её контактов нет ни одного примечания. Скорее всего OnlinePBX не связал звонок с этой сделкой.";
  }
  if (breakdown.callNotes === 0) {
    return "Примечания есть, но среди них нет звонков — только текстовые заметки.";
  }
  if (breakdown.withRecording === 0) {
    return "Звонки есть, но ни у одного нет ссылки на запись. Проверьте, включена ли запись разговоров в OnlinePBX.";
  }
  const longest = breakdown.longestCallSeconds ?? 0;
  return `Записи есть, но все звонки короче ${minutes} минут (самый длинный — ${Math.floor(longest / 60)} мин ${longest % 60} с).`;
}

function formatAlmaty(value: Date | null): string {
  if (!value) return "—";
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const field = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${field.day}.${field.month}.${field.year} ${field.hour}:${field.minute}`;
}

function formatMoney(amount: number): string {
  return Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function noteLabel(note: AmoCrmCallNote): string {
  if (note.noteType === "call_in") return "входящий звонок";
  if (note.noteType === "call_out") return "исходящий звонок";
  return note.noteType || "примечание";
}

function shorten(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= DEAL_SUMMARY_NOTE_TEXT_LIMIT
    ? clean
    : `${clean.slice(0, DEAL_SUMMARY_NOTE_TEXT_LIMIT - 1).trimEnd()}…`;
}

export function formatDealSummaryReport(input: DealSummaryReportInput): string {
  const { summary, notes, dealId, minCallSeconds } = input;
  const breakdown = summarizeNotes(notes, minCallSeconds);

  const lines = [`🗂 Сделка #${dealId}`];
  if (summary) {
    if (summary.name) lines.push(summary.name);
    lines.push(
      `📂 Воронка: ${summary.pipelineName ?? pipelineLabel(summary.pipelineId)}`,
      `📍 Этап: ${summary.statusName ?? (summary.statusId !== null ? `#${summary.statusId}` : "—")}`,
      `💰 Бюджет: ${summary.price !== null ? formatMoney(summary.price) : "не указан"}`,
      `📅 Создана: ${formatAlmaty(summary.createdAt)} · Изменена: ${formatAlmaty(summary.updatedAt)}`,
    );

    for (const contact of summary.contacts) {
      const phones = contact.phones.length > 0 ? contact.phones.join(", ") : "телефон не указан";
      lines.push(`👤 ${contact.name ?? `Контакт #${contact.id}`} · ${phones}`);
    }

    if (summary.fields.length > 0) {
      lines.push("", `📋 Заполненные поля (${summary.fields.length}):`);
      for (const field of summary.fields) {
        lines.push(`• ${field.name}: ${shorten(field.values.join(", "))}`);
      }
    } else {
      lines.push("", "📋 Заполненных полей нет.");
    }
  } else {
    lines.push("⚠️ Данные сделки из amoCRM получить не удалось.");
  }

  lines.push(
    "",
    `📝 Примечания: ${breakdown.total} (звонков: ${breakdown.callNotes}, с записью: ${breakdown.withRecording}, ` +
    `подходящих для анализа: ${breakdown.longEnough})`,
  );

  const shown = notes
    .slice()
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, DEAL_SUMMARY_MAX_NOTES);

  for (const note of shown) {
    const where = note.source === "contact" ? " · с контакта" : "";
    const duration = note.duration > 0 ? ` · ${Math.floor(note.duration / 60)}:${String(note.duration % 60).padStart(2, "0")}` : "";
    const recording = note.recordUrl ? " · 🎧 есть запись" : "";
    lines.push("", `— ${formatAlmaty(note.createdAt)} · ${noteLabel(note)}${duration}${recording}${where}`);
    if (note.text) lines.push(shorten(note.text));
  }
  if (notes.length > DEAL_SUMMARY_MAX_NOTES) {
    lines.push("", `… ещё ${notes.length - DEAL_SUMMARY_MAX_NOTES} примечаний`);
  }

  lines.push("", `💡 ${diagnoseNoAnalyzableCall(breakdown, minCallSeconds)}`);
  return lines.join("\n");
}
