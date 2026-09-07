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
import { notifyAdmins, notifyAdminsWithFile } from "./bot/notify";
import { sendFieldOptionBackup } from "./services/fieldOptionBackup";
import { sendAdminDailyReport } from "./workers/adminDailyReport";
import { runStartupChecks } from "./startup";
import { createConfiguredLeadInactivityWebhookRouter } from "./services/leadInactivityWebhookRuntime";
import { initializeConfiguredLeadInactivityActivation } from "./services/leadInactivityActivationRuntime";
import { subscribeConfiguredLeadInactivityEvents } from "./services/leadInactivitySubscriptionRuntime";
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
  console.log(
    leadInactivityWorker.testingMode
      ? "[LeadInactivityWorker] protected one-minute testing worker enabled"
      : "[LeadInactivityWorker] unrestricted one-minute production worker enabled",
  );
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

// Ежедневный отчёт всем администраторам в 09:00 (Asia/Almaty).
// Это единственный регулярный отчёт для админов, кроме основного оператора,
// поэтому он самодостаточен: звонки, поступления, план и переводы в Феникс.
cron.schedule(
  "0 9 * * *",
  async () => {
    console.log("[Cron] Sending admin daily report...");
    try {
      const result = await sendAdminDailyReport({
        send: (text) => notifyAdmins(text, "all"),
      });
      console.log("[Cron] Admin daily report sent:", result);
    } catch (err: any) {
      console.error("[Cron] Admin daily report failed:", err.message);
    }
  },
  { timezone: tz }
);

// Бэкап списков вариантов полей amoCRM — утром и вечером.
// Отправляется файлом, чтобы длинный список не обрезался лимитом Telegram.
for (const backupHour of [9, 21]) {
  cron.schedule(
    `0 ${backupHour} * * *`,
    async () => {
      console.log(`[Cron] Sending amoCRM field option backup (${backupHour}:00)...`);
      try {
        const result = await sendFieldOptionBackup({ sendFile: notifyAdminsWithFile });
        console.log("[Cron] Field option backup sent:", result);
      } catch (err: any) {
        console.error("[Cron] Field option backup failed:", err.message);
      }
    },
    { timezone: tz }
  );
}

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

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
    server.once("error", reject);
  });

  console.log(`Server listening on port ${port}`);
  console.log(`Cron timezone: ${tz}`);

  if (await subscribeConfiguredLeadInactivityEvents()) {
    console.log("[LeadInactivitySubscription] dedicated amoCRM event subscription created");
  }

  void runStartupChecks({
    applyPilotDisciplineManagerConfig,
    checkAndRestoreAmoCrmWebhook,
    notifyAdmins,
  });
}

void startServer().catch((error: unknown) => {
  console.error("[LeadInactivityActivation] startup initialization failed:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
