// ── Disk-backed job store for persistent agent jobs ──
// Jobs run on a schedule (interval, daily, or cron) and execute the agent
// with a saved prompt. Layout:
//   <root>/users/<userKeyHash>/jobs/<jobId>.json
//
// A job record is:
//   { id, userKey, title, prompt, scheduleType, intervalMinutes, dailyTime,
//     cron, enabled, lastRun, nextRun, results: [], createdAt, updatedAt }

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

function hashUserKey(userKey) {
  return crypto.createHash("sha256").update(String(userKey)).digest("hex").slice(0, 24);
}

function newJobId() {
  return "job-" + Date.now().toString(36) + "-" + crypto.randomBytes(5).toString("hex");
}

const JOB_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

// ── Simple cron matcher (5-field: minute hour day month weekday) ──
const FIELD_RANGES = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let v = min; v <= max; v++) values.add(v);
    } else if (part.includes("/")) {
      const [base, step] = part.split("/");
      const start = base === "*" ? min : parseInt(base, 10);
      const inc = parseInt(step, 10);
      for (let v = start; v <= max; v += inc) values.add(v);
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      for (let v = lo; v <= hi; v++) values.add(v);
    } else {
      values.add(parseInt(part, 10));
    }
  }
  return values;
}

function parseCron(cron) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  return [
    parseField(fields[0], 0, 59),
    parseField(fields[1], 0, 23),
    parseField(fields[2], 1, 31),
    parseField(fields[3], 1, 12),
    parseField(fields[4], 0, 6),
  ];
}

function cronMatches(parsed, date) {
  return (
    parsed[0].has(date.getMinutes()) &&
    parsed[1].has(date.getHours()) &&
    parsed[2].has(date.getDate()) &&
    parsed[3].has(date.getMonth() + 1) &&
    parsed[4].has(date.getDay())
  );
}

function computeNextRun(job) {
  const now = new Date();
  if (job.scheduleType === "interval") {
    const next = new Date(now.getTime() + job.intervalMinutes * 60 * 1000);
    return next.toISOString();
  }
  if (job.scheduleType === "daily") {
    const [hh, mm] = job.dailyTime.split(":").map(Number);
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  if (job.scheduleType === "cron" && job.cron) {
    const parsed = parseCron(job.cron);
    if (!parsed) return null;
    const next = new Date(now.getTime() + 60000);
    for (let i = 0; i < 525600; i++) {
      if (cronMatches(parsed, next)) return next.toISOString();
      next.setMinutes(next.getMinutes() + 1);
    }
    return null;
  }
  return null;
}

function dueNow(job) {
  if (!job.enabled || !job.nextRun) return false;
  return new Date(job.nextRun) <= new Date();
}class JobStore {
  constructor({ root }) {
    this.root = root;
    this._locks = new Map();
  }

  async init() {
    await fsp.mkdir(path.join(this.root, "users"), { recursive: true });
  }

  userDir(userKey) {
    return path.join(this.root, "users", hashUserKey(userKey));
  }

  filePath(userKey, jobId) {
    if (!JOB_ID_RE.test(String(jobId || ""))) return null;
    return path.join(this.userDir(userKey), "jobs", `${jobId}.json`);
  }

  _withLock(file, fn) {
    const prev = this._locks.get(file) || Promise.resolve();
    const next = prev.then(fn, fn);
    this._locks.set(
      file,
      next.then(() => {}, () => {})
    );
    return next;
  }

  async _read(file) {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
      if (!parsed || typeof parsed !== "object") return null;
      if (!Array.isArray(parsed.results)) parsed.results = [];
      return parsed;
    } catch (err) {
      if (err.code === "ENOENT") return null;
      console.error("[job-store] unreadable job", file, err.message);
      return null;
    }
  }

  async _write(file, record) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  async get(userKey, jobId) {
    const file = this.filePath(userKey, jobId);
    if (!file) return null;
    const record = await this._read(file);
    if (!record) return null;
    if (record.userKey && record.userKey !== userKey) return null;
    return record;
  }

  async create(userKey, fields) {
    const jobId = fields.id && JOB_ID_RE.test(fields.id) ? fields.id : newJobId();
    const file = this.filePath(userKey, jobId);
    if (!file) throw new Error("Invalid job id");
    const now = new Date().toISOString();
    const record = {
      id: jobId,
      userKey,
      title: fields.title || "Untitled job",
      prompt: fields.prompt || "",
      scheduleType: fields.scheduleType || "interval",
      intervalMinutes: fields.intervalMinutes || 60,
      dailyTime: fields.dailyTime || "09:00",
      cron: fields.cron || "",
      enabled: fields.enabled !== false,
      lastRun: null,
      nextRun: computeNextRun({
        scheduleType: fields.scheduleType || "interval",
        intervalMinutes: fields.intervalMinutes,
        dailyTime: fields.dailyTime,
        cron: fields.cron,
      }),
      results: [],
      createdAt: now,
      updatedAt: now,
    };
    await this._withLock(file, () => this._write(file, record));
    return record;
  }

  async ensure(userKey, jobId) {
    if (!jobId) return null;
    return (await this.get(userKey, jobId)) || null;
  }

  async update(userKey, jobId, fields) {
    const file = this.filePath(userKey, jobId);
    if (!file) throw new Error("Invalid job id");
    return this._withLock(file, async () => {
      const record = await this._read(file);
      if (!record || record.userKey !== userKey) return null;
      Object.assign(record, fields);
      record.updatedAt = new Date().toISOString();
      if (fields.scheduleType || fields.intervalMinutes !== undefined ||
          fields.dailyTime !== undefined || fields.cron !== undefined ||
          fields.enabled !== undefined) {
        record.nextRun = computeNextRun(record);
      }
      await this._write(file, record);
      return record;
    });
  }

  async recordRun(userKey, jobId, output, error) {
    const file = this.filePath(userKey, jobId);
    if (!file) return null;
    return this._withLock(file, async () => {
      const record = await this._read(file);
      if (!record || record.userKey !== userKey) return null;
      const now = new Date().toISOString();
      record.lastRun = now;
      record.results.unshift({
        at: now,
        output: output || null,
        error: error || null,
      });
      if (record.results.length > 50) record.results = record.results.slice(0, 50);
      record.nextRun = computeNextRun(record);
      record.updatedAt = now;
      await this._write(file, record);
      return record;
    });
  }

  async list(userKey) {
    const dir = path.join(this.userDir(userKey), "jobs");
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
      out.push({
        id: record.id,
        title: record.title,
        prompt: record.prompt,
        scheduleType: record.scheduleType,
        intervalMinutes: record.intervalMinutes,
        dailyTime: record.dailyTime,
        cron: record.cron,
        enabled: record.enabled,
        lastRun: record.lastRun,
        nextRun: record.nextRun,
        results: record.results,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async remove(userKey, jobId) {
    const file = this.filePath(userKey, jobId);
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
  JobStore,
  computeNextRun,
  dueNow,
  newJobId,
  hashUserKey,
  JOB_ID_RE,
};
