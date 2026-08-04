const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createLeadInactivityStore,
  ACTIVATION_BOUNDARY_SETTING_KEY,
  PRODUCTION_BASELINE_SETTING_KEY,
  PRODUCTION_BASELINE_COMPLETED_SETTING_KEY,
  WORKER_RUN_LEASE_SETTING_KEY,
  INACTIVITY_MS,
} = require("../dist/services/leadInactivityStore");

class MemoryPersistence {
  constructor() {
    this.settings = new Map();
    this.events = new Map();
    this.watches = new Map();
    this.slots = new Map();
    this.transactionCalls = 0;
  }

  async transaction(operation) {
    this.transactionCalls += 1;
    return operation(this);
  }

  async getSetting(key) {
    return this.settings.get(key) ?? null;
  }

  async createSettingIfAbsent(key, value) {
    if (!this.settings.has(key)) this.settings.set(key, value);
    return this.settings.get(key);
  }

  async replaceSettingIfValue(key, expectedValue, nextValue) {
    if (this.settings.get(key) !== expectedValue) return false;
    this.settings.set(key, nextValue);
    return true;
  }

  async insertEventIfAbsent(event) {
    if (this.events.has(event.fingerprint)) return false;
    this.events.set(event.fingerprint, event);
    return true;
  }

  async hasProductionBaselineEvent(leadId) {
    return [...this.events.values()].some((event) => event.leadId === leadId && event.eventType === "production_baseline");
  }

  async getWatch(leadId) {
    return this.watches.get(leadId) ?? null;
  }

  async createWatchIfAbsent(watch) {
    if (!this.watches.has(watch.leadId)) this.watches.set(watch.leadId, { ...watch });
    return this.watches.get(watch.leadId);
  }

  async advanceWatchIfNewer(leadId, next) {
    const current = this.watches.get(leadId);
    if (!current) return null;
    const isNewer = current.lastActivityAt < next.lastActivityAt
      || (current.lastActivityAt.getTime() === next.lastActivityAt.getTime()
        && current.lastActivityReceivedAt < next.lastActivityReceivedAt);
    if (!isNewer) return null;
    const updated = { ...current, ...next, state: "watching", leaseToken: null, leaseExpiresAt: null };
    this.watches.set(leadId, updated);
    return updated;
  }

  async markWatchUncertainForOrderConflict(leadId, eventAt, receivedAt) {
    const watch = this.watches.get(leadId);
    if (!watch || watch.lastActivityAt.getTime() !== eventAt.getTime()
      || watch.lastActivityReceivedAt.getTime() !== receivedAt.getTime()) return null;
    const uncertain = {
      ...watch,
      state: "uncertain",
      leaseToken: null,
      leaseExpiresAt: null,
    };
    this.watches.set(leadId, uncertain);
    return uncertain;
  }

  async claimDueWatch(leadId, now, leaseToken, leaseExpiresAt) {
    const watch = this.watches.get(leadId);
    if (!watch || watch.state !== "watching" || watch.dueAt > now) return null;
    const claimed = {
      ...watch,
      state: "leased",
      leaseToken,
      leaseExpiresAt,
      leaseGeneration: watch.leaseGeneration + 1,
    };
    this.watches.set(leadId, claimed);
    return claimed;
  }

  async releaseExpiredWatchLeases(now) {
    for (const [leadId, watch] of this.watches) {
      if (["leased", "mutating"].includes(watch.state) && watch.leaseExpiresAt <= now) {
        this.watches.set(leadId, { ...watch, state: "watching", leaseToken: null, leaseExpiresAt: null });
      }
    }
  }

  async listDueWatchLeadIds(now, limit, stagePairs) {
    return [...this.watches.values()]
      .filter((watch) => watch.state === "watching" && watch.dueAt <= now)
      .filter((watch) => !stagePairs?.length || stagePairs.some((stage) => (
        stage.pipelineId === watch.pipelineId && stage.statusId === watch.statusId
      )))
      .sort((left, right) => left.dueAt - right.dueAt || left.leadId - right.leadId)
      .slice(0, limit)
      .map((watch) => watch.leadId);
  }

  async isWatchClaimCurrent(lease) {
    const current = this.watches.get(lease.leadId);
    return Boolean(current && current.state === "leased" && current.leaseToken === lease.leaseToken && current.leaseGeneration === lease.leaseGeneration);
  }

  async beginMoveMutation(lease) {
    const current = this.watches.get(lease.leadId);
    if (!current || current.state !== "leased" || current.leaseToken !== lease.leaseToken || current.leaseGeneration !== lease.leaseGeneration) return false;
    this.watches.set(lease.leadId, { ...current, state: "mutating" });
    return true;
  }

  async isMoveMutationCurrent(lease) {
    const current = this.watches.get(lease.leadId);
    return Boolean(current && current.state === "mutating" && current.leaseToken === lease.leaseToken && current.leaseGeneration === lease.leaseGeneration);
  }

  async finishWatchClaim(lease, state, reason, now) {
    const current = this.watches.get(lease.leadId);
    if (!current || !["leased", "mutating"].includes(current.state) || current.leaseToken !== lease.leaseToken || current.leaseGeneration !== lease.leaseGeneration) return null;
    const finished = {
      ...current,
      state,
      leaseToken: null,
      leaseExpiresAt: null,
      stoppedAt: state === "watching" ? null : now,
      lastFailureReason: reason,
    };
    this.watches.set(lease.leadId, finished);
    return finished;
  }

  async createMoveAudit(audit) {
    if (!this.audits) this.audits = new Map();
    if (this.audits.has(audit.id)) return false;
    this.audits.set(audit.id, { ...audit, outcome: "reserved" });
    return true;
  }

  async completeMoveAudit(auditId, outcome) {
    const audit = this.audits?.get(auditId);
    if (!audit) return null;
    const completed = { ...audit, ...outcome };
    this.audits.set(auditId, completed);
    return completed;
  }

  async ensureTestSlots(limit) {
    for (let slotNumber = 1; slotNumber <= limit; slotNumber += 1) {
      if (!this.slots.has(slotNumber)) this.slots.set(slotNumber, { slotNumber, state: "free" });
    }
  }

  async reserveFreeTestSlot(leadId, auditId, now, leaseExpiresAt) {
    const slot = [...this.slots.values()].find((candidate) => candidate.state === "free");
    if (!slot) return null;
    const reserved = { ...slot, state: "reserved", leadId, auditId, reservedAt: now, leaseExpiresAt };
    this.slots.set(slot.slotNumber, reserved);
    return reserved;
  }

  async confirmTestSlot(slotNumber, auditId, confirmedAt) {
    const slot = this.slots.get(slotNumber);
    if (!slot || slot.state !== "reserved" || slot.auditId !== auditId) return null;
    const confirmed = { ...slot, state: "confirmed", confirmedAt, leaseExpiresAt: null };
    this.slots.set(slotNumber, confirmed);
    return confirmed;
  }

  async releaseTestSlotAfterKnownNoMove(slotNumber, auditId) {
    const slot = this.slots.get(slotNumber);
    if (!slot || slot.state !== "reserved" || slot.auditId !== auditId) return false;
    this.slots.set(slotNumber, {
      ...slot,
      state: "free",
      leadId: null,
      auditId: null,
      reservedAt: null,
      confirmedAt: null,
      leaseExpiresAt: null,
    });
    return true;
  }

  async markTestSlotUncertain(slotNumber, auditId, uncertainAt) {
    const slot = this.slots.get(slotNumber);
    if (!slot || slot.state !== "reserved" || slot.auditId !== auditId) return null;
    const uncertain = { ...slot, state: "uncertain", confirmedAt: uncertainAt, leaseExpiresAt: null };
    this.slots.set(slotNumber, uncertain);
    return uncertain;
  }

  async markExpiredTestSlotLeasesUncertain(now) {
    for (const [slotNumber, slot] of this.slots) {
      if (slot.state === "reserved" && slot.leaseExpiresAt <= now) {
        this.slots.set(slotNumber, {
          ...slot,
          state: "uncertain",
          confirmedAt: now,
          leaseExpiresAt: null,
        });
      }
    }
  }

  async hasUncertainTestSlot() {
    return [...this.slots.values()].some((slot) => slot.state === "uncertain");
  }
}

function createFixture(options = {}) {
  const persistence = new MemoryPersistence();
  persistence.settings.set(ACTIVATION_BOUNDARY_SETTING_KEY, "2026-07-01T00:00:00.000Z");
  return createLeadInactivityStore(persistence, {
    clock: () => new Date("2026-07-19T12:00:00.000Z"),
    randomId: () => "lease-token",
    ...options,
  });
}

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

test("elects only one cross-replica worker pass and releases it with a compare-and-set fence", async () => {
  const persistence = new MemoryPersistence();
  const now = new Date("2026-07-19T12:00:00.000Z");
  const first = createLeadInactivityStore(persistence, { clock: () => now, workerRunLeaseMs: 60_000 });
  const second = createLeadInactivityStore(persistence, { clock: () => now, workerRunLeaseMs: 60_000 });

  assert.deepEqual(await Promise.all([
    first.tryAcquireWorkerRunLease("worker-a", now),
    second.tryAcquireWorkerRunLease("worker-b", now),
  ]), [true, false]);
  assert.equal(JSON.parse(persistence.settings.get(WORKER_RUN_LEASE_SETTING_KEY)).token, "worker-a");
  assert.equal(await second.releaseWorkerRunLease("worker-b", now), false);
  assert.equal(await first.releaseWorkerRunLease("worker-a", now), true);
  const afterThirtySeconds = new Date("2026-07-19T12:00:30.000Z");
  assert.equal(await second.tryAcquireWorkerRunLease("worker-b", afterThirtySeconds), false);
  const nextMinute = new Date("2026-07-19T12:01:00.000Z");
  assert.equal(await second.tryAcquireWorkerRunLease("worker-b", nextMinute), true);
});

test("does not claim a due watch under a run token replaced after its renewal window", async () => {
  const persistence = new MemoryPersistence();
  const startedAt = new Date("2026-07-19T12:00:00.000Z");
  const takeoverAt = new Date("2026-07-19T12:01:00.000Z");
  const first = createLeadInactivityStore(persistence, { clock: () => startedAt, workerRunLeaseMs: 1_000, randomId: () => "watch-a" });
  const replacement = createLeadInactivityStore(persistence, { clock: () => takeoverAt, workerRunLeaseMs: 1_000, randomId: () => "watch-b" });
  persistence.watches.set(100, {
    leadId: 100,
    leadCreatedAt: new Date("2026-07-16T10:00:00.000Z"),
    lastActivityAt: new Date("2026-07-16T12:00:00.000Z"),
    lastActivityReceivedAt: new Date("2026-07-16T12:00:01.000Z"),
    dueAt: new Date("2026-07-19T11:59:59.000Z"),
    pipelineId: 9055778,
    statusId: 72917586,
    cycle: 1,
    state: "watching",
    leaseToken: null,
    leaseExpiresAt: null,
    leaseGeneration: 0,
    lastEventFingerprint: "event-1",
  });

  assert.equal(await first.tryAcquireWorkerRunLease("worker-a", startedAt), true);
  assert.equal(await replacement.tryAcquireWorkerRunLease("worker-b", takeoverAt), true);
  assert.equal(await first.claimDueWatchForWorkerRun(100, "worker-a", takeoverAt), null);
  assert.equal(persistence.watches.get(100).state, "watching");
});

test("renews global worker cooldown before each additional claim", async () => {
  const persistence = new MemoryPersistence();
  const startedAt = new Date("2026-07-19T12:00:00.000Z");
  const renewedAt = new Date("2026-07-19T12:00:30.000Z");
  const store = createLeadInactivityStore(persistence, { clock: () => startedAt, workerRunLeaseMs: 60_000 });
  const otherReplica = createLeadInactivityStore(persistence, { clock: () => startedAt, workerRunLeaseMs: 60_000 });

  assert.equal(await store.tryAcquireWorkerRunLease("worker-a", startedAt), true);
  assert.equal(await store.renewWorkerRunLease("worker-a", renewedAt), true);
  assert.equal(await store.releaseWorkerRunLease("worker-a", renewedAt), true);
  assert.equal(await otherReplica.tryAcquireWorkerRunLease("worker-b", new Date("2026-07-19T12:01:00.000Z")), false);
  assert.equal(await otherReplica.tryAcquireWorkerRunLease("worker-b", new Date("2026-07-19T12:01:30.000Z")), true);
});

test("creates one durable activation boundary rounded up to the next second and one watch", async () => {
  const persistence = new MemoryPersistence();
  const store = createLeadInactivityStore(persistence, {
    clock: () => new Date("2026-07-19T12:00:00.000Z"),
    randomId: () => "lease-token",
  });
  const first = await store.getOrCreateActivationBoundary(new Date("2026-07-19T12:00:00.123Z"));
  const later = await store.getOrCreateActivationBoundary(new Date("2026-07-19T13:00:00.000Z"));
  const recorded = await store.recordLeadEvent(event({
    eventAt: new Date("2026-07-19T12:02:00.000Z"),
    receivedAt: new Date("2026-07-19T12:02:01.000Z"),
    leadCreatedAt: new Date("2026-07-19T12:01:00.000Z"),
  }));

  assert.equal(first.toISOString(), "2026-07-19T12:00:01.000Z");
  assert.equal(later.toISOString(), first.toISOString());
  assert.equal(recorded.duplicate, false);
  assert.equal(recorded.watch.leadId, 100);
  assert.equal(recorded.watch.lastEventFingerprint, "event-1");
  assert.equal(recorded.watch.dueAt.getTime(), recorded.watch.lastActivityAt.getTime() + INACTIVITY_MS);
});

test("uses an explicitly configured inactivity delay when creating a watch", async () => {
  const persistence = new MemoryPersistence();
  persistence.settings.set(ACTIVATION_BOUNDARY_SETTING_KEY, "2026-07-01T00:00:00.000Z");
  const oneDayMs = 24 * 60 * 60 * 1000;
  const store = createLeadInactivityStore(persistence, { inactivityMs: oneDayMs });

  const recorded = await store.recordLeadEvent(event({ fingerprint: "one-day-delay" }));

  assert.equal(recorded.watch.dueAt.getTime(), recorded.watch.lastActivityAt.getTime() + oneDayMs);
});

test("rejects a malformed persisted activation boundary instead of silently accepting it", async () => {
  const persistence = new MemoryPersistence();
  persistence.settings.set(ACTIVATION_BOUNDARY_SETTING_KEY, "not-a-date");
  const store = createLeadInactivityStore(persistence);

  await assert.rejects(store.getOrCreateActivationBoundary(), /activation boundary is invalid/);
});

test("rejects historical leads at or before the persistent activation boundary", async () => {
  const persistence = new MemoryPersistence();
  const store = createLeadInactivityStore(persistence);
  const boundary = await store.getOrCreateActivationBoundary(new Date("2026-07-19T12:00:00.123Z"));

  const older = await store.recordLeadEvent(event({
    fingerprint: "older-lead",
    leadCreatedAt: new Date("2026-07-19T12:00:00.999Z"),
  }));
  const atBoundary = await store.recordLeadEvent(event({
    fingerprint: "boundary-lead",
    leadCreatedAt: boundary,
  }));

  assert.equal(older.ignored, true);
  assert.equal(atBoundary.ignored, true);
  assert.equal(persistence.events.size, 0);
  assert.equal(persistence.watches.size, 0);
});

test("records an event and its watch through one persistence transaction", async () => {
  const persistence = new MemoryPersistence();
  persistence.settings.set(ACTIVATION_BOUNDARY_SETTING_KEY, "2026-07-01T00:00:00.000Z");
  const store = createLeadInactivityStore(persistence);

  await store.recordLeadEvent(event());

  assert.equal(persistence.transactionCalls, 1);
});

test("advances a watch when a concurrent create returned an older event", async () => {
  class EarlierConcurrentWritePersistence extends MemoryPersistence {
    async createWatchIfAbsent(watch) {
      const earlier = {
        ...watch,
        lastActivityAt: new Date(watch.lastActivityAt.getTime() - 1_000),
        dueAt: new Date(watch.dueAt.getTime() - 1_000),
        lastEventFingerprint: "earlier-event",
      };
      this.watches.set(watch.leadId, earlier);
      return earlier;
    }
  }

  const persistence = new EarlierConcurrentWritePersistence();
  persistence.settings.set(ACTIVATION_BOUNDARY_SETTING_KEY, "2026-07-01T00:00:00.000Z");
  const store = createLeadInactivityStore(persistence);
  const recorded = await store.recordLeadEvent(event());

  assert.equal(recorded.watch.lastActivityAt.toISOString(), "2026-07-16T12:00:00.000Z");
  assert.equal(recorded.watch.lastEventFingerprint, "event-1");
});

test("starts a new cycle after a completed auto-move is manually returned to source", async () => {
  const persistence = new MemoryPersistence();
  persistence.settings.set(ACTIVATION_BOUNDARY_SETTING_KEY, "2026-07-01T00:00:00.000Z");
  persistence.watches.set(100, {
    leadId: 100,
    leadCreatedAt: new Date("2026-07-16T10:00:00.000Z"),
    lastActivityAt: new Date("2026-07-16T11:00:00.000Z"),
    lastActivityReceivedAt: new Date("2026-07-16T11:00:01.000Z"),
    dueAt: new Date("2026-07-19T11:00:00.000Z"),
    pipelineId: 9055770,
    statusId: 72917546,
    cycle: 1,
    state: "moved",
    leaseToken: null,
    leaseExpiresAt: null,
    lastEventFingerprint: "move-event",
  });
  const store = createLeadInactivityStore(persistence);
  const recorded = await store.recordLeadEvent(event({
    fingerprint: "manual-reentry",
    eventAt: new Date("2026-07-16T12:00:00.000Z"),
  }));

  assert.equal(recorded.watch.cycle, 2);
  assert.equal(recorded.watch.state, "watching");
});

test("deduplicates webhook events and never moves a deadline backwards", async () => {
  const store = createFixture();
  const first = await store.recordLeadEvent(event());
  const replay = await store.recordLeadEvent(event());
  const older = await store.recordLeadEvent(event({
    fingerprint: "event-older",
    eventAt: new Date("2026-07-16T11:00:00.000Z"),
  }));
  const newer = await store.recordLeadEvent(event({
    fingerprint: "event-newer",
    eventAt: new Date("2026-07-16T14:00:00.000Z"),
  }));

  assert.equal(replay.duplicate, true);
  assert.equal(replay.watch.lastActivityAt.toISOString(), first.watch.lastActivityAt.toISOString());
  assert.equal(older.watch.lastActivityAt.toISOString(), first.watch.lastActivityAt.toISOString());
  assert.equal(newer.watch.lastActivityAt.toISOString(), "2026-07-16T14:00:00.000Z");
  assert.equal(newer.watch.dueAt.toISOString(), "2026-07-19T14:00:00.000Z");
});

test("uses received time as a deterministic tie-breaker for equal amo event timestamps", async () => {
  const store = createFixture();
  const eventAt = new Date("2026-07-16T12:00:00.000Z");
  await store.recordLeadEvent(event({
    fingerprint: "same-second-first",
    eventAt,
    receivedAt: new Date("2026-07-16T12:00:01.000Z"),
    pipelineId: 1,
    statusId: 10,
  }));

  const recorded = await store.recordLeadEvent(event({
    fingerprint: "same-second-second",
    eventAt,
    receivedAt: new Date("2026-07-16T12:00:02.000Z"),
    pipelineId: 2,
    statusId: 20,
  }));

  assert.equal(recorded.watch.pipelineId, 2);
  assert.equal(recorded.watch.statusId, 20);
  assert.equal(recorded.watch.lastEventFingerprint, "same-second-second");
});

test("fails closed when two distinct events have an identical activity and received timestamp", async () => {
  const store = createFixture();
  const eventAt = new Date("2026-07-16T12:00:00.000Z");
  const receivedAt = new Date("2026-07-16T12:00:01.000Z");
  await store.recordLeadEvent(event({ fingerprint: "ambiguous-first", eventAt, receivedAt }));

  const ambiguous = await store.recordLeadEvent(event({
    fingerprint: "ambiguous-second",
    eventAt,
    receivedAt,
    pipelineId: 2,
    statusId: 20,
  }));

  assert.equal(ambiguous.requiresFreshRead, true);
  assert.equal(ambiguous.watch.state, "uncertain");
});

test("atomically leases a due watch to only one claimant", async () => {
  const store = createFixture();
  await store.recordLeadEvent(event());
  const now = new Date("2026-07-19T12:00:00.000Z");
  const [first, second] = await Promise.all([
    store.claimDueWatch(100, now),
    store.claimDueWatch(100, now),
  ]);

  assert.equal(Boolean(first) !== Boolean(second), true);
  assert.equal((first ?? second).state, "leased");
  assert.equal((first ?? second).leaseGeneration, 1);
});

test("reserves a testing slot inside the persistence transaction", async () => {
  const persistence = new MemoryPersistence();
  persistence.settings.set(ACTIVATION_BOUNDARY_SETTING_KEY, "2026-07-01T00:00:00.000Z");
  const store = createLeadInactivityStore(persistence);
  await store.ensureTestSlots(5);

  await store.reserveTestSlot(100, "audit-transaction", new Date("2026-07-19T12:00:00.000Z"));

  assert.equal(persistence.transactionCalls, 1);
});

test("returns a slot to free capacity only after a known no-move outcome", async () => {
  const store = createFixture();
  await store.ensureTestSlots(5);
  const first = await store.reserveTestSlot(100, "audit-known-failure");

  await store.releaseTestSlotAfterKnownNoMove(first.slotNumber, "audit-known-failure");
  const retry = await store.reserveTestSlot(101, "audit-after-known-failure");

  assert.equal(retry.slotNumber, first.slotNumber);
  assert.equal(retry.leadId, 101);
});

test("converts an expired reserved test slot to uncertain before any later reservation", async () => {
  const store = createFixture({ testSlotLeaseMs: 1_000 });
  await store.ensureTestSlots(5);
  const first = await store.reserveTestSlot(100, "audit-expired", new Date("2026-07-19T12:00:00.000Z"));
  const second = await store.reserveTestSlot(101, "audit-next", new Date("2026-07-19T12:00:01.001Z"));

  assert.equal(first.state, "reserved");
  assert.equal(second, null);
});

test("rejects a runtime increase above the approved five testing slots", async () => {
  const store = createFixture();
  await assert.rejects(store.ensureTestSlots(6), /exactly 5/);
});

test("blocks a sixth confirmed testing move after five durable slots", async () => {
  const store = createFixture();
  const now = new Date("2026-07-19T12:00:00.000Z");
  await store.ensureTestSlots(5);

  for (let index = 1; index <= 5; index += 1) {
    const slot = await store.reserveTestSlot(index, `audit-${index}`, now);
    assert.ok(slot);
    const confirmed = await store.confirmTestSlot(slot.slotNumber, `audit-${index}`, now);
    assert.equal(confirmed.state, "confirmed");
  }

  assert.equal(await store.reserveTestSlot(6, "audit-6", now), null);
});

test("a newer webhook event atomically invalidates a mutating worker fence before PATCH", async () => {
  const store = createFixture();
  const initial = event();
  await store.recordLeadEvent(initial);
  const claimed = await store.claimDueWatch(100, new Date("2026-07-19T12:00:00.000Z"));
  await store.beginMoveMutation(claimed);
  assert.equal(await store.isMoveMutationCurrent(claimed), true);

  await store.recordLeadEvent(event({
    fingerprint: "event-2",
    eventAt: new Date("2026-07-16T12:01:00.000Z"),
    receivedAt: new Date("2026-07-19T12:00:01.000Z"),
  }));

  assert.equal(await store.isMoveMutationCurrent(claimed), false);
});

test("lists due watches deterministically and fences worker completion by its lease generation", async () => {
  const persistence = new MemoryPersistence();
  persistence.settings.set(ACTIVATION_BOUNDARY_SETTING_KEY, "2026-07-01T00:00:00.000Z");
  const now = new Date("2026-07-19T12:00:00.000Z");
  persistence.watches.set(100, {
    leadId: 100,
    leadCreatedAt: new Date("2026-07-16T10:00:00.000Z"),
    lastActivityAt: new Date("2026-07-16T12:00:00.000Z"),
    lastActivityReceivedAt: new Date("2026-07-16T12:00:01.000Z"),
    dueAt: new Date("2026-07-19T11:59:00.000Z"),
    pipelineId: 9055778,
    statusId: 72917586,
    cycle: 1,
    state: "watching",
    leaseToken: null,
    leaseExpiresAt: null,
    leaseGeneration: 0,
    lastEventFingerprint: "one",
  });
  persistence.watches.set(101, {
    ...persistence.watches.get(100),
    leadId: 101,
    dueAt: new Date("2026-07-19T11:58:00.000Z"),
    pipelineId: 6909890,
    statusId: 58160902,
  });
  persistence.watches.set(102, {
    ...persistence.watches.get(100),
    leadId: 102,
    dueAt: new Date("2026-07-19T12:01:00.000Z"),
  });
  const store = createLeadInactivityStore(persistence, { clock: () => now, randomId: () => "lease-100" });

  assert.deepEqual(await store.listDueWatchLeadIds(now, 2), [101, 100]);
  assert.deepEqual(
    await store.listDueWatchLeadIds(now, 2, [{ pipelineId: 6909890, statusId: 58160902 }]),
    [101],
  );
  const claimed = await store.claimDueWatch(100, now);
  assert.equal(await store.isWatchClaimCurrent(claimed), true);
  await store.finishWatchClaim(claimed, "moved", null, now);

  assert.equal(persistence.watches.get(100).state, "moved");
  assert.equal(await store.isWatchClaimCurrent(claimed), false);
  assert.equal(persistence.watches.get(100).leaseToken, null);
  await assert.rejects(store.finishWatchClaim(claimed, "moved", null, now), /unable to finish/);
});

test("blocks all further testing moves after an uncertain PATCH result", async () => {
  const store = createFixture();
  const now = new Date("2026-07-19T12:00:00.000Z");
  await store.ensureTestSlots(5);
  const reserved = await store.reserveTestSlot(100, "audit-uncertain", now);
  assert.ok(reserved);

  const uncertain = await store.markTestSlotUncertain(reserved.slotNumber, "audit-uncertain", now);
  assert.equal(uncertain.state, "uncertain");
  assert.equal(await store.reserveTestSlot(101, "audit-after-uncertain", now), null);
});

test("baselines an eligible historical lead from one durable timestamp without weakening normal activation filtering", async () => {
  const persistence = new MemoryPersistence();
  persistence.settings.set(ACTIVATION_BOUNDARY_SETTING_KEY, "2026-07-19T12:00:00.000Z");
  const store = createLeadInactivityStore(persistence, { inactivityMs: INACTIVITY_MS });
  const baselineAt = await store.getOrCreateProductionBaseline(new Date("2026-07-22T10:00:00.123Z"));

  const recorded = await store.recordProductionBaseline({
    leadId: 900,
    leadCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
    pipelineId: 9055778,
    statusId: 72917586,
  }, baselineAt);
  const normalEvent = await store.recordLeadEvent(event({
    fingerprint: "still-blocked-historical-event",
    leadId: 901,
    leadCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
  }));
  const historicalActivityAfterBaseline = await store.recordLeadEvent(event({
    fingerprint: "historical-lead-activity-after-baseline",
    leadId: 900,
    leadCreatedAt: new Date("2026-07-01T12:00:00.000Z"),
    eventAt: new Date("2026-07-22T11:00:00.000Z"),
    receivedAt: new Date("2026-07-22T11:00:00.000Z"),
  }));

  assert.equal(baselineAt.toISOString(), "2026-07-22T10:00:01.000Z");
  assert.equal(persistence.settings.get(PRODUCTION_BASELINE_SETTING_KEY), baselineAt.toISOString());
  assert.equal(recorded.ignored, false);
  assert.equal(recorded.watch.lastActivityAt.toISOString(), baselineAt.toISOString());
  assert.equal(recorded.watch.dueAt.getTime(), baselineAt.getTime() + INACTIVITY_MS);
  assert.equal(normalEvent.ignored, true);
  assert.equal(historicalActivityAfterBaseline.ignored, false);
  assert.equal(historicalActivityAfterBaseline.watch.lastActivityAt.toISOString(), "2026-07-22T11:00:00.000Z");
  assert.equal(historicalActivityAfterBaseline.watch.dueAt.getTime(), new Date("2026-07-25T11:00:00.000Z").getTime());
  assert.equal(persistence.events.get(recorded.watch.lastEventFingerprint).eventType, "production_baseline");
});

test("locks a production baseline to one durable run and completes it only after enrollment", async () => {
  const persistence = new MemoryPersistence();
  const store = createLeadInactivityStore(persistence);
  const run = await store.beginProductionBaseline("baseline-run-a", new Date("2026-07-22T10:00:00.000Z"));

  assert.equal(await store.isProductionBaselineComplete(), false);
  await assert.rejects(
    store.beginProductionBaseline("baseline-run-b", new Date("2026-07-22T10:00:01.000Z")),
    /baseline run is already in progress/,
  );
  await store.completeProductionBaseline(run);

  assert.equal(await store.isProductionBaselineComplete(), true);
  assert.match(persistence.settings.get(PRODUCTION_BASELINE_COMPLETED_SETTING_KEY), /baseline-run-a/);
  const replay = await store.beginProductionBaseline("baseline-run-b", new Date("2026-07-23T10:00:00.000Z"));
  assert.deepEqual(replay, { ...run, alreadyCompleted: true });
  persistence.settings.set(PRODUCTION_BASELINE_COMPLETED_SETTING_KEY, "invalid");
  await assert.rejects(store.isProductionBaselineComplete(), /completion marker is invalid/);
});

test("reuses a production baseline timestamp and never moves a newer activity deadline backwards on retry", async () => {
  const persistence = new MemoryPersistence();
  persistence.settings.set(ACTIVATION_BOUNDARY_SETTING_KEY, "2026-07-01T00:00:00.000Z");
  const store = createLeadInactivityStore(persistence, { inactivityMs: INACTIVITY_MS });
  const firstBaselineAt = await store.getOrCreateProductionBaseline(new Date("2026-07-22T10:00:00.000Z"));
  await store.recordProductionBaseline({
    leadId: 902,
    leadCreatedAt: new Date("2026-07-16T12:00:00.000Z"),
    pipelineId: 9055778,
    statusId: 72917586,
  }, firstBaselineAt);
  const newerActivityAt = new Date("2026-07-22T10:01:00.000Z");
  await store.recordLeadEvent(event({
    fingerprint: "newer-after-baseline",
    leadId: 902,
    leadCreatedAt: new Date("2026-07-16T12:00:00.000Z"),
    eventAt: newerActivityAt,
    receivedAt: newerActivityAt,
  }));
  const retriedBaselineAt = await store.getOrCreateProductionBaseline(new Date("2026-07-23T10:00:00.000Z"));
  const retried = await store.recordProductionBaseline({
    leadId: 902,
    leadCreatedAt: new Date("2026-07-16T12:00:00.000Z"),
    pipelineId: 9055778,
    statusId: 72917586,
  }, retriedBaselineAt);

  assert.equal(retriedBaselineAt.toISOString(), firstBaselineAt.toISOString());
  assert.equal(retried.duplicate, true);
  assert.equal(retried.watch.lastActivityAt.toISOString(), newerActivityAt.toISOString());
  assert.equal(retried.watch.dueAt.getTime(), newerActivityAt.getTime() + INACTIVITY_MS);
});
