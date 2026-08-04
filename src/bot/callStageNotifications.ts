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
  };

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
  return [
    ...base,
    `Целевой этап: ${alert.targetName}`,
    `Не заполнены обязательные поля: ${alert.missingFields.map((field) => field.name).join("; ")}`,
    `Основание: ${conciseEvidence(alert.evidence)}`,
    "Сделка не передвинута.",
    `ID обработки: ${alert.actionId}`,
  ].join("\n\n");
}

export async function notifyCallStageAdmins(alert: CallStageAdminAlert): Promise<void> {
  await notifyAdmins(buildCallStageAdminAlert(alert));
}
