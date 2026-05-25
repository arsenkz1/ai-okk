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
