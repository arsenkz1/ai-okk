import { randomBytes } from "node:crypto";
import { countByPipeline, moveSweepCandidates, selectSweepCandidates, type SweepCandidate, type SweepMoveResult } from "./inactivitySweep";
import { phoenixSourceName } from "./phoenixMovementStats";
import type { AmoInactivityLead, AmoInactivityMoveOutcome } from "./leadInactivityAmoClient";

/**
 * The "yes/no" step between switching moves on and sweeping idle leads.
 *
 * The sweep is destructive and touches many deals at once, so it is never
 * run off the back of the /inactivity_on command directly. The command lists
 * the candidates, shows the count, and hands back a one-shot token. Only the
 * operator who asked can spend it, it expires, and the candidate list is
 * frozen at the moment of asking — what the operator confirmed is what moves.
 */

export const SWEEP_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const CALLBACK_PREFIX = "phx";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,32}$/;

export type SweepDecision = "yes" | "no";

export interface PendingSweep {
  token: string;
  requestedBy: string;
  createdAt: Date;
  candidates: SweepCandidate[];
}

export type SweepStartResult =
  | { kind: "nothing_to_move"; scanned: number }
  | { kind: "pending"; pending: PendingSweep; scanned: number };

export type SweepDecisionResult =
  | { kind: "unknown" }
  | { kind: "expired" }
  | { kind: "wrong_user" }
  | { kind: "declined"; candidates: number }
  | { kind: "swept"; result: SweepMoveResult; candidates: number };

export interface SweepConfirmationDependencies {
  listEligibleLeads(): Promise<AmoInactivityLead[]>;
  moveLeadToTarget(
    leadId: number,
    target: { sourcePipelineIds: readonly number[]; targetPipelineId: number; targetStatusId: number },
  ): Promise<AmoInactivityMoveOutcome>;
  isStopped?(): Promise<boolean>;
  onMoved?(candidate: SweepCandidate): Promise<void>;
  now?: () => Date;
  randomToken?: () => string;
}

export interface SweepConfirmationService {
  start(requestedBy: string): Promise<SweepStartResult>;
  decide(token: string, decision: SweepDecision, decidedBy: string): Promise<SweepDecisionResult>;
}

function defaultToken(): string {
  return randomBytes(18).toString("base64url");
}

export function createSweepConfirmationService(dependencies: SweepConfirmationDependencies): SweepConfirmationService {
  const now = dependencies.now ?? (() => new Date());
  const randomToken = dependencies.randomToken ?? defaultToken;
  // Process-local on purpose: a confirmation is a conversation with one
  // operator over the next few minutes, not durable state. A restart forgets
  // it, and the operator simply asks again.
  const pending = new Map<string, PendingSweep>();

  const purgeExpired = (at: Date): void => {
    for (const [token, entry] of pending) {
      if (at.getTime() - entry.createdAt.getTime() > SWEEP_CONFIRMATION_TTL_MS) pending.delete(token);
    }
  };

  return {
    async start(requestedBy): Promise<SweepStartResult> {
      const at = now();
      purgeExpired(at);
      const leads = await dependencies.listEligibleLeads();
      const candidates = selectSweepCandidates(leads, at);
      if (candidates.length === 0) return { kind: "nothing_to_move", scanned: leads.length };

      const entry: PendingSweep = { token: randomToken(), requestedBy, createdAt: at, candidates };
      if (!TOKEN_PATTERN.test(entry.token)) throw new Error("sweep confirmation token is malformed");
      pending.set(entry.token, entry);
      return { kind: "pending", pending: entry, scanned: leads.length };
    },

    async decide(token, decision, decidedBy): Promise<SweepDecisionResult> {
      const at = now();
      const entry = pending.get(token);
      if (!entry) return { kind: "unknown" };
      if (at.getTime() - entry.createdAt.getTime() > SWEEP_CONFIRMATION_TTL_MS) {
        pending.delete(token);
        return { kind: "expired" };
      }
      // Whoever asked is the only one who may answer: a second admin clicking
      // a forwarded card must not move hundreds of deals on someone else's say.
      if (entry.requestedBy !== decidedBy) return { kind: "wrong_user" };

      // One shot: the token is spent before any PATCH so a double tap or a
      // retried callback cannot run the sweep twice.
      pending.delete(token);
      if (decision === "no") return { kind: "declined", candidates: entry.candidates.length };

      const result = await moveSweepCandidates(entry.candidates, {
        moveLeadToTarget: dependencies.moveLeadToTarget,
        isStopped: dependencies.isStopped,
        onMoved: dependencies.onMoved,
      });
      return { kind: "swept", result, candidates: entry.candidates.length };
    },
  };
}

// --- Telegram surface -------------------------------------------------------

export function buildSweepCallback(token: string, decision: SweepDecision): string {
  return `${CALLBACK_PREFIX}:${token}:${decision}`;
}

export function parseSweepCallback(value: string | undefined): { token: string; decision: SweepDecision } | null {
  if (!value) return null;
  const match = /^phx:([A-Za-z0-9_-]{16,32}):(yes|no)$/.exec(value);
  return match ? { token: match[1], decision: match[2] as SweepDecision } : null;
}

export function buildSweepKeyboard(token: string): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: [[
      { text: "✅ Да, перевести", callback_data: buildSweepCallback(token, "yes") },
      { text: "❌ Нет", callback_data: buildSweepCallback(token, "no") },
    ]],
  };
}

export function formatSweepProposal(pending: PendingSweep, scanned: number): string {
  const byPipeline = countByPipeline(pending.candidates);
  const lines = [
    "▶️ Переводы в Феникс включены.",
    "",
    `Найдено лидов без касаний 7 дней и дольше: ${pending.candidates.length}`,
    `(проверено лидов на подходящих стадиях: ${scanned})`,
    "",
    ...byPipeline.map(({ pipelineId, count }) => `• ${phoenixSourceName(pipelineId)}: ${count}`),
    "",
    "Перевести их все в Феникс сейчас?",
    "Ответить может только тот, кто отправил команду. Запрос действует 10 минут.",
  ];
  return lines.join("\n");
}

export function formatSweepDecision(result: SweepDecisionResult): string {
  switch (result.kind) {
    case "unknown":
      return "ℹ️ Этот запрос уже обработан или не найден. Отправьте /inactivity_on ещё раз, если нужно.";
    case "expired":
      return "⌛ Запрос истёк (10 минут). Отправьте /inactivity_on ещё раз — список будет пересчитан.";
    case "wrong_user":
      return "❌ Подтвердить может только тот, кто отправил команду.";
    case "declined":
      return `✅ Переводы включены, массовый перенос отменён (${result.candidates} лидов не тронуты). Дальше воркер работает в обычном режиме.`;
    case "swept": {
      const { result: sweep, candidates } = result;
      const lines = [
        `🔥 Массовый перенос в Феникс: ${sweep.moved} из ${candidates}`,
      ];
      if (sweep.notMoved > 0) lines.push(`• не переведены (лид изменился между проверкой и переносом): ${sweep.notMoved}`);
      if (sweep.uncertain > 0) lines.push(`• ⚠️ неопределённый ответ amoCRM: ${sweep.uncertain} — требует ручной проверки`);
      if (sweep.stoppedAt) {
        const left = candidates - sweep.stoppedAt.index;
        lines.push(
          sweep.stoppedAt.reason === "uncertain"
            ? `⛔ Остановлено после неопределённого ответа; не обработано: ${left}. Проверьте amoCRM и повторите /inactivity_on.`
            : `⛔ Остановлено командой /inactivity_off; не обработано: ${left}.`,
        );
      }
      lines.push("", "Дальше воркер работает в обычном режиме: 3 дня без касаний, без суточного лимита.");
      return lines.join("\n");
    }
  }
}
