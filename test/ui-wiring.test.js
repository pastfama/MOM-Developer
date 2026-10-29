const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const portal = path.join(__dirname, "..", "dev-portal");
const html = fs.readFileSync(path.join(portal, "index.html"), "utf8");
const read = (f) => fs.readFileSync(path.join(portal, f), "utf8");

const scripts = ["js/config.js", "js/auth.js", "js/chat.js", "js/app.js"];

test("index.html loads every script in dependency order", () => {
  const positions = scripts.map((src) => {
    const i = html.indexOf(src);
    assert.ok(i !== -1, `${src} must be referenced by index.html`);
    return i;
  });
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted, "scripts must load config → auth → chat → app");
});

test("every element the code looks up actually exists in the page", () => {
  const ids = new Set();
  for (const file of ["js/chat.js", "js/auth.js"]) {
    const src = read(file);
    for (const m of src.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  }
  assert.ok(ids.size > 5, "expected the UI to look up several elements");
  for (const id of ids) {
    // Landing/chat panels are toggled by id, and must be present too.
    assert.ok(html.includes(`id="${id}"`), `index.html is missing id="${id}"`);
  }
});

test("the session sidebar is present so saved threads are reachable", () => {
  assert.ok(html.includes('id="newSessionBtn"'));
  assert.ok(html.includes('id="sessionList"'));
  assert.ok(html.includes('id="messages"'));
});

test("cache-busting version was bumped for changed assets", () => {
  for (const src of ["css/style.css", ...scripts]) {
    const m = new RegExp(src.replace(/[.]/g, "\\.") + "\\?v=(\\d+)").exec(html);
    assert.ok(m, `${src} should be versioned`);
    assert.ok(Number(m[1]) >= 2, `${src} needs a fresh ?v= after changes`);
  }
});

test("chat talks to the endpoints the server actually exposes", () => {
  const chat = read("js/chat.js");
  assert.ok(chat.includes("/api/dev-agent/history"), "history must use the real route");
  assert.ok(chat.includes('"/api/sessions"'));
  assert.ok(!chat.includes("innerHTML = `<div class=\"msg-bubble\">${content}"), "raw model output must be escaped");
});

// Production regressions found by probing dev.fameshire.com.
test("the API base must be same-origin in production", () => {
  const cfg = read("js/config.js");
  // Ignore comments; assert on real code only.
  const code = cfg
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  // momtv-api.azurewebsites.net has no DNS record; hardcoding it broke every call.
  assert.ok(!/azurewebsites\.net/.test(code), "no hardcoded API host in code");
  assert.match(code, /origin\.includes\("localhost"\)/);
  assert.match(code, /:\s*"";/, "prod falls through to same origin");
});

test("nothing depends on a Static Web App any more", () => {
  // Everything runs from server.js on one origin: no SWA config, no SWA deploy
  // workflow, no second hostname to keep in sync.
  const root = path.join(__dirname, "..");
  assert.equal(fs.existsSync(path.join(portal, "staticwebapp.config.json")), false);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows")), false);
  assert.equal(fs.existsSync(path.join(root, "deploy", "github-workflows")), false);
  const cfg = read("js/config.js");
  assert.ok(!/staticwebapps|azurewebsites/.test(cfg.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")));
});

