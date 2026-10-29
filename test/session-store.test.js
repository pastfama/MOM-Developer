const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const { SessionStore, deriveTitle, SESSION_ID_RE } = require("../lib/session-store");

const newStore = async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sessions-"));
  const store = new SessionStore({ root });
  await store.init();
  return { store, root };
};

test("appends turns and reads them back", async () => {
  const { store, root } = await newStore();
  const session = await store.create("entra:user-1");
  await store.append("entra:user-1", session.id, [
    { role: "user", content: "remember the deploy key is rotated" },
    { role: "assistant", content: "Noted." },
  ]);

  const loaded = await store.get("entra:user-1", session.id);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].role, "user");
  assert.equal(loaded.title, "remember the deploy key is rotated");
  await fsp.rm(root, { recursive: true, force: true });
});

test("survives a process restart (new store instance, same disk)", async () => {
  const { store, root } = await newStore();
  const session = await store.create("entra:user-2");
  await store.append("entra:user-2", session.id, [{ role: "user", content: "save this forever" }]);

  // Simulate `node server.js` being restarted: brand new in-memory state.
  const restarted = new SessionStore({ root });
  await restarted.init();
  const loaded = await restarted.get("entra:user-2", session.id);
  assert.ok(loaded, "session should still exist after restart");
  assert.equal(loaded.messages[0].content, "save this forever");

  const list = await restarted.list("entra:user-2");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, session.id);
  await fsp.rm(root, { recursive: true, force: true });
});

test("ensures a session exists without clobbering it", async () => {
  const { store, root } = await newStore();
  const first = await store.ensure("entra:user-3", "sess-abc123");
  await store.append("entra:user-3", "sess-abc123", [{ role: "user", content: "hi" }]);
  const again = await store.ensure("entra:user-3", "sess-abc123");
  assert.equal(again.id, first.id);
  assert.equal(again.messages.length, 1);
  await fsp.rm(root, { recursive: true, force: true });
});

test("isolates users from each other", async () => {
  const { store, root } = await newStore();
  const s = await store.create("entra:alice");
  await store.append("entra:alice", s.id, [{ role: "user", content: "alice secret" }]);

  assert.equal(await store.get("entra:bob", s.id), null);
  assert.deepEqual(await store.list("entra:bob"), []);
  await fsp.rm(root, { recursive: true, force: true });
});

test("rejects path-traversal session ids", async () => {
  const { store, root } = await newStore();
  for (const bad of ["../../etc/passwd", "..", "a/b", "", "x".repeat(200)]) {
    assert.equal(store.filePath("entra:user-4", bad), null, `should reject ${bad}`);
  }
  assert.equal(await store.get("entra:user-4", "../../etc/passwd"), null);
  await fsp.rm(root, { recursive: true, force: true });
});

test("serialises concurrent appends without losing turns", async () => {
  const { store, root } = await newStore();
  const s = await store.create("entra:user-5");
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.append("entra:user-5", s.id, [{ role: "user", content: "msg " + i }])
    )
  );
  const loaded = await store.get("entra:user-5", s.id);
  assert.equal(loaded.messages.length, 20);
  await fsp.rm(root, { recursive: true, force: true });
});

test("derives concise titles", () => {
  assert.equal(deriveTitle("  hello   world  "), "hello world");
  assert.equal(deriveTitle(""), "Untitled session");
  assert.ok(deriveTitle("x".repeat(200)).length <= 70);
});

test("removes sessions", async () => {
  const { store, root } = await newStore();
  const s = await store.create("entra:user-6");
  assert.equal(await store.remove("entra:user-6", s.id), true);
  assert.equal(await store.get("entra:user-6", s.id), null);
  await fsp.rm(root, { recursive: true, force: true });
});

test("session id format is enforced", () => {
  assert.ok(SESSION_ID_RE.test("sess-abc123"));
  assert.ok(!SESSION_ID_RE.test("../x"));
});
