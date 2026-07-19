const test = require("node:test");
const assert = require("node:assert/strict");

const { createPrismaLeadInactivityPersistence } = require("../dist/services/leadInactivityPrismaPersistence");

function event(overrides = {}) {
  return {
    fingerprint: "event-1",
    leadId: 100,
    eventType: "update_lead",
    eventAt: new Date("2026-07-16T12:00:00.000Z"),
    receivedAt: new Date("2026-07-16T12:00:01.000Z"),
    leadCreatedAt: new Date("2026-07-16T10:00:00.000Z"),
    pipelineId: 9055778,
    statusId: 72917586,
    ...overrides,
  };
}

test("Prisma persistence turns a unique event collision into an idempotent replay", async () => {
  const fingerprints = new Set();
  const database = {
    $transaction: async (operation) => operation(database),
    leadInactivityEvent: {
      create: async ({ data }) => {
        if (fingerprints.has(data.fingerprint)) {
          const error = new Error("unique conflict");
          error.code = "P2002";
          throw error;
        }
        fingerprints.add(data.fingerprint);
        return { id: fingerprints.size };
      },
    },
  };
  const persistence = createPrismaLeadInactivityPersistence(database);

  assert.equal(await persistence.insertEventIfAbsent(event()), true);
  assert.equal(await persistence.insertEventIfAbsent(event()), false);
});

test("Prisma persistence retries a serializable transaction conflict before returning its result", async () => {
  let calls = 0;
  let isolationLevel;
  const database = {
    $transaction: async (operation, options) => {
      calls += 1;
      isolationLevel = options.isolationLevel;
      if (calls === 1) {
        const conflict = new Error("serialization failure");
        conflict.code = "P2034";
        throw conflict;
      }
      return operation(database);
    },
  };
  const persistence = createPrismaLeadInactivityPersistence(database);

  const result = await persistence.transaction(async () => "committed");

  assert.equal(result, "committed");
  assert.equal(calls, 2);
  assert.equal(isolationLevel, "Serializable");
});

test("Prisma persistence atomically advances equal amo timestamps only when received time is newer", async () => {
  const watch = {
    leadId: 100,
    leadCreatedAt: new Date("2026-07-16T10:00:00.000Z"),
    lastActivityAt: new Date("2026-07-16T12:00:00.000Z"),
    lastActivityReceivedAt: new Date("2026-07-16T12:00:01.000Z"),
    dueAt: new Date("2026-07-19T12:00:00.000Z"),
    pipelineId: 1,
    statusId: 10,
    cycle: 1,
    state: "watching",
    leaseToken: null,
    leaseExpiresAt: null,
    leaseGeneration: 0,
    lastEventFingerprint: "first",
    stoppedAt: null,
    lastFailureReason: null,
  };
  let receivedWhere;
  const database = {
    leadInactivityWatch: {
      updateMany: async ({ where, data }) => {
        receivedWhere = where;
        const tieBreaker = where.OR[1];
        const eligible = watch.leadId === where.leadId
          && watch.lastActivityAt.getTime() === tieBreaker.lastActivityAt.getTime()
          && watch.lastActivityReceivedAt < tieBreaker.lastActivityReceivedAt.lt;
        if (!eligible) return { count: 0 };
        Object.assign(watch, data);
        return { count: 1 };
      },
      findUnique: async () => watch,
    },
  };
  const persistence = createPrismaLeadInactivityPersistence(database);

  const advanced = await persistence.advanceWatchIfNewer(100, {
    ...watch,
    lastActivityReceivedAt: new Date("2026-07-16T12:00:02.000Z"),
    pipelineId: 2,
    statusId: 20,
    lastEventFingerprint: "second",
  });

  assert.equal(receivedWhere.OR.length, 2);
  assert.equal(advanced.pipelineId, 2);
  assert.equal(advanced.statusId, 20);
  assert.equal(advanced.lastEventFingerprint, "second");
});

test("Prisma persistence claims only a currently due watching lead with its own lease token", async () => {
  const now = new Date("2026-07-19T12:00:00.000Z");
  const leaseExpiresAt = new Date("2026-07-19T12:05:00.000Z");
  const watch = {
    leadId: 100,
    leadCreatedAt: new Date("2026-07-16T10:00:00.000Z"),
    lastActivityAt: new Date("2026-07-16T12:00:00.000Z"),
    lastActivityReceivedAt: new Date("2026-07-16T12:00:01.000Z"),
    dueAt: now,
    pipelineId: 9055778,
    statusId: 72917586,
    cycle: 1,
    state: "watching",
    leaseToken: null,
    leaseExpiresAt: null,
    leaseGeneration: 0,
    lastEventFingerprint: "event-1",
  };
  let receivedWhere;
  const database = {
    $transaction: async (operation) => operation(database),
    leadInactivityWatch: {
      updateMany: async ({ where, data }) => {
        receivedWhere = where;
        const eligible = watch.leadId === where.leadId
          && watch.state === where.state
          && watch.dueAt <= where.dueAt.lte;
        if (!eligible) return { count: 0 };
        const { leaseGeneration, ...rest } = data;
        Object.assign(watch, rest);
        if (leaseGeneration?.increment) watch.leaseGeneration += leaseGeneration.increment;
        return { count: 1 };
      },
      findFirst: async ({ where }) => (
        watch.leadId === where.leadId && watch.state === where.state && watch.leaseToken === where.leaseToken
          ? watch
          : null
      ),
    },
  };
  const persistence = createPrismaLeadInactivityPersistence(database);

  const claimed = await persistence.claimDueWatch(100, now, "lease-1", leaseExpiresAt);
  const secondClaim = await persistence.claimDueWatch(100, now, "lease-2", leaseExpiresAt);

  assert.equal(receivedWhere.state, "watching");
  assert.equal(receivedWhere.dueAt.lte.toISOString(), now.toISOString());
  assert.equal(claimed.leaseToken, "lease-1");
  assert.equal(claimed.leaseGeneration, 1);
  assert.equal(secondClaim, null);
});
