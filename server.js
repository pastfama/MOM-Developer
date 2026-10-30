// ── Local dev server for dev.fameshire.com Dev Agent portal ──
// Run:  node server.js   →  http://localhost:3000

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const { SessionStore } = require("./lib/session-store");
const { JobStore } = require("./lib/job-store");
const { extractFileBlocks, applyFileBlocks } = require("./lib/apply-engine");
const { getFoundryToken, describeIdentityConfig } = require("./lib/foundry-auth");
const fivemRouter = require("./lib/fivem-router");

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
const jobStore = new JobStore({ root: path.join(DATA_ROOT, "jobs") });

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

FIVEM SERVER â€” You are also developing for a FiveM GTA V multiplayer server named "My FiveM Server".
- Use standard FiveM structure: each resource gets its own folder with fxmanifest.lua, client.lua, server.lua
- Use QBcore framework patterns (exports["qb-core"]:GetCoreObject(), QBCore.Functions, QBCore.Commands.Add)
- All Lua files go into fivem-resources/<resource-name>/ and are auto-deployed to the FiveM server
- Include fx_version 'cerulean' and game 'gta5' in fxmanifest.lua

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
  let message, sessionId, autoApply, uploadFiles = [];
  const ct = req.headers["content-type"] || "";
  if (ct && ct.includes("multipart/form-data")) {
    const boundary = ct.split("boundary=")[1];
    if (!boundary) {
      return writeJson(res, 400, { error: { message: "Missing boundary" } });
    }
    const raw = await readBody(req);
    const text = raw.toString("utf-8");
    const parts = text.split("--" + boundary);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed === "--") continue;
      const sepIdx = trimmed.indexOf("\r\n\r\n");
      if (sepIdx < 0) continue;
      const headers = trimmed.slice(0, sepIdx);
      const content = trimmed.slice(sepIdx + 4).replace(/\r\n$/, "").trim();
      const nameMatch = headers.match(/name="([^"]+)"/);
      const fileNameMatch = headers.match(/filename="([^"]+)"/);
      if (fileNameMatch) {
        uploadFiles.push({ name: fileNameMatch[1], content });
      } else if (nameMatch) {
        const nm = nameMatch[1];
        if (nm === "message") message = content;
        else if (nm === "sessionId") sessionId = content;
        else if (nm === "autoApply") autoApply = content === "true" ? false : AUTO_APPLY;
      }
    }
    if (!message || typeof message !== "string") {
      return writeJson(res, 400, { error: { message: "message is required" } });
    }
    autoApply = autoApply === undefined ? (AUTO_APPLY !== false) : autoApply;
  } else {
    let parsed;
    try {
      parsed = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return writeJson(res, 400, { error: { message: "Invalid JSON body" } });
    }
    message = parsed.message;
    sessionId = parsed.sessionId;
    autoApply = parsed.autoApply === false ? false : AUTO_APPLY;
    if (!message || typeof message !== "string") {
      return writeJson(res, 400, { error: { message: "message is required" } });
    }
  }

  // Prepend uploaded file contents to the message so the agent can read them
  let fullMessage = message;
  if (uploadFiles.length) {
    const fileContext = uploadFiles.map(f => {
      const isText = /\.(txt|js|ts|jsx|tsx|json|md|py|html|css|java|c|cpp|h|go|rs|rb|php|sh|yaml|yml|xml|ini|cfg|conf|log|sql)$/i.test(f.name);
      if (isText) {
        return "\n\n--- FILE: " + f.name + " ---\n" + f.content + "\n--- END FILE ---";
      }
      return "\n\n--- FILE: " + f.name + " (binary, " + f.content.length + " bytes) ---";
    }).join("");
    fullMessage = message + fileContext;
  }


  // Load the persisted thread — this is what makes memory survive restarts.
  const session = await store.ensure(userKey, sessionId);

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
    { role: "user", content: fullMessage },
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
    { role: "user", content: fullMessage },
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

    // FiveM auto-deploy
  const fivemDeployResult = await fivemRouter.autoDeploy(apply.applied, "agent turn");

  writeJson(res, 200, {
    response: responseText,
    sessionId: saved.id,
    session: { id: saved.id, title: saved.title, updatedAt: saved.updatedAt },
    user: profile,
    authenticated: Boolean(profile.id || profile.email),
    applied: apply.applied,
    skipped: apply.skipped,
    autoApply: apply.enabled,
    fivem: fivemDeployResult,
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

// ── /api/jobs — list and create jobs —─
async function handleJobs(req, res) {
  const { userKey } = await resolveIdentity(req);
  if (req.method === "GET") {
    const jobs = await jobStore.list(userKey);
    return writeJson(res, 200, { jobs });
  }
  if (req.method === "POST") {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch {}
    const created = await jobStore.create(userKey, {
      title: body.title,
      prompt: body.prompt,
      scheduleType: body.scheduleType,
      intervalMinutes: body.intervalMinutes,
      dailyTime: body.dailyTime,
      cron: body.cron,
      enabled: body.enabled,
    });
    return writeJson(res, 201, { job: created });
  }
  return writeJson(res, 405, { error: { message: "Method not allowed" } });
}

async function handleJobById(req, res, jobId) {
  const { userKey } = await resolveIdentity(req);
  if (req.method === "GET") {
    const job = await jobStore.get(userKey, jobId);
    if (!job) return writeJson(res, 404, { error: { message: "Job not found" } });
    return writeJson(res, 200, { job });
  }
  if (req.method === "DELETE") {
    const ok = await jobStore.remove(userKey, jobId);
    return writeJson(res, ok ? 200 : 404, { deleted: ok, jobId });
  }
  return writeJson(res, 405, { error: { message: "Method not allowed" } });
}

async function handleJobRun(req, res, jobId) {
  const { userKey } = await resolveIdentity(req);
  const job = await jobStore.get(userKey, jobId);
  if (!job) return writeJson(res, 404, { error: { message: "Job not found" } });
  try {
    const result = await runJobTurn(job);
    if (result.error) {
      await jobStore.recordRun(userKey, jobId, null, result.error);
      return writeJson(res, 200, { result: result.error, error: true });
    }
    let out = result.output;
    if (result.applied && result.applied.length)
      out += "\n\nFiles written: " + result.applied.map((a) => a.path).join(", ");
    if (result.skipped && result.skipped.length)
      out += "\n\nSkipped: " + result.skipped.map((s) => s.path).join(", ");
    await jobStore.recordRun(userKey, jobId, out, null);
    // FiveM auto-deploy for jobs
    const jobFivemResult = await fivemRouter.autoDeploy(result.applied || [], "scheduled job: " + job.title);
    if (jobFivemResult?.changed) {
      out += "\\n\\n[FiveM] Deployed to " + FIVEM_SERVER_NAME;
    }
    return writeJson(res, 200, { result: out, fivem: jobFivemResult });
  } catch (e) {
    await jobStore.recordRun(userKey, jobId, null, e.message);
    return writeJson(res, 500, { error: { message: e.message } });
  }
}

async function handleJobToggle(req, res, jobId) {
  const { userKey } = await resolveIdentity(req);
  const job = await jobStore.get(userKey, jobId);
  if (!job) return writeJson(res, 404, { error: { message: "Job not found" } });
  const updated = await jobStore.update(userKey, jobId, { enabled: !job.enabled });
  return writeJson(res, 200, { job: updated });
}

// ── Static files —─
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

      const jobDel = /^\/api\/jobs\/([^/]+)\/(run|toggle)$/.exec(pathname);
      if (jobDel) {
        if (req.method == "POST") {
          const [, jobId, action] = jobDel;
          if (action == "run") return await handleJobRun(req, res, decodeURIComponent(jobId));
          if (action == "toggle") return await handleJobToggle(req, res, decodeURIComponent(jobId));
        }
        return writeJson(res, 405, { error: { message: "Method not allowed" } });
      }

      const jobById = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
      if (jobById && req.method == "GET") return await handleJobById(req, res, decodeURIComponent(jobById[1]));
      if (jobById && req.method == "DELETE") return await handleJobById(req, res, decodeURIComponent(jobById[1]));

      if (pathname === "/api/jobs" || pathname === "/api/jobs/") {
        if (req.method == "GET" || req.method == "POST") return await handleJobs(req, res);
        return writeJson(res, 405, { error: { message: "Method not allowed" } });
      }

      const fivemResult = await fivemRouter.handle(req, res, url, writeJson);
      if (fivemResult) return fivemResult;

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

// ── Run one job turn against Foundry (same context as chat) —─
async function runJobTurn(job) {
  const userKey = job.userKey;
  const [azureCtx, githubCtx] = await Promise.all([
    cached("azure:" + userKey, CONTEXT_TTL, listAzureResources),
    cached("github:" + userKey, CONTEXT_TTL, listGitHubRepos),
  ]);
  const systemPrompt = buildSystemPrompt({
    profile: { name: "Agent", email: "", id: "" },
    azureCtx,
    githubCtx,
    sessionTitle: job.title,
  });
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: job.prompt },
  ];
  if (!FOUNDRY_KEY && FOUNDRY_AUTH === "key") {
    return { error: authFailureMessage(), code: "no_credentials" };
  }
  const endpoint = `${FOUNDRY_EP}/openai/deployments/${AGENT_ID}/chat/completions?api-version=${AGENT_API_VER}`;
  const callAgent = (auth) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.headers },
      body: JSON.stringify({ messages, max_completion_tokens: 1000 }),
    });
  let auth = await resolveFoundryAuth();
  if (!auth) {
    return { error: authFailureMessage(), code: "no_credentials" };
  }
  let ar = await callAgent(auth);
  if (ar.status === 401 && auth.mode === "entra") {
    auth = await resolveFoundryAuth({ forceRefresh: true });
    if (auth) ar = await callAgent(auth);
  }
  const ad = await ar.json().catch(() => ({}));
  if (!ar.ok) {
    return { error: "Foundry agent error (HTTP " + ar.status + ")", code: ar.status, detail: ad };
  }
  const responseText = extractText(ad);
  let applyResult = { applied: [], skipped: [], enabled: false };
  try {
    const blocks = extractFileBlocks(responseText);
    if (blocks.length) {
      const result = await applyFileBlocks({
        root: APPLY_ROOT,
        blocks,
        log: (line) => console.log("[job " + job.id + "] " + line),
      });
      applyResult = { ...result, enabled: true };
    }
  } catch (e) {
    console.error("[job " + job.id + "] apply failed:", e.message);
  }
  return {
    output: responseText,
    applied: applyResult.applied,
    skipped: applyResult.skipped,
    autoApply: applyResult.enabled,
  };
}

// ── Job scheduler — checks every 60s for due jobs —─
let jobTimer = null;

function startJobScheduler() {
  if (jobTimer) return;
  jobTimer = setInterval(async () => {
    try {
      const usersDir = path.join(DATA_ROOT, "jobs", "users");
      let userDirs;
      try {
        userDirs = await fsp.readdir(usersDir);
      } catch {
        return;
      }
      for (const userDir of userDirs) {
        const jobsDir = path.join(usersDir, userDir, "jobs");
        let jobFiles;
        try {
          jobFiles = await fsp.readdir(jobsDir);
        } catch {
          continue;
        }
        for (const jobFile of jobFiles) {
          if (!jobFile.endsWith(".json")) continue;
          const record = await jobStore._read(path.join(jobsDir, jobFile));
          if (!record || !record.enabled || !dueNow(record)) continue;
          const userKey = record.userKey;
          try {
            const result = await runJobTurn(record);
            if (result.error) {
              await jobStore.recordRun(userKey, record.id, null, result.error);
            } else {
              let out = result.output;
              if (result.applied && result.applied.length)
                out += "\n\nFiles written: " + result.applied.map((a) => a.path).join(", ");
              if (result.skipped && result.skipped.length)
                out += "\n\nSkipped: " + result.skipped.map((s) => s.path).join(", ");
              await jobStore.recordRun(userKey, record.id, out, null);
            }
          } catch (e) {
            await jobStore.recordRun(userKey, record.id, null, e.message);
          }
        }
      }
    } catch (e) {
      console.error("[job scheduler] error:", e.message);
    }
  }, 60_000);
  console.log("[job scheduler] started (60s interval)");
}

function stopJobScheduler() {
  if (jobTimer) {
    clearInterval(jobTimer);
    jobTimer = null;
  }
}

async function start() {
  await store.init();
  await jobStore.init();
  await fivemRouter.init();
  startJobScheduler();
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
