/**
 * Retry rules for amoCRM requests.
 *
 * Kept free of imports so it can be unit-tested without loading the amoCRM
 * client, which pulls in Prisma and the Telegram bot at module load.
 */

export const AMO_READ_MAX_ATTEMPTS = 4;
export const AMO_RETRY_BASE_DELAY_MS = 1_000;
export const AMO_RETRY_MAX_DELAY_MS = 30_000;

/** Only failures that a later identical request may survive. */
export function isRetryableAmoStatus(status: number | null): boolean {
  return status === null || status === 429 || status === 408 || status >= 500;
}

/**
 * Honours Retry-After when amoCRM sends it, otherwise backs off exponentially.
 * The cap matters: an absurd Retry-After must not stall a worker indefinitely.
 */
export function amoRetryDelayMs(attempt: number, retryAfterHeader: unknown): number {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(Math.ceil(retryAfterSeconds * 1_000), AMO_RETRY_MAX_DELAY_MS);
  }
  return Math.min(AMO_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), AMO_RETRY_MAX_DELAY_MS);
}
