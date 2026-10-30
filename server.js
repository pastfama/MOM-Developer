// ── Local dev server for dev.fameshire.com Dev Agent portal ──
// Run:  node server.js   →  http://localhost:3000

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const { SessionStore } = require("./lib/session-store");
const { extractFileBlocks, applyFileBlocks } = require("./lib/apply-engine");
const { getFoundryToken, describeIdentityConfig } = require("./lib/foundry-auth");

const PORT = process.env.PORT || 3000;
// Behind Caddy/nginx (TLS termination) bind to loopback: HOST=127.0.0.1
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
// The frontend lives in dev-portal/ — that directory is the web root.
const STATIC_ROOT = path.join(ROOT, "dev-portal");
const DATA_ROOT = process.env.DATA_DIR || path.join(ROOT, ".data");

const FOUNDRY_EP =
  process.env.FOUNDRY_PROJECT_ENDPOINT || "https://mom-dev-foundry.openai.azure.com";
const AGENT_ID = process.env.AGENT_ID || "gpt-4o";
const AGENT_API_VER = process.env.AGENT_API_VERSION || "2024-10-21";
const FOUNDRY_KEY = process.env.FOUNDRY_API_KEY || "";
// Managed identity is the default; ENTRA ID needs no secret at all.
// auto = try identity, fall back to FOUNDRY_API_KEY | entra = identity only | key = key only
const FOUNDRY_AUTH = (process.env.FOUNDRY_AUTH || "auto").toLowerCase();
const FOUNDRY_TOKEN_SCOPE = process.env.FOUNDRY_TOKEN_SCOPE || "https://cognitiveservices.azure.com/.default";
const FOUNDRY_CLIENT_ID = process.env.FOUNDRY_CLIENT_ID || "";
const GITHUB_PAT = process.env.GITHUB_PAT || "";
const SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID || "8cce2fe7-7c75-4969-9da9-707aadd13e52";
const TENANT_ID = process.env.AZURE_TENANT_ID || "185b412d-bddc-454b-9987-40628582c63c";
// Write the agent's file changes into the repo instead of only printing them.
const AUTO_APPLY = process.env.DEV_AGENT_AUTO_APPLY !== "0";
// The tree the agent is allowed to write into.
const APPLY_ROOT = path.resolve(process.env.DEV_AGENT_APPLY_ROOT || ROOT);

// Parity with what the Static Web App used to inject. One origin means the
// node server has to supply these itself.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const store = new SessionStore({ root: path.join(DATA_ROOT, "sessions") });

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

function writeJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...cors(),
    ...SECURITY_HEADERS,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── Context gathering (Azure + GitHub), cached so a chat turn is fast ──
const contextCache = new Map();
const CONTEXT_TTL = 60_000;

async function cached(key, ttl, fn) {
  const hit = contextCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttl) return hit.value;
  const value = await fn();
  contextCache.set(key, { at: now, value });
  return value;
}

async function getAzToken() {
  try {
    const res = await fetch(
      "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/",
      { headers: { Metadata: "true" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token || null;
  } catch (e) {
    return null;
  }
}

async function listAzureResources() {
  const token = await getAzToken();
  if (!token) return "Azure estate discovery unavailable (no managed identity on this host).";
  try {
    const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resources?api-version=2022-09-01`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return `Azure estate discovery failed (HTTP ${res.status}).`;
    const data = await res.json();
    const items = (data.value || [])
      .map((r) => `• ${r.name} — ${r.type} — RG: ${r.resourceGroup || "—"}`)
      .slice(0, 60);
    return items.length ? items.join("\n") : "No Azure resources found in subscription.";
  } catch (e) {
    return "Azure estate discovery error: " + e.message;
  }
}

async function listGitHubRepos() {
  if (!GITHUB_PAT) return "GitHub repositories unavailable (GITHUB_PAT not set).";
  try {
    const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
      headers: {
        Authorization: `token ${GITHUB_PAT}`,
        "User-Agent": "fameshire-dev-agent-local",
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) return `GitHub repositories unavailable (API error ${res.status}).`;
    const data = await res.json();
    const items = (data || [])
      .map((r) => `• ${r.full_name} — ${r.language || "?"} — ${r.private ? "private" : "public"} — ${r.description || "(no description)"}`)
      .slice(0, 40);
    return items.length ? items.join("\n") : "No GitHub repositories found.";
  } catch (e) {
    return "GitHub repositories error: " + e.message;
  }
}

async function getUserProfile(accessToken) {
  if (!accessToken) return { name: "Unknown", email: "", id: "" };
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { name: "Unknown", email: "", id: "" };
    const d = await res.json();
    return {
      name: d.displayName || "",
      email: d.userPrincipalName || d.mail || "",
      id: d.id || "",
    };
  } catch (e) {
    return { name: "Unknown", email: "", id: "" };
  }
}

// Stable, non-guessable key so history is scoped per signed-in user.
async function resolveIdentity(req) {
  const auth = req.headers["authorization"] || "";
  const accessToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const profile = await getUserProfile(accessToken);
  let userKey;
  if (profile.id) userKey = "entra:" + profile.id;
  else if (profile.email) userKey = "email:" + profile.email.toLowerCase();
  else userKey = "local:anonymous";
  return { profile, userKey, authenticated: Boolean(profile.id || profile.email) };
}

function extractText(ad) {
  if (!ad) return "(no response)";
  if (typeof ad.output_text === "string" && ad.output_text.trim()) return ad.output_text;
  const fromOutput = (ad.output || [])
    .map((o) => o.text || ((o.content || []).map((c) => c.text || "").join("") || ""))
    .join("");
  if (fromOutput.trim()) return fromOutput;
  const choice = ad.choices && ad.choices[0];
  if (choice && choice.message && typeof choice.message.content === "string") {
    return choice.message.content;
  }
  return "(no response)";
}

function buildSystemPrompt({ profile, azureCtx, githubCtx, sessionTitle }) {
  return `You are the user's personal Dev Agent on dev.fameshire.com.

IDENTITY — You are speaking to ${profile.name || "the user"} (${profile.email}), Microsoft Entra ID ID: ${profile.id}. Address them by name.

MEMORY — Every message is persisted to disk per user, keyed to their Entra ID. Prior turns are replayed to you on each request, so you do remember earlier sessions and never need them to repeat themselves. This conversation is titled "${sessionTitle}".

AZURE ESTATE (subscription ${SUBSCRIPTION_ID}, tenant ${TENANT_ID}):
${azureCtx}

GITHUB REPOSITORIES (user: pastfama):
${githubCtx}

THIS REPOSITORY — MOM-Developer is a zero-build project: a vanilla HTML/CSS/JS frontend in dev-portal/ served by a dependency-free Node http server (server.js). There is no React and no Express. Never propose a React component or an npm install unless the user explicitly asks for that stack.

HOW TO COMPLETE WORK — You do the job; you do not ask permission and you do not hand back snippets to paste. When a request requires code changes, emit every file in full using this exact fence format:

\`\`\`file:relative/path/to/file.ext
<complete file contents>
\`\`\`

Rules for file blocks:
- Paths are relative to the repository root, e.g. dev-portal/js/chat.js
- Always emit the COMPLETE file, never a fragment, diff or "...rest unchanged"
- Every file you emit is written to the repo automatically the moment you answer
- Include all files the change needs (HTML, CSS, JS, server routes) in the same reply
- Never claim something is done unless you emitted the code for it in this reply

CAPABILITIES — You have access to the following tools on the dev VM:

- **Azure CLI** — Full Azure management. The VM is authenticated with a service principal mom-dev (Owner role on subscription ${SUBSCRIPTION_ID}). Run az login --service-principal with credentials from /etc/dev-agent.env or environment variables to manage any Azure resource.
- **MCP Servers** — Installed globally via npm: @modelcontextprotocol/server-filesystem, @modelcontextprotocol/server-github, @modelcontextprotocol/server-memory. Use these to read/write files, query GitHub, and maintain persistent memory across sessions.
- **Managed Identity** — The VM has a system-assigned managed identity with Cognitive Services User access to the Foundry account mom-dev-foundry in rg-mom-dev-vm. Keyless authentication via IMDS.
- **Foundry / Azure OpenAI** — Deployment gpt-4o on mom-dev-foundry.openai.azure.com. Use chat completions API at ${FOUNDRY_EP}/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21.
- **Azure Static Web Apps** — Previously used; now retired. All traffic routes through nginx on mom-dev-vm:443 → node server on localhost:8080.

FINISH THE TASK — Never end with "let me know if you need help integrating this", "would you like me to implement that", or any offer to do work later. Implement it now, then summarise what changed in one short paragraph. Ask a question only when a detail is genuinely blocking and unguessable.`;
}

// ── Foundry auth: managed identity first, API key only as a fallback ──
async function resolveFoundryAuth({ forceRefresh = false } = {}) {
  if (FOUNDRY_AUTH !== "key") {
    const tok = await getFoundryToken({
      scope: FOUNDRY_TOKEN_SCOPE,
      clientId: FOUNDRY_CLIENT_ID || undefined,
      forceRefresh,
    });
    if (tok) {
      return {
        mode: "entra",
        source: tok.source,
        headers: { Authorization: `Bearer ${tok.token}` },
      };
    }
    if (FOUNDRY_AUTH === "entra") return null;
  }
  if (FOUNDRY_KEY) {
    return { mode: "key", source: "env", headers: { "api-key": FOUNDRY_KEY } };
  }
  return null;
}

function authFailureMessage() {
  return (
    "The agent could not authenticate. No managed identity token was available " +
    `(tried IDENTITY_ENDPOINT and ${describeIdentityConfig().imdsEndpoint}) and FOUNDRY_API_KEY is not set. ` +
    "In Azure: enable a system-assigned identity on the app, grant it 'Cognitive Services User' " +
    "on the Foundry resource, and leave FOUNDRY_AUTH=auto. Locally there is no identity: set " +
    "FOUNDRY_API_KEY and FOUNDRY_AUTH=key instead."
  );
}

// ── POST /api/dev-agent — one conversation turn ──
async function handleAgentTurn(req, res) {
  const { profile, userKey } = await resolveIdentity(req);
  let parsed;
  try {
    parsed = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return writeJson(res, 400, { error: { message: "Invalid JSON body" } });
  }
  const message = parsed.message;
  if (!message || typeof message !== "string") {
    return writeJson(res, 400, { error: { message: "message is required" } });
  }
  const autoApply = parsed.autoApply === false ? false : AUTO_APPLY;

  // Load the persisted thread — this is what makes memory survive restarts.
  const session = await store.ensure(userKey, parsed.sessionId);

  const [azureCtx, githubCtx] = await Promise.all([
    cached("azure", CONTEXT_TTL, listAzureResources),
    cached("github", CONTEXT_TTL, listGitHubRepos),
  ]);

  const systemPrompt = buildSystemPrompt({
    profile,
    azureCtx,
    githubCtx,
    sessionTitle: session.title,
  });
  const history = session.messages.slice(-40).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: message },
  ];

  if (!FOUNDRY_KEY && FOUNDRY_AUTH === "key") {
    return writeJson(res, 503, {
      error: { message: authFailureMessage(), code: "no_credentials" },
    });
  }

  const endpoint = `${FOUNDRY_EP}/openai/deployments/${AGENT_ID}/chat/completions?api-version=${AGENT_API_VER}`;
  const callAgent = (auth) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.headers },
      body: JSON.stringify({ messages, max_completion_tokens: 1000 }),
    });

  let responseText;
  try {
    let auth = await resolveFoundryAuth();
    if (!auth) {
      return writeJson(res, 503, {
        error: { message: authFailureMessage(), code: "no_credentials" },
      });
    }
    let ar = await callAgent(auth);
    // A cached token can be revoked or expire early — refresh once, then fail.
    if (ar.status === 401 && auth.mode === "entra") {
      auth = await resolveFoundryAuth({ forceRefresh: true });
      if (auth) ar = await callAgent(auth);
    }
    const ad = await ar.json().catch(() => ({}));
    if (!ar.ok) {
      return writeJson(res, 502, {
        error: {
          message: `Foundry agent error (HTTP ${ar.status})`,
          authMode: auth.mode,
          detail: ad,
        },
      });
    }
    responseText = extractText(ad);
  } catch (e) {
    return writeJson(res, 502, {
      error: { message: "Foundry agent call failed", detail: e.message },
    });
  }

  // Persist the turn before doing anything else, so it is never lost.
  const saved = await store.append(userKey, session.id, [
    { role: "user", content: message },
    { role: "assistant", content: responseText },
  ]);

  // Turn the reply into real files instead of snippets to copy.
  let apply = { applied: [], skipped: [], enabled: autoApply };
  if (autoApply) {
    const blocks = extractFileBlocks(responseText);
    if (blocks.length) {
      const result = await applyFileBlocks({
        root: APPLY_ROOT,
        blocks,
        log: (line) => console.log(line),
      });
      apply = { ...result, enabled: true };
    }
  }

  writeJson(res, 200, {
    response: responseText,
    sessionId: saved.id,
    session: { id: saved.id, title: saved.title, updatedAt: saved.updatedAt },
    user: profile,
    authenticated: Boolean(profile.id || profile.email),
    applied: apply.applied,
    skipped: apply.skipped,
    autoApply: apply.enabled,
  });
}

// ── GET /api/dev-agent (or /api/dev-agent/history) — replay a thread ──
async function handleHistory(req, res, url) {
  const { userKey } = await resolveIdentity(req);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return writeJson(res, 400, { error: { message: "sessionId is required" } });
  const session = await store.get(userKey, sessionId);
  if (!session) {
    return writeJson(res, 200, {
      sessionId,
      title: null,
      messages: [],
      updatedAt: null,
      found: false,
    });
  }
  writeJson(res, 200, {
    sessionId: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages,
    found: true,
  });
}

// ── /api/sessions — list and create ──
async function handleSessions(req, res) {
  const { userKey, profile } = await resolveIdentity(req);
  if (req.method === "GET") {
    const sessions = await store.list(userKey);
    return writeJson(res, 200, { sessions, user: profile });
  }
  // POST → new session
  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    body = {};
  }
  const created = await store.create(userKey, { title: body.title });
  writeJson(res, 201, { session: { id: created.id, title: created.title, createdAt: created.createdAt } });
}

async function handleSessionDelete(req, res, sessionId) {
  const { userKey } = await resolveIdentity(req);
  const ok = await store.remove(userKey, sessionId);
  writeJson(res, ok ? 200 : 404, { deleted: ok, sessionId });
}

// ── Static files ──
// Only dev-portal/ is public. The old code joined every request onto the repo
// root, so /js/chat.js fell through to index.html and the browser received
// HTML where it expected JavaScript — the portal could never boot.
function resolveStatic(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!rel || rel === "/") rel = "/index.html";
  const abs = path.join(STATIC_ROOT, rel);
  const inside = path.relative(STATIC_ROOT, abs);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct = MIME[ext] || "application/octet-stream";
    // index.html is the only unversioned asset: never cache it, or a deploy
    // will not be picked up. CSS/JS are referenced as ?v=N, so they can be
    // cached hard — bump the query string when you change them.
    const versioned = ext === ".js" || ext === ".css";
    res.writeHead(200, {
      "Content-Type": ct,
      "Cache-Control": versioned ? "public, max-age=31536000, immutable" : "no-cache",
      ...SECURITY_HEADERS,
    });
    res.end(content);
  });
}

function handleStatic(req, res, url) {
  const file = resolveStatic(url.pathname);
  if (file) return serveFile(res, file);
  // Unknown path without a file extension → serve the app shell.
  if (!path.extname(url.pathname)) {
    const shell = path.join(STATIC_ROOT, "index.html");
    if (fs.existsSync(shell)) return serveFile(res, shell);
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

// ── Router ──
function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const { pathname } = url;
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors());
        return res.end();
      }

      if (pathname === "/api/health") {
        return writeJson(res, 200, {
          ok: true,
          agent: AGENT_ID,
          // "configured" means an auth path exists, not that it has been exercised.
          foundryConfigured: FOUNDRY_AUTH !== "key" || Boolean(FOUNDRY_KEY),
          auth: {
            mode: FOUNDRY_AUTH,
            scope: FOUNDRY_TOKEN_SCOPE,
            apiKeyPresent: Boolean(FOUNDRY_KEY),
            ...describeIdentityConfig(),
          },
          githubConfigured: Boolean(GITHUB_PAT),
          autoApply: AUTO_APPLY,
          sessionsDir: store.root,
        });
      }

      if (pathname === "/api/dev-agent" || pathname === "/api/dev-agent/") {
        if (req.method === "POST") return await handleAgentTurn(req, res);
        if (req.method === "GET") return await handleHistory(req, res, url);
        return writeJson(res, 405, { error: { message: "Method not allowed" } });
      }

      if (pathname === "/api/dev-agent/history") {
        if (req.method === "GET") return await handleHistory(req, res, url);
        return writeJson(res, 405, { error: { message: "Method not allowed" } });
      }

      if (pathname === "/api/sessions" || pathname === "/api/sessions/") {
        if (req.method === "GET" || req.method === "POST") return await handleSessions(req, res);
        return writeJson(res, 405, { error: { message: "Method not allowed" } });
      }

      const del = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
      if (del && req.method === "DELETE") {
        return await handleSessionDelete(req, res, decodeURIComponent(del[1]));
      }

      if (pathname.startsWith("/api/")) {
        return writeJson(res, 404, { error: { message: "Unknown API route" } });
      }

      return handleStatic(req, res, url);
    } catch (err) {
      console.error("[server] unhandled error", err);
      if (!res.headersSent) {
        writeJson(res, 500, { error: { message: "Internal server error", detail: err.message } });
      }
    }
  });
}

async function start() {
  await store.init();
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`\n=== Dev Agent server on http://localhost:${PORT} ===`);
    console.log(`Listening:       ${HOST}:${PORT}`);
    console.log(`Serves both UI and API on one origin (no Static Web App, no Function App)`);
    console.log(`Web root:        ${STATIC_ROOT}`);
    console.log(`Sessions saved:  ${store.root}`);
    console.log(`Auto-apply:      ${AUTO_APPLY ? "on" : "off"} (DEV_AGENT_AUTO_APPLY=0 to disable)`);
    console.log(
      `Agent auth:      ${FOUNDRY_AUTH} mode` +
        (FOUNDRY_AUTH === "key"
          ? ` (${FOUNDRY_KEY ? "api key configured" : "NO API KEY - calls will fail"})`
          : ` (managed identity via ${describeIdentityConfig().identityEndpoint ? "IDENTITY_ENDPOINT" : "IMDS"}; key ${FOUNDRY_KEY ? "also available" : "not set"})`)
    );
    console.log(`Entra redirect:  http://localhost:${PORT}\n`);
  });
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
}

module.exports = { createServer, start, store, resolveFoundryAuth, ROOT, STATIC_ROOT };
