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

export const supervisorAiSessions = new Map<number, SupervisorAiSession>();
export const roleFlowState = new Map<number, RoleFlowState>();
