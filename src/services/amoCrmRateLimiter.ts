import axios, { type InternalAxiosRequestConfig } from "axios";
import { prisma } from "../config/database";

export const AMOCRM_GLOBAL_MAX_REQUESTS_PER_SECOND = 5;
// Keep 40 ms of dispatch jitter headroom below the external five-RPS ceiling.
// A slot that wakes late is re-reserved, never dispatched out of order.
export const AMOCRM_GLOBAL_MIN_REQUEST_INTERVAL_MS = 260;
export const AMOCRM_GLOBAL_MAX_TIMER_DELAY_MS = 2_147_483_647;
const AMOCRM_GLOBAL_MAX_SLOT_RESERVATION_ATTEMPTS = 128;
export const AMOCRM_GLOBAL_RATE_LIMIT_SETTING_KEY = "amocrm.global_request_rate_limit";

export interface AmoCrmRateSlotReservation {
  delayMs: number;
  scheduledAtMs: number;
}

export interface AmoCrmRateSlotStore {
  reserveRequestSlot(): Promise<AmoCrmRateSlotReservation>;
  readCurrentTimeMs(): Promise<number>;
}

export interface AmoCrmPrismaRateLimitClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface AmoCrmGlobalRateLimiter {
  waitForRequestSlot(): Promise<void>;
}

export interface AmoCrmRateLimitedAxiosRequestConfig extends InternalAxiosRequestConfig {
  __amoCrmGlobalRateLimitReserved?: true;
}

export interface CreateAmoCrmGlobalRateLimiterOptions {
  store: AmoCrmRateSlotStore;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDatabaseTimeMs(value: unknown, field: string): number {
  const parsed = typeof value === "bigint" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`amoCRM global rate-limit ${field} is invalid`);
  }
  return parsed;
}

/**
 * PostgreSQL owns both the atomic slot allocation and the clock used to calculate
 * the wait. Railway replica wall clocks are intentionally never consulted here.
 */
export function createPrismaAmoCrmRateSlotStore(
  database: AmoCrmPrismaRateLimitClient,
  settingKey = AMOCRM_GLOBAL_RATE_LIMIT_SETTING_KEY,
): AmoCrmRateSlotStore {
  return {
    async reserveRequestSlot(): Promise<AmoCrmRateSlotReservation> {
      const rows = await database.$queryRaw<Array<{ delayMs: unknown; scheduledAtMs: unknown }>>`
        WITH reserved AS (
          INSERT INTO "LeadInactivitySetting" ("key", "value", "createdAt", "updatedAt")
          VALUES (
            ${settingKey},
            (
              floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
              + ${AMOCRM_GLOBAL_MIN_REQUEST_INTERVAL_MS}
            )::text,
            clock_timestamp(),
            clock_timestamp()
          )
          ON CONFLICT ("key") DO UPDATE
          SET
            "value" = (
              GREATEST(
                "LeadInactivitySetting"."value"::bigint,
                floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
              ) + ${AMOCRM_GLOBAL_MIN_REQUEST_INTERVAL_MS}
            )::text,
            "updatedAt" = clock_timestamp()
          WHERE "LeadInactivitySetting"."value" ~ '^[0-9]+$'
          RETURNING ("value"::bigint - ${AMOCRM_GLOBAL_MIN_REQUEST_INTERVAL_MS}) AS "scheduledAt"
        )
        SELECT
          "scheduledAt" AS "scheduledAtMs",
          GREATEST(
            0::bigint,
            "scheduledAt" - floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
          ) AS "delayMs"
        FROM reserved
      `;
      if (rows.length !== 1) {
        throw new Error("unable to reserve a global amoCRM request-rate slot");
      }
      return {
        delayMs: parseDatabaseTimeMs(rows[0].delayMs, "delay"),
        scheduledAtMs: parseDatabaseTimeMs(rows[0].scheduledAtMs, "scheduled timestamp"),
      };
    },

    async readCurrentTimeMs(): Promise<number> {
      const rows = await database.$queryRaw<Array<{ nowMs: unknown }>>`
        SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"
      `;
      if (rows.length !== 1) throw new Error("unable to read the database time for the global amoCRM request limiter");
      return parseDatabaseTimeMs(rows[0].nowMs, "database timestamp");
    },
  };
}

export function createAmoCrmGlobalRateLimiter(
  options: CreateAmoCrmGlobalRateLimiterOptions,
): AmoCrmGlobalRateLimiter {
  const sleep = options.sleep ?? defaultSleep;

  return {
    async waitForRequestSlot(): Promise<void> {
      for (let attempt = 1; attempt <= AMOCRM_GLOBAL_MAX_SLOT_RESERVATION_ATTEMPTS; attempt += 1) {
        const { delayMs, scheduledAtMs } = await options.store.reserveRequestSlot();
        if (delayMs > AMOCRM_GLOBAL_MAX_TIMER_DELAY_MS) {
          throw new Error("amoCRM global rate-limit delay exceeds the safe timer range");
        }
        if (scheduledAtMs > Number.MAX_SAFE_INTEGER - AMOCRM_GLOBAL_MIN_REQUEST_INTERVAL_MS) {
          throw new Error("amoCRM global rate-limit scheduled timestamp is outside the safe integer range");
        }
        if (delayMs > 0) await sleep(delayMs);

        // Do not dispatch a slot that became overdue while this replica was
        // paused. Database time is checked again, so timers from a stalled
        // process cannot wake as an unbounded HTTP burst.
        const databaseNowMs = await options.store.readCurrentTimeMs();
        if (databaseNowMs < scheduledAtMs + AMOCRM_GLOBAL_MIN_REQUEST_INTERVAL_MS) return;
      }
      throw new Error("unable to obtain a current global amoCRM request-rate slot");
    },
  };
}

function isAmoCrmTenantHostname(hostname: string): boolean {
  return hostname.endsWith(".amocrm.ru") || hostname.endsWith(".amocrm.com");
}

export function normalizeAmoCrmTenantBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error("AMOCRM base URL must be an HTTPS amoCRM tenant origin");
  }
  if (
    parsed.protocol !== "https:"
    || !isAmoCrmTenantHostname(parsed.hostname.toLowerCase())
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("AMOCRM base URL must be an HTTPS amoCRM tenant origin");
  }
  return parsed.origin;
}

export function isAmoCrmRequestUrl(url: string | undefined, baseUrl?: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url, baseUrl);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return parsed.protocol === "https:" && isAmoCrmTenantHostname(hostname);
}

const globalAmoCrmRateLimiter = createAmoCrmGlobalRateLimiter({
  store: createPrismaAmoCrmRateSlotStore(prisma),
});

export function waitForGlobalAmoCrmRequestSlot(): Promise<void> {
  return globalAmoCrmRateLimiter.waitForRequestSlot();
}

export function createAmoCrmAxiosRequestGate(rateLimiter: AmoCrmGlobalRateLimiter) {
  return async (request: AmoCrmRateLimitedAxiosRequestConfig): Promise<AmoCrmRateLimitedAxiosRequestConfig> => {
    if (
      isAmoCrmRequestUrl(request.url, request.baseURL)
      && request.__amoCrmGlobalRateLimitReserved !== true
    ) {
      await rateLimiter.waitForRequestSlot();
    }
    return request;
  };
}

let globalInterceptorInstalled = false;

export function installGlobalAmoCrmAxiosRateLimit(): void {
  if (globalInterceptorInstalled) return;
  globalInterceptorInstalled = true;
  axios.interceptors.request.use(createAmoCrmAxiosRequestGate(globalAmoCrmRateLimiter));
}

installGlobalAmoCrmAxiosRateLimit();
