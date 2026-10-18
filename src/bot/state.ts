import type { GeminiMessage } from "../services/aiAnalysis";
import { createStateMap } from "./stateStore";

export interface SupervisorAiSession {
  active: boolean;
  targetManagerId: number;
  targetManagerName: string;
  history: GeminiMessage[];
  systemContext: string;
}

export interface RoleFlowState {
  step: string;
  data: Record<string, unknown>;
}

export type TeamLeadManageMode = "add" | "remove";
export type TeamLeadManageStage = "selecting" | "confirming";

export interface TeamLeadManageFlowState {
  mode: TeamLeadManageMode;
  stage: TeamLeadManageStage;
  page: number;
  selectedManagerIds: number[];
  sourceTeamLeadManagerId: number;
}

/** A conversation with the AI stays open for two hours after the last message. */
export const AI_SESSION_TTL_SECONDS = 2 * 60 * 60;
/** A button-driven flow (pick managers, ask about a manager) waits ten minutes. */
export const FLOW_TTL_SECONDS = 10 * 60;

export const supervisorAiSessions = createStateMap<SupervisorAiSession>("bot:supai:", AI_SESSION_TTL_SECONDS);
export const roleFlowState = createStateMap<RoleFlowState>("bot:roleflow:", FLOW_TTL_SECONDS);
export const teamLeadManageFlowState = createStateMap<TeamLeadManageFlowState>("bot:tlflow:", FLOW_TTL_SECONDS);

/** Users who typed /start and still owe the bot their 6-digit code. */
export const awaitingCode = new Set<number>();

/** A manager's own AI-coach conversation. */
export interface AiSession {
  active: boolean;
  history: GeminiMessage[];
  systemContext: string;
  managerId: number;
  period: string;
}
export const aiSessions = createStateMap<AiSession>("bot:ai:", AI_SESSION_TTL_SECONDS);
