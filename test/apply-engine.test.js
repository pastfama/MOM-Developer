const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const { extractFileBlocks, applyFileBlocks, validateTarget } = require("../lib/apply-engine");

const tmpRoot = async () => fsp.mkdtemp(path.join(os.tmpdir(), "apply-"));

test("extracts file: blocks and ignores plain language fences", () => {
  const reply = [
    "Here is the change.",
    "```file:dev-portal/js/chat.js",
    "const a = 1;",
    "```",
    "And a snippet that must NOT be written:",
    "```js",
    "const b = 2;",
    "```",
  ].join("\n");

  const blocks = extractFileBlocks(reply);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "dev-portal/js/chat.js");
  assert.equal(blocks[0].content, "const a = 1;\n");
});

test("accepts a bare path fence but not a bare language fence", () => {
  assert.equal(extractFileBlocks("```dev-portal/a.js\nx\n```").length, 1);
  assert.equal(extractFileBlocks("```python\nprint(1)\n```").length, 0);
});

test("ignores an unterminated fence instead of swallowing the reply", () => {
  assert.deepEqual(extractFileBlocks("```file:a/b.js\nconst x = 1;"), []);
});

test("refuses dangerous targets", () => {
  assert.ok(validateTarget("/repo", "../../etc/passwd").reason);
  assert.ok(validateTarget("/repo", ".git/config").reason);
  assert.ok(validateTarget("/repo", "node_modules/x/index.js").reason);
  assert.ok(validateTarget("/repo", "/etc/passwd").reason);
  assert.ok(validateTarget("/repo", ".env").reason);
  assert.ok(validateTarget("/repo", "certs/server.pem").reason);
});

test("writes, updates and reports unchanged files", async () => {
  const root = await tmpRoot();
  const blocks = [{ path: "dev-portal/js/new.js", content: "const x = 1;\n" }];

  const first = await applyFileBlocks({ root, blocks });
  assert.deepEqual(first.applied, [{ path: "dev-portal/js/new.js", action: "created", bytes: 13 }]);
  assert.equal(await fsp.readFile(path.join(root, "dev-portal/js/new.js"), "utf8"), "const x = 1;\n");

  const second = await applyFileBlocks({ root, blocks });
  assert.equal(second.applied[0].action, "unchanged");

  const third = await applyFileBlocks({
    root,
    blocks: [{ path: "dev-portal/js/new.js", content: "const x = 2;\n" }],
  });
  assert.equal(third.applied[0].action, "updated");
  assert.equal(await fsp.readFile(path.join(root, "dev-portal/js/new.js"), "utf8"), "const x = 2;\n");

  await fsp.rm(root, { recursive: true, force: true });
});

test("skips blocked paths without touching the filesystem", async () => {
  const root = await tmpRoot();
  const result = await applyFileBlocks({
    root,
    blocks: [{ path: "../escape.js", content: "x" }],
  });
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].reason, "path traversal");
  assert.equal(fs.existsSync(path.join(root, "..", "escape.js")), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test("dryRun reports intent without writing", async () => {
  const root = await tmpRoot();
  const result = await applyFileBlocks({
    root,
    blocks: [{ path: "a.js", content: "x" }],
    dryRun: true,
  });
  assert.equal(result.applied[0].action, "created");
  assert.equal(fs.existsSync(path.join(root, "a.js")), false);
  await fsp.rm(root, { recursive: true, force: true });
});
