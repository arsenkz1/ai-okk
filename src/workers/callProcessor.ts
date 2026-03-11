import { createWorker } from "../config/queue";
import { prisma } from "../config/database";
import {
  CallProcessingJobData,
  OnlinePbxWebhookPayload,
} from "../queues/callProcessing";
import {
  analyzeCallWithGemini,
  transcribeAudioWithGemini,
} from "../services/aiAnalysis";
import { appendCallRowToSheet } from "../services/googleSheets";
import {
  addNoteToDeal,
  lookupDealByPhone,
  isQualifyingDeal,
} from "../services/amocrm";

async function ensureCallRecord(
  payload: OnlinePbxWebhookPayload
): Promise<{ id: number; dealId: number | null; pipelineId: number | null; stageId: number | null }> {
  const existing = await prisma.call.findUnique({
    where: {
      externalId_source: {
        externalId: payload.uuid,
        source: "onlinepbx",
      },
    },
    include: { deal: true },
  });

  if (existing) {
    return {
      id: existing.id,
      dealId: existing.dealId,
      pipelineId: existing.deal?.pipelineId ?? null,
      stageId: existing.deal?.statusId ?? null,
    };
  }

  // Ищем менеджера по internal_number (внутренний номер АТС)
  let managerId: number | null = null;
  if (payload.internal_number) {
    const mgr = await prisma.manager.findUnique({
      where: { internalNumber: payload.internal_number },
    });
    if (mgr?.isActive) {
      managerId = mgr.id;
      console.log("[CallWorker] Manager found:", { internalNumber: payload.internal_number, managerId, name: mgr.name });
    }
  }

  // Ищем сделку по номеру телефона клиента (external_number)
  const clientPhone = payload.external_number ?? payload.caller ?? payload.callee;
  let dealId: number | null = null;
  let pipelineId: number | null = null;
  let stageId: number | null = null;

  if (clientPhone) {
    const found = await lookupDealByPhone(clientPhone);
    if (found) {
      dealId = found.dealId;
      pipelineId = found.pipelineId;
      stageId = found.stageId;
      console.log("[CallWorker] Deal found by phone:", {
        phone: clientPhone,
        dealId,
        pipelineId,
        stageId,
        qualifying: isQualifyingDeal(pipelineId, stageId),
      });
    }
  }

  const now = new Date();
  const startedAt = payload.start_time ? new Date(payload.start_time) : now;
  const endedAt = new Date(startedAt.getTime() + payload.duration * 1000);

  const call = await prisma.call.create({
    data: {
      externalId: payload.uuid,
      source: "onlinepbx",
      managerId,
      dealId,
      direction: payload.direction,
      status: payload.status,
      startedAt,
      endedAt,
      durationSeconds: payload.duration,
      recordUrl: payload.record_url,
      processingStatus: "queued",
      manualTriggered: false,
    },
  });

  return { id: call.id, dealId, pipelineId, stageId };
}

async function processCallJob(jobData: CallProcessingJobData) {
  const { payload } = jobData;

  console.log("[CallWorker] Got job:", {
    uuid: payload.uuid,
    duration: payload.duration,
    direction: payload.direction,
  });

  const { id: callId, dealId, pipelineId, stageId } = await ensureCallRecord(payload);
  console.log("[CallWorker] Call record:", { callId, dealId, pipelineId, stageId });

  // Проверяем что сделка в квалифицирующей стадии
  // Если сделка найдена, но стадия не квалифицирующая — пропускаем анализ
  if (dealId !== null && pipelineId !== null && stageId !== null) {
    if (!isQualifyingDeal(pipelineId, stageId)) {
      await prisma.call.update({
        where: { id: callId },
        data: { processingStatus: "skipped_stage" },
      });
      console.log("[CallWorker] Skipped: deal not in qualifying stage", {
        callId,
        dealId,
        pipelineId,
        stageId,
      });
      return;
    }
  }
  // Если сделка не найдена (dealId=null) — продолжаем анализ без привязки к сделке
  // (запишем в Sheets, но не добавим примечание в amoCRM)

  // Транскрибация аудио через Gemini
  let transcriptText = "";
  if (payload.record_url) {
    console.log("[CallWorker] Transcribing audio:", { callId, url: payload.record_url });
    try {
      transcriptText = await transcribeAudioWithGemini(payload.record_url);

      // Сохраняем транскрипт в БД
      await prisma.callTranscript.upsert({
        where: { callId },
        update: { text: transcriptText },
        create: { callId, text: transcriptText },
      });
      // Отдельный update для поля engine (обходим ограничение Prisma 7 upsert)
      await prisma.callTranscript.update({
        where: { callId },
        data: { engine: "gemini" },
      });

      console.log("[CallWorker] Transcript saved:", {
        callId,
        length: transcriptText.length,
      });
    } catch (err) {
      console.error("[CallWorker] Transcription failed:", err);
    }
  }

  await prisma.call.update({
    where: { id: callId },
    data: {
      processingStatus: "transcribed",
      processingAttempts: { increment: 1 },
    },
  });

  console.log("[CallWorker] Marked as transcribed:", { callId });

  const analysis = await analyzeCallWithGemini(transcriptText, {
    durationSeconds: payload.duration,
    direction: payload.direction,
  });

  console.log("[CallWorker] AI analysis result:", {
    callId,
    overallScore: analysis.overallScore,
  });

  await prisma.callAnalysis.upsert({
    where: { callId },
    update: {
      overallScore: analysis.overallScore,
      criteria: analysis.criteria,
      strengths: analysis.strengths,
      weaknesses: analysis.weaknesses,
      recommendations: analysis.recommendations,
      summary: analysis.summary,
    },
    create: {
      callId,
      overallScore: analysis.overallScore,
      criteria: analysis.criteria,
      strengths: analysis.strengths,
      weaknesses: analysis.weaknesses,
      recommendations: analysis.recommendations,
      summary: analysis.summary,
    },
  });

  await prisma.call.update({
    where: { id: callId },
    data: {
      processingStatus: "analyzed",
    },
  });

  // Google Sheets
  try {
    await appendCallRowToSheet([
      new Date().toISOString(), // дата записи
      payload.uuid,
      payload.internal_number ?? "",
      payload.external_number ?? "",
      payload.direction,
      payload.duration,
      analysis.overallScore,
      analysis.summary,
      (analysis.weaknesses || []).join("; "),
      (analysis.recommendations || []).join("; "),
      payload.record_url ?? "",
    ]);
    console.log("[CallWorker] Appended to Google Sheets:", { callId });
  } catch (err) {
    console.error("[CallWorker] Failed to append to Google Sheets:", err);
  }

  // Примечание в amoCRM по сделке
  if (dealId) {
    const scoreStr = analysis.overallScore !== null ? `${analysis.overallScore}/10` : "н/д";
    const weaknesses = (analysis.weaknesses || []).slice(0, 3).join("\n  • ");
    const recommendations = (analysis.recommendations || []).slice(0, 3).join("\n  • ");

    const noteText = [
      `📞 Анализ звонка`,
      `Дата: ${new Date(payload.start_time ?? Date.now()).toLocaleString("ru-RU")}`,
      `Оценка: ${scoreStr}`,
      ``,
      `📝 ${analysis.summary}`,
      weaknesses ? `\n⚠️ Ошибки:\n  • ${weaknesses}` : "",
      recommendations ? `\n💡 Рекомендации:\n  • ${recommendations}` : "",
      ``,
      `🔗 Запись: ${payload.record_url ?? "—"}`,
    ]
      .filter((line) => line !== null)
      .join("\n");

    try {
      await addNoteToDeal(dealId, noteText);
      console.log("[CallWorker] Added amo note:", { callId, dealId });
    } catch (err) {
      console.error("[CallWorker] Failed to add amo note:", err);
    }
  }

  await prisma.call.update({
    where: { id: callId },
    data: {
      processingStatus: "processed",
    },
  });
  console.log("[CallWorker] Processed successfully:", { callId });
}

createWorker("call_processing", async (job) => {
  const data = job.data as CallProcessingJobData;

  try {
    await processCallJob(data);
  } catch (error: any) {
    console.error("Error processing call job:", error);
    // Обновляем статус звонка как error, если удалось определить запись
    try {
      const call = await prisma.call.findUnique({
        where: {
          externalId_source: {
            externalId: data.callExternalId,
            source: "onlinepbx",
          },
        },
      });

      if (call) {
        await prisma.call.update({
          where: { id: call.id },
          data: {
            processingStatus: "error",
            lastError: String(error?.message ?? error),
          },
        });
      }
    } catch (inner) {
      console.error("Failed to update call status after error:", inner);
    }

    throw error;
  }
});

