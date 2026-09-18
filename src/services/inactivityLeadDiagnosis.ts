import { prisma } from "../config/database";
import { STOPPED_BY_OPERATOR_REASON } from "./inactivityMovementSwitch";
import { INACTIVITY_MS, isAllowedInactivitySourceStage, TARGET_PIPELINE_ID } from "./leadInactivityPolicy";
import { ACTIVATION_BOUNDARY_SETTING_KEY } from "./leadInactivityStore";

/**
 * Why one specific lead has not been moved to Phoenix.
 *
 * The worker never scans amoCRM: it moves only leads it holds a watch for, and
 * a watch exists only because a webhook once reported a touch. So "idle for
 * eight days yet still here" is almost never a broken timer — it is a lead the
 * worker has no record of, or one whose record ended in a state that no longer
 * leads to a move. This names which.
 */

export interface LeadDiagnosisInput {
  leadId: number;
  now: Date;
  /** Live amoCRM read; null when the lead could not be fetched. */
  lead: { createdAt: Date; updatedAt: Date; pipelineId: number; statusId: number } | null;
  activationBoundary: Date | null;
  watch: {
    state: string;
    lastActivityAt: Date;
    dueAt: Date;
    cycle: number;
    stoppedAt: Date | null;
    lastFailureReason: string | null;
  } | null;
  hasBaselineEvent: boolean;
  eventCount: number;
  lastAudit: { outcome: string; errorMessage: string | null; createdAt: Date } | null;
}

export type LeadDiagnosisKind =
  | "lead_unavailable"
  | "already_in_phoenix"
  | "outside_stages"
  | "historical_never_baselined"
  | "never_seen"
  | "stopped_by_operator"
  | "uncertain"
  | "outside_scope"
  | "moved_and_returned"
  | "not_due_yet"
  | "due_waiting"
  | "in_progress"
  | "skipped_other";

export interface LeadDiagnosis {
  kind: LeadDiagnosisKind;
  explanation: string;
  /** What, if anything, will get this lead moving again. */
  remedy: string;
}

function days(ms: number): string {
  return (ms / (24 * 3600 * 1000)).toFixed(1);
}

export function diagnoseLead(input: LeadDiagnosisInput): LeadDiagnosis {
  const { lead, watch, now } = input;

  if (!lead) {
    return {
      kind: "lead_unavailable",
      explanation: "Сделку не удалось прочитать из amoCRM — удалена или нет доступа.",
      remedy: "Проверьте ID и права интеграции.",
    };
  }
  if (lead.pipelineId === TARGET_PIPELINE_ID) {
    return { kind: "already_in_phoenix", explanation: "Сделка уже в воронке Феникс.", remedy: "Ничего не требуется." };
  }
  if (!isAllowedInactivitySourceStage(lead.pipelineId, lead.statusId)) {
    return {
      kind: "outside_stages",
      explanation: "Сделка стоит на стадии, с которой перенос по неактивности не выполняется (только ОЖОП / квалифицирован / взято в работу в UZUM, EXODE, Дата, Видеочат).",
      remedy: "Это ожидаемое поведение, не ошибка.",
    };
  }

  if (!watch) {
    const historical = input.activationBoundary !== null
      && lead.createdAt.getTime() <= input.activationBoundary.getTime()
      && !input.hasBaselineEvent;
    if (historical) {
      return {
        kind: "historical_never_baselined",
        explanation: "Сделка создана до границы активации и не вошла в baseline. Все события по ней игнорируются — воркер её не видит и не увидит.",
        remedy: "Уедет на ближайшей ежедневной сверке в 22:00 (она смотрит прямо в amoCRM) или массовым переносом по /inactivity_on.",
      };
    }
    return {
      kind: "never_seen",
      explanation: "По сделке нет записи наблюдения: ни одного вебхука о касании не было принято. Воркер не сканирует amoCRM, поэтому о сделке не знает.",
      remedy: "Уедет на ближайшей ежедневной сверке в 22:00. После любого касания появится и под наблюдением воркера.",
    };
  }

  if (watch.state === "skipped" && watch.lastFailureReason === STOPPED_BY_OPERATOR_REASON) {
    return {
      kind: "stopped_by_operator",
      explanation: `Снята с наблюдения командой /inactivity_off${watch.stoppedAt ? ` (${watch.stoppedAt.toISOString().slice(0, 10)})` : ""}. С тех пор касаний не было, поэтому новая запись не появилась.`,
      remedy: "Уедет на ближайшей ежедневной сверке в 22:00, если переводы включены.",
    };
  }
  if (watch.state === "uncertain") {
    return {
      kind: "uncertain",
      explanation: "amoCRM когда-то ответил на перенос неоднозначно. Такая сделка навсегда выпадает из очереди: повторять вслепую опасно.",
      remedy: "Проверьте сделку в amoCRM вручную. Новое касание создаст новую запись наблюдения.",
    };
  }
  if (watch.state === "outside_scope") {
    return {
      kind: "outside_scope",
      explanation: "Когда воркер дошёл до сделки, она была вне разрешённых стадий, и наблюдение закрылось. Потом её вернули на подходящую стадию, но без принятого вебхука.",
      remedy: "Вернётся после следующего касания.",
    };
  }
  if (watch.state === "moved") {
    return {
      kind: "moved_and_returned",
      explanation: `Уже переводилась в Феникс (цикл ${watch.cycle}), потом её вернули обратно. Новых касаний после возврата не зафиксировано, поэтому второй цикл не начался.`,
      remedy: "Следующее касание начнёт новый цикл с отсчётом 3 дня.",
    };
  }
  if (watch.state === "leased") {
    return { kind: "in_progress", explanation: "Обрабатывается воркером прямо сейчас.", remedy: "Подождите минуту." };
  }
  if (watch.state === "watching") {
    if (watch.dueAt.getTime() > now.getTime()) {
      return {
        kind: "not_due_yet",
        explanation: `Под наблюдением, срок ещё не наступил. Последнее касание по данным воркера: ${watch.lastActivityAt.toISOString().slice(0, 16).replace("T", " ")} UTC — это позже, чем updated_at в amoCRM показывает «простой».`,
        remedy: `Уедет автоматически через ${days(watch.dueAt.getTime() - now.getTime())} дн.`,
      };
    }
    const overdue = days(now.getTime() - watch.dueAt.getTime());
    const audit = input.lastAudit
      ? ` Последняя попытка: ${input.lastAudit.outcome}${input.lastAudit.errorMessage ? ` — ${input.lastAudit.errorMessage}` : ""}.`
      : " Попыток переноса ещё не было.";
    return {
      kind: "due_waiting",
      explanation: `Просрочена на ${overdue} дн. и стоит в очереди.${audit} Обычная причина — суточный лимит: очередь разбирается по приоритету ОЖОП → квал → взято в работу, и нижние группы могли не доходить.`,
      remedy: "После снятия лимита (/inactivity_on) уедет на ближайшем проходе. Если нет — смотрите /inactivity_status.",
    };
  }
  return {
    kind: "skipped_other",
    explanation: `Наблюдение закрыто в состоянии «${watch.state}»${watch.lastFailureReason ? `: ${watch.lastFailureReason}` : ""}.`,
    remedy: "Следующее касание создаст новую запись.",
  };
}

export function formatLeadDiagnosis(input: LeadDiagnosisInput, diagnosis: LeadDiagnosis): string {
  const lines = [`🔎 Сделка #${input.leadId} — почему не в Фениксе`, ""];
  if (input.lead) {
    const idle = input.now.getTime() - input.lead.updatedAt.getTime();
    lines.push(
      `Простой по amoCRM (updated_at): ${days(idle)} дн.${idle >= INACTIVITY_MS ? "" : " — меньше 3 дней"}`,
      `Воронка/стадия: ${input.lead.pipelineId} / ${input.lead.statusId}`,
    );
  }
  lines.push(
    `Запись наблюдения: ${input.watch ? input.watch.state : "нет"}`,
    `Принято событий по сделке: ${input.eventCount}`,
    "",
    `💡 ${diagnosis.explanation}`,
    `➡️ ${diagnosis.remedy}`,
  );
  return lines.join("\n");
}

export interface LoadLeadDiagnosisDependencies {
  readLead(leadId: number): Promise<{ createdAt: Date; updatedAt: Date; pipelineId: number; statusId: number }>;
  now?: () => Date;
}

export async function loadLeadDiagnosisInput(
  leadId: number,
  dependencies: LoadLeadDiagnosisDependencies,
): Promise<LeadDiagnosisInput> {
  const now = dependencies.now?.() ?? new Date();
  const [lead, boundaryRow, watch, baselineEvent, eventCount, lastAudit] = await Promise.all([
    dependencies.readLead(leadId).catch(() => null),
    prisma.leadInactivitySetting.findUnique({ where: { key: ACTIVATION_BOUNDARY_SETTING_KEY } }),
    prisma.leadInactivityWatch.findUnique({ where: { leadId } }),
    prisma.leadInactivityEvent.findFirst({ where: { leadId, eventType: "production_baseline" }, select: { id: true } }),
    prisma.leadInactivityEvent.count({ where: { leadId } }),
    prisma.leadInactivityMoveAudit.findFirst({
      where: { leadId },
      orderBy: { createdAt: "desc" },
      select: { outcome: true, errorMessage: true, createdAt: true },
    }),
  ]);

  const boundary = boundaryRow?.value ? new Date(boundaryRow.value) : null;
  return {
    leadId,
    now,
    lead,
    activationBoundary: boundary && !Number.isNaN(boundary.getTime()) ? boundary : null,
    watch: watch
      ? {
        state: watch.state,
        lastActivityAt: watch.lastActivityAt,
        dueAt: watch.dueAt,
        cycle: watch.cycle,
        stoppedAt: watch.stoppedAt,
        lastFailureReason: watch.lastFailureReason,
      }
      : null,
    hasBaselineEvent: baselineEvent !== null,
    eventCount,
    lastAudit,
  };
}
