const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFieldOptionBackupFile,
  buildFieldOptionBackupCaption,
  backupFileName,
  sendFieldOptionBackup,
} = require("../dist/services/fieldOptionBackup");

const NOW = new Date("2026-08-30T04:00:00.000Z"); // 09:00 Almaty

function backup(overrides = {}) {
  return {
    snapshots: [{
      fieldId: 967019,
      fieldName: "Region",
      fieldType: "select",
      originalEnums: [{ id: 1, value: "Toshkent", sort: 1 }, { id: 2, value: "Samarqand", sort: 2 }],
      capturedAt: new Date("2026-08-28T05:00:00.000Z"),
    }],
    additions: [{
      fieldId: 967019,
      fieldName: "Region",
      enumId: 3,
      value: "Andijon",
      createdAt: new Date("2026-08-29T06:30:00.000Z"),
    }],
    ...overrides,
  };
}

test("writes the original option list and what was added on top of it", () => {
  const file = buildFieldOptionBackupFile(backup(), NOW);

  assert.equal(file.includes("Снято: 30.08.2026 09:00 (Asia/Almaty)"), true);
  assert.equal(file.includes("Поле: Region (id 967019, тип select)"), true);
  assert.equal(file.includes("ИСХОДНЫЕ ВАРИАНТЫ (2):"), true);
  assert.equal(file.includes("  1\tToshkent"), true);
  assert.equal(file.includes("  2\tSamarqand"), true);
  assert.equal(file.includes("ДОБАВЛЕНО ИИ (1):"), true);
  assert.equal(file.includes("  3\tAndijon\t29.08.2026 11:30"), true);
});

test("marks a field as untouched rather than omitting its section", () => {
  const file = buildFieldOptionBackupFile(backup({ additions: [] }), NOW);

  assert.equal(file.includes("ДОБАВЛЕНО ИИ (0):"), true);
  assert.equal(file.includes("  —"), true);
});

test("says plainly when no field has ever been modified", () => {
  const file = buildFieldOptionBackupFile({ snapshots: [], additions: [] }, NOW);

  assert.equal(file.includes("Ни одно поле ещё не изменялось"), true);
  assert.equal(file.includes("Полей под наблюдением: 0"), true);
});

test("surfaces additions whose field has no stored original", () => {
  const file = buildFieldOptionBackupFile(backup({
    additions: [
      ...backup().additions,
      { fieldId: 999, fieldName: "Kurs", enumId: 7, value: "Excel", createdAt: NOW },
    ],
  }), NOW);

  // These are exactly the ones a rollback could otherwise overlook.
  assert.equal(file.includes("⚠️ ДОБАВЛЕНИЯ БЕЗ ИСХОДНОГО СНИМКА (1):"), true);
  assert.equal(file.includes("Kurs (id 999)\t7\tExcel"), true);
});

test("summarizes the backup and points at the rollback command", () => {
  const caption = buildFieldOptionBackupCaption(backup(), NOW);
  assert.equal(caption.includes("Полей: 1 · вариантов добавлено ИИ: 1"), true);
  assert.equal(caption.includes("npm run amo-options:rollback"), true);

  const quiet = buildFieldOptionBackupCaption({ snapshots: [], additions: [] }, NOW);
  assert.equal(quiet.includes("Изменений от ИИ пока нет."), true);
  assert.equal(quiet.includes("rollback"), false);
});

test("names the file by the Almaty moment so two daily backups never collide", () => {
  assert.equal(backupFileName(NOW), "amo-field-options-2026-08-30-0900.txt");
  assert.equal(
    backupFileName(new Date("2026-08-30T16:00:00.000Z")),
    "amo-field-options-2026-08-30-2100.txt",
  );
});

test("sends one document carrying the caption, the file and its name", async () => {
  const sent = [];
  const result = await sendFieldOptionBackup({
    loadBackup: async () => backup(),
    sendFile: async (caption, content, filename) => { sent.push({ caption, content, filename }); },
    now: () => NOW,
  });

  assert.deepEqual(result, { sent: true, fields: 1, additions: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].filename, "amo-field-options-2026-08-30-0900.txt");
  assert.equal(sent[0].content.includes("ИСХОДНЫЕ ВАРИАНТЫ (2):"), true);
});
