import { Router } from "express";
import {
  createProtectedLeadInactivityWebhookHandler,
  type CreateProtectedLeadInactivityWebhookHandlerOptions,
} from "../services/leadInactivityWebhook";

export function createLeadInactivityWebhookRouter(
  options: CreateProtectedLeadInactivityWebhookHandlerOptions,
): Router {
  const router = Router();
  const handler = createProtectedLeadInactivityWebhookHandler(options);

  router.post("/webhooks/amocrm/inactivity/:secret", (request, response) => {
    void handler(request, response);
  });

  return router;
}
