import axios from "axios";

/**
 * OnlinePBX session keys and their renewal.
 *
 * `ONLINEPBX_PBX_AUTH` is not a permanent credential: it is a `key_id:key`
 * session pair that OnlinePBX expires (documented as three days from last use).
 * When it lapses the API answers HTTP 200 with `isNotAuth` in the body, so a
 * plain status check never notices — the request just "fails" with a confusing
 * message. This module mints a fresh session from the long-lived
 * `ONLINEPBX_API_KEY` and retries once.
 */

export const PBX_AUTH_ENDPOINT = "auth.json";

/**
 * Hosts tried when minting a session key. The rest of the integration talks to
 * api2, while the auth documentation names api.onlinepbx.ru as its server, so
 * the working host is used first and the documented one as a fallback.
 */
export const PBX_AUTH_HOSTS: readonly string[] = Object.freeze([
  "https://api2.onlinepbx.ru",
  "https://api.onlinepbx.ru",
]);

export interface PbxSession {
  header: string;
}

export interface PbxAuthHttpResponse {
  status: number;
  data: unknown;
}

export interface PbxAuthHttpClient {
  post(url: string, body: unknown, config: { headers: Record<string, string>; timeout: number }): Promise<PbxAuthHttpResponse>;
}

/**
 * OnlinePBX signals an expired key inside a 200 response, so the body is the
 * only reliable place to detect it.
 */
export function isPbxAuthFailure(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const payload = body as { isNotAuth?: unknown; errorCode?: unknown; comment?: unknown };
  if (payload.isNotAuth === true) return true;
  if (payload.errorCode === "API_KEY_CHECK_FAILED") return true;
  return typeof payload.comment === "string" && payload.comment.toLowerCase().includes("not authorized");
}

/**
 * Reads the `key_id` / `key` pair out of an auth.json response. The shape is
 * accepted at the top level and under `data`, because the field nesting differs
 * between OnlinePBX endpoints.
 */
export function parsePbxAuthResponse(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const candidates = [root, root.data as Record<string, unknown> | undefined].filter(
    (value): value is Record<string, unknown> => Boolean(value) && typeof value === "object",
  );

  for (const candidate of candidates) {
    const keyId = candidate.key_id;
    const key = candidate.key;
    if (typeof keyId === "string" && typeof key === "string" && keyId.trim() && key.trim()) {
      return `${keyId.trim()}:${key.trim()}`;
    }
  }
  return null;
}

export interface PbxAuthConfig {
  domain: string;
  apiKey: string | null;
  /** Session pair from the environment, used until it stops working. */
  initialHeader: string | null;
  authHosts: readonly string[];
}

export function readPbxAuthConfig(
  environment: Record<string, string | undefined> = process.env,
): PbxAuthConfig {
  const configuredHost = environment.ONLINEPBX_AUTH_BASE_URL?.trim();
  return {
    domain: environment.ONLINEPBX_DOMAIN?.trim() || "",
    apiKey: environment.ONLINEPBX_API_KEY?.trim() || null,
    initialHeader: environment.ONLINEPBX_PBX_AUTH?.trim() || null,
    authHosts: configuredHost ? [configuredHost.replace(/\/+$/, "")] : PBX_AUTH_HOSTS,
  };
}

export interface PbxAuthProvider {
  /** Current header value, minting one if none is cached. */
  getAuthHeader(): Promise<string>;
  /** Discards the cached session and mints a new one. */
  refreshAuthHeader(): Promise<string>;
  /**
   * Runs a request with the current header and retries it once with a fresh
   * session when OnlinePBX reports the key as expired.
   */
  withAuth<T extends PbxAuthHttpResponse>(request: (header: string) => Promise<T>): Promise<T>;
}

export interface CreatePbxAuthProviderOptions {
  config?: PbxAuthConfig;
  http?: PbxAuthHttpClient;
}

export function createPbxAuthProvider(options: CreatePbxAuthProviderOptions = {}): PbxAuthProvider {
  const config = options.config ?? readPbxAuthConfig();
  const http: PbxAuthHttpClient = options.http ?? {
    async post(url, body, requestConfig) {
      const response = await axios.post(url, body, { ...requestConfig, validateStatus: () => true });
      return { status: response.status, data: response.data };
    },
  };

  // The configured pair is used until OnlinePBX rejects it. OnlinePBX asks for
  // a key to be requested only on the first call or after {isNotAuth: true},
  // because every auth issues a new key and invalidates the previous session.
  let session: PbxSession | null = config.initialHeader ? { header: config.initialHeader } : null;
  let pending: Promise<string> | null = null;

  const mint = async (): Promise<string> => {
    if (!config.domain) throw new Error("ONLINEPBX_DOMAIN is not configured");
    if (!config.apiKey) {
      throw new Error(
        "OnlinePBX session key expired and ONLINEPBX_API_KEY is not configured, so a new one cannot be requested",
      );
    }

    // Documented contract: form-urlencoded, auth_key plus new=true, which is
    // what marks the request as a key renewal.
    const body = new URLSearchParams({ auth_key: config.apiKey, new: "true" }).toString();
    const failures: string[] = [];

    for (const host of config.authHosts) {
      const url = `${host}/${config.domain}/${PBX_AUTH_ENDPOINT}`;
      let response: PbxAuthHttpResponse;
      try {
        response = await http.post(url, body, {
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          timeout: 15_000,
        });
      } catch (error) {
        failures.push(`${host}: ${error instanceof Error ? error.message : "request failed"}`);
        continue;
      }

      const header = parsePbxAuthResponse(response.data);
      if (header) {
        session = { header };
        console.log(`[PbxAuth] Minted a new OnlinePBX session key via ${host}`);
        return header;
      }
      failures.push(`${host}: ${JSON.stringify(response.data).slice(0, 200)}`);
    }

    throw new Error(`OnlinePBX auth.json did not return a session key. Attempts: ${failures.join(" | ")}`);
  };

  /** Concurrent callers share one mint instead of racing for several keys. */
  const mintOnce = async (): Promise<string> => {
    if (!pending) {
      pending = mint().finally(() => { pending = null; });
    }
    return pending;
  };

  return {
    async getAuthHeader(): Promise<string> {
      if (session) return session.header;
      return mintOnce();
    },

    async refreshAuthHeader(): Promise<string> {
      session = null;
      return mintOnce();
    },

    async withAuth<T extends PbxAuthHttpResponse>(request: (header: string) => Promise<T>): Promise<T> {
      const first = await request(await this.getAuthHeader());
      if (!isPbxAuthFailure(first.data)) return first;
      console.warn("[PbxAuth] OnlinePBX rejected the session key, requesting a new one");
      return request(await this.refreshAuthHeader());
    },
  };
}

let sharedProvider: PbxAuthProvider | null = null;

export function getPbxAuthProvider(): PbxAuthProvider {
  if (!sharedProvider) sharedProvider = createPbxAuthProvider();
  return sharedProvider;
}
