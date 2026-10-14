/**
 * What an error log line may contain.
 *
 * An axios or gaxios error object carries the whole request: headers with the
 * bearer token, the body, the response. Printing it dumped a live amoCRM token
 * into the hosting logs. Log sites therefore print this summary, never the
 * error itself.
 */

export interface ErrorSummary {
  name: string;
  message: string;
  code?: string;
  status?: number;
  method?: string;
  /** Origin and path only; a query string could carry a key. */
  url?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function summarizeError(error: unknown): ErrorSummary {
  const record = asRecord(error);
  if (!record) return { name: "Error", message: String(error) };

  const summary: ErrorSummary = {
    name: typeof record.name === "string" ? record.name : "Error",
    message: typeof record.message === "string" ? record.message : String(error),
  };
  if (typeof record.code === "string") summary.code = record.code;

  const response = asRecord(record.response);
  const status = Number(response?.status ?? record.status);
  if (Number.isInteger(status) && status > 0) summary.status = status;

  const config = asRecord(record.config);
  if (typeof config?.method === "string") summary.method = config.method.toUpperCase();
  const rawUrl = typeof config?.url === "string" ? config.url : undefined;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl, typeof config?.baseURL === "string" ? config.baseURL : undefined);
      summary.url = `${parsed.origin}${parsed.pathname}`;
    } catch {
      summary.url = rawUrl.split("?")[0];
    }
  }
  return summary;
}
