# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (hot reload)
npm run dev

# Build (generates Prisma client + compiles TypeScript)
npm run build

# Production start (runs migrations, then starts app)
npm start

# Database migrations
npm run prisma:migrate   # create new migration
npm run prisma:generate  # regenerate Prisma client types
```

Local infrastructure (PostgreSQL 15 + Redis 7) is managed via `docker-compose.yml`.

## Architecture

This is an AI-powered call quality control system that processes sales calls, analyzes them with Gemini AI, and coaches managers via Telegram.

### Data Flow

1. **OnlinePBX webhook** (`/webhooks/onlinepbx/call-end`) receives call-end events for calls >8 minutes
2. Call is queued in BullMQ → **`callProcessor` worker** runs the pipeline:
   - Downloads MP3 recording (extracts from TAR if needed via `pbxHistory.ts`)
   - Transcribes + analyzes via **Google Gemini** (`aiAnalysis.ts`)
   - Looks up matching deal in **amoCRM** (`amocrm.ts`)
   - Writes results to **Google Sheets** (`googleSheets.ts`)
   - Adds analysis note to the amoCRM deal
3. **Cron jobs**: manager sync at 09:00, daily reports at 21:00
4. **Telegram bot** (polling) handles manager coaching sessions with conversation history

### Key Services

| Service | File | Role |
|---|---|---|
| AI Analysis | `src/services/aiAnalysis.ts` | Gemini 2.5 Flash transcription + analysis with circuit breaker |
| amoCRM | `src/services/amocrm.ts` | Syncs contacts/deals/managers, phone-based deal lookup |
| PBX History | `src/services/pbxHistory.ts` | Downloads recordings, extracts MP3 from TAR archives |
| Manager Sync | `src/services/managerSync.ts` | OnlinePBX ↔ DB manager sync with activation state |
| Google Sheets | `src/services/googleSheets.ts` | Exports call data and manager metrics |

### Queues (BullMQ + Redis)

- `call_processing`: 5 concurrent, 5 retries with exponential backoff
- `history_sync`: 1 concurrent (rate-limited)
- `daily_reports`: 2 concurrent
- `telegram_notifications`: 5 concurrent
- `ai_coach`: 2 concurrent

Queue config is in `src/config/queue.ts`.

### Telegram Bot

Polling-based bot (`src/bot/index.ts`) with commands:
- `/sync` — trigger amoCRM sync
- `/sync-managers` — sync manager list from PBX
- `/coach` — start AI coaching session (maintains conversation history in DB)
- `/sheet` — link to Google Sheet
- `/period-report` — generate custom period report

Manager linking uses one-time codes stored in `TelegramLink` table.

### Database (Prisma + PostgreSQL)

Schema in `prisma/schema.prisma`. Key models: `Manager`, `Call`, `CallAnalysis`, `Deal`, `Contact`, `TelegramLink`, `DailySummary`, `AiTrainerSession`.

Prisma 7 config uses `prisma.config.ts` (not inline in schema) with the pg adapter (`src/config/database.ts`).

### Environment Variables

All secrets in `.env`: `DATABASE_URL`, `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `AMOCRM_*`, `ONLINEPBX_*`, `GOOGLE_SHEETS_*`.
