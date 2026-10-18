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

async function claimKey(key: string): Promise<boolean> {
  try {
    const { redisConnection } = await import("../config/queue");
    const result = await redisConnection.set(key, "1", "EX", DEDUPE_TTL_SECONDS, "NX");
    return result === "OK";
  } catch {
    // Without Redis the bot keeps answering; a rare duplicate beats silence.
    return true;
  }
}
