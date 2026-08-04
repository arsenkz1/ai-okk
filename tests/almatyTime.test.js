const test = require("node:test");
const assert = require("node:assert/strict");

const {
  almatyLocalDateTimeToUtc,
  almatyPresetDueAt,
  parseAlmatyDateTimeInput,
} = require("../dist/services/almatyTime");

test("converts an explicit Asia/Almaty date/time into its exact UTC instant", () => {
  assert.deepEqual(
    almatyLocalDateTimeToUtc("2026-08-05", "15:00"),
    new Date("2026-08-05T10:00:00.000Z"),
  );
  assert.equal(almatyLocalDateTimeToUtc("2026-02-30", "15:00"), null);
  assert.equal(almatyLocalDateTimeToUtc("2026-08-05", "25:00"), null);
});

test("parses reviewer input and calculates calendar presets in Almaty instead of server time", () => {
  assert.deepEqual(parseAlmatyDateTimeInput("05.08.2026 15:00"), new Date("2026-08-05T10:00:00.000Z"));
  assert.deepEqual(parseAlmatyDateTimeInput("2026-08-05 15:00"), new Date("2026-08-05T10:00:00.000Z"));
  assert.equal(parseAlmatyDateTimeInput("2026/08/05 15:00"), null);

  const now = new Date("2026-08-04T17:00:00.000Z"); // 22:00 in Almaty
  assert.deepEqual(almatyPresetDueAt("tomorrow_10", now), new Date("2026-08-05T05:00:00.000Z"));
  assert.deepEqual(almatyPresetDueAt("today_18", now), new Date("2026-08-04T13:00:00.000Z"));
});
