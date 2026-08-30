const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aggregateCallVolume,
  fetchCallVolumeForRange,
  isConnectedRecord,
  internalExtensionOf,
  emptyCallVolume,
  CALL_VOLUME_HISTORY_PAGE_SIZE,
} = require("../dist/services/callVolumeStats");

function record(overrides = {}) {
  return {
    uuid: "uuid-1",
    caller_id_number: "101",
    destination_number: "998901234567",
    duration: 300,
    user_talk_time: 280,
    ...overrides,
  };
}

const EXTENSIONS = new Map([["101", 1], ["102", 2]]);

test("counts a call as connected only when someone actually talked", () => {
  assert.equal(isConnectedRecord(record({ user_talk_time: 1 })), true);
  assert.equal(isConnectedRecord(record({ user_talk_time: 0 })), false);
  // A ringing call has duration but no talk time; talk time wins.
  assert.equal(isConnectedRecord(record({ user_talk_time: 0, duration: 25 })), false);
  // Without talk time at all, a positive duration is the only signal left.
  assert.equal(isConnectedRecord(record({ user_talk_time: undefined, duration: 25 })), true);
  assert.equal(isConnectedRecord(record({ user_talk_time: undefined, duration: 0 })), false);
});

test("identifies the manager extension on inbound and outbound calls", () => {
  assert.equal(internalExtensionOf(record({ caller_id_number: "101", destination_number: "998901234567" })), "101");
  assert.equal(internalExtensionOf(record({ caller_id_number: "998901234567", destination_number: "102" })), "102");
  // Extension-to-extension and external-to-external calls belong to nobody.
  assert.equal(internalExtensionOf(record({ caller_id_number: "101", destination_number: "102" })), null);
  assert.equal(internalExtensionOf(record({ caller_id_number: "998901111111", destination_number: "998902222222" })), null);
});

test("splits connected and missed calls per manager", () => {
  const volume = aggregateCallVolume([
    record({ uuid: "a", caller_id_number: "101", user_talk_time: 300, duration: 320 }),
    record({ uuid: "b", caller_id_number: "101", user_talk_time: 0, duration: 20 }),
    record({ uuid: "c", caller_id_number: "101", user_talk_time: 0, duration: 15 }),
    record({ uuid: "d", caller_id_number: "998901234567", destination_number: "102", user_talk_time: 60 }),
  ], EXTENSIONS);

  assert.deepEqual(volume.get(1), { total: 3, connected: 1, missed: 2, talkSeconds: 300 });
  assert.deepEqual(volume.get(2), { total: 1, connected: 1, missed: 0, talkSeconds: 60 });
});

test("ignores calls belonging to unknown extensions instead of guessing an owner", () => {
  const volume = aggregateCallVolume([
    record({ uuid: "a", caller_id_number: "999" }),
    record({ uuid: "b", caller_id_number: "101" }),
  ], EXTENSIONS);

  assert.equal(volume.size, 1);
  assert.equal(volume.get(1).total, 1);
});

test("counts a repeated uuid once so overlapping history pages cannot inflate volume", () => {
  const volume = aggregateCallVolume([
    record({ uuid: "same" }),
    record({ uuid: "same" }),
    record({ uuid: "other" }),
  ], EXTENSIONS);

  assert.equal(volume.get(1).total, 2);
});

test("starts every manager from a zeroed counter", () => {
  assert.deepEqual(emptyCallVolume(), { total: 0, connected: 0, missed: 0, talkSeconds: 0 });
  assert.equal(aggregateCallVolume([], EXTENSIONS).size, 0);
});

test("flags a possibly truncated day when the history page cap is reached", async () => {
  const full = Array.from({ length: CALL_VOLUME_HISTORY_PAGE_SIZE }, (_, index) => record({ uuid: `u${index}` }));
  const truncated = await fetchCallVolumeForRange(new Date(), new Date(), EXTENSIONS, async () => full);
  assert.equal(truncated.possiblyTruncated, true);
  assert.equal(truncated.byManager.get(1).total, CALL_VOLUME_HISTORY_PAGE_SIZE);

  const partial = await fetchCallVolumeForRange(new Date(), new Date(), EXTENSIONS, async () => [record()]);
  assert.equal(partial.possiblyTruncated, false);
});

test("asks OnlinePBX for a page large enough to hold a full day", async () => {
  let requestedCount = null;
  await fetchCallVolumeForRange(new Date(), new Date(), EXTENSIONS, async (_from, _to, count) => {
    requestedCount = count;
    return [];
  });
  assert.equal(requestedCount, CALL_VOLUME_HISTORY_PAGE_SIZE);
});
