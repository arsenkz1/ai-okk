# Архитектура системы AI OKK

## Общая схема

```
OnlinePBX ──webhook──► /webhooks/onlinepbx ──► BullMQ Queue ──► callProcessor Worker
                                                                        │
                                          ┌─────────────────────────────┤
                                          │                             │
                                     Gemini AI                    amoCRM API
                                    (транскрипция                (поиск сделки,
                                     + анализ)                   запись примечания)
                                          │                             │
                                     Google Sheets              PostgreSQL (БД)
                                    (запись строки)           (Call, CallAnalysis,
                                                               Deal, Manager...)

amoCRM ────webhook──► /webhooks/amocrm ──► handleAmoCrmWebhook
                                                  │
                                     status 142 ──► ✅ в Sheets
                                     status 143 ──► ❌ в Sheets
                                     contacts.add ──► syncContactById

Telegram Bot (polling) ◄──► Менеджеры / Админы
     │
     ├── /report /week /month /period /errors
     ├── /ask — AI-коуч сессия
     ├── /sync /sync-managers
     └── /analyze_deal <id>

CRON (каждый день 09:00 Asia/Almaty):
  ├── syncManagersFromPbx()
  └── sendDailyReports() — отчёт за вчера

CRON (каждые 3 часа):
  └── checkAndRestoreAmoCrmWebhook()
```

---

## 1. Обработка входящего звонка (основной флоу)

```
OnlinePBX отправляет POST /webhooks/onlinepbx/call-end
          │
          ▼
[routes/onlinepbx.ts] normalizeOnlinePbxPayload()
  • direction: "in" / "out"
  • internal_number = caller (out) или callee (in)
  • external_number = callee (out) или caller (in)
  • event=test_webhook? → отвечаем 200, выходим
          │
          ▼
Фильтр: duration < 6 минут? → пропускаем (skipped)
          │
          ▼
callProcessingQueue.add(job) → BullMQ сохраняет задачу в Redis
          │
          ▼
[workers/callProcessor.ts] processCallJob()

  ┌────────────────────────────────────────────────────────┐
  │ 1. ensureCallRecord()                                  │
  │    • ищем звонок по UUID в БД                          │
  │    • если уже есть и dealId не null → возвращаем       │
  │    • определяем clientPhone = external_number          │
  │    • lookupDealByPhone(phone) → ищем в PhoneMapping БД │
  │    • если не нашли → lookupDealByPhoneFromAmo(phone):  │
  │        - GET /api/v4/contacts?query=phone (все дубли)  │
  │        - собираем все lead_id с контактов              │
  │        - GET /api/v4/leads?filter[contact_id][]=...    │
  │        - выбираем лучшую сделку (самая новая)          │
  │        - сохраняем контакт + сделку + PhoneMapping в БД│
  │    • если сделка не найдена → skipNotify=false         │
  │    • если найдена но не квалифицирующая → skipNotify=true│
  │    • создаём Call запись в БД (upsert по UUID)         │
  └────────────────────────────────────────────────────────┘
          │
          ▼
  dealId == null и forceDealId нет?
    ├── skipNotify=true → тихо пропускаем (skipped_stage)
    └── skipNotify=false → уведомляем админов "сделка не найдена"
                           → пропускаем
          │
          ▼
  ┌────────────────────────────────────────────────────────┐
  │ 2. Скачивание записи звонка                            │
  │    [services/pbxHistory.ts]                            │
  │    • скачиваем MP3 по download_url                     │
  │    • если TAR-архив → извлекаем MP3 из него            │
  │    • возвращаем Buffer с аудио                         │
  └────────────────────────────────────────────────────────┘
          │
          ▼
  ┌────────────────────────────────────────────────────────┐
  │ 3. Транскрипция [services/aiAnalysis.ts]               │
  │    transcribeAudioWithGemini()                         │
  │    • модель: gemini-2.5-flash (или GEMINI_AUDIO_MODEL) │
  │    • отправляем base64 аудио + промпт                  │
  │    • получаем текст разговора                          │
  │    • сохраняем в CallTranscript в БД                   │
  └────────────────────────────────────────────────────────┘
          │
          ▼
  ┌────────────────────────────────────────────────────────┐
  │ 4. Анализ [services/aiAnalysis.ts]                     │
  │    analyzeCallWithGemini()                             │
  │    • отправляем транскрипцию + промпт                  │
  │    • получаем JSON с 10 оценками (каждый 1-10):        │
  │      Блок 1 (Идентификация): contextScore, needsScore, │
  │                               painScore, summaryScore  │
  │      Блок 2 (Презентация):   presentationScore,        │
  │                               pointBScore              │
  │      Блок 3 (Закрытие):      closingScore,             │
  │                               objectionsScore,         │
  │                               urgencyScore,            │
  │                               agreementScore           │
  │    + comment (разбор на узб.), strengths[], weaknesses[]│
  │    + clientPortrait (портрет клиента на узб.)          │
  │    • итоговый балл = сумма всех 10 оценок (макс 100)   │
  └────────────────────────────────────────────────────────┘
          │
          ▼
  Сохраняем CallAnalysis в БД (upsert)
          │
          ├──► Google Sheets: appendCallRowToSheet()
          │      Колонки A-T:
          │      A=Дата/время(UTC+5), B=UUID, C=Телефон,
          │      D=Длительность, E=Сделка(ссылка),
          │      F=Менеджер, G-P=10 оценок,
          │      Q=Комментарий, R=Сумма, S=Запись, T=Закрыта?
          │      • если UUID уже есть → обновляем строку
          │      • если нет → добавляем новую
          │
          └──► amoCRM: addNoteToDeal(dealId, clientPortrait)
                 • 2 попытки с паузой 4 сек
                 • если обе провалились → уведомляем админов
```

---

## 2. amoCRM Webhook флоу

```
amoCRM отправляет POST /webhooks/amocrm
          │
          ▼
[routes/amocrm.ts] → handleAmoCrmWebhook(body)
[services/amocrm.ts]
          │
          ├── leads.update[].status_id == 142 (Успешно)?
          │     └── pipeline_id в QUALIFYING_PIPELINE_IDS?
          │           └── markDealAsWon(dealId) → ✅ в колонку T таблицы
          │
          ├── leads.update[].status_id == 143 (Закрыто/нереализовано)?
          │     └── pipeline_id в QUALIFYING_PIPELINE_IDS?
          │           └── markDealAsLost(dealId) → ❌ в колонку T таблицы
          │
          ├── leads.update[].status_id в QUALIFYING_STAGE_IDS?
          │     └── ищем звонки в БД по dealId со статусом skipped_stage
          │           └── ставим их заново в callProcessingQueue
          │
          └── contacts.add[]?
                └── syncContactById(contactId)
                      → GET /api/v4/contacts/{id}?with=leads
                      → сохраняем в PhoneMapping + Deal + Contact в БД
```

---

## 3. Поиск сделки по телефону

```
lookupDealByPhone(phone)
  │
  ▼
normalizePhone(phone):
  • 11 цифр начинается с 8 → заменяем на 7
  • 10 цифр → добавляем 7 спереди
  • остальное → как есть
  │
  ▼
Ищем в PhoneMapping по нормализованному номеру
  │
  ├── Нашли → возвращаем { dealId, pipelineId, stageId }
  │
  └── Не нашли → lookupDealByPhoneFromAmo(phone):
        │
        ▼
        amoRateLimit() ← глобальный rate limiter 3 req/s для ВСЕХ запросов в amoCRM
        │
        ▼
        GET /api/v4/contacts?query={phone}&with=leads&limit=250
        (получаем ВСЕ контакты-дубли с частичным списком leads)
        │
        ▼
        Собираем все lead_id из _embedded.leads
        │
        ▼
        GET /api/v4/leads?filter[contact_id][]={id1}&filter[contact_id][]={id2}...
        (получаем ВСЕ сделки всех контактов)
        │
        ▼
        Выбираем лучшую сделку (самая свежая по updated_at)
        │
        ▼
        Сохраняем в БД:
          • Contact (upsert по amoCRM ID)
          • Deal (upsert по amoCRM ID)
          • PhoneMapping (upsert по phone → dealId)
        │
        ▼
        Возвращаем { dealId, pipelineId, stageId } или null
```

---

## 4. Telegram Bot команды

### Менеджер

```
/start → вводит 6-значный код → привязка TelegramLink (status=used)

/report → buildReport(today)
/week   → buildReport(last 7 days)
/month  → buildReport(current month)
/period → вводит дату начала и конца (макс 7 дней)
/errors → топ слабых мест за 30 дней по weaknesses[]

buildReport() возвращает:
  📊 Hisobot
  📞 Tahlil qilingan qo'ng'iroqlar: N
  ⏱ Jami vaqt: Xs Yd
  ⭐ O'rtacha ball: XX/100
  💪 Kuchli tomonlar: • ...
  ⚠️ O'sish sohalari: • ...

/ask [kun|hafta|oy] → AI-коуч сессия
  • строим systemPrompt из последних звонков
  • история сообщений хранится в AiTrainerSession в БД
  • каждый текстовый ответ уходит в Gemini с историей
/stop_ai → завершает сессию
```

### Админ

```
/start → сразу попадает в админ-меню (код не нужен)

/report /week /month /period /errors:
  → если нет привязки как менеджер → buildAdminReport()
     📊 Umumiy hisobot
     👥 Menejerlar: N (qo'ng'iroqlar: M)
     ⭐ O'rtacha ball: XX/100
     📈 Menejerlar reytingi: 1. Имя — XX/100 (N qo'ng'iroq)
     ⚠️ Eng zaif kriteriyalar: • ...

/sync         → syncContactsFromAmoCrm()
/sync-managers → syncManagersFromPbx() + writeManagersToSheet()
/analyze_deal <id> → ставит звонок по сделке в очередь заново
/sheet        → ссылка на Google Sheet
```

---

## 5. Крон задачи

| Время | Задача |
|---|---|
| 09:00 Asia/Almaty | `syncManagersFromPbx()` — синхронизирует менеджеров из OnlinePBX в БД |
| 09:00 Asia/Almaty | `sendDailyReports()` — отчёт за вчерашний день каждому менеджеру |
| Каждые 3 часа | `checkAndRestoreAmoCrmWebhook()` — проверяет и восстанавливает хук в amoCRM |

---

## 6. База данных (ключевые модели)

```
Manager          — менеджер (amoUserId, internalNumber, isActive)
  └── TelegramLink — привязка к Telegram (oneTimeCode, telegramUserId)
  └── Call[]       — звонки менеджера
  └── DailySummary[] — ежедневные сводки

Call             — звонок (uuid, duration, direction, processingStatus)
  └── CallAnalysis — анализ (overallScore, criteria JSON, comment,
                              strengths[], weaknesses[], clientPortrait)
  └── CallTranscript — транскрипция текста

Deal             — сделка из amoCRM (amoId, pipelineId, statusId)
Contact          — контакт из amoCRM (amoId)
PhoneMapping     — телефон → сделка (phone, dealId, contactId)

AiTrainerSession — история AI-коуч диалога (managerId, messages JSON)
BotAdmin         — Telegram ID администраторов

processingStatus значения:
  queued         — в очереди
  processing     — обрабатывается
  analyzed       — успешно проанализирован
  skipped_stage  — пропущен (сделка не в нужной стадии / контакт найден но без сделки)
  skipped_no_deal — пропущен, контакт не найден в amoCRM (уведомили админов)
  failed         — ошибка
```

---

## 7. Внешние сервисы и лимиты

| Сервис | Лимит | Где используется |
|---|---|---|
| amoCRM API | 3 req/s (глобальный rate limiter) | все запросы через `amoGet` / `amoPost` |
| Gemini API | retry до 4 раз при 429 | транскрипция + анализ + AI-коуч |
| OnlinePBX | скачивание записей за 7 дней max | `/sync_history` команда |
| BullMQ очереди | call_processing: 5 concurrent, 5 retries | основная очередь звонков |
| Google Sheets | USER_ENTERED формулы | HYPERLINK для сделок и записей |

---

## 8. Переменные окружения

```
DATABASE_URL          — PostgreSQL строка подключения
REDIS_URL             — Redis для BullMQ
TELEGRAM_BOT_TOKEN    — токен бота
GEMINI_API_KEY        — ключ Gemini API
GEMINI_AUDIO_MODEL    — модель для аудио (по умолч. gemini-2.5-flash)
GEMINI_TEXT_MODEL     — модель для анализа (по умолч. gemini-2.5-flash)
AMOCRM_DOMAIN         — домен amoCRM (qadamsales.amocrm.ru)
AMOCRM_ACCESS_TOKEN   — токен amoCRM
ONLINEPBX_DOMAIN      — домен OnlinePBX
ONLINEPBX_PBX_AUTH    — API ключ OnlinePBX
GOOGLE_PROJECT_ID     — Google Cloud проект
GOOGLE_CLIENT_EMAIL   — сервис-аккаунт email
GOOGLE_PRIVATE_KEY    — приватный ключ сервис-аккаунта
GOOGLE_SHEETS_SPREADSHEET_ID — ID таблицы
GOOGLE_SHEETS_TAB_NAME       — вкладка звонков (Sheet1)
GOOGLE_SHEETS_MANAGERS_TAB   — вкладка менеджеров
APP_BASE_URL          — публичный URL приложения (для регистрации хуков)
CRON_TIMEZONE         — часовой пояс (Asia/Almaty = UTC+5)
APP_PORT              — порт сервера (3000)
```
