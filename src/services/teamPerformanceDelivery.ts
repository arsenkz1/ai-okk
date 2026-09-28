import { formatTeamPerformance, type TeamPerformance } from "./performanceReport";
import {
  buildTeamPerformanceWorkbook,
  teamWorkbookCaption,
  teamWorkbookFilename,
  XLSX_CONTENT_TYPE,
} from "./teamPerformanceWorkbook";

/**
 * Sends a team report as the company message plus the manager table as an
 * Excel file. If the file cannot be built, the managers go back into the text
 * so the numbers are never silently missing.
 */

export interface TeamReportFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
  caption: string;
}

export interface DeliverTeamPerformanceOptions {
  team: TeamPerformance;
  sendText: (text: string) => Promise<void>;
  /** Absent when the channel cannot carry files; the managers stay inline. */
  sendFile?: (file: TeamReportFile) => Promise<void>;
  logPrefix: string;
  buildWorkbook?: (team: TeamPerformance) => Promise<Buffer>;
}

/**
 * The manager table as a ready-to-send file, or null when there is nothing to
 * tabulate or the workbook could not be built (logged, never thrown: a report
 * must still go out).
 */
export async function buildTeamReportFile(
  team: TeamPerformance,
  logPrefix: string,
  buildWorkbook: (team: TeamPerformance) => Promise<Buffer> = buildTeamPerformanceWorkbook,
): Promise<TeamReportFile | null> {
  if (team.members.length === 0) return null;
  try {
    const buffer = await buildWorkbook(team);
    return { buffer, filename: teamWorkbookFilename(team), contentType: XLSX_CONTENT_TYPE, caption: teamWorkbookCaption(team) };
  } catch (error) {
    console.error(`${logPrefix} manager table workbook failed:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export async function deliverTeamPerformance(options: DeliverTeamPerformanceOptions): Promise<{ membersInFile: boolean }> {
  const { team } = options;
  const file = options.sendFile ? await buildTeamReportFile(team, options.logPrefix, options.buildWorkbook) : null;

  await options.sendText(formatTeamPerformance(team, { membersInFile: file !== null }));
  if (file) await options.sendFile!(file);
  return { membersInFile: file !== null };
}
