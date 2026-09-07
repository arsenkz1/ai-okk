const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolvePrimaryAdminIds,
  DEFAULT_PRIMARY_ADMIN_TELEGRAM_IDS,
} = require("../dist/bot/notify");

test("defaults to the agreed operator when nothing is configured", () => {
  assert.deepEqual([...DEFAULT_PRIMARY_ADMIN_TELEGRAM_IDS], ["295612129"]);
  assert.deepEqual(resolvePrimaryAdminIds({}), ["295612129"]);
  assert.deepEqual(resolvePrimaryAdminIds({ PRIMARY_ADMIN_TELEGRAM_IDS: "" }), ["295612129"]);
  assert.deepEqual(resolvePrimaryAdminIds({ PRIMARY_ADMIN_TELEGRAM_IDS: "  ,  " }), ["295612129"]);
});

test("accepts a configured list and trims it", () => {
  assert.deepEqual(
    resolvePrimaryAdminIds({ PRIMARY_ADMIN_TELEGRAM_IDS: " 111 , 222 " }),
    ["111", "222"],
  );
  assert.deepEqual(resolvePrimaryAdminIds({ PRIMARY_ADMIN_TELEGRAM_IDS: "333" }), ["333"]);
});
