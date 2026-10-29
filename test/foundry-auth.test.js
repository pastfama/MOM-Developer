const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getFoundryToken,
  normalizeScope,
  resourceForScope,
  clearTokenCache,
} = require("../lib/foundry-auth");

const realFetch = global.fetch;

// Capture identity calls so we can assert on URLs, headers and call counts.
function stubIdentity(handler) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers || {} });
    return handler(String(url), opts);
  };
  return calls;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

test.beforeEach(() => {
  clearTokenCache();
  delete process.env.IDENTITY_ENDPOINT;
  delete process.env.IDENTITY_HEADER;
  delete process.env.IMDS_ENDPOINT;
});

test.after(() => {
  global.fetch = realFetch;
});

test("normalises scopes and resources", () => {
  assert.equal(normalizeScope("https://ai.azure.com"), "https://ai.azure.com/.default");
  assert.equal(normalizeScope("https://ai.azure.com/.default"), "https://ai.azure.com/.default");
  assert.equal(resourceForScope("https://ai.azure.com/.default"), "https://ai.azure.com");
  assert.equal(resourceForScope("https://cognitiveservices.azure.com/.default"), "https://cognitiveservices.azure.com");
  assert.equal(normalizeScope(""), "https://ai.azure.com/.default");
});

test("uses IDENTITY_ENDPOINT on App Service and sends the identity header", async () => {
  process.env.IDENTITY_ENDPOINT = "http://localhost:41783/msi/token";
  process.env.IDENTITY_HEADER = "secret-header-value";
  const calls = stubIdentity(() => json({ access_token: "tok-app-service", expires_on: "9999999999" }));

  const token = await getFoundryToken({ scope: "https://ai.azure.com/.default" });
  assert.equal(token.token, "tok-app-service");
  assert.equal(token.source, "identity-endpoint");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^http:\/\/localhost:41783\/msi\/token\?/);
  assert.match(calls[0].url, /resource=https%3A%2F%2Fai\.azure\.com/);
  assert.equal(calls[0].headers["X-IDENTITY-HEADER"], "secret-header-value");
});

test("falls back to IMDS when there is no IDENTITY_ENDPOINT", async () => {
  process.env.IMDS_ENDPOINT = "http://169.254.169.254/metadata/identity/oauth2/token";
  const calls = stubIdentity(() => json({ access_token: "tok-vm", expires_in: "3600" }));

  const token = await getFoundryToken({});
  assert.equal(token.token, "tok-vm");
  assert.equal(token.source, "imds");
  assert.equal(calls[0].headers.Metadata, "true");
});

test("passes a user-assigned client id through", async () => {
  const calls = stubIdentity(() => json({ access_token: "t", expires_in: "3600" }));
  await getFoundryToken({ clientId: "client-123" });
  assert.match(calls[0].url, /client_id=client-123/);
});

test("caches the token instead of asking IMDS on every turn", async () => {
  const calls = stubIdentity(() => json({ access_token: "cached-token", expires_in: "3600" }));
  await getFoundryToken({});
  const second = await getFoundryToken({});
  assert.equal(second.token, "cached-token");
  assert.equal(calls.length, 1, "second call must hit the cache");
});

test("refreshes an expired token", async () => {
  let n = 0;
  const calls = stubIdentity(() => {
    n += 1;
    // First token expires in the past, second is fresh.
    return json(
      n === 1
        ? { access_token: "stale", expires_on: String(Math.floor(Date.now() / 1000) - 60) }
        : { access_token: "fresh", expires_in: "3600" }
    );
  });
  assert.equal((await getFoundryToken({})).token, "stale");
  assert.equal((await getFoundryToken({})).token, "fresh");
  assert.equal(calls.length, 2);
});

test("forceRefresh bypasses the cache", async () => {
  let n = 0;
  stubIdentity(() => json({ access_token: "t" + ++n, expires_in: "3600" }));
  assert.equal((await getFoundryToken({})).token, "t1");
  assert.equal((await getFoundryToken({ forceRefresh: true })).token, "t2");
});

test("returns null when no identity is reachable, and remembers the failure", async () => {
  process.env.IMDS_ENDPOINT = "http://127.0.0.1:1/token";
  const calls = stubIdentity(() => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal(await getFoundryToken({}), null);
  assert.equal(await getFoundryToken({}), null);
  assert.equal(calls.length, 1, "failure should be cached to avoid a timeout per turn");
});

test("a non-OK identity response is treated as no token", async () => {
  process.env.IMDS_ENDPOINT = "http://169.254.169.254/metadata/identity/oauth2/token";
  stubIdentity(() => json({ error: "no identity" }, 400));
  assert.equal(await getFoundryToken({}), null);
});
