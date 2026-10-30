// ── Disk-backed session store ──
// Conversations and user memory survive server restarts. Layout:
//   <root>/users/<userKeyHash>/sessions/<sessionId>.json
//   <root>/users/<userKeyHash>/memory.json
//
// A session record is:
//   { id, userKey, title, createdAt, updatedAt, messages: [{role, content, at}] }

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const MAX_MESSAGES = 400; // keep the tail; older turns are dropped
const MAX_TITLE = 70;
const MAX_MEMORIES = 100;
const MAX_MEMORY_LENGTH = 500;

const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;
const MEMORY_ID_RE = /^mem-[a-z0-9-]{8,80}$/;

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

  memoryFilePath(userKey) {
    return path.join(this.userDir(userKey), "memory.json");
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

  async _readMemory(userKey) {
    const file = this.memoryFilePath(userKey);
    try {
      const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
      if (!parsed || parsed.userKey !== userKey || !Array.isArray(parsed.items)) {
        return { userKey, updatedAt: null, items: [] };
      }
      return {
        ...parsed,
        items: parsed.items.filter((item) => item && MEMORY_ID_RE.test(item.id) && typeof item.text === "string"),
      };
    } catch (err) {
      if (err.code === "ENOENT") return { userKey, updatedAt: null, items: [] };
      console.error("[session-store] unreadable user memory", file, err.message);
      return { userKey, updatedAt: null, items: [] };
    }
  }

  async _writeMemory(userKey, items) {
    const file = this.memoryFilePath(userKey);
    const now = new Date().toISOString();
    await this._write(file, { userKey, updatedAt: now, items });
  }

  async listMemories(userKey) {
    const { items } = await this._readMemory(userKey);
    return items;
  }

  async remember(userKey, value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) throw new Error("Memory text is required");
    if (text.length > MAX_MEMORY_LENGTH) {
      throw new Error(`Memory must be ${MAX_MEMORY_LENGTH} characters or fewer`);
    }

    const file = this.memoryFilePath(userKey);
    return this._withLock(file, async () => {
      const { items } = await this._readMemory(userKey);
      const existing = items.find((item) => item.text.toLocaleLowerCase() === text.toLocaleLowerCase());
      if (existing) return existing;
      if (items.length >= MAX_MEMORIES) throw new Error(`Memory is limited to ${MAX_MEMORIES} items`);

      const item = {
        id: `mem-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`,
        text,
        createdAt: new Date().toISOString(),
      };
      await this._writeMemory(userKey, [...items, item]);
      return item;
    });
  }

  async forgetMemory(userKey, memoryId) {
    if (!MEMORY_ID_RE.test(String(memoryId || ""))) return false;
    const file = this.memoryFilePath(userKey);
    return this._withLock(file, async () => {
      const { items } = await this._readMemory(userKey);
      const remaining = items.filter((item) => item.id !== memoryId);
      if (remaining.length === items.length) return false;
      await this._writeMemory(userKey, remaining);
      return true;
    });
  }

  async forgetMemoryText(userKey, value) {
    const text = String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    if (!text) return false;
    const file = this.memoryFilePath(userKey);
    return this._withLock(file, async () => {
      const { items } = await this._readMemory(userKey);
      const remaining = items.filter((item) => item.text.toLocaleLowerCase() !== text);
      if (remaining.length === items.length) return false;
      await this._writeMemory(userKey, remaining);
      return true;
    });
  }

  async clearMemories(userKey) {
    const file = this.memoryFilePath(userKey);
    return this._withLock(file, async () => {
      const { items } = await this._readMemory(userKey);
      if (items.length) await this._writeMemory(userKey, []);
      return items.length;
    });
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
