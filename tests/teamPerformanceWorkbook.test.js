const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const { aggregateTeamPerformance, formatTeamPerformance } = require("../dist/services/performanceReport");
const {
  buildTeamPerformanceWorkbook,
  teamMemberRows,
  teamTotalsRow,
  teamWorkbookCaption,
  teamWorkbookFilename,
  TEAM_SHEET_COLUMNS,
} = require("../dist/services/teamPerformanceWorkbook");
const { buildTeamReportFile, deliverTeamPerformance } = require("../dist/services/teamPerformanceDelivery");

const calls = (over = {}) => ({ total: 40, connected: 25, missed: 15, talkSeconds: 7200, analyzed: 4, avgScore: 72, possiblyTruncated: false, ...over });
const revenue = (over = {}) => ({ wonCount: 2, wonAmount: 12500000, partialCount: 1, partialAmount: 1800000, unknownAmountCount: 0, ...over });

function team() {
  return aggregateTeamPerformance("Kompaniya", "Kecha (26.09)", [
    { managerName: "Past", calls: calls(), revenue: revenue({ wonAmount: 1000000 }), plan: null },
    { managerName: "Yuqori", calls: calls({ total: 10, connected: 4, missed: 6 }), revenue: revenue({ wonAmount: 9000000 }), plan: { target: 10000000, achieved: 9000000 } },
    { managerName: "Noma'lum", calls: { ...calls(), volumeUnavailable: true }, revenue: revenue({ wonAmount: 0 }), plan: null },
  ], ["<b>Феникс (стажёр):</b> 3 сделок"]);
}

test("rows follow the report order, strongest revenue first, with plan only where one is set", () => {
  const rows = teamMemberRows(team());
  assert.deepEqual(rows.map((row) => [row.rank, row.manager]), [[1, "Yuqori"], [2, "Past"], [3, "Noma'lum"]]);
  assert.equal(rows[0].planPercent, 90);
  assert.equal(rows[0].planTarget, 10000000);
  assert.equal(rows[1].planTarget, null);
  assert.equal(rows[0].talkMinutes, 120);
});

test("an unread PBX leaves the volume cells empty instead of writing zeros", () => {
  const row = teamMemberRows(team())[2];
  assert.equal(row.calls, null);
  assert.equal(row.connected, null);
  assert.equal(row.talkMinutes, null);
  // Analysis comes from our database and stays.
  assert.equal(row.analyzed, 4);
  assert.equal(row.avgScore, 72);
});

test("the totals row carries the same company numbers as the message", () => {
  const totals = teamTotalsRow(team());
  assert.equal(totals.manager, "Jami");
  assert.equal(totals.wonAmount, 10000000);
  assert.equal(totals.wonCount, 6);
  // One member had no readable volume, so the company volume is unknown too.
  assert.equal(totals.calls, null);
});

test("the workbook opens with a title, a header row, one row per manager and a bold totals row", async () => {
  const buffer = await buildTeamPerformanceWorkbook(team());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Menejerlar");
  assert.ok(sheet, "sheet exists");
  assert.equal(sheet.getCell("A1").value, "Kompaniya — Kecha (26.09)");
  assert.deepEqual(sheet.getRow(2).values.slice(1), TEAM_SHEET_COLUMNS.map((column) => column.header));
  assert.equal(sheet.getCell("B3").value, "Yuqori");
  assert.equal(sheet.getCell("J3").value, 9000000);
  assert.equal(sheet.getCell("O3").value, 90);
  assert.equal(sheet.getCell("C5").value, null, "unknown volume stays blank");
  assert.equal(sheet.getCell("B6").value, "Jami");
  assert.equal(sheet.getRow(6).font.bold, true);
  assert.equal(sheet.getColumn("J").numFmt, "#,##0");
});

test("file name and caption name the period; path characters never reach the name", () => {
  const named = { ...team(), title: "Jamoa: A/B?", periodLabel: "Kecha (26.09)" };
  assert.equal(teamWorkbookFilename(named), "Menejerlar - Jamoa A B - Kecha (26.09).xlsx");
  assert.equal(teamWorkbookCaption(named), "Menejerlar — Kecha (26.09): 3 ta");
});

test("with the table in a file the message keeps the company block and drops the manager lines", () => {
  const text = formatTeamPerformance(team(), { membersInFile: true });
  assert.equal(text.includes("Menejerlar"), false);
  assert.equal(text.includes("Yuqori"), false);
  assert.equal(text.includes("<b>Феникс (стажёр):</b> 3 сделок"), true);
  assert.equal(formatTeamPerformance(team()).includes("<b>Menejerlar:</b>"), true);
});

test("delivery sends the message first and the Excel file second", async () => {
  const sent = [];
  const result = await deliverTeamPerformance({
    team: team(),
    sendText: async (text) => { sent.push(["text", text]); },
    sendFile: async (file) => { sent.push(["file", file]); },
    logPrefix: "[test]",
  });
  assert.equal(result.membersInFile, true);
  assert.deepEqual(sent.map(([kind]) => kind), ["text", "file"]);
  assert.equal(sent[0][1].includes("Menejerlar"), false);
  const file = sent[1][1];
  assert.equal(file.filename, "Menejerlar - Kompaniya - Kecha (26.09).xlsx");
  assert.equal(file.contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(file.buffer.subarray(0, 2).toString(), "PK", "a real zip container");
});

test("delivery falls back to inline managers when the workbook cannot be built, or no file channel exists", async () => {
  const sent = [];
  const failed = await deliverTeamPerformance({
    team: team(),
    sendText: async (text) => { sent.push(text); },
    sendFile: async () => { throw new Error("must not be called"); },
    buildWorkbook: async () => { throw new Error("xlsx broke"); },
    logPrefix: "[test]",
  });
  assert.equal(failed.membersInFile, false);
  assert.equal(sent[0].includes("<b>Menejerlar:</b>"), true);

  const textOnly = await deliverTeamPerformance({ team: team(), sendText: async (text) => { sent.push(text); }, logPrefix: "[test]" });
  assert.equal(textOnly.membersInFile, false);
  assert.equal(sent[1].includes("Yuqori"), true);
});

test("an empty team sends no file at all", async () => {
  let files = 0;
  const result = await deliverTeamPerformance({
    team: aggregateTeamPerformance("Jamoa", "Kecha", []),
    sendText: async () => {},
    sendFile: async () => { files += 1; },
    logPrefix: "[test]",
  });
  assert.equal(result.membersInFile, false);
  assert.equal(files, 0);
});

test("the file step alone yields a named xlsx for a team and nothing for an empty one or a broken builder", async () => {
  const file = await buildTeamReportFile(team(), "[test]");
  assert.equal(file.filename, "Menejerlar - Kompaniya - Kecha (26.09).xlsx");
  assert.equal(file.buffer.subarray(0, 2).toString(), "PK");
  assert.equal(await buildTeamReportFile(aggregateTeamPerformance("Jamoa", "Kecha", []), "[test]"), null);
  assert.equal(await buildTeamReportFile(team(), "[test]", async () => { throw new Error("xlsx broke"); }), null);
});
