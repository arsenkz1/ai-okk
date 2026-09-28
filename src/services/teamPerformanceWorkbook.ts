import ExcelJS from "exceljs";
import { orderTeamMembers, planPercent, type ManagerPerformance, type TeamPerformance } from "./performanceReport";

/**
 * The per-manager part of the team report as an Excel sheet.
 *
 * A dozen managers times ten numbers does not read as Telegram text: the
 * lines wrap and nothing lines up. The company block stays in the message;
 * the manager table arrives right after it as a file that opens in a
 * spreadsheet, sorts and filters.
 */

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface TeamMemberRow {
  rank: number;
  manager: string;
  /** null when the PBX volume could not be read; never a fake 0. */
  calls: number | null;
  connected: number | null;
  missed: number | null;
  talkMinutes: number | null;
  analyzed: number;
  avgScore: number | null;
  wonCount: number;
  wonAmount: number;
  partialCount: number;
  partialAmount: number;
  planTarget: number | null;
  planAchieved: number | null;
  planPercent: number | null;
}

export const TEAM_SHEET_COLUMNS: ReadonlyArray<{ key: keyof TeamMemberRow; header: string; width: number; money?: boolean }> = [
  { key: "rank", header: "№", width: 5 },
  { key: "manager", header: "Menejer", width: 28 },
  { key: "calls", header: "Qo'ng'iroqlar", width: 14 },
  { key: "connected", header: "Dozvon", width: 10 },
  { key: "missed", header: "Nedozvon", width: 10 },
  { key: "talkMinutes", header: "Suhbat (daqiqa)", width: 15 },
  { key: "analyzed", header: "Tahlil", width: 8 },
  { key: "avgScore", header: "O'rtacha ball", width: 13 },
  { key: "wonCount", header: "Muvaffaqiyatli (ta)", width: 18 },
  { key: "wonAmount", header: "Muvaffaqiyatli (summa)", width: 22, money: true },
  { key: "partialCount", header: "Qisman to'langan (ta)", width: 20 },
  { key: "partialAmount", header: "Qisman to'langan (summa)", width: 24, money: true },
  { key: "planTarget", header: "Oylik reja", width: 16, money: true },
  { key: "planAchieved", header: "Bajarildi", width: 16, money: true },
  { key: "planPercent", header: "Reja %", width: 8 },
];

function rowFor(rank: number, name: string, member: Pick<ManagerPerformance, "calls" | "revenue" | "plan">): TeamMemberRow {
  const volume = !member.calls.volumeUnavailable;
  const hasPlan = member.plan !== null && member.plan.target > 0;
  return {
    rank,
    manager: name,
    calls: volume ? member.calls.total : null,
    connected: volume ? member.calls.connected : null,
    missed: volume ? member.calls.missed : null,
    talkMinutes: volume ? Math.round(member.calls.talkSeconds / 60) : null,
    analyzed: member.calls.analyzed,
    avgScore: member.calls.avgScore,
    wonCount: member.revenue.wonCount,
    wonAmount: Math.round(member.revenue.wonAmount),
    partialCount: member.revenue.partialCount,
    partialAmount: Math.round(member.revenue.partialAmount),
    planTarget: hasPlan ? member.plan!.target : null,
    planAchieved: hasPlan ? Math.round(member.plan!.achieved) : null,
    planPercent: planPercent(member.plan),
  };
}

/** One row per manager, in the same order the text report used. */
export function teamMemberRows(team: TeamPerformance): TeamMemberRow[] {
  return orderTeamMembers(team.members).map((member, index) => rowFor(index + 1, member.managerName, member));
}

/** The company line at the bottom; same aggregates as the message above the file. */
export function teamTotalsRow(team: TeamPerformance): TeamMemberRow {
  return rowFor(0, "Jami", team);
}

export async function buildTeamPerformanceWorkbook(team: TeamPerformance): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AI OKK";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Menejerlar", { views: [{ state: "frozen", ySplit: 2 }] });

  sheet.columns = TEAM_SHEET_COLUMNS.map(({ key, header, width }) => ({ key, header, width }));
  // Row 1 is the title; the header row is inserted below it so the frozen
  // pane keeps both visible.
  sheet.spliceRows(1, 0, [`${team.title} — ${team.periodLabel}`]);
  sheet.mergeCells(1, 1, 1, TEAM_SHEET_COLUMNS.length);
  sheet.getRow(1).font = { bold: true, size: 13 };
  sheet.getRow(2).font = { bold: true };
  sheet.getRow(2).alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(2).height = 30;

  for (const row of teamMemberRows(team)) sheet.addRow(row);
  const totals = sheet.addRow({ ...teamTotalsRow(team), rank: null });
  totals.font = { bold: true };

  for (const column of TEAM_SHEET_COLUMNS) {
    if (column.money) sheet.getColumn(column.key).numFmt = "#,##0";
  }
  sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: TEAM_SHEET_COLUMNS.length } };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Telegram accepts any unicode name; only path separators and control characters go. */
export function teamWorkbookFilename(team: TeamPerformance): string {
  const stem = `Menejerlar - ${team.title} - ${team.periodLabel}`
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${stem}.xlsx`;
}

export function teamWorkbookCaption(team: TeamPerformance): string {
  return `Menejerlar — ${team.periodLabel}: ${team.members.length} ta`;
}
