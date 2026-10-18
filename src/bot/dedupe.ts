/**
 * Telegram re-delivers updates after a restart or a slow handler, and every
 * replica of the bot receives the same polling stream. One Redis key per
 * update makes sure a message is acted on once.
 *
 * Redis is imported lazily: the queue module that owns the connection also
 * instantiates BullMQ, which would keep the test runner alive.
 */

const DEDUPE_TTL_SECONDS = 120;

export async function claimUpdate(chatId: number, messageId: number): Promise<boolean> {
  return claimKey(`bot:dedup:${chatId}:${messageId}`);
}

/** Inline-button taps are deduplicated by Telegram's own query id. */
export async function claimCallback(queryId: string): Promise<boolean> {
  return claimKey(`bot:cbq:${queryId}`);
}

export const CALLBACK_ACTION_LOCK_SECONDS = 5;

/**
 * The same button on the same message, tapped again within a few seconds, is
 * a double tap: the first run is still going. Later taps are a new request.
 */
export async function claimCallbackAction(chatId: number, messageId: number, data: string): Promise<boolean> {
  return claimKey(`bot:cbq:act:${chatId}:${messageId}:${data}`, CALLBACK_ACTION_LOCK_SECONDS);
}

async function claimKey(key: string, ttlSeconds = DEDUPE_TTL_SECONDS): Promise<boolean> {
  try {
    const { redisConnection } = await import("../config/queue");
    const result = await redisConnection.set(key, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  } catch {
    // Without Redis the bot keeps answering; a rare duplicate beats silence.
    return true;
  }
}
