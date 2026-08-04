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
import { runCallTaskAutomation } from "../services/callTaskAutomation";
import { getCallTaskAutomationRuntime } from "../services/callTaskAutomationRuntime";
import { runCallStageAutomation } from "../services/callStageAutomation";
import { getCallStageAutomationRuntime } from "../services/callStageAutomationRuntime";
import {
  addNoteToDeal,
  lookupDealByPhone,
  lookupDealByPhoneFromAmo,
  isQualifyingDeal,
  ensureDealInDb,
  normalizePhone,
} from "../services/amocrm";

async function ensureCallRecord(
  payload: OnlinePbxWebhookPayload,
  forceDealId?: number
): Promise<{ id: number; dealId: number | null; pipelineId: number | null; stageId: number | null; skipNotify?: boolean; searchMeta?: { phone: string; normalizedPhone: string; foundInDb: boolean; foundInAmo: boolean } }> {
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

  let searchMeta: { phone: string; normalizedPhone: string; foundInDb: boolean; foundInAmo: boolean } | undefined;

  if (forceDealId) {
    await ensureDealInDb(forceDealId);
    dealId = forceDealId;
  } else {
    const clientPhone = payload.external_number ?? payload.caller ?? payload.callee;
    if (clientPhone) {
      const normalizedPhone = normalizePhone(clientPhone);
      let foundInDb = false;
      let foundInAmo = false;

      let found = await lookupDealByPhone(clientPhone);
      if (found) foundInDb = true;

      if (!found) {
        found = await lookupDealByPhoneFromAmo(clientPhone);
        if (found) foundInAmo = true;
      }

      searchMeta = { phone: clientPhone, normalizedPhone, foundInDb, foundInAmo };

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
    return { id: existing.id, dealId, pipelineId, stageId, skipNotify, searchMeta };
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

  return { id: call.id, dealId, pipelineId, stageId, skipNotify, searchMeta };
}

/**
 * Runs independently of the quality-score analysis after a transcript exists.
 * It is deliberately best-effort: task automation errors must not turn a
 * completed call transcription into a retry storm.
 */
async function maybeRunCallTaskAutomation(callId: number, transcript: string): Promise<void> {
  try {
    const runtime = getCallTaskAutomationRuntime();
    if (!runtime.config.enabled) return;
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: {
        id: true,
        dealId: true,
        startedAt: true,
        manager: { select: { amoUserId: true } },
      },
    });
    if (!call?.dealId) return;
    const result = await runCallTaskAutomation({
      callId: call.id,
      dealId: call.dealId,
      // The call start time, rather than the local record creation time,
      // prevents a historical re-import from crossing the activation boundary.
      callCreatedAt: call.startedAt,
      managerAmoUserId: call.manager?.amoUserId ?? null,
      transcript,
    }, runtime.dependencies);
    console.info("[CallTaskAutomation] Processed call action", {
      callId: call.id,
      dealId: call.dealId,
      result: result.kind,
      actionId: "actionId" in result ? result.actionId : undefined,
    });
  } catch (error) {
    console.error("[CallTaskAutomation] Call action processing failed", {
      callId,
      reason: error instanceof Error ? error.message : "unknown error",
    });
  }
}

/**
 * Separate from task automation: this may mutate only a verified UZUM stage.
 * It is best-effort, so an integration failure cannot cause the completed-call
 * worker itself to retry and replay a non-idempotent amoCRM PATCH.
 */
async function maybeRunCallStageAutomation(callId: number, transcript: string): Promise<void> {
  try {
    const runtime = getCallStageAutomationRuntime();
    if (!runtime.config.enabled) return;
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { id: true, dealId: true, startedAt: true, endedAt: true },
    });
    if (!call?.dealId || !call.endedAt) return;
    const result = await runCallStageAutomation({
      callId: call.id,
      dealId: call.dealId,
      // Use source call timestamps, never local processing time, so historical
      // imports cannot cross the durable activation boundary.
      callCreatedAt: call.startedAt,
      callEndedAt: call.endedAt,
      transcript,
    }, runtime.dependencies);
    console.info("[CallStageAutomation] Processed call stage", {
      callId: call.id,
      dealId: call.dealId,
      result: result.kind,
      actionId: "actionId" in result ? result.actionId : undefined,
    });
  } catch (error) {
    console.error("[CallStageAutomation] Call stage processing failed", {
      callId,
      reason: error instanceof Error ? error.message : "unknown error",
    });
  }
}

async function processCallJob(jobData: CallProcessingJobData, jobAttemptsMade: number, jobMaxAttempts: number) {
  const { payload, localFilePath } = jobData;

  console.log("[CallWorker] Got job:", {
    uuid: payload.uuid,
    duration: payload.duration,
    direction: payload.direction,
  });

  const { id: callId, dealId, pipelineId, stageId, skipNotify, searchMeta } = await ensureCallRecord(payload, jobData.forceDealId);

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
    const searchInfo = searchMeta
      ? `📲 Нормализован: ${searchMeta.normalizedPhone}\n` +
        `🔍 Локальная БД: ${searchMeta.foundInDb ? "✅ найдено" : "❌ не найдено"}\n` +
        `🔍 amoCRM API: ${searchMeta.foundInAmo ? "✅ найдено" : "❌ не найдено"}\n`
      : "";
    await notifyAdmins(
      `⚠️ Звонок без сделки (пропущен)\n\n` +
      `📞 Телефон: ${phone}\n` +
      searchInfo +
      `⏱ Длительность: ${duration} мин\n` +
      `🆔 UUID: ${payload.uuid}\n\n` +
      `Сделка не найдена. Звонок не проанализирован.\n` +
      `💡 Если контакт есть в amoCRM — проверьте формат номера телефона в карточке.`
    );
    return;
  }

  // Транскрибация аудио через Gemini
  let transcriptText = "";
  let transcribeFinishReason: string | undefined;
  let transcribeAudioSizeKb: number | undefined;

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
      const result = await transcribeAudioWithGemini(payload.record_url);
      transcriptText = result.text;
      transcribeFinishReason = result.finishReason;
      transcribeAudioSizeKb = result.audioSizeKb;

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
      const isCircuitOpen = err?.message?.includes("Circuit is OPEN");
      const httpStatus = err?.response?.status;
      console.error("[CallWorker] Transcription failed:", err?.message ?? err);

      // Все ошибки — retry. Уведомляем только на последней попытке.
      const isLastAttempt = jobAttemptsMade + 1 >= jobMaxAttempts;
      if (isLastAttempt) {
        const reason = isTimeout
          ? "Таймаут скачивания"
          : isCircuitOpen
          ? "Gemini API временно недоступен (circuit breaker)"
          : `Ошибка скачивания: ${httpStatus ? `HTTP ${httpStatus}` : (err?.message ?? err)}`;
        await prisma.call.update({
          where: { id: callId },
          data: { processingStatus: "failed", lastError: `${reason} после ${jobMaxAttempts} попыток` },
        });
        await notifyAdmins(
          `⚠️ Транскрипция не удалась после ${jobMaxAttempts} попыток\nUUID: ${payload.uuid}\nDeal: ${dealId ?? "не найден"}\nДлительность: ${Math.round((payload.duration || 0) / 60)} мин\n\n${reason}\n\nЗапись: ${payload.record_url}`
        ).catch(() => {});
      }
      throw err; // BullMQ retry
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
    const finishInfo = transcribeFinishReason ? `\n🔴 Gemini finishReason: ${transcribeFinishReason}` : "";
    const sizeInfo = transcribeAudioSizeKb ? `\n📦 Размер файла: ${transcribeAudioSizeKb} KB` : "";
    const hintMap: Record<string, string> = {
      OTHER: "Gemini отказался обрабатывать файл (возможно формат или содержимое)",
      SAFETY: "Заблокировано фильтром безопасности Gemini",
      RECITATION: "Заблокировано как повторение обучающих данных",
      MAX_TOKENS: "Ответ обрезан — файл слишком большой для одного запроса",
      STOP: "Gemini завершил нормально, но не распознал речь — возможно тихая или пустая запись",
    };
    const finishKey = transcribeFinishReason?.startsWith("BLOCKED:")
      ? "BLOCKED"
      : transcribeFinishReason;
    const blockedDetail = transcribeFinishReason?.startsWith("BLOCKED:")
      ? `Запрос заблокирован Gemini: ${transcribeFinishReason.replace("BLOCKED:", "")}`
      : null;
    const hint = blockedDetail
      ? `\n💡 ${blockedDetail}`
      : (finishKey && hintMap[finishKey])
        ? `\n💡 ${hintMap[finishKey]}`
        : "\n💡 Возможные причины: тихая запись, неподдерживаемый формат, или сбой Gemini";
    await notifyAdmins(
      `⚠️ Транскрипция не удалась — пустой текст\n` +
      `UUID: ${payload.uuid}\n` +
      `Deal: ${dealId ?? "не найден"}\n` +
      `Длительность: ${Math.round(payload.duration / 60)} мин` +
      finishInfo +
      sizeInfo +
      hint + "\n" +
      `Запись: ${payload.record_url || localFilePath || "нет"}`
    ).catch(() => {});
    return;
  }

  // Quality scoring, task proposals, and UZUM stage routing are independent
  // consumers of the same persisted finished transcript.
  const taskAutomationPromise = maybeRunCallTaskAutomation(callId, transcriptText);
  const stageAutomationPromise = maybeRunCallStageAutomation(callId, transcriptText);
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

  // Each path catches and records its own failures. They were started in parallel
  // above, then explicitly awaited before acknowledging the queue job.
  await taskAutomationPromise;
  await stageAutomationPromise;

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

