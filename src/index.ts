import "dotenv/config";
import express from "express";
import cron from "node-cron";
import onlinepbxRouter from "./routes/onlinepbx";
import amocrmRouter from "./routes/amocrm";
import { syncContactsFromAmoCrm, checkAndRestoreAmoCrmWebhook } from "./services/amocrm";
import { applyPilotDisciplineManagerConfig, syncManagersFromPbx } from "./services/managerSync";
import { sendDailyReports } from "./workers/dailyReport";
import "./workers/callProcessor";
import { bot } from "./bot/index"; // запускает бот в режиме polling
import { runDisciplineCheck } from "./services/disciplineCheck";
import { notifyAdmins } from "./bot/notify";
import { runStartupChecks } from "./startup";
import { createConfiguredLeadInactivityWebhookRouter } from "./services/leadInactivityWebhookRuntime";
import { initializeConfiguredLeadInactivityActivation } from "./services/leadInactivityActivationRuntime";
import { startConfiguredLeadInactivityWorker } from "./services/leadInactivityWorkerRuntime";
void bot; // используется через polling

const app = express();

// extended:true нужен для парсинга вложенных ключей от amoCRM:
// contacts[update][0][id]=123
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const port = process.env.APP_PORT || 3000;
const tz = process.env.CRON_TIMEZONE || "Asia/Almaty";

// ---------------------------------------------------------------------------
// HTTP Routes
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

app.use(onlinepbxRouter);
app.use(amocrmRouter);
const leadInactivityWebhookRouter = createConfiguredLeadInactivityWebhookRouter();
if (leadInactivityWebhookRouter) {
  app.use(leadInactivityWebhookRouter);
  console.log("[LeadInactivityWebhook] isolated endpoint enabled");
}
const leadInactivityWorker = startConfiguredLeadInactivityWorker();
if (leadInactivityWorker) {
  console.log("[LeadInactivityWorker] protected one-minute testing worker enabled");
}

/**
 * POST /admin/sync-amocrm
 * Первоначальная синхронизация контактов из amoCRM в PhoneMapping.
 * Body: { "from": "2026-02-01" }
 */
app.post("/admin/sync-amocrm", async (req, res) => {
  const fromStr = req.body?.from ?? req.query?.from ?? "2026-02-01";
  const fromDate = new Date(String(fromStr));

  if (isNaN(fromDate.getTime())) {
    return res.status(400).json({ error: "Invalid 'from' date" });
  }

  res.status(202).json({ message: "Sync started", from: fromDate.toISOString() });

  syncContactsFromAmoCrm(fromDate)
    .then((r) => console.log("[AdminSync] amoCRM contacts done:", r))
    .catch((e) => console.error("[AdminSync] amoCRM contacts failed:", e));
});

/**
 * POST /admin/sync-managers
 * Ручной запуск синхронизации менеджеров из OnlinePBX.
 */
app.post("/admin/sync-managers", async (_req, res) => {
  res.status(202).json({ message: "Manager sync started" });

  syncManagersFromPbx()
    .then((r) => console.log("[AdminSync] Managers done:", r))
    .catch((e) => console.error("[AdminSync] Managers failed:", e));
});

// ---------------------------------------------------------------------------
// CRON задачи
// ---------------------------------------------------------------------------

// Синхронизация менеджеров каждый день в 09:00 (Asia/Almaty)
cron.schedule(
  "0 9 * * *",
  async () => {
    console.log("[Cron] Running daily manager sync...");
    try {
      const r = await syncManagersFromPbx();
      console.log("[Cron] Manager sync done:", r);
    } catch (err: any) {
      console.error("[Cron] Manager sync failed:", err.message);
    }
  },
  { timezone: tz }
);

// Ежедневные отчёты менеджерам в 09:00 (Asia/Almaty) — за вчерашний день
cron.schedule(
  "0 9 * * *",
  async () => {
    console.log("[Cron] Sending daily reports...");
    try {
      const result = await sendDailyReports(async (chatId, text) => {
        await bot.sendMessage(chatId, text);
      });
      console.log("[Cron] Daily reports done:", result);
    } catch (err: any) {
      console.error("[Cron] Daily reports failed:", err.message);
    }
  },
  { timezone: tz }
);

// Дисциплина: проверка AI-сессии менеджеров в рабочие дни
const coachDeadlineHour = parseInt(process.env.COACH_DEADLINE_HOUR ?? "11");
cron.schedule(
  `0 ${coachDeadlineHour} * * 1-5`,
  async () => {
    console.log("[Cron] Running discipline check...");
    try {
      const r = await runDisciplineCheck(async (chatId, text) => {
        await bot.sendMessage(chatId, text);
      });
      console.log("[Cron] Discipline check done:", r);
    } catch (err: any) {
      console.error("[Cron] Discipline check failed:", err.message);
    }
  },
  { timezone: tz }
);

// Проверка amoCRM webhook каждые 3 часа
cron.schedule(
  "0 */3 * * *",
  async () => {
    console.log("[Cron] Checking amoCRM webhook...");
    try {
      await checkAndRestoreAmoCrmWebhook(notifyAdmins);
    } catch (err: any) {
      console.error("[Cron] amoCRM webhook check failed:", err.message);
    }
  },
  { timezone: tz }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function startServer(): Promise<void> {
  const activationBoundary = await initializeConfiguredLeadInactivityActivation();
  if (activationBoundary) {
    console.log(`[LeadInactivityActivation] durable boundary initialized: ${activationBoundary.toISOString()}`);
  }

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    console.log(`Cron timezone: ${tz}`);

    void runStartupChecks({
      applyPilotDisciplineManagerConfig,
      checkAndRestoreAmoCrmWebhook,
      notifyAdmins,
    });
  });
}

void startServer().catch((error: unknown) => {
  console.error("[LeadInactivityActivation] startup initialization failed:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
