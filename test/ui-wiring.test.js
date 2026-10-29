const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const portal = path.join(root, "dev-portal");
const html = fs.readFileSync(path.join(portal, "index.html"), "utf8");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const main = read("dev-portal/src/main.jsx");
const auth = read("dev-portal/src/auth.js");
const workspace = read("dev-portal/src/workspace.jsx");
const styles = read("dev-portal/css/style.css");

test("the built portal entry mounts the React application", () => {
  assert.match(html, /<script type="module" src="\/src\/main\.jsx"><\/script>/);
  assert.match(html, /id="chat-root"/);
  assert.match(main, /createRoot/);
  assert.match(main, /initializeAuth/);
});

test("all DOM elements used by the app exist in the page shell", () => {
  for (const source of [main, auth]) {
    for (const match of source.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) {
      assert.ok(html.includes(`id="${match[1]}"`), `index.html is missing id="${match[1]}"`);
    }
  }
});

test("the chat uses assistant-ui and preserves saved-session navigation", () => {
  assert.match(workspace, /AssistantRuntimeProvider/);
  assert.match(workspace, /useExternalStoreRuntime/);
  assert.match(workspace, /ThreadPrimitive/);
  assert.match(workspace, /\/api\/dev-agent\/history/);
  assert.match(workspace, /\/api\/sessions/);
  assert.match(workspace, /dev-agent:active:/);
});

test("dark and light themes are persisted and follow system preference initially", () => {
  assert.match(main, /dev-agent:theme/);
  assert.match(main, /prefers-color-scheme: light/);
  assert.match(main, /themeToggle/);
  assert.match(styles, /data-theme="light"/);
  assert.match(styles, /color-scheme: dark/);
});

test("the API remains same-origin in production and uses the existing routes", () => {
  assert.match(workspace, /fetch\(path/);
  assert.match(workspace, /Authorization: `Bearer \$\{token\}`/);
  assert.match(workspace, /\/api\/dev-agent/);
  assert.match(workspace, /\/api\/dev-agent\/history/);
});

test("the production installer builds the Vite frontend from locked dependencies", () => {
  const installer = read("deploy/install.sh");
  assert.match(installer, /package-lock\.json/);
  assert.match(installer, /npm ci/);
  assert.match(installer, /npm run build/);
  assert.match(installer, /npm prune --omit=dev/);
});
