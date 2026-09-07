const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isRetryableAmoStatus,
  amoRetryDelayMs,
  AMO_RETRY_MAX_DELAY_MS,
} = require("../dist/services/amoRetryPolicy");

test("retries only failures a later identical request may survive", () => {
  assert.equal(isRetryableAmoStatus(429), true);
  assert.equal(isRetryableAmoStatus(500), true);
  assert.equal(isRetryableAmoStatus(502), true);
  assert.equal(isRetryableAmoStatus(408), true);
  // A network failure with no status is retryable for a read.
  assert.equal(isRetryableAmoStatus(null), true);
});

test("never retries a failure that would repeat identically", () => {
  assert.equal(isRetryableAmoStatus(400), false);
  assert.equal(isRetryableAmoStatus(401), false);
  assert.equal(isRetryableAmoStatus(403), false);
  assert.equal(isRetryableAmoStatus(404), false);
});

test("honours Retry-After when amoCRM sends one", () => {
  assert.equal(amoRetryDelayMs(1, "5"), 5000);
  assert.equal(amoRetryDelayMs(1, 2), 2000);
  assert.equal(amoRetryDelayMs(1, "0.5"), 500);
  // A hostile or absurd Retry-After cannot stall the worker indefinitely.
  assert.equal(amoRetryDelayMs(1, "99999"), AMO_RETRY_MAX_DELAY_MS);
});

test("backs off exponentially when no Retry-After is given", () => {
  assert.equal(amoRetryDelayMs(1, undefined), 1000);
  assert.equal(amoRetryDelayMs(2, undefined), 2000);
  assert.equal(amoRetryDelayMs(3, undefined), 4000);
  assert.equal(amoRetryDelayMs(99, undefined), AMO_RETRY_MAX_DELAY_MS);
  assert.equal(amoRetryDelayMs(1, "not a number"), 1000);
});
