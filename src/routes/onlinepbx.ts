import { Router } from "express";
import {
  callProcessingQueue,
  OnlinePbxWebhookPayload,
} from "../queues/callProcessing";

const router = Router();

function normalizeOnlinePbxPayload(raw: any): OnlinePbxWebhookPayload | null {
  if (!raw) return null;

  // Если уже пришёл в "нашем" JSON-формате
  if (
    raw.event === "call_end" &&
    typeof raw.uuid === "string" &&
    typeof raw.duration === "number"
  ) {
    return raw as OnlinePbxWebhookPayload;
  }

  // Формат application/x-www-form-urlencoded от OnlinePBX
  if (raw.event !== "call_end" || typeof raw.uuid !== "string") {
    return null;
  }

  const durationSeconds = Number(
    raw.dialog_duration ?? raw.call_duration ?? raw.duration
  );

  if (!Number.isFinite(durationSeconds)) {
    return null;
  }

  // timestamp в секундах -> ISO строка
  let startTime = "";
  if (raw.date) {
    const ts = Number(raw.date);
    if (Number.isFinite(ts)) {
      startTime = new Date(ts * 1000).toISOString();
    }
  }

  const directionRaw = String(raw.direction || "").toLowerCase();
  const direction: "in" | "out" =
    directionRaw === "outbound" ? "out" : "in";

  const caller = String(raw.caller || "");
  const callee = String(raw.callee || "");

  // Внутренний/внешний номера в зависимости от направления
  const internal_number = direction === "out" ? caller : callee;
  const external_number = direction === "out" ? callee : caller;

  const record_url: string | undefined =
    (raw.download_url as string | undefined) ??
    (raw.record_url as string | undefined);

  const status: string =
    (raw.status as string | undefined) ??
    (raw.hangup_cause as string | undefined) ??
    "completed";

  const payload: OnlinePbxWebhookPayload = {
    event: "call_end",
    uuid: raw.uuid,
    direction,
    caller,
    callee,
    start_time: startTime,
    end_time: "", // при необходимости можно вычислить как start_time + duration
    duration: durationSeconds,
    status,
    record_url,
    from_domain: raw.from_domain,
    to_domain: raw.to_domain,
    gateway: raw.gateway,
    internal_number,
    external_number,
  };

  return payload;
}

router.post("/webhooks/onlinepbx/call-end", async (req, res) => {
  const raw = req.body;
  console.log("[OnlinePBX] Webhook received:", JSON.stringify(raw));

  if (raw?.event === "test_webhook") {
    console.log(`[OnlinePBX] Test webhook from domain=${raw.domain}`);
    return res.status(200).json({ ok: true });
  }

  const payload = normalizeOnlinePbxPayload(raw);

  if (!payload) {
    console.warn("[OnlinePBX] Invalid payload, skipping");
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Фильтр по длительности: меньше 6 минут — не обрабатываем.
  if (payload.duration < 6 * 60) {
    console.log(
      `[OnlinePBX] Short call skipped: uuid=${payload.uuid} duration=${payload.duration}s`
    );
    return res.status(200).json({ skipped: true, reason: "short_call" });
  }

  console.log(
    `[OnlinePBX] Queuing call: uuid=${payload.uuid} duration=${payload.duration}s direction=${payload.direction} from=${payload.caller} to=${payload.callee}`
  );

  const jobData = {
    callExternalId: payload.uuid,
    source: "onlinepbx" as const,
    payload,
    receivedAt: new Date().toISOString(),
  };

  // Идемпотентность будет обеспечиваться на уровне БД и логики воркера,
  // здесь просто ставим задачу в очередь.
  await callProcessingQueue.add("process_call", jobData);

  console.log(`[OnlinePBX] Call queued successfully: uuid=${payload.uuid}`);
  res.status(200).json({ queued: true });
});

export default router;

