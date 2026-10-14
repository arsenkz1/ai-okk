const test = require("node:test");
const assert = require("node:assert/strict");

const { summarizeError } = require("../dist/services/errorSummary");

test("an axios error is reduced to status, code, method and path, never headers or body", () => {
  const error = Object.assign(new Error("socket hang up"), {
    name: "AxiosError",
    code: "ECONNRESET",
    config: {
      method: "post",
      url: "https://qadamsales.amocrm.ru/api/v4/leads/26591647/notes?secret=1",
      headers: { Authorization: "Bearer TOKEN" },
      data: "[{\"note_type\":\"common\"}]",
    },
    request: { _header: "POST /x HTTP/1.1\r\nAuthorization: Bearer TOKEN" },
  });

  const summary = summarizeError(error);
  assert.deepEqual(summary, {
    name: "AxiosError",
    message: "socket hang up",
    code: "ECONNRESET",
    method: "POST",
    url: "https://qadamsales.amocrm.ru/api/v4/leads/26591647/notes",
  });
  assert.equal(JSON.stringify(summary).includes("TOKEN"), false);
});

test("an HTTP failure keeps its status", () => {
  const summary = summarizeError({ name: "AxiosError", message: "Request failed with status code 401", response: { status: 401, data: { title: "Unauthorized" } }, config: { method: "get", url: "/api/v4/account", baseURL: "https://x.amocrm.ru" } });
  assert.equal(summary.status, 401);
  assert.equal(summary.url, "https://x.amocrm.ru/api/v4/account");
});

test("plain errors and non-errors still produce a readable line", () => {
  assert.deepEqual(summarizeError(new TypeError("boom")), { name: "TypeError", message: "boom" });
  assert.deepEqual(summarizeError("just a string"), { name: "Error", message: "just a string" });
  assert.deepEqual(summarizeError(null), { name: "Error", message: "null" });
});
