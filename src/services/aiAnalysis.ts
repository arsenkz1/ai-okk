import "dotenv/config";
import axios, { AxiosError } from "axios";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Gemini helpers
// ---------------------------------------------------------------------------

function geminiModel(envVar: string, fallback: string): string {
  const raw = process.env[envVar] ?? fallback;
  return raw.startsWith("gemini-") ? raw : `gemini-${raw}`;
}

/**
 * Обёртка с retry для 429 (rate-limit).
 * До 4 попыток с экспоненциальной задержкой: 2s, 4s, 8s, 16s.
 */
async function withGeminiRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const axiosErr = err as AxiosError;
      const status = axiosErr?.response?.status;

      if (status === 429) {
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s, 16s
        console.warn(
          `[Gemini] 429 Rate Limit (attempt ${attempt}/${maxAttempts}), retrying in ${delay / 1000}s...`
        );
        await new Promise((r) => setTimeout(r, delay));
        lastError = err;
        continue;
      }

      // Для остальных ошибок — сразу бросаем
      throw err;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Circuit Breaker для Gemini API
// Защищает от каскадных сбоев: после N подряд ошибок перестаёт делать запросы
// на время cooldown, затем пробует снова (HALF_OPEN).
// ---------------------------------------------------------------------------

type CbState = "CLOSED" | "OPEN" | "HALF_OPEN";

const cb = {
  state: "CLOSED" as CbState,
  failures: 0,
  lastFailureAt: 0,
  threshold: 5,         // 5 подряд ошибок → OPEN
  cooldownMs: 120_000,  // 2 минуты в OPEN перед попыткой HALF_OPEN
};

function cbTick(success: boolean): void {
  if (success) {
    if (cb.failures > 0) {
      console.log(`[Gemini CB] Request succeeded, resetting circuit (was: ${cb.state})`);
    }
    cb.failures = 0;
    cb.state = "CLOSED";
    return;
  }

  cb.failures++;
  cb.lastFailureAt = Date.now();

  if (cb.state === "HALF_OPEN" || cb.failures >= cb.threshold) {
    cb.state = "OPEN";
    console.warn(
      `[Gemini CB] Circuit OPEN after ${cb.failures} failures. Cooling down for ${cb.cooldownMs / 1000}s`
    );
  }
}

/**
 * Выполняет Gemini-запрос через retry + circuit breaker.
 * Бросает ошибку "Circuit OPEN" немедленно, не совершая HTTP-запрос.
 */
async function withGemini<T>(fn: () => Promise<T>): Promise<T> {
  // Проверяем состояние circuit breaker
  if (cb.state === "OPEN") {
    const elapsed = Date.now() - cb.lastFailureAt;
    if (elapsed >= cb.cooldownMs) {
      cb.state = "HALF_OPEN";
      console.log("[Gemini CB] Switching to HALF_OPEN — testing one request");
    } else {
      const remaining = Math.ceil((cb.cooldownMs - elapsed) / 1000);
      throw new Error(
        `[Gemini CB] Circuit is OPEN. Cooldown remaining: ${remaining}s`
      );
    }
  }

  try {
    const result = await withGeminiRetry(fn);
    cbTick(true);
    return result;
  } catch (err) {
    cbTick(false);
    throw err;
  }
}

/** Текущее состояние circuit breaker (для мониторинга/логов) */
export function getGeminiCircuitStatus(): { state: CbState; failures: number } {
  return { state: cb.state, failures: cb.failures };
}

// ---------------------------------------------------------------------------
// AI Coach: диалог с памятью (используется Telegram-ботом)
// ---------------------------------------------------------------------------

export interface GeminiMessage {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

export async function askGeminiWithHistory(
  history: GeminiMessage[],
  systemPrompt: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "GEMINI_API_KEY не настроен.";

  const model = geminiModel("GEMINI_TEXT_MODEL", "gemini-2.5-flash");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const response = await withGemini(() =>
      axios.post(url, {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: history,
      })
    );
    return (
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ??
      "Нет ответа от AI."
    );
  } catch (err: any) {
    console.error("[Gemini] askGeminiWithHistory error:", err.message);
    return "Ошибка при обращении к AI. Попробуй позже.";
  }
}

/**
 * Произвольный текстовый промпт → текстовый ответ.
 */
export async function askGeminiRaw(
  prompt: string,
  systemPrompt?: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "GEMINI_API_KEY не настроен.";

  const model = geminiModel("GEMINI_TEXT_MODEL", "gemini-2.5-flash");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
  };
  if (systemPrompt) {
    body.system_instruction = { parts: [{ text: systemPrompt }] };
  }

  try {
    const response = await withGemini(() => axios.post(url, body));
    return (
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ??
      "Нет ответа от AI."
    );
  } catch (err: any) {
    console.error("[Gemini] askGeminiRaw error:", err.message);
    return "Ошибка при обращении к AI. Попробуй позже.";
  }
}

// ---------------------------------------------------------------------------
// Транскрибация аудио через Gemini
// ---------------------------------------------------------------------------

const TRANSCRIBE_PROMPT = `Транскрибируй аудиозапись телефонного разговора.
Правила:
- Обозначай реплики как "Менеджер:" и "Клиент:" (определи роли по контексту: менеджер продаёт / отвечает на вопросы, клиент — покупатель).
- Каждую реплику с новой строки.
- Передавай речь максимально точно, без правок и сокращений.
- Верни только текст транскрипции, без комментариев и пояснений.`;

/**
 * Транскрибация из локального Buffer (для исторических звонков из TAR-архива).
 */
export async function transcribeAudioFromBuffer(
  buffer: Buffer,
  mimeType = "audio/mpeg"
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "";

  const model = geminiModel("GEMINI_TRANSCRIBE_MODEL", "gemini-2.5-flash");
  const base64Audio = buffer.toString("base64");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await withGemini(() =>
    axios.post(url, {
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mimeType, data: base64Audio } },
            { text: TRANSCRIBE_PROMPT },
          ],
        },
      ],
    })
  );

  const rawText =
    response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return rawText.trim();
}

/**
 * Транскрибация по URL (для real-time звонков из OnlinePBX webhook).
 */
export async function transcribeAudioWithGemini(
  recordUrl: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "";

  const model = geminiModel("GEMINI_TRANSCRIBE_MODEL", "gemini-2.5-flash");

  const pbxApiKey = process.env.ONLINEPBX_PBX_AUTH ?? process.env.ONLINEPBX_API_KEY;
  const audioResponse = await axios.get(recordUrl, {
    responseType: "arraybuffer",
    timeout: 60_000,
    headers: pbxApiKey ? { "x-pbx-authentication": pbxApiKey } : {},
  });

  const contentType = String(audioResponse.headers["content-type"] ?? "");
  if (
    audioResponse.status !== 200 ||
    contentType.includes("application/json") ||
    contentType.includes("text/")
  ) {
    const errBody = Buffer.from(audioResponse.data).toString("utf-8");
    throw new Error(
      `Failed to download audio (status ${audioResponse.status}): ${errBody.slice(0, 200)}`
    );
  }

  const base64Audio = Buffer.from(audioResponse.data).toString("base64");

  const mime = recordUrl.toLowerCase().includes(".ogg")
    ? "audio/ogg"
    : recordUrl.toLowerCase().includes(".wav")
    ? "audio/wav"
    : "audio/mpeg";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await withGemini(() =>
    axios.post(url, {
      contents: [
        {
          parts: [
            {
              inline_data: {
                mime_type: mime,
                data: base64Audio,
              },
            },
            { text: TRANSCRIBE_PROMPT },
          ],
        },
      ],
    })
  );

  const rawText =
    response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return rawText.trim();
}

// ---------------------------------------------------------------------------
// Анализ звонка через Gemini (Zod-валидированный ответ)
// ---------------------------------------------------------------------------

const CriteriaItemSchema = z.object({
  code: z.string().default(""),
  name: z.string().default(""),
  score: z.number().default(0),
  comment: z.string().default(""),
});

const CallAnalysisSchema = z.object({
  overallScore: z.number().nullable().optional().default(null),
  criteria: z.array(CriteriaItemSchema).default([]),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
  summary: z.string().default(""),
  clientPortrait: z.string().default(""),
});

export type CallAnalysisResult = z.infer<typeof CallAnalysisSchema>;

export async function analyzeCallWithGemini(
  transcript: string,
  metadata: {
    durationSeconds: number;
    direction: string;
  }
): Promise<CallAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = geminiModel("GEMINI_TEXT_MODEL", "gemini-2.5-flash");

  const fallback: CallAnalysisResult = {
    overallScore: null,
    criteria: [],
    strengths: [],
    weaknesses: [],
    recommendations: [],
    summary: "Анализ не выполнен: GEMINI_API_KEY не настроен.",
    clientPortrait: "",
  };

  if (!apiKey) return fallback;

  const prompt = `
Sen — qo'ng'iroq sifatini nazorat qiluvchi AI-tizimsan.
Dialogni qat'iy JSON sxemasi bo'yicha tahlil qil:
{
  "overallScore": number 0-10,
  "criteria": [
    { "code": "greeting", "name": "Salomlashish", "score": 0-10, "comment": "..." },
    { "code": "needs", "name": "Ehtiyojlarni aniqlash", "score": 0-10, "comment": "..." },
    { "code": "presentation", "name": "Mahsulot taqdimoti", "score": 0-10, "comment": "..." },
    { "code": "objections", "name": "E'tirozlar bilan ishlash", "score": 0-10, "comment": "..." },
    { "code": "closing", "name": "Bitimni yakunlash", "score": 0-10, "comment": "..." }
  ],
  "strengths": ["...", "..."],
  "weaknesses": ["...", "..."],
  "recommendations": ["...", "..."],
  "summary": "2-3 gapdan iborat qisqa xulosa",
  "clientPortrait": "Mijoz portreti: ismi (agar aytilgan bo'lsa), taxminiy yoshi, sohasi/kasbi, asosiy ehtiyoji, munosabati va xulq-atvori haqida 2-4 gapdan iborat qisqa tavsif"
}

MUHIM: barcha matn maydonlarini (summary, comment, strengths, weaknesses, recommendations, clientPortrait) O'ZBEK TILIDA (lotin alifbosi) yoz.
FAQAT JSON qaytар, tushuntirish va formatirlashsiz.

Meta-ma'lumotlar:
- davomiyligi (sek): ${metadata.durationSeconds}
- yo'nalishi: ${metadata.direction}

Dialog:
${transcript}
`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await withGemini(() =>
      axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
      })
    );

    const rawText =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    // Убираем markdown-обёртку ```json ... ```
    const text = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error("[Gemini] analyzeCall: failed to parse JSON:", text.slice(0, 200));
      return { ...fallback, summary: "Анализ не выполнен из-за ошибки формата ответа AI." };
    }

    const validated = CallAnalysisSchema.safeParse(parsed);
    if (!validated.success) {
      console.error("[Gemini] analyzeCall: Zod validation failed:", validated.error.message);
      // Пробуем частичное восстановление из сырых данных
      const raw = parsed as Record<string, unknown>;
      return {
        overallScore: typeof raw.overallScore === "number" ? raw.overallScore : null,
        criteria: Array.isArray(raw.criteria) ? raw.criteria as any : [],
        strengths: Array.isArray(raw.strengths) ? raw.strengths as string[] : [],
        weaknesses: Array.isArray(raw.weaknesses) ? raw.weaknesses as string[] : [],
        recommendations: Array.isArray(raw.recommendations) ? raw.recommendations as string[] : [],
        summary: typeof raw.summary === "string" ? raw.summary : "",
        clientPortrait: typeof raw.clientPortrait === "string" ? raw.clientPortrait : "",
      };
    }

    return validated.data;
  } catch (error: any) {
    console.error("[Gemini] analyzeCall error:", error.message ?? error);
    return { ...fallback, summary: "Анализ не выполнен из-за ошибки AI-сервиса." };
  }
}
