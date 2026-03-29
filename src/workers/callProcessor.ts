import * as fs from "fs";
import { createWorker } from "../config/queue";
import { prisma } from "../config/database";
import { notifyAdmins, notifyAdminsWithFile } from "../bot/notify";
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
): Promise<{ id: number; dealId: number | null; pipelineId: number | null; stageId: number | null; skipNotify?: boolean }> {
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
  let skipNotify = false;

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
        // Если сделка найдена через amoCRM API — убеждаемся что она записана в локальную БД
        await ensureDealInDb(found.dealId);
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
    return { id: existing.id, dealId, pipelineId, stageId, skipNotify };
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

  return { id: call.id, dealId, pipelineId, stageId, skipNotify };
}

async function processCallJob(jobData: CallProcessingJobData, jobAttemptsMade: number, jobMaxAttempts: number) {
  const { payload, localFilePath } = jobData;

  console.log("[CallWorker] Got job:", {
    uuid: payload.uuid,
    duration: payload.duration,
    direction: payload.direction,
  });

  const { id: callId, dealId, pipelineId, stageId, skipNotify } = await ensureCallRecord(payload, jobData.forceDealId);

  // Стадия/воронка больше не фильтруется — обрабатываем все найденные сделки
  // Если сделка не найдена (dealId=null) — пропускаем анализ
  // Уведомляем только если контакт вообще не найден в amoCRM (skipNotify=false)
  if (dealId === null && !jobData.forceDealId) {
    if (skipNotify) {
      await prisma.call.update({ where: { id: callId }, data: { processingStatus: "skipped_stage" } });
      return;
    }
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

    } catch (err: any) {
      const isTimeout = err?.code === "ECONNABORTED" || err?.message?.includes("timeout");
      console.error("[CallWorker] Transcription failed:", err?.message ?? err);

      if (isTimeout) {
        // Таймаут — бросаем ошибку, BullMQ сделает retry автоматически
        // Уведомляем только на последней попытке
        const isLastAttempt = jobAttemptsMade + 1 >= jobMaxAttempts;
        if (isLastAttempt) {
          await prisma.call.update({
            where: { id: callId },
            data: { processingStatus: "failed", lastError: `Таймаут скачивания после ${jobMaxAttempts} попыток` },
          });
          await notifyAdmins(
            `⚠️ Транскрипция не удалась после ${jobMaxAttempts} попыток\nUUID: ${payload.uuid}\nDeal: ${dealId ?? "не найден"}\nДлительность: ${Math.round((payload.duration || 0) / 60)} мин\n\nТаймаут скачивания записи\n\nЗапись: ${payload.record_url}`
          ).catch(() => {});
        }
        throw err; // BullMQ retry
      }

      // Другие ошибки (403, 404 и т.д.) — уведомляем сразу, retry не поможет
      const reason = `Ошибка скачивания: ${err?.message ?? err}`;
      await prisma.call.update({
        where: { id: callId },
        data: { processingStatus: "failed", lastError: reason },
      });
      await notifyAdmins(
        `⚠️ Транскрипция не удалась\nUUID: ${payload.uuid}\nDeal: ${dealId ?? "не найден"}\nДлительность: ${Math.round((payload.duration || 0) / 60)} мин\n\n${reason}\n\nЗапись: ${payload.record_url}`
      ).catch(() => {});
      return;
    }
  }

  await prisma.call.update({
    where: { id: callId },
    data: {
      processingStatus: "transcribed",
      processingAttempts: { increment: 1 },
    },
  });

  // Если транскрипт пустой — уведомляем админов и останавливаем обработку
  if (!transcriptText.trim()) {
    await prisma.call.update({
      where: { id: callId },
      data: { processingStatus: "failed", lastError: "Transcription returned empty text" },
    });
    await notifyAdmins(
      `⚠️ Транскрипция не удалась — пустой текст\n` +
      `UUID: ${payload.uuid}\n` +
      `Deal: ${dealId ?? "не найден"}\n` +
      `Длительность: ${Math.round(payload.duration / 60)} мин\n` +
      `Запись: ${payload.record_url || localFilePath || "нет"}`
    ).catch(() => {});
    return;
  }

  const analysis = await analyzeCallWithGemini(transcriptText, {
    durationSeconds: payload.duration,
    direction: payload.direction,
  });

  const totalScore =
    analysis.contextScore + analysis.needsScore + analysis.painScore + analysis.summaryScore +
    analysis.presentationScore + analysis.pointBScore +
    analysis.closingScore + analysis.objectionsScore + analysis.urgencyScore + analysis.agreementScore;

  console.log("[CallWorker] AI analysis result:", { callId, totalScore });

  if (analysis.rawGeminiResponse) {
    const filename = `gemini_error_${payload.uuid}.txt`;
    const content = [
      `UUID: ${payload.uuid}`,
      `Deal: ${dealId ?? "null"}`,
      ``,
      `--- PARSE ERROR ---`,
      analysis.parseError ?? "(no error details)",
      ``,
      `--- RAW GEMINI RESPONSE ---`,
      analysis.rawGeminiResponse,
    ].join("\n");
    const msg = `⚠️ Gemini вернул неверный JSON\nUUID: ${payload.uuid}\n\n<pre>${analysis.parseError ?? ""}</pre>`;
    await notifyAdminsWithFile(msg, content, filename).catch(() => {});
  }

  const scoresJson = {
    contextScore: analysis.contextScore,
    needsScore: analysis.needsScore,
    painScore: analysis.painScore,
    summaryScore: analysis.summaryScore,
    presentationScore: analysis.presentationScore,
    pointBScore: analysis.pointBScore,
    closingScore: analysis.closingScore,
    objectionsScore: analysis.objectionsScore,
    urgencyScore: analysis.urgencyScore,
    agreementScore: analysis.agreementScore,
  };

  await prisma.callAnalysis.upsert({
    where: { callId },
    update: {
      overallScore: totalScore,
      criteria: scoresJson,
      summary: analysis.comment,
      strengths: analysis.strengths,
      weaknesses: analysis.weaknesses,
    },
    create: {
      callId,
      overallScore: totalScore,
      criteria: scoresJson,
      summary: analysis.comment,
      strengths: analysis.strengths,
      weaknesses: analysis.weaknesses,
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
    const tz = process.env.CRON_TIMEZONE || "Asia/Almaty";
    const dateStr = new Date().toLocaleString("ru-RU", { timeZone: tz });

    const durationSec = payload.duration;
    const durationStr = `${Math.floor(durationSec / 60)} мин ${durationSec % 60} сек`;

    const callRecord = await prisma.call.findUnique({ where: { id: callId }, include: { manager: true } });
    const managerLabel = callRecord?.manager?.name ?? payload.internal_number ?? "";

    await appendCallRowToSheet([
      dateStr,                                                          // A Дата/Время
      payload.uuid,                                                     // B UUID
      payload.external_number ?? "",                                    // C Телефон клиента
      durationStr,                                                      // D Длительность
      dealId                                                            // E Сделка ID
        ? `=HYPERLINK("https://qadamsales.amocrm.ru/leads/detail/${dealId}";"#${dealId}")`
        : "",
      managerLabel,                                                     // F Менеджер
      analysis.contextScore,                                            // G Текущий контекст
      analysis.needsScore,                                              // H Выявил потребность
      analysis.painScore,                                               // I Вытащил Боли
      analysis.summaryScore,                                            // J Резюме
      analysis.presentationScore,                                       // K Презентация
      analysis.pointBScore,                                             // L Точка Б + продукт
      analysis.closingScore,                                            // M Попытка закрытия
      analysis.objectionsScore,                                         // N Отработка возражений
      analysis.urgencyScore,                                            // O Срочность
      analysis.agreementScore,                                          // P Договорённость след шаг
      analysis.comment,                                                 // Q Комментарии по обучению
      totalScore,                                                       // R Сумма баллов
      payload.record_url                                                // S Ссылка на запись
        ? `=HYPERLINK("${payload.record_url}";"▶ Слушать")`
        : "",
      "",                                                               // T Сделка закрыта?
    ]);
  } catch (err) {
    console.error("[CallWorker] Failed to append to Google Sheets:", err);
  }

  // amoCRM bitimiga mijoz portreti izohini qo'shish
  if (dealId && analysis.clientPortrait) {
    const portrait = analysis.clientPortrait.replace(/\.\s+/g, ".\n");
    let noteWritten = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 4000));
        await addNoteToDeal(dealId, portrait);
        noteWritten = true;
        break;
      } catch (err) {
        console.error(`[CallWorker] Failed to add amo note (attempt ${attempt}):`, err);
      }
    }
    if (!noteWritten) {
      await notifyAdmins(
        `⚠️ Примечание не записано в сделку #${dealId}\n` +
        `UUID: ${payload.uuid}\n` +
        `Две попытки провалились. Проверь amoCRM или логи.`
      );
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
  const maxAttempts = job.opts?.attempts ?? 5;

  try {
    await processCallJob(data, job.attemptsMade, maxAttempts);
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

