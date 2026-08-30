import { prisma } from "../config/database";
import type { FieldOption } from "./amoOptionMatching";

/**
 * Durable record of what this system did to amoCRM option lists.
 *
 * Two separate things are stored, because they answer different questions:
 *  - the snapshot answers "what did this field look like before we touched it",
 *    written once per field and never overwritten;
 *  - the addition log answers "which options did we add", so a rollback can
 *    remove exactly those and leave anything a person added alone.
 */

export interface SnapshotEnum {
  id: number;
  value: string;
  sort: number | null;
}

export interface FieldOptionSnapshot {
  fieldId: number;
  fieldName: string;
  fieldType: string;
  originalEnums: SnapshotEnum[];
  capturedAt: Date;
}

export interface AmoFieldOptionRegistry {
  /**
   * Stores the field's current option list if nothing is stored yet, then
   * returns the stored original. Must succeed before any option is added.
   */
  captureSnapshot(input: {
    fieldId: number;
    fieldName: string;
    fieldType: string;
    enums: readonly SnapshotEnum[];
    now?: Date;
  }): Promise<FieldOptionSnapshot>;
  getSnapshot(fieldId: number): Promise<FieldOptionSnapshot | null>;
  recordAddition(input: {
    fieldId: number;
    fieldName: string;
    enumId: number;
    value: string;
    actionId?: string | null;
    dealId?: number | null;
  }): Promise<void>;
  listActiveAdditions(fieldId?: number): Promise<Array<{
    id: string;
    fieldId: number;
    fieldName: string;
    enumId: number;
    value: string;
    createdAt: Date;
  }>>;
  markReverted(additionIds: readonly string[], now?: Date): Promise<number>;
}

function parseEnums(raw: unknown, fieldId: number): SnapshotEnum[] {
  if (!Array.isArray(raw)) throw new Error(`stored option snapshot for field ${fieldId} is malformed`);
  return raw.map((entry) => {
    const item = entry as { id?: unknown; value?: unknown; sort?: unknown } | null;
    if (!item || typeof item !== "object") throw new Error(`stored option snapshot for field ${fieldId} is malformed`);
    const id = Number(item.id);
    const sort = Number(item.sort);
    if (!Number.isInteger(id) || id <= 0 || typeof item.value !== "string") {
      throw new Error(`stored option snapshot for field ${fieldId} is malformed`);
    }
    return { id, value: item.value, sort: Number.isInteger(sort) ? sort : null };
  });
}

export function createAmoFieldOptionRegistry(
  database: Pick<typeof prisma, "amoFieldOptionSnapshot" | "amoFieldOptionAddition"> = prisma,
): AmoFieldOptionRegistry {
  return {
    async captureSnapshot(input): Promise<FieldOptionSnapshot> {
      const capturedAt = input.now ?? new Date();
      const enums = input.enums.map((item) => ({ id: item.id, value: item.value, sort: item.sort }));

      // createMany + skipDuplicates keeps the first snapshot authoritative even
      // when two calls race: the original must never be rewritten by a later,
      // already-modified list.
      await database.amoFieldOptionSnapshot.createMany({
        data: [{
          fieldId: input.fieldId,
          fieldName: input.fieldName,
          fieldType: input.fieldType,
          originalEnums: enums,
          capturedAt,
        }],
        skipDuplicates: true,
      });

      const stored = await database.amoFieldOptionSnapshot.findUnique({ where: { fieldId: input.fieldId } });
      if (!stored) throw new Error(`option snapshot for field ${input.fieldId} could not be stored`);
      return {
        fieldId: stored.fieldId,
        fieldName: stored.fieldName,
        fieldType: stored.fieldType,
        originalEnums: parseEnums(stored.originalEnums, stored.fieldId),
        capturedAt: stored.capturedAt,
      };
    },

    async getSnapshot(fieldId): Promise<FieldOptionSnapshot | null> {
      const stored = await database.amoFieldOptionSnapshot.findUnique({ where: { fieldId } });
      if (!stored) return null;
      return {
        fieldId: stored.fieldId,
        fieldName: stored.fieldName,
        fieldType: stored.fieldType,
        originalEnums: parseEnums(stored.originalEnums, stored.fieldId),
        capturedAt: stored.capturedAt,
      };
    },

    async recordAddition(input): Promise<void> {
      await database.amoFieldOptionAddition.createMany({
        data: [{
          fieldId: input.fieldId,
          fieldName: input.fieldName,
          enumId: input.enumId,
          value: input.value,
          actionId: input.actionId ?? null,
          dealId: input.dealId ?? null,
        }],
        skipDuplicates: true,
      });
    },

    async listActiveAdditions(fieldId) {
      return database.amoFieldOptionAddition.findMany({
        where: { revertedAt: null, ...(fieldId === undefined ? {} : { fieldId }) },
        orderBy: [{ fieldId: "asc" }, { createdAt: "asc" }],
        select: { id: true, fieldId: true, fieldName: true, enumId: true, value: true, createdAt: true },
      });
    },

    async markReverted(additionIds, now = new Date()): Promise<number> {
      if (additionIds.length === 0) return 0;
      const updated = await database.amoFieldOptionAddition.updateMany({
        where: { id: { in: [...additionIds] }, revertedAt: null },
        data: { revertedAt: now },
      });
      return updated.count;
    },
  };
}

/**
 * Builds the option list to PATCH back when removing this system's additions.
 * Options added by people after the snapshot are kept: a wholesale restore to
 * the snapshot would silently delete their work.
 */
export function planOptionRollback(input: {
  currentEnums: readonly SnapshotEnum[];
  additions: readonly { id: string; enumId: number; value: string }[];
}): { keptEnums: SnapshotEnum[]; removed: Array<{ id: string; enumId: number; value: string }> } {
  const additionByEnumId = new Map(input.additions.map((addition) => [addition.enumId, addition]));
  const keptEnums: SnapshotEnum[] = [];
  const removed: Array<{ id: string; enumId: number; value: string }> = [];

  for (const item of input.currentEnums) {
    const addition = additionByEnumId.get(item.id);
    if (addition) removed.push(addition);
    else keptEnums.push(item);
  }
  return { keptEnums, removed };
}

/** Options recorded as added that amoCRM no longer has; nothing to remove. */
export function alreadyGoneAdditions(input: {
  currentEnums: readonly SnapshotEnum[];
  additions: readonly { id: string; enumId: number; value: string }[];
}): Array<{ id: string; enumId: number; value: string }> {
  const present = new Set(input.currentEnums.map((item) => item.id));
  return input.additions.filter((addition) => !present.has(addition.enumId));
}

export function toFieldOptions(enums: readonly SnapshotEnum[]): FieldOption[] {
  return enums.map((item) => ({ id: item.id, value: item.value }));
}
