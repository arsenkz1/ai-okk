export const CALL_STAGE_AUTOMATION_ACTIVATION_SETTING_KEY = "call_stage_automation.activation_boundary";
export const CALL_STAGE_AUTOMATION_TEST_LIMIT = 3;
export const DEFAULT_CALL_STAGE_AUTOMATION_TEST_SLOT_LEASE_MS = 10 * 60 * 1_000;

export type CallStageAutomationTestSlotState = "free" | "reserved" | "confirmed" | "uncertain";

export interface CallStageAutomationTestSlot {
  slotNumber: number;
  state: CallStageAutomationTestSlotState;
  dealId: number | null;
  actionId: string | null;
  reservedAt: Date | null;
  confirmedAt: Date | null;
  leaseExpiresAt: Date | null;
}

export interface CallStageAutomationPersistence {
  transaction<T>(operation: (persistence: CallStageAutomationPersistence) => Promise<T>): Promise<T>;
  getSetting(key: string): Promise<string | null>;
  createSettingIfAbsent(key: string, value: string): Promise<string>;
  ensureTestSlots(limit: number): Promise<void>;
  findTestSlotForDeal(dealId: number): Promise<CallStageAutomationTestSlot | null>;
  reserveFreeTestSlot(dealId: number, actionId: string, now: Date, leaseExpiresAt: Date): Promise<CallStageAutomationTestSlot | null>;
  reclaimTestSlotLease(actionId: string, now: Date, leaseExpiresAt: Date): Promise<CallStageAutomationTestSlot | null>;
  markExpiredTestSlotsUncertain(now: Date): Promise<number>;
  confirmTestSlot(actionId: string, now: Date): Promise<CallStageAutomationTestSlot | null>;
  releaseTestSlotBeforePatch(actionId: string): Promise<boolean>;
  markTestSlotUncertain(actionId: string, now: Date): Promise<CallStageAutomationTestSlot | null>;
}

export interface CallStageAutomationStoreOptions {
  leaseMs?: number;
}

export type ReserveTestMoveResult =
  | { kind: "reserved"; slot: CallStageAutomationTestSlot }
  | { kind: "reclaimed"; slot: CallStageAutomationTestSlot }
  | { kind: "already_claimed"; slot: CallStageAutomationTestSlot }
  | { kind: "limit_reached" };

export interface CallStageAutomationStore {
  getActivationBoundary(): Promise<Date | null>;
  getOrCreateActivationBoundary(now?: Date): Promise<Date>;
  ensureTestSlots(limit: number): Promise<void>;
  reserveTestMove(input: { dealId: number; actionId: string; now: Date }): Promise<ReserveTestMoveResult>;
  confirmTestMove(actionId: string, now: Date): Promise<CallStageAutomationTestSlot | null>;
  releaseTestMoveBeforePatch(actionId: string): Promise<boolean>;
  markTestMoveUncertain(actionId: string, now: Date): Promise<CallStageAutomationTestSlot | null>;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${name} must be a valid Date`);
}

function parseActivationBoundary(value: string): Date {
  const boundary = new Date(value);
  if (Number.isNaN(boundary.getTime()) || boundary.toISOString() !== value) {
    throw new Error("call-stage activation boundary is corrupt");
  }
  return boundary;
}

/** Prevents stage-routing history from being enrolled when the test is enabled. */
export function isCallStageAutomationEligible(input: {
  activationBoundary: Date;
  leadCreatedAt: Date;
  callCreatedAt: Date;
}): boolean {
  assertValidDate(input.activationBoundary, "activationBoundary");
  assertValidDate(input.leadCreatedAt, "leadCreatedAt");
  assertValidDate(input.callCreatedAt, "callCreatedAt");
  return input.leadCreatedAt.getTime() > input.activationBoundary.getTime()
    && input.callCreatedAt.getTime() > input.activationBoundary.getTime();
}

export function createCallStageAutomationStore(
  persistence: CallStageAutomationPersistence,
  options: CallStageAutomationStoreOptions = {},
): CallStageAutomationStore {
  const leaseMs = options.leaseMs ?? DEFAULT_CALL_STAGE_AUTOMATION_TEST_SLOT_LEASE_MS;
  assertPositiveInteger(leaseMs, "test slot leaseMs");

  async function ensureTestSlots(limit: number): Promise<void> {
    if (limit !== CALL_STAGE_AUTOMATION_TEST_LIMIT) {
      throw new Error(`call-stage testing limit must be exactly ${CALL_STAGE_AUTOMATION_TEST_LIMIT}`);
    }
    await persistence.ensureTestSlots(limit);
  }

  return {
    async getActivationBoundary(): Promise<Date | null> {
      const value = await persistence.getSetting(CALL_STAGE_AUTOMATION_ACTIVATION_SETTING_KEY);
      return value === null ? null : parseActivationBoundary(value);
    },

    async getOrCreateActivationBoundary(now = new Date()): Promise<Date> {
      assertValidDate(now, "activation boundary now");
      const value = await persistence.createSettingIfAbsent(CALL_STAGE_AUTOMATION_ACTIVATION_SETTING_KEY, now.toISOString());
      return parseActivationBoundary(value);
    },

    ensureTestSlots,

    async reserveTestMove(input): Promise<ReserveTestMoveResult> {
      assertPositiveInteger(input.dealId, "test dealId");
      if (!input.actionId.trim()) throw new Error("test actionId is required");
      assertValidDate(input.now, "test reservation now");
      const leaseExpiresAt = new Date(input.now.getTime() + leaseMs);

      return persistence.transaction(async (transaction) => {
        await transaction.ensureTestSlots(CALL_STAGE_AUTOMATION_TEST_LIMIT);
        const existing = await transaction.findTestSlotForDeal(input.dealId);
        if (existing) {
          if (existing.state === "reserved" && existing.actionId === input.actionId) {
            const reclaimed = await transaction.reclaimTestSlotLease(input.actionId, input.now, leaseExpiresAt);
            if (reclaimed) return { kind: "reclaimed", slot: reclaimed };
          }
          if (existing.state === "reserved" && existing.leaseExpiresAt && existing.leaseExpiresAt.getTime() <= input.now.getTime() && existing.actionId) {
            await transaction.markTestSlotUncertain(existing.actionId, input.now);
          }
          return { kind: "already_claimed", slot: existing };
        }

        await transaction.markExpiredTestSlotsUncertain(input.now);
        const reserved = await transaction.reserveFreeTestSlot(input.dealId, input.actionId, input.now, leaseExpiresAt);
        if (reserved) return { kind: "reserved", slot: reserved };
        const concurrent = await transaction.findTestSlotForDeal(input.dealId);
        if (concurrent) return { kind: "already_claimed", slot: concurrent };
        return { kind: "limit_reached" };
      });
    },

    async confirmTestMove(actionId, now) {
      if (!actionId.trim()) throw new Error("test actionId is required");
      assertValidDate(now, "test confirmation now");
      return persistence.confirmTestSlot(actionId, now);
    },

    async releaseTestMoveBeforePatch(actionId) {
      if (!actionId.trim()) throw new Error("test actionId is required");
      return persistence.releaseTestSlotBeforePatch(actionId);
    },

    async markTestMoveUncertain(actionId, now) {
      if (!actionId.trim()) throw new Error("test actionId is required");
      assertValidDate(now, "test uncertainty now");
      return persistence.markTestSlotUncertain(actionId, now);
    },
  };
}
