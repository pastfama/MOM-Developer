// ── Local dev server for dev.fameshire.com Dev Agent portal ──
// Run:  node server.js   →  http://localhost:3000

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const FOUNDRY_EP = process.env.FOUNDRY_PROJECT_ENDPOINT || "https://fameshire-foundry-resource.services.ai.azure.com/api/projects/fameshire-foundry";
const AGENT_ID = process.env.AGENT_ID || "momtv-developer";
const AGENT_API_VER = process.env.AGENT_API_VERSION || "2025-05-15-preview";
const FOUNDRY_KEY = process.env.FOUNDRY_API_KEY || "";
const GITHUB_PAT = process.env.GITHUB_PAT || "";
const SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID || "8cce2fe7-7c75-4969-9da9-707aadd13e52";
const TENANT_ID = process.env.AZURE_TENANT_ID || "185b412d-bddc-454b-9987-40628582c63c";

const sessions = new Map();

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

async function getAzToken() {
  try {
    const res = await fetch("http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/", { headers: { Metadata: "true" } });
    const data = await res.json();
    return data.access_token || null;
  } catch (e) { return null; }
}

async function listAzureResources() {
  const token = await getAzToken();
  if (!token) return "Azure estate discovery unavailable (no managed identity on local VM).";
  try {
    const url = `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resources?api-version=2022-09-01`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return "Azure estate discovery failed (HTTP " + res.status + ").";
    const data = await res.json();
    const items = (data.value || []).map((r) => `• ${r.name} — ${r.type} — RG: ${r.resourceGroup || "—"}`).slice(0, 60);
    return items.length ? items.join("\n") : "No Azure resources found in subscription.";
  } catch (e) { return "Azure estate discovery error: " + e.message; }
}

async function listGitHubRepos() {
  if (!GITHUB_PAT) return "GitHub repositories unavailable (GITHUB_PAT not set).";
  try {
    const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
      headers: { Authorization: `token ${GITHUB_PAT}`, "User-Agent": "fameshire-dev-agent-local", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return "GitHub repositories unavailable (API error " + res.status + ").";
    const data = await res.json();
    const items = (data || []).map((r) => `• ${r.full_name} — ${r.language || "?"} — ${r.private ? "private" : "public"} — ${r.description || "(no description)"}`).slice(0, 40);
    return items.length ? items.join("\n") : "No GitHub repositories found.";
  } catch (e) { return "GitHub repositories error: " + e.message; }
}

async function getUserProfile(accessToken) {
  if (!accessToken) return { name: "Unknown", email: "", id: "" };
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return { name: "Unknown", email: "", id: "" };
    const d = await res.json();
    return { name: d.displayName || "", email: d.userPrincipalName || d.mail || "", id: d.id || "" };
  } catch (e) { return { name: "Unknown", email: "", id: "" }; }
}

function extractText(ad) {
  return (((ad && ad.output) || []).map((o) => o.text || ((o.content || []).map((c) => c.text || "").join("") || "")).join("") || "(no response)");
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function writeJson(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = { ...cors(), "Content-Length": Buffer.byteLength(body) };
  res.writeHead(status, headers);
  res.end(body);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" }[ext] || "text/plain";
    res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache" });
    res.end(content);
  });
}

async function handleDevAgent(req, res) {
  const auth = req.headers["authorization"] || "";
  const accessToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const profile = await getUserProfile(accessToken);
  const body = await readBody(req);
  let parsed;
  try { parsed = JSON.parse(body || "{}"); } catch { writeJson(res, 400, { error: "Invalid JSON" }); return; }
  const { message, sessionId: clientSid } = parsed;
  if (!message || typeof message !== "string") { writeJson(res, 400, { error: "message is required" }); return; }
  const sessionId = clientSid || "sess-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  let session = sessions.get(sessionId);
  if (!session) { session = { user: profile, messages: [] }; sessions.set(sessionId, session); }
  else if (profile.name && profile.name !== "Unknown") { session.user = profile; }
  const [azureCtx, githubCtx] = await Promise.all([listAzureResources(), listGitHubRepos()]);
  const systemPrompt = `You are the user's personal Dev Agent.

IDENTITY — You are speaking to ${profile.name || "the user"} (${profile.email}), Microsoft Entra ID ID: ${profile.id}. You know who they are. Address them by name. Their identity comes from Microsoft login on dev.fameshire.com.

MEMORY — You remember everything said earlier in this session. Reference prior turns when relevant. Do not ask the user to repeat themselves.

AZURE ESTATE (subscription ${SUBSCRIPTION_ID}, tenant ${TENANT_ID}):
${azureCtx}

GITHUB REPOSITORIES (user: pastfama):
${githubCtx}

CAPABILITIES — You can answer questions about any of the above, write code, suggest Azure changes, review GitHub repos, and help the user build and debug. Be concise, practical, and never invent resource names or repo names that are not in the lists above. If you don't know something, say so.`;
  const messages = [
    { type: "message", role: "system", content: systemPrompt },
    ...session.messages.map((m) => ({ type: "message", role: m.role, content: m.content })),
    { type: "message", role: "user", content: message },
  ];
  const endpoint = FOUNDRY_EP + "/agents/" + AGENT_ID + "/endpoint/protocols/openai/responses?api-version=" + AGENT_API_VER;
  let responseText = "";
  try {
    const ar = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "api-key": FOUNDRY_KEY }, body: JSON.stringify({ model: "gpt-4.1-mini", input: messages }) });
    const ad = await ar.json();
    if (!ar.ok) { writeJson(res, ar.status, { error: { message: "Foundry agent error", detail: ad } }); return; }
    responseText = extractText(ad);
  } catch (e) { writeJson(res, 502, { error: { message: "Foundry agent call failed", detail: e.message } }); return; }
  session.messages.push({ role: "user", content: message });
  session.messages.push({ role: "assistant", content: responseText });
  writeJson(res, 200, { response: responseText, sessionId, user: profile });
}

async function handleHistory(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");
  const auth = req.headers["authorization"] || "";
  const accessToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const profile = await getUserProfile(accessToken);
  let session = sessionId ? sessions.get(sessionId) : null;
  if (!session) session = { user: profile, messages: [] };
  writeJson(res, 200, { messages: session.messages, sessionId });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") { res.writeHead(204, cors()); res.end(); return; }
  if (url.pathname === "/api/dev-agent" || url.pathname === "/api/dev-agent/") {
    if (req.method === "GET") return handleHistory(req, res);
    if (req.method === "POST") return handleDevAgent(req, res);
    res.writeHead(405, { ...cors(), "Content-Length": 0 }); res.end(); return;
  }
  let filePath = path.join(ROOT, url.pathname === "/" ? "/index.html" : url.pathname);
  if (!fs.existsSync(filePath)) filePath = path.join(ROOT, "/dev-portal/index.html");
  if (!fs.existsSync(filePath)) filePath = path.join(ROOT, "/index.html");
  serveFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`\n=== Dev Agent local server on http://localhost:${PORT} ===\n`);
  console.log("Open: http://localhost:" + PORT);
  console.log("API:  POST http://localhost:" + PORT + "/api/dev-agent");
  console.log("Entra redirect URI: http://localhost:" + PORT);
  console.log("Press Ctrl+C to stop.\n");
});

