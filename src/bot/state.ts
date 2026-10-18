import { GeminiMessage } from "../services/aiAnalysis";

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

export const supervisorAiSessions = new Map<number, SupervisorAiSession>();
export const roleFlowState = new Map<number, RoleFlowState>();
export const teamLeadManageFlowState = new Map<number, TeamLeadManageFlowState>();

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
export const aiSessions = new Map<number, AiSession>();
