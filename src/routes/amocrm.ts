import { Router } from "express";
import { handleAmoCrmWebhook } from "../services/amocrm";

const router = Router();

/**
 * POST /webhooks/amocrm
 * Принимает вебхуки от amoCRM о создании/обновлении контактов и сделок.
 * Тело приходит как application/x-www-form-urlencoded с вложенными ключами:
 *   contacts[update][0][id]=123&leads[update][0][id]=456
 * Express с extended:true автоматически разбирает вложенную структуру.
 */
router.post("/webhooks/amocrm", async (req, res) => {
  res.status(200).json({ ok: true });
  handleAmoCrmWebhook(req.body)
    .catch((err) => console.error("[AmoWebhook] Handler error:", err));
});

export default router;
