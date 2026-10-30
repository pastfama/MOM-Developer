// ── FiveM API router ──
// Handles /api/fivem/* routes. Required by server.js.

const { deploy: fivemDeploy, writeFile: fivemWriteFile, listResources: fivemListResources, restartResource: fivemRestartResource, FIVEM_REPO, DEPLOY_METHOD } = require("./fivem-deploy");
const fsp = require("fs/promises");
const path = require("path");

const FIVEM_ENABLED = process.env.FIVEM_ENABLED !== "0";
const FIVEM_AUTO_DEPLOY = process.env.FIVEM_AUTO_DEPLOY !== "0";
const FIVEM_SERVER_NAME = process.env.FIVEM_SERVER_NAME || "My FiveM Server";
const APPLY_ROOT = path.resolve(process.env.DEV_AGENT_APPLY_ROOT || process.cwd());

async function handle(req, res, url, writeJson) {
  const pathname = url.pathname;

  if (pathname === "/api/fivem/resources" && req.method === "GET") {
    const resources = await fivemListResources();
    return writeJson(res, 200, { resources, method: DEPLOY_METHOD, repo: FIVEM_REPO });
  }

  if (pathname === "/api/fivem/deploy" && req.method === "POST") {
    try {
      const result = await fivemDeploy("Manual deploy from portal");
      return writeJson(res, 200, { ok: true, changed: result.changed });
    } catch (e) {
      return writeJson(res, 500, { error: { message: "FiveM deploy failed: " + e.message } });
    }
  }

  const fivemRestart = /^\/api\/fivem\/restart\/([^/]+)$/.exec(pathname);
  if (fivemRestart && req.method === "POST") {
    const result = await fivemRestartResource(decodeURIComponent(fivemRestart[1]));
    return writeJson(res, 200, result);
  }

  if (pathname === "/api/fivem/status" && req.method === "GET") {
    return writeJson(res, 200, {
      enabled: FIVEM_ENABLED,
      autoDeploy: FIVEM_AUTO_DEPLOY,
      method: DEPLOY_METHOD,
      repo: FIVEM_REPO,
      serverName: FIVEM_SERVER_NAME,
    });
  }

  return null; // not a FiveM route
}

// Called from handleAgentTurn and runJobTurn to auto-deploy .lua files
async function autoDeploy(applied, sourceLabel) {
  if (!FIVEM_ENABLED || !FIVEM_AUTO_DEPLOY || !applied || !applied.length) return null;
  const luaFiles = applied.filter(a => a.path.endsWith(".lua") || a.path.endsWith("fxmanifest.lua") || a.path.endsWith("__resource.lua"));
  if (!luaFiles.length) return null;
  try {
    for (const f of luaFiles) {
      const fullPath = path.join(APPLY_ROOT, f.path);
      let content = "";
      try { content = await fsp.readFile(fullPath, "utf8"); } catch {}
      await fivemWriteFile(f.path, content);
    }
    const result = await fivemDeploy("Auto-deploy from " + sourceLabel);
    return result;
  } catch (e) {
    console.error("[fivem] auto-deploy failed:", e.message);
    return { error: e.message };
  }
}

async function init() {
  if (!FIVEM_ENABLED) return;
  try {
    await fsp.mkdir(FIVEM_REPO, { recursive: true });
    console.log("[fivem] Repo ready at " + FIVEM_REPO);
  } catch (e) {
    console.error("[fivem] init failed:", e.message);
  }
}

module.exports = { handle, autoDeploy, init, FIVEM_ENABLED, FIVEM_SERVER_NAME };