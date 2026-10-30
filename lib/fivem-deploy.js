// ── FiveM deployment module ──
// Pushes agent-written files to your FiveM server via git, rsync, or SFTP.
// Configure in dev-agent.env:
//   FIVEM_DEPLOY_METHOD=git|rsync|sftp
//   FIVEM_DEPLOY_TARGET=/path/to/fivem-server/resources  (local rsync)
//   FIVEM_DEPLOY_REMOTEPATH=/path/to/fivem-server/resources (remote rsync/SFTP)
//   FIVEM_DEPLOY_HOST=your.fivem.server
//   FIVEM_DEPLOY_USER=deployuser
//   FIVEM_DEPLOY_KEY=~/.ssh/id_rsa
//   FIVEM_DEPLOY_BRANCH=main

const fsp = require("fs/promises");
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

const ROOT = process.cwd();
const FIVEM_REPO = path.join(ROOT, "fivem-resources"); // local staging dir
const DEPLOY_METHOD = process.env.FIVEM_DEPLOY_METHOD || "git";
const DEPLOY_TARGET = process.env.FIVEM_DEPLOY_TARGET || "";
const DEPLOY_REMOTEPATH = process.env.FIVEM_DEPLOY_REMOTEPATH || "";
const DEPLOY_HOST = process.env.FIVEM_DEPLOY_HOST || "";
const DEPLOY_USER = process.env.FIVEM_DEPLOY_USER || "";
const DEPLOY_KEY = process.env.FIVEM_DEPLOY_KEY || "";
const DEPLOY_BRANCH = process.env.FIVEM_DEPLOY_BRANCH || "main";

function log(...args) {
  console.log("[FiveM Deploy]", ...args);
}

async function ensureGitRepo() {
  try {
    await fsp.access(path.join(FIVEM_REPO, ".git"));
    log("FiveM git repo exists at", FIVEM_REPO);
  } catch {
    log("Initializing FiveM git repo at", FIVEM_REPO);
    await fsp.mkdir(FIVEM_REPO, { recursive: true });
    await execPromise("git init", { cwd: FIVEM_REPO });
    await execPromise(`git checkout -b ${DEPLOY_BRANCH}`, { cwd: FIVEM_REPO });
  }
}

async function writeFile(relativePath, content) {
  const fullPath = path.join(FIVEM_REPO, relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, "utf8");
  log("Wrote", relativePath);
}

async function commitAndPush(message) {
  await execPromise(`git add -A`, { cwd: FIVEM_REPO });
  const { stdout } = await execPromise(
    `git -c user.email="devagent@mom-dev.local" -c user.name="Dev Agent" commit -m "${message}" --allow-empty`,
    { cwd: FIVEM_REPO }
  );
  if (stdout.includes("nothing to commit")) {
    log("No changes to commit");
    return { changed: false };
  }
  await execPromise(`git push origin ${DEPLOY_BRANCH}`, { cwd: FIVEM_REPO });
  log("Pushed to origin/" + DEPLOY_BRANCH);
  return { changed: true };
}

async function rsyncLocal() {
  if (!DEPLOY_TARGET) {
    throw new Error("FIVEM_DEPLOY_TARGET not set");
  }
  await fsp.mkdir(DEPLOY_TARGET, { recursive: true });
  await execPromise(
    `rsync -av --delete ${FIVEM_REPO}/ ${DEPLOY_TARGET}/`,
    { cwd: ROOT }
  );
  log("Rsynced to", DEPLOY_TARGET);
}

async function rsyncRemote() {
  if (!DEPLOY_HOST || !DEPLOY_USER || !DEPLOY_REMOTEPATH) {
    throw new Error("FIVEM_DEPLOY_HOST, FIVEM_DEPLOY_USER, FIVEM_DEPLOY_REMOTEPATH required");
  }
  const keyFlag = DEPLOY_KEY ? `-e "ssh -i ${DEPLOY_KEY}"` : "";
  await execPromise(
    `rsync -av --delete -e "ssh -i ${DEPLOY_KEY}" ${FIVEM_REPO}/ ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_REMOTEPATH}/`,
    { cwd: ROOT }
  );
  log("Rsynced to", DEPLOY_USER + "@" + DEPLOY_HOST + ":" + DEPLOY_REMOTEPATH);
}

async function deploy(commitMessage) {
  await ensureGitRepo();
  let result = { changed: false };

  if (DEPLOY_METHOD === "git") {
    result = await commitAndPush(commitMessage);
  } else if (DEPLOY_METHOD === "rsync") {
    await rsyncLocal();
    result.changed = true;
  } else if (DEPLOY_METHOD === "sftp-rsync") {
    await rsyncRemote();
    result.changed = true;
  } else {
    throw new Error("Unknown FIVEM_DEPLOY_METHOD: " + DEPLOY_METHOD);
  }

  return result;
}

async function listResources() {
  const resources = [];
  try {
    const entries = await fsp.readdir(FIVEM_REPO, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fxPath = path.join(FIVEM_REPO, entry.name, "fxmanifest.lua");
        let hasFxmanifest = false;
        try {
          await fsp.access(fxPath);
          hasFxmanifest = true;
        } catch {}
        resources.push({ name: entry.name, hasFxmanifest });
      }
    }
  } catch {
    // repo may not exist yet
  }
  return resources;
}

async function restartResource(resourceName) {
  // This would typically send an RCON command to the FiveM server
  // or trigger a webhook. Implement based on your server setup.
  log("Restart resource requested:", resourceName);
  return { resource: resourceName, restarted: false, note: "Implement RCON/webhook restart" };
}

module.exports = {
  deploy,
  writeFile,
  listResources,
  restartResource,
  FIVEM_REPO,
  DEPLOY_METHOD,
};