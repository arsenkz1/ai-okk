import { prisma } from "../config/database";
import { createAmoFieldOptionRegistry, type FieldOptionSnapshot } from "./amoFieldOptionRegistry";

/**
 * Twice-daily backup of amoCRM option lists for administrators.
 *
 * The point is to keep the original lists somewhere outside this database: if
 * the field is ever mangled, the file in the admin's chat is enough to rebuild
 * it by hand. It is sent as a document rather than a message so a long list is
 * never truncated by Telegram's message limit.
 */

export interface FieldOptionAdditionRow {
  fieldId: number;
  fieldName: string;
  enumId: number;
  value: string;
  createdAt: Date;
}

export interface FieldOptionBackup {
  snapshots: FieldOptionSnapshot[];
  additions: FieldOptionAdditionRow[];
}

function formatAlmaty(value: Date): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const field = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${field.day}.${field.month}.${field.year} ${field.hour}:${field.minute}`;
}

/** File name carries the moment, so consecutive backups never overwrite each other in a chat. */
export function backupFileName(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const field = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `amo-field-options-${field.year}-${field.month}-${field.day}-${field.hour}${field.minute}.txt`;
}

/**
 * Renders the full backup: every field's original option list, then every
 * option this system added on top of it.
 */
export function buildFieldOptionBackupFile(backup: FieldOptionBackup, now: Date): string {
  const lines = [
    "Бэкап списков вариантов полей amoCRM",
    `Снято: ${formatAlmaty(now)} (Asia/Almaty)`,
    `Полей под наблюдением: ${backup.snapshots.length}`,
    `Вариантов добавлено ИИ: ${backup.additions.length}`,
    "",
  ];

  if (backup.snapshots.length === 0) {
    lines.push("Ни одно поле ещё не изменялось — исходные списки не сохранялись.");
    return lines.join("\n");
  }

  const additionsByField = new Map<number, FieldOptionAdditionRow[]>();
  for (const addition of backup.additions) {
    additionsByField.set(addition.fieldId, [...(additionsByField.get(addition.fieldId) ?? []), addition]);
  }

  for (const snapshot of backup.snapshots) {
    lines.push(
      "=".repeat(60),
      `Поле: ${snapshot.fieldName} (id ${snapshot.fieldId}, тип ${snapshot.fieldType})`,
      `Исходный список сохранён: ${formatAlmaty(snapshot.capturedAt)}`,
      "",
      `ИСХОДНЫЕ ВАРИАНТЫ (${snapshot.originalEnums.length}):`,
    );
    for (const option of snapshot.originalEnums) {
      lines.push(`  ${option.id}\t${option.value}`);
    }

    const added = additionsByField.get(snapshot.fieldId) ?? [];
    lines.push("", `ДОБАВЛЕНО ИИ (${added.length}):`);
    if (added.length === 0) lines.push("  —");
    for (const addition of added) {
      lines.push(`  ${addition.enumId}\t${addition.value}\t${formatAlmaty(addition.createdAt)}`);
    }
    lines.push("");
  }

  // Additions whose field somehow has no snapshot must still be visible: they
  // are precisely the ones a rollback would otherwise miss.
  const orphaned = backup.additions.filter(
    (addition) => !backup.snapshots.some((snapshot) => snapshot.fieldId === addition.fieldId),
  );
  if (orphaned.length > 0) {
    lines.push("=".repeat(60), `⚠️ ДОБАВЛЕНИЯ БЕЗ ИСХОДНОГО СНИМКА (${orphaned.length}):`);
    for (const addition of orphaned) {
      lines.push(`  ${addition.fieldName} (id ${addition.fieldId})\t${addition.enumId}\t${addition.value}`);
    }
  }

  return lines.join("\n");
}

export function buildFieldOptionBackupCaption(backup: FieldOptionBackup, now: Date): string {
  return [
    "🗂 Бэкап списков вариантов amoCRM",
    `Снято: ${formatAlmaty(now)}`,
    `Полей: ${backup.snapshots.length} · вариантов добавлено ИИ: ${backup.additions.length}`,
    backup.additions.length > 0
      ? "Откат добавленных вариантов: npm run amo-options:rollback"
      : "Изменений от ИИ пока нет.",
  ].join("\n");
}

export async function loadFieldOptionBackup(): Promise<FieldOptionBackup> {
  const registry = createAmoFieldOptionRegistry();
  const stored = await prisma.amoFieldOptionSnapshot.findMany({ orderBy: { fieldId: "asc" } });
  const snapshots: FieldOptionSnapshot[] = [];
  for (const row of stored) {
    const snapshot = await registry.getSnapshot(row.fieldId);
    if (snapshot) snapshots.push(snapshot);
  }
  return { snapshots, additions: await registry.listActiveAdditions() };
}

export interface SendFieldOptionBackupDependencies {
  loadBackup?: () => Promise<FieldOptionBackup>;
  sendFile: (caption: string, content: string, filename: string) => Promise<void>;
  now?: () => Date;
}

export async function sendFieldOptionBackup(
  dependencies: SendFieldOptionBackupDependencies,
): Promise<{ sent: boolean; fields: number; additions: number }> {
  const now = dependencies.now?.() ?? new Date();
  const backup = await (dependencies.loadBackup ?? loadFieldOptionBackup)();
  await dependencies.sendFile(
    buildFieldOptionBackupCaption(backup, now),
    buildFieldOptionBackupFile(backup, now),
    backupFileName(now),
  );
  return { sent: true, fields: backup.snapshots.length, additions: backup.additions.length };
}
