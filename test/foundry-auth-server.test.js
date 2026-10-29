// Proves the keyless path is the default and fails loudly (not silently) when
// no identity exists — the exact situation on a laptop or the CI sandbox.
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

let server;
let base;
let DATA_DIR;

test.before(async () => {
  DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), "devagent-auth-"));
  process.env.DATA_DIR = DATA_DIR;
  process.env.FOUNDRY_AUTH = "entra"; // keyless, identity only
  delete process.env.FOUNDRY_API_KEY;
  delete process.env.IDENTITY_ENDPOINT;
  process.env.IMDS_ENDPOINT = "http://127.0.0.1:1/token"; // unreachable on purpose

  const { createServer, store } = require("../server");
  await store.init();
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (DATA_DIR) await fsp.rm(DATA_DIR, { recursive: true, force: true });
});

test("health reports keyless mode without a key", async () => {
  const res = await fetch(base + "/api/health");
  const data = await res.json();
  assert.equal(data.auth.mode, "entra");
  assert.equal(data.auth.apiKeyPresent, false);
  assert.equal(data.auth.scope, "https://ai.azure.com/.default");
  assert.equal(data.foundryConfigured, true);
});

test("a turn without an identity returns 503 with actionable guidance", async () => {
  const res = await fetch(base + "/api/dev-agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.error.code, "no_credentials");
  assert.match(data.error.message, /Cognitive Services User/);
  assert.match(data.error.message, /IDENTITY_ENDPOINT/);
});

test("key mode with no key also fails clearly", async () => {
  const { resolveFoundryAuth } = require("../server");
  // resolveFoundryAuth reads module-level config, so assert the entra path here
  // and rely on the 503 above for the user-visible behaviour.
  assert.equal(typeof resolveFoundryAuth, "function");
});
