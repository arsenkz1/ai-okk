const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPbxAuthProvider,
  isPbxAuthFailure,
  parsePbxAuthResponse,
  readPbxAuthConfig,
  PBX_AUTH_HOSTS,
} = require("../dist/services/pbxAuth");

const CONFIG = {
  domain: "pbx1.onpbx.ru",
  apiKey: "long-lived-key",
  initialHeader: "old_id:old_key",
  authHosts: PBX_AUTH_HOSTS,
};

function authResponse(overrides = {}) {
  return { status: 200, data: { status: "1", data: { key_id: "new_id", key: "new_key" }, ...overrides } };
}

test("recognizes the expired-key answer that arrives with HTTP 200", () => {
  // This is the exact body OnlinePBX returns for a lapsed session key.
  assert.equal(isPbxAuthFailure({
    status: "0",
    comment: "not authorized: api keys not found",
    isNotAuth: true,
    errorCode: "API_KEY_CHECK_FAILED",
  }), true);
  assert.equal(isPbxAuthFailure({ errorCode: "API_KEY_CHECK_FAILED" }), true);
  assert.equal(isPbxAuthFailure({ isNotAuth: true }), true);
});

test("does not mistake an ordinary failure for an auth failure", () => {
  assert.equal(isPbxAuthFailure({ status: "0", comment: "wrong date range" }), false);
  assert.equal(isPbxAuthFailure({ status: "1", data: [] }), false);
  assert.equal(isPbxAuthFailure(null), false);
  assert.equal(isPbxAuthFailure("nope"), false);
});

test("builds the key_id:key header from either response shape", () => {
  assert.equal(parsePbxAuthResponse({ data: { key_id: "a", key: "b" } }), "a:b");
  assert.equal(parsePbxAuthResponse({ key_id: "a", key: "b" }), "a:b");
  assert.equal(parsePbxAuthResponse({ data: { key_id: " a ", key: " b " } }), "a:b");
  assert.equal(parsePbxAuthResponse({ data: { key_id: "a" } }), null);
  assert.equal(parsePbxAuthResponse({ data: {} }), null);
  assert.equal(parsePbxAuthResponse(null), null);
});

test("reads the credentials out of the environment", () => {
  assert.deepEqual(
    readPbxAuthConfig({ ONLINEPBX_DOMAIN: " d ", ONLINEPBX_API_KEY: " k ", ONLINEPBX_PBX_AUTH: " a:b " }),
    { domain: "d", apiKey: "k", initialHeader: "a:b", authHosts: PBX_AUTH_HOSTS },
  );
  assert.deepEqual(
    readPbxAuthConfig({}),
    { domain: "", apiKey: null, initialHeader: null, authHosts: PBX_AUTH_HOSTS },
  );
});

test("lets one auth host be pinned without a code change", () => {
  const config = readPbxAuthConfig({ ONLINEPBX_AUTH_BASE_URL: "https://api.onlinepbx.ru/" });
  assert.deepEqual(config.authHosts, ["https://api.onlinepbx.ru"]);
});

test("uses the configured session key until OnlinePBX rejects it", async () => {
  const posts = [];
  const provider = createPbxAuthProvider({
    config: CONFIG,
    http: { async post(url, body) { posts.push({ url, body }); return authResponse(); } },
  });

  const used = [];
  const result = await provider.withAuth(async (header) => {
    used.push(header);
    return { status: 200, data: { status: "1", data: [] } };
  });

  assert.deepEqual(used, ["old_id:old_key"]);
  assert.equal(posts.length, 0, "no session is minted while the configured one works");
  assert.deepEqual(result.data, { status: "1", data: [] });
});

test("mints a new key and retries once when the session expired", async () => {
  const provider = createPbxAuthProvider({
    config: CONFIG,
    http: { async post() { return authResponse(); } },
  });

  const used = [];
  const result = await provider.withAuth(async (header) => {
    used.push(header);
    return used.length === 1
      ? { status: 200, data: { isNotAuth: true, errorCode: "API_KEY_CHECK_FAILED" } }
      : { status: 200, data: { status: "1", data: ["record"] } };
  });

  assert.deepEqual(used, ["old_id:old_key", "new_id:new_key"]);
  assert.deepEqual(result.data, { status: "1", data: ["record"] });
});

test("posts the documented form body to auth.json", async () => {
  const posts = [];
  const provider = createPbxAuthProvider({
    config: { ...CONFIG, initialHeader: null },
    http: { async post(url, body, config) { posts.push({ url, body, config }); return authResponse(); } },
  });

  assert.equal(await provider.getAuthHeader(), "new_id:new_key");
  assert.equal(posts[0].url, "https://api2.onlinepbx.ru/pbx1.onpbx.ru/auth.json");
  assert.equal(posts[0].config.headers["content-type"], "application/x-www-form-urlencoded");
  // auth_key plus new=true, which is what marks the request as a renewal.
  const body = new URLSearchParams(String(posts[0].body));
  assert.equal(body.get("auth_key"), "long-lived-key");
  assert.equal(body.get("new"), "true");
});

test("falls back to the documented auth host when the working one refuses", async () => {
  const urls = [];
  const provider = createPbxAuthProvider({
    config: { ...CONFIG, initialHeader: null },
    http: {
      async post(url) {
        urls.push(url);
        return urls.length === 1
          ? { status: 404, data: { status: "0", comment: "not found" } }
          : authResponse();
      },
    },
  });

  assert.equal(await provider.getAuthHeader(), "new_id:new_key");
  assert.deepEqual(urls, [
    "https://api2.onlinepbx.ru/pbx1.onpbx.ru/auth.json",
    "https://api.onlinepbx.ru/pbx1.onpbx.ru/auth.json",
  ]);
});

test("caches the minted key instead of authenticating on every call", async () => {
  let mints = 0;
  const provider = createPbxAuthProvider({
    config: { ...CONFIG, initialHeader: null },
    http: { async post() { mints += 1; return authResponse(); } },
  });

  await provider.getAuthHeader();
  await provider.getAuthHeader();
  assert.equal(mints, 1);
});

test("never mints a key on a schedule, only on first use or rejection", async () => {
  let mints = 0;
  const provider = createPbxAuthProvider({
    config: { ...CONFIG, initialHeader: null },
    http: { async post() { mints += 1; return authResponse(); } },
  });

  // Every auth issues a new key and drops the previous session, so OnlinePBX
  // asks for one only on the first call or after {isNotAuth: true}.
  for (let i = 0; i < 5; i++) await provider.getAuthHeader();
  assert.equal(mints, 1);

  await provider.refreshAuthHeader();
  assert.equal(mints, 2);
});

test("shares one mint between concurrent callers", async () => {
  let mints = 0;
  const provider = createPbxAuthProvider({
    config: { ...CONFIG, initialHeader: null },
    http: {
      async post() {
        mints += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return authResponse();
      },
    },
  });

  const headers = await Promise.all([
    provider.getAuthHeader(),
    provider.getAuthHeader(),
    provider.getAuthHeader(),
  ]);
  assert.deepEqual(headers, ["new_id:new_key", "new_id:new_key", "new_id:new_key"]);
  assert.equal(mints, 1);
});

test("says plainly that no new key can be requested without the API key", async () => {
  const provider = createPbxAuthProvider({
    config: { domain: "pbx1.onpbx.ru", apiKey: null, initialHeader: null },
    http: { async post() { throw new Error("must not be called"); } },
  });

  await assert.rejects(provider.getAuthHeader(), /ONLINEPBX_API_KEY is not configured/);
});

test("reports what auth.json actually answered when no key comes back", async () => {
  const provider = createPbxAuthProvider({
    config: { ...CONFIG, initialHeader: null },
    http: { async post() { return { status: 200, data: { status: "0", comment: "wrong auth_key" } }; } },
  });

  await assert.rejects(provider.getAuthHeader(), /wrong auth_key/);
});
