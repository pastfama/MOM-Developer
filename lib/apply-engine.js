// ── Apply engine ──
// The agent used to answer with code snippets in chat and leave the work to
// you. Instead it now labels each file it wants to change:
//
//     ```file:dev-portal/js/chat.js
//     ...full file contents...
//     ```
//
// Those blocks are written straight into the repo, so a request completes
// instead of stopping at "let me know if you need help integrating this".

const fsp = require("fs/promises");
const path = require("path");

const MAX_FILE_BYTES = 512 * 1024; // per file
const MAX_TOTAL_BYTES = 2 * 1024 * 1024; // per response

// Anything that isn't source we are willing to write unattended.
const DENY_DIRS = [".git", "node_modules", ".data", ".cline-home", ".vscode", ".ssh", ".azure"];
const DENY_EXT = new Set([
  ".pem", ".key", ".pfx", ".p12", ".crt", ".cer", ".der", ".zip", ".gz", ".tgz",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".png", ".jpg", ".jpeg", ".gif",
  ".webp", ".ico", ".pdf", ".woff", ".woff2", ".ttf", ".mp4", ".mp3",
]);

// Fence info strings that are languages, not file paths.
const KNOWN_LANGS = new Set([
  "js", "javascript", "jsx", "ts", "typescript", "tsx", "json", "html", "css",
  "scss", "bash", "sh", "shell", "zsh", "powershell", "ps1", "python", "py",
  "node", "sql", "yaml", "yml", "toml", "ini", "xml", "md", "markdown", "diff",
  "text", "txt", "plaintext", "console", "output", "http", "csharp", "cs",
  "java", "go", "rust", "rb", "php", "dockerfile", "graphql", "env",
]);

const PATH_RE = /^[A-Za-z0-9._\-\/]+$/;

// Decide whether a fence's info string names a file we should write.
function parseFenceTarget(info) {
  const raw = String(info || "").trim();
  if (!raw) return null;
  const cleaned = raw.replace(/^file:\s*/, "").trim();
  const first = cleaned.split(/\s+/)[0];
  if (!first) return null;
  if (!cleaned.startsWith("file:")) {
    // A bare fence is only a file when it clearly looks like a path.
    if (KNOWN_LANGS.has(first.toLowerCase())) return null;
    if (!first.includes("/") || !/\.[A-Za-z0-9]+$/.test(first)) return null;
  }
  if (!PATH_RE.test(first)) return null;
  return first;
}

function extractFileBlocks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*```(.*)$/.exec(lines[i]);
    if (!open) continue;
    const target = parseFenceTarget(open[1]);
    if (!target) continue;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^\s*```\s*$/.test(lines[j])) break;
      body.push(lines[j]);
    }
    if (j >= lines.length) break; // unterminated fence: ignore
    blocks.push({ path: target, content: body.join("\n") + "\n" });
    i = j;
  }
  return blocks;
}

// Returns { rel } on success or { reason } when the path must be refused.
function validateTarget(root, target) {
  const rel = String(target).replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!rel) return { reason: "empty path" };
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return { reason: "absolute path" };
  const segments = rel.split("/");
  if (segments.some((s) => s === "..")) return { reason: "path traversal" };
  if (segments.some((s) => DENY_DIRS.includes(s))) return { reason: "protected directory" };
  if (segments[0] === ".env" || /^\.env\./.test(segments[0])) return { reason: "secrets file" };
  if (DENY_EXT.has(path.extname(rel).toLowerCase())) return { reason: "binary or key file" };
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return { reason: "outside repo" };
  return { rel, abs };
}

async function applyFileBlocks({ root, blocks, dryRun = false, log = () => {} }) {
  const applied = [];
  const skipped = [];
  let total = 0;

  for (const block of blocks || []) {
    const check = validateTarget(root, block.path);
    if (!check.rel) {
      skipped.push({ path: String(block.path), reason: check.reason });
      continue;
    }
    const content = String(block.content ?? "");
    const bytes = Buffer.byteLength(content, "utf8");
    if (content.includes("\u0000")) {
      skipped.push({ path: check.rel, reason: "binary content" });
      continue;
    }
    if (bytes > MAX_FILE_BYTES) {
      skipped.push({ path: check.rel, reason: `file too large (${bytes} bytes)` });
      continue;
    }
    if (total + bytes > MAX_TOTAL_BYTES) {
      skipped.push({ path: check.rel, reason: "response exceeds total size limit" });
      continue;
    }

    let action = "created";
    try {
      const existing = await fsp.readFile(check.abs, "utf8");
      if (existing === content) action = "unchanged";
      else action = "updated";
    } catch (err) {
      if (err.code !== "ENOENT") {
        skipped.push({ path: check.rel, reason: "unreadable: " + err.message });
        continue;
      }
    }

    if (action === "unchanged") {
      applied.push({ path: check.rel, action, bytes });
      continue;
    }
    if (!dryRun) {
      try {
        await fsp.mkdir(path.dirname(check.abs), { recursive: true });
        await fsp.writeFile(check.abs, content, "utf8");
      } catch (err) {
        skipped.push({ path: check.rel, reason: "write failed: " + err.message });
        continue;
      }
    }
    total += bytes;
    applied.push({ path: check.rel, action, bytes });
    log(`[apply] ${action} ${check.rel} (${bytes} bytes)`);
  }

  return { applied, skipped };
}

module.exports = {
  extractFileBlocks,
  applyFileBlocks,
  validateTarget,
  parseFenceTarget,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
};
