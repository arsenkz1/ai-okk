export interface PilotManagerConfig {
  amoUserId: number;
  amoRoleId: number;
  name: string;
}

export interface HiddenLeadStage {
  pipelineId: number;
  statusId: number;
}

export const MIN_DISCIPLINE_MESSAGES_PER_DAY = 3;
export const MIN_DISCIPLINE_MESSAGE_WORDS = 5;

export const PILOT_MANAGER_CONFIGS: PilotManagerConfig[] = [
  { amoUserId: 12695650, amoRoleId: 1207102, name: "Абубакир Сиддик" },
  { amoUserId: 11865042, amoRoleId: 1207106, name: "Муслима" },
  { amoUserId: 13385638, amoRoleId: 1207110, name: "Surayyo" },
  { amoUserId: 12565342, amoRoleId: 1207114, name: "Сарвиноз" },
];

export const HIDDEN_NEW_LEAD_STAGES: HiddenLeadStage[] = [
  { pipelineId: 6909890, statusId: 58160714 },
  { pipelineId: 8425422, statusId: 68567418 },
  { pipelineId: 9055778, statusId: 72917578 },
  { pipelineId: 9888398, statusId: 78602094 },
  { pipelineId: 10630306, statusId: 83801770 },
  { pipelineId: 10734414, statusId: 84554882 },
  { pipelineId: 9055770, statusId: 72917546 },
  { pipelineId: 6945006, statusId: 58398434 },
];

export const PILOT_MANAGER_AMO_IDS = PILOT_MANAGER_CONFIGS.map((item) => item.amoUserId);

export function getPilotManagerConfig(amoUserId: number | null | undefined): PilotManagerConfig | null {
  if (!amoUserId) return null;
  return PILOT_MANAGER_CONFIGS.find((item) => item.amoUserId === amoUserId) ?? null;
}
