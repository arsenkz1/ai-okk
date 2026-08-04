export const CALL_TASK_AUTOMATION_ACTIVATION_SETTING_KEY = "call_task_automation.activation_boundary";
export const CALL_TASK_AUTOMATION_TEST_LIMIT = 5;
export const DEFAULT_CALL_TASK_AUTOMATION_TEST_SLOT_LEASE_MS = 10 * 60 * 1000;

export type CallTaskAutomationTestSlotState = "free" | "reserved" | "confirmed" | "uncertain";

export interface CallTaskAutomationTestSlot {
  slotNumber: number;
  state: CallTaskAutomationTestSlotState;
  leadId: number | null;
  actionId: string | null;
  reservedAt: Date | null;
  confirmedAt: Date | null;
  leaseExpiresAt: Date | null;
}

export interface CallTaskAutomationPersistence {
  transaction<T>(operation: (persistence: CallTaskAutomationPersistence) => Promise<T>): Promise<T>;
  getSetting(key: string): Promise<string | null>;
  createSettingIfAbsent(key: string, value: string): Promise<string>;
  ensureTestSlots(limit: number): Promise<void>;
  findTestSlotForLead(leadId: number): Promise<CallTaskAutomationTestSlot | null>;
  reserveFreeTestSlot(
    leadId: number,
    actionId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<CallTaskAutomationTestSlot | null>;
  reclaimTestSlotLease(
    actionId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<CallTaskAutomationTestSlot | null>;
  markExpiredTestSlotsUncertain(now: Date): Promise<number>;
  confirmTestSlot(actionId: string, now: Date): Promise<CallTaskAutomationTestSlot | null>;
  releaseTestSlotBeforeAnalysis(actionId: string): Promise<boolean>;
  markTestSlotUncertain(actionId: string, now: Date): Promise<CallTaskAutomationTestSlot | null>;
}

export interface CallTaskAutomationStoreOptions {
  leaseMs?: number;
}

export interface ReserveTestLeadInput {
  leadId: number;
  actionId: string;
  now: Date;
}

export type ReserveTestLeadResult =
  | { kind: "reserved"; slot: CallTaskAutomationTestSlot }
  | { kind: "reclaimed"; slot: CallTaskAutomationTestSlot }
  | { kind: "already_claimed"; slot: CallTaskAutomationTestSlot }
  | { kind: "limit_reached" };

export interface CallTaskAutomationStore {
  getActivationBoundary(): Promise<Date | null>;
  getOrCreateActivationBoundary(now?: Date): Promise<Date>;
  ensureTestSlots(limit: number): Promise<void>;
  reserveTestLead(input: ReserveTestLeadInput): Promise<ReserveTestLeadResult>;
  confirmTestLead(actionId: string, now: Date): Promise<CallTaskAutomationTestSlot | null>;
  releaseTestLeadBeforeAnalysis(actionId: string): Promise<boolean>;
  markTestLeadUncertain(actionId: string, now: Date): Promise<CallTaskAutomationTestSlot | null>;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${name} must be a valid Date`);
  }
}

function parseActivationBoundary(value: string): Date {
  const boundary = new Date(value);
  if (Number.isNaN(boundary.getTime()) || boundary.toISOString() !== value) {
    throw new Error("call-task activation boundary is corrupt");
  }
  return boundary;
}

/**
 * Prevents historical catch-up: a lead itself must be strictly newer than the
 * durable activation boundary and its call must not predate that boundary.
 */
export function isCallTaskAutomationEligible(input: {
  activationBoundary: Date;
  leadCreatedAt: Date;
  callCreatedAt: Date;
}): boolean {
  const { activationBoundary, leadCreatedAt, callCreatedAt } = input;
  assertValidDate(activationBoundary, "activationBoundary");
  assertValidDate(leadCreatedAt, "leadCreatedAt");
  assertValidDate(callCreatedAt, "callCreatedAt");
  return leadCreatedAt.getTime() > activationBoundary.getTime()
    && callCreatedAt.getTime() >= activationBoundary.getTime();
}

export function createCallTaskAutomationStore(
  persistence: CallTaskAutomationPersistence,
  options: CallTaskAutomationStoreOptions = {},
): CallTaskAutomationStore {
  const leaseMs = options.leaseMs ?? DEFAULT_CALL_TASK_AUTOMATION_TEST_SLOT_LEASE_MS;
  assertPositiveInteger(leaseMs, "test slot leaseMs");

  async function ensureTestSlots(limit: number): Promise<void> {
    if (limit !== CALL_TASK_AUTOMATION_TEST_LIMIT) {
      throw new Error(`call-task testing limit must be exactly ${CALL_TASK_AUTOMATION_TEST_LIMIT}`);
    }
    await persistence.ensureTestSlots(limit);
  }

  return {
    async getActivationBoundary(): Promise<Date | null> {
      const value = await persistence.getSetting(CALL_TASK_AUTOMATION_ACTIVATION_SETTING_KEY);
      return value === null ? null : parseActivationBoundary(value);
    },

    async getOrCreateActivationBoundary(now = new Date()): Promise<Date> {
      assertValidDate(now, "activation boundary now");
      const value = await persistence.createSettingIfAbsent(
        CALL_TASK_AUTOMATION_ACTIVATION_SETTING_KEY,
        now.toISOString(),
      );
      return parseActivationBoundary(value);
    },

    ensureTestSlots,

    async reserveTestLead(input: ReserveTestLeadInput): Promise<ReserveTestLeadResult> {
      assertPositiveInteger(input.leadId, "test leadId");
      if (!input.actionId.trim()) throw new Error("test actionId is required");
      assertValidDate(input.now, "test reservation now");
      const leaseExpiresAt = new Date(input.now.getTime() + leaseMs);

      return persistence.transaction(async (transaction) => {
        await transaction.ensureTestSlots(CALL_TASK_AUTOMATION_TEST_LIMIT);
        const existing = await transaction.findTestSlotForLead(input.leadId);
        if (existing) {
          // A reclaimed analysis lease must resume its own reservation, not
          // consume a second slot or mark its own action as skipped. Refresh
          // the slot lease before another worker can conservatively expire it.
          if (existing.state === "reserved" && existing.actionId === input.actionId) {
            const reclaimed = await transaction.reclaimTestSlotLease(
              input.actionId,
              input.now,
              leaseExpiresAt,
            );
            if (reclaimed) return { kind: "reclaimed", slot: reclaimed };
          }
          if (
            existing.state === "reserved"
            && existing.leaseExpiresAt !== null
            && existing.leaseExpiresAt.getTime() <= input.now.getTime()
            && existing.actionId
          ) {
            await transaction.markTestSlotUncertain(existing.actionId, input.now);
          }
          return { kind: "already_claimed", slot: existing };
        }

        // A crashed analysis cannot silently free capacity: it is converted to
        // uncertain before a different lead may take any remaining free slot.
        await transaction.markExpiredTestSlotsUncertain(input.now);
        const reserved = await transaction.reserveFreeTestSlot(
          input.leadId,
          input.actionId,
          input.now,
          leaseExpiresAt,
        );
        if (reserved) return { kind: "reserved", slot: reserved };

        // A concurrent contender may have claimed this same lead after the
        // first lookup. Prefer the per-lead result over a misleading capacity
        // result if it is observable now.
        const concurrent = await transaction.findTestSlotForLead(input.leadId);
        if (concurrent) return { kind: "already_claimed", slot: concurrent };
        return { kind: "limit_reached" };
      });
    },

    async confirmTestLead(actionId: string, now: Date): Promise<CallTaskAutomationTestSlot | null> {
      if (!actionId.trim()) throw new Error("test actionId is required");
      assertValidDate(now, "test confirmation now");
      return persistence.confirmTestSlot(actionId, now);
    },

    async releaseTestLeadBeforeAnalysis(actionId: string): Promise<boolean> {
      if (!actionId.trim()) throw new Error("test actionId is required");
      return persistence.releaseTestSlotBeforeAnalysis(actionId);
    },

    async markTestLeadUncertain(actionId: string, now: Date): Promise<CallTaskAutomationTestSlot | null> {
      if (!actionId.trim()) throw new Error("test actionId is required");
      assertValidDate(now, "test uncertainty now");
      return persistence.markTestSlotUncertain(actionId, now);
    },
  };
}
