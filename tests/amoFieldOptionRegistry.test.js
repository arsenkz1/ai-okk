const test = require("node:test");
const assert = require("node:assert/strict");

const {
  planOptionRollback,
  alreadyGoneAdditions,
  toFieldOptions,
  createAmoFieldOptionRegistry,
} = require("../dist/services/amoFieldOptionRegistry");

const CURRENT = [
  { id: 1, value: "Toshkent", sort: 1 },
  { id: 2, value: "Samarqand", sort: 2 },
  { id: 3, value: "Andijon", sort: 3 },
  { id: 4, value: "Buxoro", sort: 4 },
];

test("removes only the options this system added", () => {
  const { keptEnums, removed } = planOptionRollback({
    currentEnums: CURRENT,
    additions: [{ id: "a1", enumId: 3, value: "Andijon" }],
  });

  // Buxoro was added by a person after the snapshot and must survive.
  assert.deepEqual(keptEnums.map((item) => item.value), ["Toshkent", "Samarqand", "Buxoro"]);
  assert.deepEqual(removed.map((item) => item.enumId), [3]);
});

test("keeps the whole list when nothing was added by this system", () => {
  const { keptEnums, removed } = planOptionRollback({ currentEnums: CURRENT, additions: [] });
  assert.deepEqual(keptEnums, CURRENT);
  assert.deepEqual(removed, []);
});

test("preserves the original order and sort of the options it keeps", () => {
  const { keptEnums } = planOptionRollback({
    currentEnums: CURRENT,
    additions: [{ id: "a1", enumId: 2, value: "Samarqand" }],
  });
  assert.deepEqual(keptEnums, [
    { id: 1, value: "Toshkent", sort: 1 },
    { id: 3, value: "Andijon", sort: 3 },
    { id: 4, value: "Buxoro", sort: 4 },
  ]);
});

test("reports recorded additions that amoCRM no longer has", () => {
  const gone = alreadyGoneAdditions({
    currentEnums: CURRENT,
    additions: [{ id: "a1", enumId: 3, value: "Andijon" }, { id: "a2", enumId: 99, value: "Xorazm" }],
  });

  assert.deepEqual(gone.map((item) => item.id), ["a2"]);
});

test("converts stored enums into matcher options", () => {
  assert.deepEqual(toFieldOptions(CURRENT), [
    { id: 1, value: "Toshkent" },
    { id: 2, value: "Samarqand" },
    { id: 3, value: "Andijon" },
    { id: 4, value: "Buxoro" },
  ]);
});

function fakeDatabase() {
  const snapshots = new Map();
  const additions = [];
  return {
    snapshots,
    additions,
    amoFieldOptionSnapshot: {
      async createMany({ data, skipDuplicates }) {
        for (const row of data) {
          if (skipDuplicates && snapshots.has(row.fieldId)) continue;
          snapshots.set(row.fieldId, { ...row });
        }
        return { count: data.length };
      },
      async findUnique({ where }) { return snapshots.get(where.fieldId) ?? null; },
    },
    amoFieldOptionAddition: {
      async createMany({ data, skipDuplicates }) {
        for (const row of data) {
          const exists = additions.some((item) => item.fieldId === row.fieldId && item.enumId === row.enumId);
          if (skipDuplicates && exists) continue;
          additions.push({ id: `add-${additions.length + 1}`, revertedAt: null, createdAt: new Date(), ...row });
        }
        return { count: data.length };
      },
      async findMany({ where }) {
        return additions.filter((item) => (
          item.revertedAt === null && (where.fieldId === undefined || item.fieldId === where.fieldId)
        ));
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const item of additions) {
          if (where.id.in.includes(item.id) && item.revertedAt === null) {
            item.revertedAt = data.revertedAt;
            count += 1;
          }
        }
        return { count };
      },
    },
  };
}

test("stores the original list once and never overwrites it", async () => {
  const database = fakeDatabase();
  const registry = createAmoFieldOptionRegistry(database);
  const original = [{ id: 1, value: "Toshkent", sort: 1 }];

  const first = await registry.captureSnapshot({
    fieldId: 967019, fieldName: "Region", fieldType: "select", enums: original,
  });
  // A second capture happens after an option was already added; it must not
  // replace the pre-automation list.
  const second = await registry.captureSnapshot({
    fieldId: 967019,
    fieldName: "Region",
    fieldType: "select",
    enums: [...original, { id: 2, value: "Andijon", sort: 2 }],
  });

  assert.deepEqual(first.originalEnums, original);
  assert.deepEqual(second.originalEnums, original);
  assert.deepEqual((await registry.getSnapshot(967019)).originalEnums, original);
});

test("returns nothing for a field that was never modified", async () => {
  const registry = createAmoFieldOptionRegistry(fakeDatabase());
  assert.equal(await registry.getSnapshot(1), null);
});

test("records each added option once and can close it out after a rollback", async () => {
  const database = fakeDatabase();
  const registry = createAmoFieldOptionRegistry(database);

  await registry.recordAddition({ fieldId: 1, fieldName: "Region", enumId: 5, value: "Andijon" });
  await registry.recordAddition({ fieldId: 1, fieldName: "Region", enumId: 5, value: "Andijon" });

  const active = await registry.listActiveAdditions();
  assert.equal(active.length, 1);

  assert.equal(await registry.markReverted(active.map((item) => item.id)), 1);
  assert.deepEqual(await registry.listActiveAdditions(), []);
  // A repeated rollback must not double-count what it already closed.
  assert.equal(await registry.markReverted(active.map((item) => item.id)), 0);
  assert.equal(await registry.markReverted([]), 0);
});
