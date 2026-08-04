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

function watch(overrides = {}) {
  return {
    leadId: 100,
    leadCreatedAt: new Date("2026-07-16T10:00:00.000Z"),
    lastActivityAt: new Date("2026-07-16T12:00:00.000Z"),
    lastActivityReceivedAt: new Date("2026-07-16T12:00:01.000Z"),
    dueAt: new Date("2026-07-19T12:00:00.000Z"),
    pipelineId: 9055778,
    statusId: 72917586,
    cycle: 1,
    state: "watching",
    leaseToken: null,
    leaseExpiresAt: null,
    leaseGeneration: 0,
    lastEventFingerprint: "event-1",
    stoppedAt: null,
    lastFailureReason: null,
    ...overrides,
  };
}

test("Prisma persistence conditionally replaces a setting with a compare-and-set fence", async () => {
  let received = null;
  const persistence = createPrismaLeadInactivityPersistence({
    leadInactivitySetting: {
      updateMany: async (query) => {
        received = query;
        return { count: 1 };
      },
    },
  });

  assert.equal(await persistence.replaceSettingIfValue("worker-run", "old", "new"), true);
  assert.deepEqual(received, {
    where: { key: "worker-run", value: "old" },
    data: { value: "new" },
  });
});

test("Prisma persistence accepts a mutating watch so an incoming webhook can revoke its fence", async () => {
  const persistence = createPrismaLeadInactivityPersistence({
    leadInactivityWatch: {
      findUnique: async () => watch({ state: "mutating", leaseToken: "lease-100", leaseGeneration: 3 }),
    },
  });

  const current = await persistence.getWatch(100);

  assert.equal(current.state, "mutating");
});

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
  const currentWatch = watch({ pipelineId: 1, statusId: 10, lastEventFingerprint: "first" });
  let receivedWhere;
  const database = {
    leadInactivityWatch: {
      updateMany: async ({ where, data }) => {
        receivedWhere = where;
        const tieBreaker = where.OR[1];
        const eligible = currentWatch.leadId === where.leadId
          && currentWatch.lastActivityAt.getTime() === tieBreaker.lastActivityAt.getTime()
          && currentWatch.lastActivityReceivedAt < tieBreaker.lastActivityReceivedAt.lt;
        if (!eligible) return { count: 0 };
        Object.assign(currentWatch, data);
        return { count: 1 };
      },
      findUnique: async () => currentWatch,
    },
  };
  const persistence = createPrismaLeadInactivityPersistence(database);

  const advanced = await persistence.advanceWatchIfNewer(100, {
    ...currentWatch,
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
  const currentWatch = watch({ dueAt: now });
  let receivedWhere;
  const database = {
    $transaction: async (operation) => operation(database),
    leadInactivityWatch: {
      updateMany: async ({ where, data }) => {
        receivedWhere = where;
        const eligible = currentWatch.leadId === where.leadId
          && currentWatch.state === where.state
          && currentWatch.dueAt <= where.dueAt.lte;
        if (!eligible) return { count: 0 };
        const { leaseGeneration, ...rest } = data;
        Object.assign(currentWatch, rest);
        if (leaseGeneration?.increment) currentWatch.leaseGeneration += leaseGeneration.increment;
        return { count: 1 };
      },
      findFirst: async ({ where }) => (
        currentWatch.leadId === where.leadId && currentWatch.state === where.state && currentWatch.leaseToken === where.leaseToken
          ? currentWatch
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

test("Prisma persistence selects due watches, fences completion, and records a slot-linked audit", async () => {
  const now = new Date("2026-07-19T12:00:00.000Z");
  const claimed = watch({ state: "leased", leaseToken: "lease-100", leaseGeneration: 3 });
  const calls = { due: null, finish: null, audit: null, completion: null };
  const database = {
    leadInactivityWatch: {
      findMany: async (query) => {
        calls.due = query;
        return [{ leadId: 101 }, { leadId: 100 }];
      },
      findFirst: async ({ where }) => (
        where.leaseToken === "lease-100" && where.leaseGeneration === 3 ? { leadId: 100 } : null
      ),
      updateMany: async ({ where, data }) => {
        calls.finish = { where, data };
        return { count: 1 };
      },
      findUnique: async () => ({ ...claimed, state: "moved", leaseToken: null, leaseExpiresAt: null, stoppedAt: now }),
    },
    leadInactivityMoveAudit: {
      create: async ({ data }) => { calls.audit = data; return { id: data.id }; },
      updateMany: async ({ where, data }) => { calls.completion = { where, data }; return { count: 1 }; },
    },
  };
  const persistence = createPrismaLeadInactivityPersistence(database);

  const priorityGroup = [
    { pipelineId: 6909890, statusId: 58160902 },
    { pipelineId: 9055778, statusId: 72919958 },
  ];
  assert.deepEqual(await persistence.listDueWatchLeadIds(now, 5, priorityGroup), [101, 100]);
  assert.deepEqual(calls.due, {
    where: {
      state: "watching",
      dueAt: { lte: now },
      OR: priorityGroup,
    },
    orderBy: [{ dueAt: "asc" }, { leadId: "asc" }],
    take: 5,
    select: { leadId: true },
  });
  assert.equal(await persistence.isWatchClaimCurrent(claimed), true);
  const finished = await persistence.finishWatchClaim(claimed, "moved", null, now);
  assert.equal(finished.state, "moved");
  assert.equal(calls.finish.where.leaseGeneration, 3);
  assert.equal(calls.finish.data.stoppedAt.toISOString(), now.toISOString());

  await persistence.createMoveAudit({
    id: "audit-100", leadId: 100, cycle: 1, sourcePipelineId: 9055778, sourceStatusId: 72917586,
    targetPipelineId: 9055770, targetStatusId: 72917546, eventCutoffAt: claimed.lastActivityAt,
  });
  assert.equal(calls.audit.outcome, "reserved");
  assert.equal(calls.audit.targetStatusId, 72917546);
  assert.equal(await persistence.completeMoveAudit("audit-100", { kind: "confirmed", slotNumber: 1 }, now), true);
  assert.equal(calls.completion.where.outcome, "reserved");
  assert.equal(calls.completion.data.outcome, "confirmed");
  assert.equal(calls.completion.data.slotNumber, 1);
});

test("Prisma persistence transitions a fenced lease to mutating and lets an activity advance revoke it", async () => {
  const currentWatch = watch({ state: "leased", leaseToken: "lease-100", leaseGeneration: 3 });
  const operations = [];
  const database = {
    leadInactivityWatch: {
      updateMany: async ({ where, data }) => {
        operations.push({ where, data });
        if (where.OR) {
          if (currentWatch.leadId !== where.leadId || currentWatch.lastActivityAt >= where.OR[0].lastActivityAt.lt) return { count: 0 };
          Object.assign(currentWatch, data);
          return { count: 1 };
        }
        const allowedState = Array.isArray(where.state?.in) ? where.state.in.includes(currentWatch.state) : currentWatch.state === where.state;
        if (currentWatch.leadId !== where.leadId || !allowedState || currentWatch.leaseToken !== where.leaseToken || currentWatch.leaseGeneration !== where.leaseGeneration) return { count: 0 };
        Object.assign(currentWatch, data);
        return { count: 1 };
      },
      findFirst: async ({ where }) => (
        currentWatch.leadId === where.leadId
          && currentWatch.state === where.state
          && currentWatch.leaseToken === where.leaseToken
          && currentWatch.leaseGeneration === where.leaseGeneration
          ? { leadId: currentWatch.leadId }
          : null
      ),
      findUnique: async () => currentWatch,
    },
  };
  const persistence = createPrismaLeadInactivityPersistence(database);

  assert.equal(await persistence.beginMoveMutation(currentWatch), true);
  assert.equal(currentWatch.state, "mutating");
  assert.equal(await persistence.isMoveMutationCurrent(currentWatch), true);

  const advanced = await persistence.advanceWatchIfNewer(100, {
    ...currentWatch,
    lastActivityAt: new Date("2026-07-16T12:01:00.000Z"),
    lastActivityReceivedAt: new Date("2026-07-19T12:00:00.000Z"),
    dueAt: new Date("2026-07-19T12:01:00.000Z"),
    state: "watching",
    leaseToken: null,
    leaseExpiresAt: null,
  });

  assert.equal(advanced.state, "watching");
  assert.equal(await persistence.isMoveMutationCurrent(currentWatch), false);
  assert.equal(operations[0].where.state, "leased");
});
