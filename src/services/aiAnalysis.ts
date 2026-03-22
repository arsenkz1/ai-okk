import "dotenv/config";
import axios, { AxiosError } from "axios";
import { z } from "zod";
import { jsonrepair } from "jsonrepair";

// ---------------------------------------------------------------------------
// Gemini helpers
// ---------------------------------------------------------------------------

function geminiModel(envVar: string, fallback: string): string {
  const raw = process.env[envVar] ?? fallback;
  return raw.startsWith("gemini-") ? raw : `gemini-${raw}`;
}

/** Собирает текст из всех parts ответа Gemini (thought + response могут быть раздельно) */
function extractGeminiText(response: any): string {
  const parts: { text?: string; thought?: boolean }[] =
    response.data?.candidates?.[0]?.content?.parts ?? [];
  // Пропускаем thinking-части (thought: true) — они могут содержать { } и ломать JSON-экстракцию
  return parts
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("")
    .trim();
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
    return extractGeminiText(response) || "Нет ответа от AI.";
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
    return extractGeminiText(response) || "Нет ответа от AI.";
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

  return extractGeminiText(response);
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

  return extractGeminiText(response);
}

// ---------------------------------------------------------------------------
// Утилита: заменяет литеральные переносы строк внутри JSON-строк на \n/\r
// Простой state machine O(n), без regex — избегает катастрофического backtracking
// ---------------------------------------------------------------------------

function fixJsonNewlines(text: string): string {
  let result = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        // escape-последовательность — копируем оба символа как есть
        result += ch + (text[i + 1] ?? "");
        i += 2;
        continue;
      } else if (ch === '"') {
        inString = false;
        result += ch;
      } else if (ch === "\n") {
        result += "\\n";
      } else if (ch === "\r") {
        result += "\\r";
      } else {
        result += ch;
      }
    } else {
      if (ch === '"') inString = true;
      result += ch;
    }
    i++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Анализ звонка через Gemini (Zod-валидированный ответ)
// ---------------------------------------------------------------------------

const CallAnalysisSchema = z.object({
  // Блок 1: Идентификация клиента (4 × 10 = 40)
  contextScore:      z.number().min(1).max(10).default(1),
  needsScore:        z.number().min(1).max(10).default(1),
  painScore:         z.number().min(1).max(10).default(1),
  summaryScore:      z.number().min(1).max(10).default(1),
  // Блок 2: Презентация (2 × 10 = 20)
  presentationScore: z.number().min(1).max(10).default(1),
  pointBScore:       z.number().min(1).max(10).default(1),
  // Блок 3: Закрытие (4 × 10 = 40)
  closingScore:      z.number().min(1).max(10).default(1),
  objectionsScore:   z.number().min(1).max(10).default(1),
  urgencyScore:      z.number().min(1).max(10).default(1),
  agreementScore:    z.number().min(1).max(10).default(1),
  // Комментарий эксперта (подробный)
  comment:           z.string().default(""),
  // Сильные стороны (2-3 пункта на узбекском)
  strengths:         z.array(z.string()).default([]),
  // Зоны роста (2-3 пункта на узбекском)
  weaknesses:        z.array(z.string()).default([]),
  // Портрет клиента (на узбекском, для примечания в amoCRM)
  clientPortrait:    z.string().default(""),
});

export type CallAnalysisResult = z.infer<typeof CallAnalysisSchema> & {
  rawGeminiResponse?: string; // заполняется только при ошибке парсинга
  parseError?: string;        // текст ошибки JSON.parse / jsonrepair
};

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
    contextScore: 1, needsScore: 1, painScore: 1, summaryScore: 1,
    presentationScore: 1, pointBScore: 1,
    closingScore: 1, objectionsScore: 1, urgencyScore: 1, agreementScore: 1,
    comment: "Анализ не выполнен: GEMINI_API_KEY не настроен.",
    strengths: [],
    weaknesses: [],
    clientPortrait: "",
  };

  if (!apiKey) return fallback;

  const prompt = `Ты — опытный руководитель отдела продаж онлайн-школы, обучающей практическим профессиям (таргетинг, SMM, Excel, аналитика и др.).

Проанализируй звонок менеджера по 10 критериям и верни строго JSON без пояснений.

БЛОК 1 — Идентификация клиента (каждый критерий 1–10):
1. contextScore — Контекст клиента: понял ли менеджер чем занимается клиент, его опыт и фон?
   10: узнал всё (занятость, опыт, пробовал ли раньше). 7–9: 2–3 аспекта поверхностно. 4–6: одна деталь. 1–3: не интересовался.
2. needsScore — Цель и точка А: выяснил ли менеджер что клиент хочет изменить/достичь?
   10: клиент назвал цель, менеджер докопался до сути. 7–9: цель названа без глубины. 4–6: менеджер сам сделал вывод. 1–3: цель не выяснена.
3. painScore — Боли и триггеры: узнал ли менеджер сильное эмоциональное переживание клиента?
   10: боли чётко озвучены и раскрыты. 7–9: боль упомянута, но не раскрыта. 4–6: предположения без подтверждения. 1–3: боли не обсуждались.
4. summaryScore — Резюме запроса: сделал ли менеджер итоговое резюме по клиенту?
   10: кратко повторил суть запроса и уточнил «Я правильно понял?». 7–9: резюме частичное. 4–6: что-то повторил без оформления. 1–3: резюме не было.

БЛОК 2 — Презентация (каждый критерий 1–10):
5. presentationScore — Связь с болями: привязал ли менеджер курс к болям/потребностям клиента?
   10: чётко связал курс с озвученными болями. 7–9: привязка есть но слабая. 4–6: презентация оторвана от контекста. 1–3: шаблонный рассказ без индивидуализации.
6. pointBScore — Точка Б через продукт: показал ли конкретный желаемый результат?
   10: ясно нарисовал «после» (профессия, доход, навыки). 7–9: намёк на результат. 4–6: говорил о процессе обучения, не о результате. 1–3: не рассказал к чему приведёт курс.

БЛОК 3 — Закрытие (каждый критерий 1–10):
7. closingScore — Попытка закрытия на оплату: была ли активная попытка закрыть на оплату/бронь?
   10: прямо и уверенно предложил оплату. 7–9: попытка есть но мягкая. 4–6: намёк без действия. 1–3: попытки не было.
8. objectionsScore — Работа с возражениями через контекст: обработал ли возражения опираясь на боли/цели клиента?
   10: возражения обработаны со ссылкой на мотивацию клиента. 7–9: контекст использован частично. 4–6: абстрактные шаблонные ответы. 1–3: возражения не обработаны.
9. urgencyScore — Срочность / FOMO: создал ли менеджер мотивацию принять решение сейчас?
   10: явно усилил мотивацию (последствия откладывания, ограничения). 7–9: слабая попытка. 4–6: мягкий намёк без эффекта. 1–3: ничего не усилил.
10. agreementScore — Договорённость по следующему шагу: есть ли конкретная договорённость ведущая к оплате?
    10: договорились и по шагу, и по сроку оплаты. 7–9: чёткий следующий шаг но без срока. 4–6: шаг есть но не ведёт к оплате. 1–3: не договорились что будет дальше.

ФОРМАТ ОТВЕТА (только JSON, без markdown):
{
  "contextScore": <1–10>,
  "needsScore": <1–10>,
  "painScore": <1–10>,
  "summaryScore": <1–10>,
  "presentationScore": <1–10>,
  "pointBScore": <1–10>,
  "closingScore": <1–10>,
  "objectionsScore": <1–10>,
  "urgencyScore": <1–10>,
  "agreementScore": <1–10>,
  "comment": "<o'zbek tilida (lotin): har bir mezon uchun raqam, nomi, ball va tushuntirish. Gaplar orasida \\n belgisini ishlat (haqiqiy yangi qator EMAS). Oxirida: Tavsiyalar — 3-4 ta aniq tavsiya, har biri \\n bilan ajratilgan>",
  "strengths": ["<menejer yaxshi qilgan narsa 1>", "<menejer yaxshi qilgan narsa 2>"],
  "weaknesses": ["<o'sish sohasi 1>", "<o'sish sohasi 2>"],
  "clientPortrait": "<portret o'zbek tilida (lotin). Gaplar orasida \\n belgisini ishlat (haqiqiy yangi qator EMAS). Tarkib: ismi (agar aytilgan bo'lsa), taxminiy yoshi, sohasi, asosiy ehtiyoji, xulq-atvori — 2–4 gap>"
}

Длительность звонка: ${metadata.durationSeconds} сек. Направление: ${metadata.direction}.

Диалог:
${transcript}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await withGemini(() =>
      axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
      })
    );

    // Собираем текст из всех parts (Gemini 2.5 может вернуть thought + response)
    const rawText = extractGeminiText(response) || "{}";

    // Извлекаем JSON: ищем первый { и последний } в ответе
    const jsonStart = rawText.indexOf("{");
    const jsonEnd = rawText.lastIndexOf("}");
    const text = jsonStart !== -1 && jsonEnd > jsonStart
      ? rawText.slice(jsonStart, jsonEnd + 1)
      : rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (firstErr) {
      // Gemini иногда возвращает невалидный JSON: литеральные переносы строк,
      // неэкранированные кавычки внутри строк и т.п.
      // jsonrepair умеет чинить все эти случаи.
      try {
        parsed = JSON.parse(jsonrepair(text));
      } catch (secondErr) {
        const parseError = `JSON.parse: ${(firstErr as Error).message}\njsonrepair+parse: ${(secondErr as Error).message}`;
        console.error("[Gemini] analyzeCall: failed to parse JSON even after repair.", parseError);
        return { ...fallback, comment: "Анализ не выполнен из-за ошибки формата ответа AI.", rawGeminiResponse: rawText, parseError };
      }
    }

    const validated = CallAnalysisSchema.safeParse(parsed);
    if (!validated.success) {
      console.error("[Gemini] analyzeCall: Zod validation failed:", validated.error.message);
      const raw = parsed as Record<string, unknown>;
      const num = (k: string) => typeof raw[k] === "number" ? raw[k] as number : 1;
      return {
        contextScore: num("contextScore"),
        needsScore: num("needsScore"),
        painScore: num("painScore"),
        summaryScore: num("summaryScore"),
        presentationScore: num("presentationScore"),
        pointBScore: num("pointBScore"),
        closingScore: num("closingScore"),
        objectionsScore: num("objectionsScore"),
        urgencyScore: num("urgencyScore"),
        agreementScore: num("agreementScore"),
        comment: typeof raw.comment === "string" ? raw.comment : "",
        strengths: Array.isArray(raw.strengths) ? raw.strengths as string[] : [],
        weaknesses: Array.isArray(raw.weaknesses) ? raw.weaknesses as string[] : [],
        clientPortrait: typeof raw.clientPortrait === "string" ? raw.clientPortrait : "",
      };
    }

    return validated.data;
  } catch (error: any) {
    console.error("[Gemini] analyzeCall error:", error.message ?? error);
    return { ...fallback, comment: "Анализ не выполнен из-за ошибки AI-сервиса." };
  }
}
