import { createQueue } from "../config/queue";

export interface OnlinePbxWebhookPayload {
  event: "call_end";
  uuid: string;
  direction: "in" | "out";
  caller: string;
  callee: string;
  start_time: string;
  end_time: string;
  duration: number;
  status: string;
  record_url?: string;
  from_domain?: string;
  to_domain?: string;
  gateway?: string;
  internal_number?: string;
  external_number?: string;
}

export interface CallProcessingJobData {
  callExternalId: string;
  source: "onlinepbx";
  payload: OnlinePbxWebhookPayload;
  receivedAt: string;
  manualTriggered?: boolean;
  /** Путь к локальному MP3-файлу, извлечённому из TAR-архива (только для исторической синхронизации) */
  localFilePath?: string;
}

export const callProcessingQueue = createQueue("call_processing");

