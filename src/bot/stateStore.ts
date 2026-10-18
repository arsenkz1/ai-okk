/**
 * Per-user bot state that must outlive a process: AI sessions and the
 * multi-step flows. One JSON record per user and kind, in Redis, with a TTL.
 *
 * The in-memory maps this replaces vanished on every deploy and were
 * invisible to a second replica; a manager mid-conversation simply lost it.
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Redis-backed. The connection lives in the queue module, imported on first use. */
export function createRedisKeyValueStore(): KeyValueStore {
  const redis = async () => (await import("../config/queue")).redisConnection;
  return {
    async get(key) { return (await redis()).get(key); },
    async set(key, value, ttlSeconds) { await (await redis()).set(key, value, "EX", ttlSeconds); },
    async del(key) { await (await redis()).del(key); },
  };
}

export interface MemoryKeyValueStore extends KeyValueStore {
  rows: Map<string, { value: string; expiresAt: number }>;
}

/** For tests and for running without Redis: honours TTLs by the given clock. */
export function createMemoryKeyValueStore(now: () => number = () => Date.now()): MemoryKeyValueStore {
  const rows = new Map<string, { value: string; expiresAt: number }>();
  return {
    rows,
    async get(key) {
      const row = rows.get(key);
      if (!row) return null;
      if (row.expiresAt <= now()) { rows.delete(key); return null; }
      return row.value;
    },
    async set(key, value, ttlSeconds) { rows.set(key, { value, expiresAt: now() + ttlSeconds * 1000 }); },
    async del(key) { rows.delete(key); },
  };
}

let activeStore: KeyValueStore = createRedisKeyValueStore();

/** Swaps the backing store for every state map; tests use the memory store. */
export function configureStateStore(store: KeyValueStore): void {
  activeStore = store;
}

export interface StateMap<T> {
  get(userId: number): Promise<T | null>;
  /** Writes the value and restarts its TTL. */
  set(userId: number, value: T): Promise<void>;
  /** True when something was stored. */
  delete(userId: number): Promise<boolean>;
}

export function createStateMap<T>(prefix: string, ttlSeconds: number): StateMap<T> {
  const keyFor = (userId: number): string => `${prefix}${userId}`;
  return {
    async get(userId) {
      const raw = await activeStore.get(keyFor(userId));
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        await activeStore.del(keyFor(userId));
        return null;
      }
    },
    async set(userId, value) {
      await activeStore.set(keyFor(userId), JSON.stringify(value), ttlSeconds);
    },
    async delete(userId) {
      const existed = (await activeStore.get(keyFor(userId))) !== null;
      await activeStore.del(keyFor(userId));
      return existed;
    },
  };
}
