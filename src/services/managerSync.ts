import "dotenv/config";
import axios from "axios";
import { prisma } from "../config/database";
import { writeManagersToSheet } from "./googleSheets";
import {
  getPilotManagerConfig,
  PILOT_MANAGER_AMO_IDS,
} from "../config/disciplinePilot";

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

interface PbxUserMapping {
  uid: string;      // внутренний номер АТС: "101", "102", ...
  name: string;     // имя в PBX (может быть пустым)
  amo_id: string;   // ID пользователя в amoCRM
  amo_name: string; // имя пользователя в amoCRM
}

export interface ManagerSyncResult {
  created: number;
  updated: number;
  deactivated: number;
  reactivated: number;
  total: number;
  sheetUpdated: boolean;
  sheetError?: string;
}

export async function applyPilotDisciplineManagerConfig(): Promise<void> {
  await prisma.manager.updateMany({
    where: { isDisciplinePilot: true, amoUserId: { notIn: PILOT_MANAGER_AMO_IDS } },
    data: { isDisciplinePilot: false, amoRoleId: null },
  });

  for (const amoUserId of PILOT_MANAGER_AMO_IDS) {
    const pilot = getPilotManagerConfig(amoUserId);
    if (!pilot) continue;

    await prisma.manager.updateMany({
      where: { amoUserId },
      data: {
        isDisciplinePilot: true,
        amoRoleId: pilot.amoRoleId,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Получить маппинг пользователей из OnlinePBX
// ---------------------------------------------------------------------------

async function fetchPbxUsersMapping(): Promise<PbxUserMapping[]> {
  const domain = process.env.ONLINEPBX_DOMAIN;
  const auth = process.env.ONLINEPBX_PBX_AUTH;

  if (!domain || !auth) {
    throw new Error("ONLINEPBX_DOMAIN or ONLINEPBX_PBX_AUTH not configured in .env");
  }

  const r = await axios.post(
    `https://api2.onlinepbx.ru/${domain}/amocrm/get.json`,
    {},
    {
      headers: {
        "x-pbx-authentication": auth,
        accept: "application/json",
      },
      timeout: 15_000,
    }
  );

  const data = r.data;
  if (data.status !== "1" || !Array.isArray(data.data?.usersMapping)) {
    throw new Error(`OnlinePBX API error: ${JSON.stringify(data)}`);
  }

  // Фильтруем: uid и amo_id обязательны
  return (data.data.usersMapping as any[]).filter(
    (u) => u.uid && u.amo_id && u.amo_name
  );
}

// ---------------------------------------------------------------------------
// Генерация уникального 6-значного кода
// ---------------------------------------------------------------------------

async function generateUniqueCode(): Promise<string> {
  while (true) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const exists = await prisma.telegramLink.findUnique({
      where: { oneTimeCode: code },
    });
    if (!exists) return code;
  }
}

// ---------------------------------------------------------------------------
// Основная функция синхронизации
// ---------------------------------------------------------------------------

export async function syncManagersFromPbx(): Promise<ManagerSyncResult> {
  console.log("[ManagerSync] Starting sync from OnlinePBX...");

  const mapping = await fetchPbxUsersMapping();
  console.log(`[ManagerSync] Got ${mapping.length} users from PBX`);

  const pbxAmoIds = new Set(mapping.map((u) => parseInt(u.amo_id)));
  let created = 0, updated = 0, deactivated = 0, reactivated = 0;

  // --- Шаг 1: Обрабатываем каждого пользователя из PBX ---
  for (const user of mapping) {
    const amoUserId = parseInt(user.amo_id);
    const pilot = getPilotManagerConfig(amoUserId);

    const existing = await prisma.manager.findUnique({
      where: { amoUserId },
      include: {
        telegramLinks: {
          // Берём все активные ссылки (issued и used)
          where: { status: { in: ["issued", "used"] } },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (existing) {
      const wasInactive = !existing.isActive;

      await prisma.manager.update({
        where: { id: existing.id },
        data: {
          name: user.amo_name,
          internalNumber: user.uid,
          isActive: true,
          deactivatedAt: null,
          isDisciplinePilot: !!pilot,
          amoRoleId: pilot?.amoRoleId ?? null,
        },
      });

      const hasUsedLink = existing.telegramLinks.some((l) => l.status === "used");
      const hasIssuedLink = existing.telegramLinks.some((l) => l.status === "issued");

      if (wasInactive) {
        // Вернули — сбрасываем старые привязки и генерируем новый код
        await prisma.telegramLink.updateMany({
          where: { managerId: existing.id, status: { in: ["issued", "used"] } },
          data: { status: "expired" },
        });
        await prisma.telegramLink.create({
          data: {
            managerId: existing.id,
            oneTimeCode: await generateUniqueCode(),
            status: "issued",
          },
        });
        reactivated++;
        console.log(`[ManagerSync] Reactivated: ${user.amo_name} (uid=${user.uid})`);
      } else if (!hasUsedLink && !hasIssuedLink) {
        // Нет ни активации, ни ожидающего кода — создаём код
        await prisma.telegramLink.create({
          data: {
            managerId: existing.id,
            oneTimeCode: await generateUniqueCode(),
            status: "issued",
          },
        });
      }

      updated++;
    } else {
      // Новый менеджер
      const newManager = await prisma.manager.create({
        data: {
          name: user.amo_name,
          amoUserId,
          internalNumber: user.uid,
          isActive: true,
          isDisciplinePilot: !!pilot,
          amoRoleId: pilot?.amoRoleId ?? null,
        },
      });

      await prisma.telegramLink.create({
        data: {
          managerId: newManager.id,
          oneTimeCode: await generateUniqueCode(),
          status: "issued",
        },
      });

      created++;
      console.log(`[ManagerSync] Created: ${user.amo_name} (uid=${user.uid})`);
    }
  }

  // --- Шаг 2: Деактивируем тех кого нет в PBX ---
  const activeManagers = await prisma.manager.findMany({
    where: { isActive: true, amoUserId: { not: null } },
  });

  for (const manager of activeManagers) {
    if (manager.amoUserId && !pbxAmoIds.has(manager.amoUserId)) {
      await prisma.manager.update({
        where: { id: manager.id },
        data: { isActive: false, deactivatedAt: new Date() },
      });

      // Устаревшие коды — помечаем expired
      await prisma.telegramLink.updateMany({
        where: { managerId: manager.id, status: "issued" },
        data: { status: "expired" },
      });

      deactivated++;
      console.log(
        `[ManagerSync] Deactivated: ${manager.name} (amoId=${manager.amoUserId})`
      );
    }
  }

  await applyPilotDisciplineManagerConfig();

  // --- Шаг 3: Обновляем Google Sheet ---
  let sheetUpdated = false;
  let sheetError: string | undefined;
  try {
    await writeManagersToSheet();
    sheetUpdated = true;
    console.log("[ManagerSync] Google Sheet updated");
  } catch (err: any) {
    sheetError = err.message;
    console.error("[ManagerSync] Failed to update Google Sheet:", err.message);
  }

  const result = { created, updated, deactivated, reactivated, total: mapping.length, sheetUpdated, sheetError };
  console.log("[ManagerSync] Done:", result);
  return result;
}

// ---------------------------------------------------------------------------
// Сброс кода для менеджера (для команды /reset_code в боте)
// ---------------------------------------------------------------------------

export async function resetManagerCode(
  amoUserId: number
): Promise<{ code: string; managerName: string } | null> {
  const manager = await prisma.manager.findUnique({ where: { amoUserId } });
  if (!manager) return null;

  // Помечаем все старые ссылки как expired
  await prisma.telegramLink.updateMany({
    where: { managerId: manager.id, status: { in: ["issued", "used"] } },
    data: { status: "expired" },
  });

  const code = await generateUniqueCode();
  await prisma.telegramLink.create({
    data: { managerId: manager.id, oneTimeCode: code, status: "issued" },
  });

  try {
    await writeManagersToSheet();
  } catch {}

  return { code, managerName: manager.name };
}
