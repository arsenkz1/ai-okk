/**
 * "The bot asked a question and is waiting for the answer."
 *
 * One record per user, in Redis, so that a dialog survives a redeploy and is
 * seen by every replica. An answer is valid for ten minutes; the record is
 * kept for an hour after that only so a late reply can be told "time is up"
 * instead of being misread as something else.
 */

import { createRedisKeyValueStore } from "./stateStore";

export type PendingInputKind =
  | "deal_id"
  | "lead_id"
  | "telegram_id"
  | "plan_amount"
  | "task_due"
  | "period_from"
  | "period_to"
  | "salary_days"
  | "salary_plan"
  | "salary_fact"
  | "rate_amount";

export type PendingPayload = Record<string, unknown>;

export interface PendingInput<P extends PendingPayload = PendingPayload> {
  kind: PendingInputKind;
  payload: P;
  /** Epoch milliseconds. */
  createdAt: number;
}

export interface PendingInputStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export const PENDING_INPUT_TTL_MS = 10 * 60 * 1000;
export const PENDING_INPUT_KEEP_SECONDS = 60 * 60;

export type PendingLookup =
  | { state: "none" }
  | { state: "expired" }
  | { state: "pending"; input: PendingInput };

export interface PendingInputService {
  expect(userId: number, kind: PendingInputKind, payload?: PendingPayload): Promise<void>;
  lookup(userId: number): Promise<PendingLookup>;
  /** Returns the live input and clears it. */
  take(userId: number): Promise<PendingInput | null>;
  /** True when something was pending. */
  cancel(userId: number): Promise<boolean>;
}

const keyFor = (userId: number): string => `bot:pending:${userId}`;

export function createPendingInputService(store: PendingInputStore, now: () => number = () => Date.now()): PendingInputService {
  async function read(userId: number): Promise<PendingLookup> {
    const raw = await store.get(keyFor(userId));
    if (!raw) return { state: "none" };
    let input: PendingInput;
    try {
      input = JSON.parse(raw) as PendingInput;
      if (typeof input.kind !== "string" || typeof input.createdAt !== "number") throw new Error("malformed");
    } catch {
      await store.del(keyFor(userId));
      return { state: "none" };
    }
    if (now() - input.createdAt > PENDING_INPUT_TTL_MS) {
      await store.del(keyFor(userId));
      return { state: "expired" };
    }
    return { state: "pending", input };
  }

  return {
    async expect(userId, kind, payload = {}) {
      const input: PendingInput = { kind, payload, createdAt: now() };
      await store.set(keyFor(userId), JSON.stringify(input), PENDING_INPUT_KEEP_SECONDS);
    },
    lookup: read,
    async take(userId) {
      const found = await read(userId);
      if (found.state !== "pending") return null;
      await store.del(keyFor(userId));
      return found.input;
    },
    async cancel(userId) {
      const found = await read(userId);
      await store.del(keyFor(userId));
      return found.state === "pending";
    },
  };
}

/** Redis-backed store, shared with the other per-user state. */
export function createRedisPendingInputStore(): PendingInputStore {
  return createRedisKeyValueStore();
}

export const pendingInput: PendingInputService = createPendingInputService(createRedisPendingInputStore());
