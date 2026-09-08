import { notifyAdmins } from "./notify";
import type { UZUMRequiredField } from "../services/callStagePolicy";

export type CallStageAdminAlert =
  | {
    kind: "review";
    actionId: string;
    dealId: number;
    evidence: string;
  }
  | {
    kind: "missing_fields";
    actionId: string;
    dealId: number;
    targetName: string;
    evidence: string;
    missingFields: UZUMRequiredField[];
  }
  | {
    kind: "recent_stage_movement";
    actionId: string;
    dealId: number;
    targetName: string;
  }
  | {
    kind: "moved";
    actionId: string;
    dealId: number;
    targetName: string;
  }
  | {
    kind: "autofilled";
    actionId: string;
    dealId: number;
    targetName: string;
    evidence: string;
    filled: readonly CallStageAutofilledField[];
    /** Set when the fields were written but the move itself did not happen. */
    moveFailedReason?: string;
  }
  | {
    kind: "autofill_failed";
    actionId: string;
    dealId: number;
    targetName: string;
    evidence: string;
    missingFields: UZUMRequiredField[];
    reason: string;
  };

export interface CallStageAutofilledField {
  fieldName: string;
  value: string;
  /** True when a new amoCRM option had to be created for this value. */
  createdOption: boolean;
  /** False when the value is the model's assumption, not something that was said. */
  grounded: boolean;
  /** Set when an existing option was reused for a differently worded value. */
  matchedBy?: "qualifier" | "typo";
  /** What the model actually said, when it differs from the reused option. */
  modelValue?: string;
}

function amoDealUrl(baseUrl: string | undefined, dealId: number): string | null {
  if (!baseUrl) return null;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
    return `${parsed.origin}/leads/detail/${dealId}`;
  } catch {
    return null;
  }
}

function conciseEvidence(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 700);
}

function conciseValue(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Plain-text alert only; raw call transcripts and field values are never sent to Telegram. */
export function buildCallStageAdminAlert(
  alert: CallStageAdminAlert,
  amoBaseUrl = process.env.AMOCRM_BASE_URL,
): string {
  const deal = amoDealUrl(amoBaseUrl, alert.dealId);
  const base = [
    "Проверка автоперевода UZUM",
    deal ? `Сделка: #${alert.dealId} — ${deal}` : `Сделка: #${alert.dealId}`,
  ];
  if (alert.kind === "review") {
    return [
      ...base,
      "Итог звонка неоднозначен — сделка не передвинута.",
      `Основание: ${conciseEvidence(alert.evidence)}`,
      `ID обработки: ${alert.actionId}`,
    ].join("\n\n");
  }
  if (alert.kind === "recent_stage_movement") {
    return [
      ...base,
      `Предполагаемый этап: ${alert.targetName}`,
      "Сделка не передвинута: за последние 30 минут уже было перемещение стадии.",
      `ID обработки: ${alert.actionId}`,
    ].join("\n\n");
  }
  if (alert.kind === "moved") {
    return [
      ...base,
      `Сделка автоматически передвинута на этап: ${alert.targetName}.`,
      `ID обработки: ${alert.actionId}`,
    ].join("\n\n");
  }
  if (alert.kind === "autofilled") {
    // Guessed values and newly created options are called out by name: this log
    // is the only place an operator can catch AI-invented CRM data.
    const filledLines = alert.filled.map((field) => {
      const marks = [
        field.grounded ? "из разговора" : "⚠️ предположение ИИ",
        field.createdOption ? "⚠️ создан новый вариант списка" : null,
        field.matchedBy && field.modelValue
          ? `сопоставлено с существующим вариантом, ИИ сказал «${conciseValue(field.modelValue)}»`
          : null,
      ].filter(Boolean).join(", ");
      return `• ${field.fieldName}: ${conciseValue(field.value)} (${marks})`;
    });
    const assumed = alert.filled.filter((field) => !field.grounded).length;
    const created = alert.filled.filter((field) => field.createdOption).length;
    return [
      ...base,
      `Целевой этап: ${alert.targetName}`,
      alert.moveFailedReason
        ? `⚠️ Поля заполнены автоматически, но сделка НЕ передвинута: ${alert.moveFailedReason}`
        : "Обязательные поля заполнены автоматически, сделка передвинута.",
      `Заполнено полей: ${alert.filled.length} (предположений ИИ: ${assumed}, новых вариантов списка: ${created})`,
      filledLines.join("\n"),
      `Основание: ${conciseEvidence(alert.evidence)}`,
      `ID обработки: ${alert.actionId}`,
    ].join("\n\n");
  }
  if (alert.kind === "autofill_failed") {
    return [
      ...base,
      `Целевой этап: ${alert.targetName}`,
      `Не заполнены обязательные поля: ${alert.missingFields.map((field) => field.name).join("; ")}`,
      `Автозаполнение не выполнено: ${alert.reason}`,
      `Основание: ${conciseEvidence(alert.evidence)}`,
      "Сделка не передвинута.",
      `ID обработки: ${alert.actionId}`,
    ].join("\n\n");
  }
  return [
    ...base,
    `Целевой этап: ${alert.targetName}`,
    `Не заполнены обязательные поля: ${alert.missingFields.map((field) => field.name).join("; ")}`,
    `Основание: ${conciseEvidence(alert.evidence)}`,
    "Сделка не передвинута.",
    `ID обработки: ${alert.actionId}`,
  ].join("\n\n");
}

/** Operator-only: administrators receive Phoenix moves and nothing else. */
export async function notifyCallStageAdmins(alert: CallStageAdminAlert): Promise<void> {
  await notifyAdmins(buildCallStageAdminAlert(alert));
}
