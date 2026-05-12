import { prisma } from "../config/database";

const CRITERIA_LABELS_RU: Record<string, string> = {
  contextScore:      "Контекст",
  needsScore:        "Выявление потребности",
  painScore:         "Выявление боли",
  summaryScore:      "Резюме",
  presentationScore: "Презентация",
  pointBScore:       "Точка Б (результат)",
  closingScore:      "Закрытие",
  objectionsScore:   "Работа с возражениями",
  urgencyScore:      "Срочность",
  agreementScore:    "Договорённость",
};

function criteriaLineRu(criteria: unknown): string {
  if (!criteria || typeof criteria !== "object") return "";
  const c = criteria as Record<string, unknown>;
  return Object.entries(CRITERIA_LABELS_RU)
    .map(([key, label]) => {
      const score = typeof c[key] === "number" ? (c[key] as number) : null;
      return score !== null ? `${label}: ${score}` : null;
    })
    .filter(Boolean)
    .join(", ");
}

function getWeakAreasRu(criteria: unknown): string[] {
  if (!criteria || typeof criteria !== "object") return [];
  const c = criteria as Record<string, unknown>;
  return Object.entries(CRITERIA_LABELS_RU)
    .filter(([key]) => typeof c[key] === "number" && (c[key] as number) <= 5)
    .map(([, label]) => label);
}

function getStrongAreasRu(criteria: unknown): string[] {
  if (!criteria || typeof criteria !== "object") return [];
  const c = criteria as Record<string, unknown>;
  return Object.entries(CRITERIA_LABELS_RU)
    .filter(([key]) => typeof c[key] === "number" && (c[key] as number) >= 8)
    .map(([, label]) => label);
}

export async function buildSupervisorAiPrompt(
  targetManagerId: number,
  targetManagerName: string,
  supervisorRole: "TEAMLEAD" | "ROP"
): Promise<string> {
  const from = new Date();
  from.setDate(from.getDate() - 6);
  from.setHours(0, 0, 0, 0);

  const calls = await prisma.call.findMany({
    where: {
      managerId: targetManagerId,
      startedAt: { gte: from },
      processingStatus: "processed",
    },
    include: { analysis: true },
    orderBy: { startedAt: "desc" },
    take: 50,
  });

  const scores = calls
    .map((c) => c.analysis?.overallScore)
    .filter((s): s is number => s != null);
  const avgStr = scores.length
    ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
    : "нет данных";

  const callLines = calls.length
    ? calls
        .map((c) => {
          const date = c.startedAt.toLocaleDateString("ru-RU");
          const score = c.analysis?.overallScore ?? "—";
          const criteria = criteriaLineRu(c.analysis?.criteria);
          const weak = getWeakAreasRu(c.analysis?.criteria).join(", ");
          const strong = getStrongAreasRu(c.analysis?.criteria).join(", ");
          const summary = c.analysis?.summary ?? "";
          return (
            `  • ${date} | балл ${score}/100` +
            (criteria ? `\n    Критерии: ${criteria}` : "") +
            (strong ? `\n    Сильные: ${strong}` : "") +
            (weak ? `\n    Слабые: ${weak}` : "") +
            (summary ? `\n    Резюме: ${summary.slice(0, 250)}` : "")
          );
        })
        .join("\n")
    : "  Нет проанализированных звонков за последние 7 дней.";

  const supervisorLabel = supervisorRole === "ROP" ? "РОП" : "ТимЛид";

  return `Ты — AI-аналитик качества звонков. Помогаешь ${supervisorLabel} оценить работу менеджера.

ТВОЯ РОЛЬ:
- Отвечай как профессиональный аналитик и наставник
- Давай конкретные, практичные рекомендации на основе реальных данных
- Не выдумывай факты — опирайся только на данные звонков ниже
- Ответы лаконичные (3–6 предложений), без воды
- Если данных мало — честно скажи об этом
- НЕ используй приветствия (Здравствуйте, Привет и т.д.)
- ВСЕГДА отвечай на РУССКОМ языке

ДАННЫЕ МЕНЕДЖЕРА (последние 7 дней):
Имя: ${targetManagerName}
Проанализировано звонков: ${calls.length}
Средний балл: ${avgStr}/100

Звонки:
${callLines}

Используй эти данные для ответов на вопросы ${supervisorLabel}а.`;
}
