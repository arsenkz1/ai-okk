const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveCallTaskDueAt, DEFAULT_TASK_HOUR } = require("../dist/services/callTaskDueDate");

// 15:00 Almaty on 4 August 2026.
const now = new Date("2026-08-04T10:00:00.000Z");

test("keeps an agreed clock time exactly as agreed", () => {
  const result = resolveCallTaskDueAt({ kind: "exact", at: "2026-08-05T15:00:00+05:00" }, now);
  assert.deepEqual(result, {
    kind: "resolved",
    dueAt: new Date("2026-08-05T10:00:00.000Z"),
    usedDefaultTime: false,
  });
});

test("uses 10:00 Almaty whenever the day is known but the time is not", () => {
  assert.equal(DEFAULT_TASK_HOUR, "10:00");

  const tomorrow = resolveCallTaskDueAt({ kind: "tomorrow" }, now);
  assert.deepEqual(tomorrow.dueAt, new Date("2026-08-05T05:00:00.000Z"));
  assert.equal(tomorrow.usedDefaultTime, true);

  const named = resolveCallTaskDueAt({ kind: "date", date: "2026-09-15" }, now);
  assert.deepEqual(named.dueAt, new Date("2026-09-15T05:00:00.000Z"));
});

test("puts a bare month on its first day at 10:00", () => {
  const result = resolveCallTaskDueAt({ kind: "month", month: "2026-10" }, now);
  assert.deepEqual(result.dueAt, new Date("2026-10-01T05:00:00.000Z"));
  assert.equal(result.usedDefaultTime, true);
});

test("derives tomorrow from the Almaty calendar, not from UTC", () => {
  // 20:00 UTC on 4 August is already 01:00 on 5 August in Almaty.
  const lateEvening = new Date("2026-08-04T20:00:00.000Z");
  const result = resolveCallTaskDueAt({ kind: "tomorrow" }, lateEvening);
  assert.deepEqual(result.dueAt, new Date("2026-08-06T05:00:00.000Z"));
});

test("crosses a month boundary correctly", () => {
  const lastDay = new Date("2026-08-31T06:00:00.000Z"); // 11:00 Almaty
  const result = resolveCallTaskDueAt({ kind: "tomorrow" }, lastDay);
  assert.deepEqual(result.dueAt, new Date("2026-09-01T05:00:00.000Z"));
});

test("refuses a due date that already passed instead of pushing it forward", () => {
  assert.deepEqual(
    resolveCallTaskDueAt({ kind: "month", month: "2026-07" }, now),
    { kind: "unresolved", reason: "not_in_future" },
  );
  assert.deepEqual(
    resolveCallTaskDueAt({ kind: "exact", at: "2026-08-04T09:00:00+05:00" }, now),
    { kind: "unresolved", reason: "not_in_future" },
  );
  // Today at 10:00 Almaty is already behind a 15:00 "now".
  assert.deepEqual(
    resolveCallTaskDueAt({ kind: "date", date: "2026-08-04" }, now),
    { kind: "unresolved", reason: "not_in_future" },
  );
});

test("reports an unusable hint rather than inventing a date", () => {
  assert.deepEqual(resolveCallTaskDueAt(null, now), { kind: "unresolved", reason: "no_hint" });
  assert.deepEqual(
    resolveCallTaskDueAt({ kind: "date", date: "15.09.2026" }, now),
    { kind: "unresolved", reason: "invalid_hint" },
  );
  assert.deepEqual(
    resolveCallTaskDueAt({ kind: "date", date: "2026-02-31" }, now),
    { kind: "unresolved", reason: "invalid_hint" },
  );
  assert.deepEqual(
    resolveCallTaskDueAt({ kind: "exact", at: "not a date" }, now),
    { kind: "unresolved", reason: "invalid_hint" },
  );
});
