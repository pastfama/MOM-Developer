const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

let createServer;
let store;
let base;
let server;
let DATA_DIR;
let APPLY_ROOT;
let activeSessionId;
const realFetch = global.fetch;
const foundryEndpoints = [];

// ── Stub the outside world: Foundry, Azure IMDS, Microsoft Graph ──
const foundryCalls = [];
const AGENT_REPLY = [
  "Done — here is the file.",
  "```file:dev-portal/js/feature.js",
  'window.feature = () => "shipped";',
  "```",
  "That is everything it needs.",
].join("\n");

const authHeaders = { Authorization: "Bearer stub-token" };

test.before(async () => {
  DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), "devagent-data-"));
  APPLY_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "devagent-apply-"));

  // Configure before requiring: server.js reads config at module load.
  process.env.DATA_DIR = DATA_DIR;
  process.env.DEV_AGENT_APPLY_ROOT = APPLY_ROOT;
  process.env.FOUNDRY_API_KEY = "test-key";
  process.env.FOUNDRY_PROJECT_ENDPOINT =
    "https://unit-test.services.ai.azure.com/api/projects/unit-test";
  process.env.FOUNDRY_MODEL_DEPLOYMENT = "unit-test-deployment";
  process.env.GITHUB_PAT = "";
  process.env.DEV_AGENT_AUTO_APPLY = "1";

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    // Local requests to the server under test must use the real implementation.
    if (u.startsWith("http://127.0.0.1:") || u.startsWith("http://localhost:")) {
      return realFetch(url, opts);
    }
    if (u.includes("169.254.169.254")) {
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    }
    if (u.includes("services.ai.azure.com")) {
      foundryEndpoints.push(u);
      foundryCalls.push(JSON.parse(opts.body || "{}"));
      return new Response(JSON.stringify({ output_text: AGENT_REPLY }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("graph.microsoft.com")) {
      return new Response(
        JSON.stringify({ displayName: "Ada", userPrincipalName: "ada@x.io", id: "u-1" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error("unexpected fetch: " + u);
  };

  ({ createServer, store } = require("../server"));
  await store.init();
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const dir of [DATA_DIR, APPLY_ROOT]) {
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("serves the app shell as HTML", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(await res.text(), /Dev Agent/);
});

test("serves the built React JavaScript referenced by the app shell", async () => {
  const shell = await fetch(base + "/");
  const html = await shell.text();
  const scriptPath = /<script[^>]+src="([^"]+\.js)"[^>]*><\/script>/.exec(html)?.[1];
  assert.ok(scriptPath, "built index.html must reference a JavaScript bundle");
  const res = await fetch(new URL(scriptPath, base));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  const body = await res.text();
  assert.ok(body.length > 1000, "the application bundle should not be empty");
  assert.ok(!body.includes("<!DOCTYPE html>"), "must not fall back to index.html");
});

test("serves the built stylesheet referenced by the app shell", async () => {
  const shell = await fetch(base + "/");
  const html = await shell.text();
  const cssPath = /<link[^>]+href="([^"]+\.css)"[^>]*>/.exec(html)?.[1];
  assert.ok(cssPath, "built index.html must reference a CSS bundle");
  const res = await fetch(new URL(cssPath, base));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/css/);
  assert.ok(!(await res.text()).includes("<!DOCTYPE html>"));
});

test("returns 404 for a missing asset instead of HTML", async () => {
  const res = await fetch(base + "/js/nope.js");
  assert.equal(res.status, 404);
  assert.ok(!(await res.text()).includes("<!DOCTYPE html>"));
});

test("blocks path traversal on static files", async () => {
  const res = await fetch(base + "/../server.js");
  assert.equal(res.status, 404);
});

test("health endpoint reports configuration", async () => {
  const res = await fetch(base + "/api/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.foundryConfigured, true);
  assert.equal(data.autoApply, true);
});

test("unknown API routes return JSON, never HTML", async () => {
  const res = await fetch(base + "/api/nope");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /application\/json/);
});

test("history for an unknown session is JSON, not a fallback page", async () => {
  const res = await fetch(base + "/api/dev-agent/history?sessionId=sess-missing1", {
    headers: authHeaders,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  const data = await res.json();
  assert.deepEqual(data.messages, []);
  assert.equal(data.found, false);
});

test("a turn writes the agent's files into the repo", async () => {
  const res = await fetch(base + "/api/dev-agent", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "ship the feature" }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.applied.length, 1);
  assert.equal(data.applied[0].path, "dev-portal/js/feature.js");
  assert.equal(data.applied[0].action, "created");
  assert.equal(
    foundryEndpoints.at(-1),
    "https://unit-test.services.ai.azure.com/api/projects/unit-test/openai/v1/responses"
  );
  assert.equal(foundryCalls.at(-1).model, "unit-test-deployment");
  activeSessionId = data.sessionId;
  assert.ok(activeSessionId, "server must return the session id");
  const written = await fsp.readFile(path.join(APPLY_ROOT, "dev-portal/js/feature.js"), "utf8");
  assert.equal(written, 'window.feature = () => "shipped";\n');
});

test("the next turn replays earlier messages (memory survives)", async () => {
  const res = await fetch(base + "/api/dev-agent", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "now add a test for it", sessionId: activeSessionId }),
  });
  assert.equal(res.status, 200);
  const last = foundryCalls[foundryCalls.length - 1];
  const prompt = JSON.stringify(last.input);
  assert.ok(prompt.includes("ship the feature"), "earlier user turn must be replayed");
  assert.ok(prompt.includes("now add a test for it"), "current turn must be included");
  assert.equal(last.input[0].role, "system");
  assert.match(last.input[0].content, /Be warm, respectful, direct, and constructive/);
  assert.match(last.input[0].content, /offer the closest practical path toward the same goal/);
  assert.match(last.input[0].content, /Do not promise "yes" when it would be misleading/);
  assert.match(last.input[0].content, /Aim for 2–4 sentences or up to 3 brief bullets/);
  assert.match(last.input[0].content, /summarize the relevant highlights instead of exhaustively naming every resource/);
});

test("history is persisted and listed for the signed-in user", async () => {
  const listRes = await fetch(base + "/api/sessions", { headers: authHeaders });
  const list = await listRes.json();
  assert.equal(list.sessions.length, 1);
  const sessionId = list.sessions[0].id;

  const histRes = await fetch(base + "/api/dev-agent/history?sessionId=" + sessionId, {
    headers: authHeaders,
  });
  const hist = await histRes.json();
  assert.equal(hist.found, true);
  assert.equal(hist.messages.length, 4); // 2 turns x (user + assistant)
  assert.equal(hist.messages[0].content, "ship the feature");
});

test("long-term memory API supports adding, listing, and removing notes", async () => {
  const clear = await fetch(base + "/api/memory", { method: "DELETE", headers: authHeaders });
  assert.equal(clear.status, 200);

  const create = await fetch(base + "/api/memory", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Works mostly in TypeScript" }),
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(created.memory.text, "Works mostly in TypeScript");

  const list = await fetch(base + "/api/memory", { headers: authHeaders });
  assert.deepEqual((await list.json()).memories, [created.memory]);

  const remove = await fetch(base + "/api/memory/" + created.memory.id, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(remove.status, 200);
  assert.deepEqual((await (await fetch(base + "/api/memory", { headers: authHeaders })).json()).memories, []);
});

test("remember requests carry explicit facts into new sessions and forget them on request", async () => {
  await fetch(base + "/api/memory", { method: "DELETE", headers: authHeaders });

  const remember = await fetch(base + "/api/dev-agent", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Remember that I prefer concise answers." }),
  });
  assert.equal(remember.status, 200);
  assert.match(foundryCalls.at(-1).input[0].content, /I prefer concise answers/);

  const newSession = await fetch(base + "/api/sessions", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: "{}",
  });
  const sessionId = (await newSession.json()).session.id;
  const followUp = await fetch(base + "/api/dev-agent", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "What response style do I prefer?", sessionId }),
  });
  assert.equal(followUp.status, 200);
  assert.match(foundryCalls.at(-1).input[0].content, /I prefer concise answers/);

  const forget = await fetch(base + "/api/dev-agent", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Forget that I prefer concise answers." }),
  });
  assert.equal(forget.status, 200);
  assert.deepEqual((await (await fetch(base + "/api/memory", { headers: authHeaders })).json()).memories, []);
});

test("another user cannot read that session", async () => {
  const listRes = await fetch(base + "/api/sessions", { headers: authHeaders });
  const mine = (await listRes.json()).sessions[0].id;

  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1:") || u.startsWith("http://localhost:")) {
      return original(url, opts);
    }
    if (u.includes("graph.microsoft.com")) {
      return new Response(
        JSON.stringify({ displayName: "Bob", userPrincipalName: "bob@x.io", id: "u-2" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return original(url, opts);
  };
  const res = await fetch(base + "/api/dev-agent/history?sessionId=" + mine, {
    headers: { Authorization: "Bearer other-token" },
  });
  global.fetch = original;
  const data = await res.json();
  assert.equal(data.found, false);
  assert.deepEqual(data.messages, []);
});

test("creating a session returns a usable id", async () => {
  const res = await fetch(base + "/api/sessions", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.match(data.session.id, /^sess-/);
});

test("serves the security headers and cache policy SWA used to provide", async () => {
  const shell = await fetch(base + "/");
  const htmlText = await shell.text();
  const scriptPath = /<script[^>]+src="([^"]+\.js)"[^>]*><\/script>/.exec(htmlText)?.[1];
  assert.ok(scriptPath, "built index.html must reference a JavaScript bundle");
  const js = await fetch(new URL(scriptPath, base));
  assert.equal(js.headers.get("x-content-type-options"), "nosniff");
  assert.equal(js.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(js.headers.get("referrer-policy"), /strict-origin/);
  assert.match(js.headers.get("cache-control"), /immutable/);

  const html = await fetch(base + "/");
  assert.equal(html.headers.get("cache-control"), "no-cache", "index.html must never be cached");

  const api = await fetch(base + "/api/health");
  assert.equal(api.headers.get("x-content-type-options"), "nosniff");
});
