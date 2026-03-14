import * as fs from "fs";
import { createWorker } from "../config/queue";
import { prisma } from "../config/database";
import { notifyAdmins } from "../bot/notify";
import {
  CallProcessingJobData,
  OnlinePbxWebhookPayload,
} from "../queues/callProcessing";
import {
  analyzeCallWithGemini,
  transcribeAudioFromBuffer,
  transcribeAudioWithGemini,
} from "../services/aiAnalysis";
import { appendCallRowToSheet } from "../services/googleSheets";
import {
  addNoteToDeal,
  lookupDealByPhone,
  lookupDealByPhoneFromAmo,
  isQualifyingDeal,
  ensureDealInDb,
} from "../services/amocrm";

async function ensureCallRecord(
  payload: OnlinePbxWebhookPayload,
  forceDealId?: number
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
    // Если сделка уже привязана — возвращаем как есть
    if (existing.dealId) {
      return {
        id: existing.id,
        dealId: existing.dealId,
        pipelineId: existing.deal?.pipelineId ?? null,
        stageId: existing.deal?.statusId ?? null,
      };
    }
    // dealId === null: пробуем найти сделку (могла появиться после первой попытки)
    // Поиск выполняется ниже, результат запишем в существующую запись
  }

  // Ищем менеджера по internal_number (внутренний номер АТС)
  let managerId: number | null = null;
  if (payload.internal_number) {
    const mgr = await prisma.manager.findUnique({
      where: { internalNumber: payload.internal_number },
    });
    if (mgr?.isActive) {
      managerId = mgr.id;
    }
  }

  // Ищем сделку: если передан forceDealId — используем его напрямую, иначе ищем по телефону
  let dealId: number | null = null;
  let pipelineId: number | null = null;
  let stageId: number | null = null;

  if (forceDealId) {
    await ensureDealInDb(forceDealId);
    dealId = forceDealId;
  } else {
    const clientPhone = payload.external_number ?? payload.caller ?? payload.callee;
    if (clientPhone) {
      let found = await lookupDealByPhone(clientPhone);

      if (!found) {
        found = await lookupDealByPhoneFromAmo(clientPhone);
      }

      if (found) {
        dealId = found.dealId;
        pipelineId = found.pipelineId;
        stageId = found.stageId;
      }
    }
  }

  // Если запись уже существовала (но без сделки) — обновляем dealId и возвращаем
  if (existing) {
    if (dealId) {
      await prisma.call.update({
        where: { id: existing.id },
        data: { dealId, processingStatus: "queued" },
      });
    }
    return { id: existing.id, dealId, pipelineId, stageId };
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
  const { payload, localFilePath } = jobData;

  console.log("[CallWorker] Got job:", {
    uuid: payload.uuid,
    duration: payload.duration,
    direction: payload.direction,
  });

  const { id: callId, dealId, pipelineId, stageId } = await ensureCallRecord(payload, jobData.forceDealId);

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
  // Если сделка не найдена (dealId=null) — пропускаем анализ и уведомляем админов
  if (dealId === null && !jobData.forceDealId) {
    await prisma.call.update({
      where: { id: callId },
      data: { processingStatus: "skipped_no_deal" },
    });
    console.log("[CallWorker] Skipped: no deal found for call", { callId, uuid: payload.uuid });
    const duration = Math.round(payload.duration / 60);
    const phone = payload.external_number ?? payload.caller ?? payload.callee ?? "—";
    await notifyAdmins(
      `⚠️ Звонок без сделки (пропущен)\n\n` +
      `📞 Телефон: ${phone}\n` +
      `⏱ Длительность: ${duration} мин\n` +
      `🆔 UUID: ${payload.uuid}\n\n` +
      `Сделка по этому номеру не найдена в amoCRM. Звонок не проанализирован.`
    );
    return;
  }

  // Транскрибация аудио через Gemini
  let transcriptText = "";

  if (localFilePath) {
    // Исторический звонок: читаем локальный MP3-файл, извлечённый из TAR
    try {
      if (!fs.existsSync(localFilePath)) {
        console.warn("[CallWorker] Local file not found (cleaned up or never extracted):", localFilePath);
      } else {
        const audioBuffer = fs.readFileSync(localFilePath);
        transcriptText = await transcribeAudioFromBuffer(audioBuffer);

        // Удаляем temp файл после успешной транскрипции
        try { fs.unlinkSync(localFilePath); } catch {}

        await prisma.callTranscript.upsert({
          where: { callId },
          update: { text: transcriptText },
          create: { callId, text: transcriptText },
        });
        await prisma.callTranscript.update({
          where: { callId },
          data: { engine: "gemini" },
        });

      }
    } catch (err) {
      console.error("[CallWorker] Transcription from file failed:", err);
      // Удаляем битый файл если он есть
      try { if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath); } catch {}
    }
  } else if (payload.record_url) {
    // Real-time звонок: скачиваем по URL из OnlinePBX
    try {
      transcriptText = await transcribeAudioWithGemini(payload.record_url);

      await prisma.callTranscript.upsert({
        where: { callId },
        update: { text: transcriptText },
        create: { callId, text: transcriptText },
      });
      await prisma.callTranscript.update({
        where: { callId },
        data: { engine: "gemini" },
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
      payload.record_url
        ? `=HYPERLINK("${payload.record_url}";"▶ Слушать")`
        : "",
      dealId
        ? `=HYPERLINK("https://qadamsales.amocrm.ru/leads/detail/${dealId}";"#${dealId}")`
        : "",
    ]);
  } catch (err) {
    console.error("[CallWorker] Failed to append to Google Sheets:", err);
  }

  // amoCRM bitimiga izoh qo'shish
  if (dealId) {
    const scoreStr = analysis.overallScore !== null ? `${analysis.overallScore}/10` : "—";
    const weaknesses = (analysis.weaknesses || []).slice(0, 3).join("\n  • ");
    const recommendations = (analysis.recommendations || []).slice(0, 3).join("\n  • ");

    const noteText = [
      `📞 Qo'ng'iroq tahlili`,
      `Sana: ${new Date(payload.start_time ?? Date.now()).toLocaleString("ru-RU")}`,
      `Ball: ${scoreStr}`,
      ``,
      `📝 ${analysis.summary}`,
      weaknesses ? `\n⚠️ Xatolar:\n  • ${weaknesses}` : "",
      recommendations ? `\n💡 Tavsiyalar:\n  • ${recommendations}` : "",
      ``,
      `🔗 Yozuv: ${payload.record_url ?? "—"}`,
    ]
      .filter((line) => line !== null)
      .join("\n");

    try {
      await addNoteToDeal(dealId, noteText);
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

