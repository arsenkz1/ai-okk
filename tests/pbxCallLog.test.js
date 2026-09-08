const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPbxCallLogEntry, loadCallVolumeFromLog } = require("../dist/services/pbxCallLog");

const receivedAt = new Date("2026-09-08T05:00:00.000Z");

function webhook(overrides = {}) {
  return {
    event: "call_end",
    uuid: "call-1",
    direction: "outbound",
    caller: "101",
    callee: "998901234567",
    date: "1757300000",
    call_duration: "45",
    dialog_duration: "30",
    hangup_cause: "NORMAL_CLEARING",
    ...overrides,
  };
}

test("keeps talk time and total length apart", () => {
  const entry = buildPbxCallLogEntry(webhook(), receivedAt);

  // The normalized payload collapses these into one duration; the difference is
  // exactly what separates an answered call from a missed one.
  assert.equal(entry.callSeconds, 45);
  assert.equal(entry.talkSeconds, 30);
  assert.equal(entry.uuid, "call-1");
  assert.equal(entry.hangupCause, "NORMAL_CLEARING");
});

test("records an unanswered call with zero talk time", () => {
  const entry = buildPbxCallLogEntry(webhook({ dialog_duration: "0", call_duration: "18" }), receivedAt);
  assert.equal(entry.talkSeconds, 0);
  assert.equal(entry.callSeconds, 18);
});

test("picks the manager extension by direction", () => {
  const outbound = buildPbxCallLogEntry(webhook(), receivedAt);
  assert.equal(outbound.direction, "out");
  assert.equal(outbound.internalNumber, "101");
  assert.equal(outbound.externalNumber, "998901234567");

  const inbound = buildPbxCallLogEntry(
    webhook({ direction: "inbound", caller: "998901234567", callee: "102" }),
    receivedAt,
  );
  assert.equal(inbound.direction, "in");
  assert.equal(inbound.internalNumber, "102");
});

test("falls back to the delivery time when the call has no timestamp", () => {
  const entry = buildPbxCallLogEntry(webhook({ date: undefined }), receivedAt);
  assert.deepEqual(entry.startedAt, receivedAt);
  assert.deepEqual(buildPbxCallLogEntry(webhook(), receivedAt).startedAt, new Date(1757300000 * 1000));
});

test("never reports a call that talked longer than it lasted", () => {
  const entry = buildPbxCallLogEntry(webhook({ call_duration: "10", dialog_duration: "40" }), receivedAt);
  assert.equal(entry.callSeconds, 40);
  assert.equal(entry.talkSeconds, 40);
});

test("ignores anything that is not a usable call_end webhook", () => {
  assert.equal(buildPbxCallLogEntry(null, receivedAt), null);
  assert.equal(buildPbxCallLogEntry({ event: "test_webhook" }, receivedAt), null);
  assert.equal(buildPbxCallLogEntry(webhook({ uuid: "" }), receivedAt), null);
  assert.equal(buildPbxCallLogEntry(webhook({ event: "call_start" }), receivedAt), null);
});

function database(rows) {
  return { pbxCallLog: { async findMany() { return rows; } } };
}

test("splits connected and missed calls per manager", async () => {
  const volume = await loadCallVolumeFromLog(
    { from: new Date(0), to: new Date() },
    new Map([["101", 1], ["102", 2]]),
    database([
      { internalNumber: "101", talkSeconds: 300 },
      { internalNumber: "101", talkSeconds: 0 },
      { internalNumber: "102", talkSeconds: 60 },
      { internalNumber: "999", talkSeconds: 60 },
      { internalNumber: null, talkSeconds: 60 },
    ]),
  );

  assert.deepEqual(volume.get(1), { total: 2, connected: 1, missed: 1, talkSeconds: 300 });
  assert.deepEqual(volume.get(2), { total: 1, connected: 1, missed: 0, talkSeconds: 60 });
  // Unknown and missing extensions are attributed to nobody.
  assert.equal(volume.size, 2);
});

test("returns null for a period the log does not cover", async () => {
  // Null means "fall back to history", not "no calls happened".
  const volume = await loadCallVolumeFromLog({ from: new Date(0), to: new Date() }, new Map(), database([]));
  assert.equal(volume, null);
});
