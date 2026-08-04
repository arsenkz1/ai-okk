import axios from "axios";
import "./amoCrmRateLimiter";
import { DIRECT_LEAD_WEBHOOK_ACTIONS } from "./leadInactivityPolicy";
import type { AmoInactivityHttpResponse } from "./leadInactivityAmoClient";

// Exact amoCRM v4 `settings` values. In particular, the current webhook API
// documents `note_lead` (not the payload's entity/action shape) for lead notes.
export const AMO_INACTIVITY_WEBHOOK_EVENTS = Object.freeze([...DIRECT_LEAD_WEBHOOK_ACTIONS]);
export const AMO_INACTIVITY_SUBSCRIPTION_TIMEOUT_MS = 10_000;

export interface LeadInactivityAmoSubscriptionClient {
  subscribe(): Promise<void>;
}

export interface AmoInactivitySubscriptionHttpRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  timeout: number;
  data: unknown;
}

export interface AmoInactivitySubscriptionHttpClient {
  request(request: AmoInactivitySubscriptionHttpRequest): Promise<AmoInactivityHttpResponse>;
}

export interface CreateLeadInactivityAmoSubscriptionClientOptions {
  baseUrl: string;
  accessToken: string;
  publicBaseUrl: string;
  webhookSecret: string;
  http?: AmoInactivitySubscriptionHttpClient;
}

function normalizeAmoBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const host = parsed.hostname.toLowerCase();
  const isAmoTenant = host.endsWith(".amocrm.ru") || host.endsWith(".amocrm.com");
  if (
    parsed.protocol !== "https:" ||
    !isAmoTenant ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("AMOCRM base URL must be an HTTPS amoCRM tenant origin");
  }
  return parsed.origin;
}

function normalizedResponseHeaders(headers: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries((headers ?? {}) as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  );
}

export function buildLeadInactivityWebhookDestination(publicBaseUrl: string, secret: string): string {
  if (!secret) throw new Error("AMOCRM inactivity webhook secret is required");
  const parsed = new URL(publicBaseUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("amoCRM inactivity webhook public base URL must not include a path, query, fragment, credentials, or port");
  }
  return `${parsed.origin}/webhooks/amocrm/inactivity/${encodeURIComponent(secret)}`;
}

export function createLeadInactivityAmoSubscriptionClient(
  options: CreateLeadInactivityAmoSubscriptionClientOptions,
): LeadInactivityAmoSubscriptionClient {
  const baseUrl = normalizeAmoBaseUrl(options.baseUrl);
  if (!options.accessToken) throw new Error("AMOCRM access token is required");
  const destination = buildLeadInactivityWebhookDestination(options.publicBaseUrl, options.webhookSecret);
  const http: AmoInactivitySubscriptionHttpClient = options.http ?? {
    async request(request: AmoInactivitySubscriptionHttpRequest): Promise<AmoInactivityHttpResponse> {
      const response = await axios.request(request);
      return { status: response.status, data: response.data, headers: normalizedResponseHeaders(response.headers) };
    },
  };

  return {
    async subscribe(): Promise<void> {
      const response = await http.request({
        method: "POST",
        url: `${baseUrl}/api/v4/webhooks`,
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: AMO_INACTIVITY_SUBSCRIPTION_TIMEOUT_MS,
        data: {
          destination,
          settings: [...AMO_INACTIVITY_WEBHOOK_EVENTS],
        },
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`amoCRM webhook subscription failed with HTTP ${response.status}`);
      }
    },
  };
}
