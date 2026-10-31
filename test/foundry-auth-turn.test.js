// End-to-end keyless turn: identity token → Foundry 401 → refresh → retry.
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const realFetch = global.fetch;
let baseRef = "";
let server;
let DATA_DIR;
let APPLY_ROOT;

const foundryCalls = [];
let tokenSeq = 0;

test.before(async () => {
  DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), "devagent-entra-"));
  APPLY_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "devagent-entra-apply-"));
  process.env.DATA_DIR = DATA_DIR;
  process.env.DEV_AGENT_APPLY_ROOT = APPLY_ROOT;
  process.env.FOUNDRY_AUTH = "entra";
  process.env.IDENTITY_ENDPOINT = "http://msi.internal/msi/token";
  process.env.IDENTITY_HEADER = "identity-secret";
  delete process.env.FOUNDRY_API_KEY;

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (baseRef && u.startsWith(baseRef)) return realFetch(url, opts);
    if (u.includes("graph.microsoft.com")) {
      return new Response(
        JSON.stringify({ displayName: "Ada", userPrincipalName: "ada@example.com", id: "user-1" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.startsWith("http://msi.internal/msi/token")) {
      tokenSeq += 1;
      return new Response(
        JSON.stringify({ access_token: "tok-" + tokenSeq, expires_in: "3600" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.includes("services.ai.azure.com")) {
      foundryCalls.push({ headers: opts.headers || {}, body: opts.body });
      if ((opts.headers || {}).Authorization === "Bearer tok-1") {
        return new Response(JSON.stringify({ error: "token expired" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          output_text: "```file:dev-portal/js/entra.js\nwindow.entra = true;\n```\nDone.",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.includes("169.254.169.254")) {
      return new Response("{}", { status: 500 });
    }
    throw new Error("unexpected fetch: " + u);
  };

  const { createServer, store } = require("../server");
  await store.init();
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  baseRef = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  global.fetch = realFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const dir of [DATA_DIR, APPLY_ROOT]) {
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("calls Foundry with a bearer token from the identity endpoint, no API key", async () => {
  const res = await fetch(baseRef + "/api/dev-agent", {
    method: "POST",
    headers: { Authorization: "Bearer entra-user-token", "Content-Type": "application/json" },
    body: JSON.stringify({ message: "build it keyless" }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(foundryCalls.length, 2, "should retry exactly once after the 401");
  for (const call of foundryCalls) {
    assert.match(call.headers.Authorization, /^Bearer tok-\d+$/);
    assert.equal(call.headers["api-key"], undefined, "must not send an API key");
  }
  assert.equal(foundryCalls[1].headers.Authorization, "Bearer tok-2", "retry uses a fresh token");
  assert.equal(data.applied[0].path, "dev-portal/js/entra.js");
  assert.equal(await fsp.readFile(path.join(APPLY_ROOT, "dev-portal/js/entra.js"), "utf8"), "window.entra = true;\n");
});

test("the refreshed token is cached for subsequent turns", async () => {
  foundryCalls.length = 0;
  const res = await fetch(baseRef + "/api/dev-agent", {
    method: "POST",
    headers: { Authorization: "Bearer entra-user-token", "Content-Type": "application/json" },
    body: JSON.stringify({ message: "again" }),
  });
  assert.equal(res.status, 200);
  assert.equal(foundryCalls.length, 1, "no 401 this time, so a single call");
  assert.equal(foundryCalls[0].headers.Authorization, "Bearer tok-2");
});
