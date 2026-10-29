// ── Disk-backed session store ──
// Every conversation is persisted per user so the agent survives server
// restarts and browser closes. Layout:
//   <root>/users/<userKeyHash>/sessions/<sessionId>.json
//
// A session record is:
//   { id, userKey, title, createdAt, updatedAt, messages: [{role, content, at}] }

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const MAX_MESSAGES = 400; // keep the tail; older turns are dropped
const MAX_TITLE = 70;

const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

function hashUserKey(userKey) {
  return crypto.createHash("sha256").update(String(userKey)).digest("hex").slice(0, 24);
}

// Turn the first user message into a human-readable session title.
function deriveTitle(text) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "Untitled session";
  return clean.length > MAX_TITLE ? clean.slice(0, MAX_TITLE - 1) + "…" : clean;
}

function newSessionId() {
  return "sess-" + Date.now().toString(36) + "-" + crypto.randomBytes(5).toString("hex");
}

class SessionStore {
  constructor({ root }) {
    this.root = root;
    // Per-file write queue so concurrent turns cannot interleave and corrupt.
    this._locks = new Map();
  }

  async init() {
    await fsp.mkdir(path.join(this.root, "users"), { recursive: true });
  }

  userDir(userKey) {
    return path.join(this.root, "users", hashUserKey(userKey));
  }

  // Returns an absolute path only for well-formed ids, so a malicious
  // sessionId can never escape the user's directory (path traversal).
  filePath(userKey, sessionId) {
    if (!SESSION_ID_RE.test(String(sessionId || ""))) return null;
    return path.join(this.userDir(userKey), "sessions", `${sessionId}.json`);
  }

  _withLock(file, fn) {
    const prev = this._locks.get(file) || Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive but never leak a rejected promise.
    this._locks.set(
      file,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  async _read(file) {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
      if (!parsed || typeof parsed !== "object") return null;
      if (!Array.isArray(parsed.messages)) parsed.messages = [];
      return parsed;
    } catch (err) {
      if (err.code === "ENOENT") return null;
      // A corrupt file must not take the whole portal down.
      console.error("[session-store] unreadable session", file, err.message);
      return null;
    }
  }

  async _write(file, record) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await fsp.rename(tmp, file); // atomic swap
  }

  async get(userKey, sessionId) {
    const file = this.filePath(userKey, sessionId);
    if (!file) return null;
    const record = await this._read(file);
    if (!record) return null;
    // Never hand one user's conversation to another.
    if (record.userKey && record.userKey !== userKey) return null;
    return record;
  }

  async create(userKey, { id, title } = {}) {
    const sessionId = id && SESSION_ID_RE.test(id) ? id : newSessionId();
    const file = this.filePath(userKey, sessionId);
    if (!file) throw new Error("Invalid session id");
    const now = new Date().toISOString();
    const record = {
      id: sessionId,
      userKey,
      title: title ? deriveTitle(title) : "New session",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await this._withLock(file, () => this._write(file, record));
    return record;
  }

  // Existing record, or a freshly created one — callers don't need to care.
  async ensure(userKey, sessionId) {
    if (!sessionId) return this.create(userKey);
    return (await this.get(userKey, sessionId)) || this.create(userKey, { id: sessionId });
  }

  // Append a batch of turns and persist. Returns the stored record.
  async append(userKey, sessionId, messages) {
    const file = this.filePath(userKey, sessionId);
    if (!file) throw new Error("Invalid session id");
    return this._withLock(file, async () => {
      const now = new Date().toISOString();
      const record = (await this._read(file)) || {
        id: sessionId,
        userKey,
        title: "New session",
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      for (const m of [].concat(messages || [])) {
        if (!m || !m.role || typeof m.content !== "string") continue;
        record.messages.push({ role: m.role, content: m.content, at: now });
        if (!record.title || record.title === "New session") {
          if (m.role === "user") record.title = deriveTitle(m.content);
        }
      }
      if (record.messages.length > MAX_MESSAGES) {
        record.messages = record.messages.slice(-MAX_MESSAGES);
      }
      record.userKey = userKey;
      record.updatedAt = now;
      await this._write(file, record);
      return record;
    });
  }

  async list(userKey) {
    const dir = path.join(this.userDir(userKey), "sessions");
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this._read(path.join(dir, name));
      if (!record || record.userKey !== userKey) continue;
      const last = record.messages[record.messages.length - 1];
      out.push({
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        turns: record.messages.length,
        preview: last ? String(last.content).replace(/\s+/g, " ").slice(0, 120) : "",
      });
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async remove(userKey, sessionId) {
    const file = this.filePath(userKey, sessionId);
    if (!file) return false;
    try {
      await fsp.unlink(file);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }
}

module.exports = {
  SessionStore,
  deriveTitle,
  newSessionId,
  hashUserKey,
  SESSION_ID_RE,
  MAX_MESSAGES,
};
