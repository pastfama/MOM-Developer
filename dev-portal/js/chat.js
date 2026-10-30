// ── Dev Agent chat ──
// Every turn is persisted server-side per user, so the thread survives page
// reloads, browser restarts and server restarts.
let sessionId = null;
let isTyping = false;
let activeUserKey = "anon";
let wired = false;
let attachments = [];


const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const activeKey = () => "dev-agent:active:" + activeUserKey;

function userKeyFor(account) {
  if (!account) return "anon";
  return account.homeAccountId || account.username || "anon";
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Model output is untrusted: escape first, then add a little formatting.
function renderContent(text) {
  const src = String(text == null ? "" : text);
  const parts = src.split(/```/);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // fenced block: drop a leading language hint on its own first line
      const body = parts[i].replace(/^[A-Za-z0-9_+.\-]*(?::[^\n]*)?\n/, "");
      out += `<pre class="code"><code>${esc(body.replace(/\s+$/, ""))}</code></pre>`;
    } else {
      out += esc(parts[i])
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    }
  }
  return out;
}

async function api(path, options = {}) {
  const token = await window.getAccessToken();
  const headers = Object.assign({}, options.headers || {});
  if (token) headers.Authorization = "Bearer " + token;
  if (options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(API_BASE + path, Object.assign({}, options, { headers }));
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new Error(
      "Expected JSON from " + path + " but got " + (ct || "no content-type") +
        ". The API route is probably missing or the server is serving a static file instead."
    );
  }
  const data = await res.json();
  if (!res.ok) {
    const msg = (data.error && data.error.message) || "HTTP " + res.status;
    throw new Error(msg);
  }
  return data;
}

function renderSessionList(sessions) {
  const box = document.getElementById("sessionList");
  if (!box) return;
  box.innerHTML = "";
  if (!sessions.length) {
    box.innerHTML = '<div class="session-empty">No saved sessions yet.</div>';
    return;
  }
  sessions.forEach((s) => {
    const btn = document.createElement("button");
    btn.className = "session-item" + (s.id === sessionId ? " active" : "");
    btn.dataset.id = s.id;
    btn.innerHTML =
      '<span class="st">' + esc(s.title || "Untitled") + "</span>" +
      '<span class="sm">' + esc(fmtTime(s.updatedAt)) + " \u00b7 " + (s.turns || 0) + " msgs</span>";
    btn.addEventListener("click", () => selectSession(s.id));
    box.appendChild(btn);
  });
}

async function refreshSessions() {
  try {
    const data = await api("/api/sessions");
    const sessions = data.sessions || [];
    renderSessionList(sessions);
    return sessions;
  } catch (e) {
    console.error("Session list failed:", e.message);
    return [];
  }
}

async function selectSession(id) {
  sessionId = id;
  localStorage.setItem(activeKey(), id);
  await loadHistory();
  await refreshSessions();
  updateSessionInfo();
}

async function newSession() {
  try {
    const data = await api("/api/sessions", { method: "POST", body: "{}" });
    sessionId = data.session.id;
    localStorage.setItem(activeKey(), sessionId);
    document.getElementById("messages").innerHTML = "";
    addSystemMessage("New session started. Everything here is saved automatically.");
    await refreshSessions();
    updateSessionInfo();
  } catch (e) {
    addSystemMessage("Could not start a session: " + esc(e.message));
  }
}

async function loadHistory() {
  if (!sessionId) return;
  const messages = document.getElementById("messages");
  try {
    const data = await api("/api/dev-agent/history?sessionId=" + encodeURIComponent(sessionId));
    messages.innerHTML = "";
    const turns = data.messages || [];
    turns.forEach((m) => addMessage(m.role, m.content, false));
    if (!turns.length) {
      addSystemMessage("Dev Agent ready. This conversation is saved as you go \u2014 close the tab and it will still be here.");
    }
    scrollToBottom();
  } catch (e) {
    messages.innerHTML = "";
    addSystemMessage("Could not load history: " + esc(e.message));
  }
}

function initChat(account) {
  activeUserKey = userKeyFor(account);
  const sendBtn = document.getElementById("sendBtn");
  const newSessionBtn = document.getElementById("newSessionBtn");
  const promptInput = document.getElementById("promptInput");
  const attachBtn = document.getElementById("attachBtn");
  const fileInput = document.getElementById("fileInput");

  if (sendBtn) {
    sendBtn.removeEventListener("click", sendMessage);
    sendBtn.addEventListener("click", sendMessage);
  }
  if (newSessionBtn) {
    newSessionBtn.removeEventListener("click", newSession);
    newSessionBtn.addEventListener("click", newSession);
  }
  if (promptInput) {
    promptInput.removeEventListener("keypress", handleKeypress);
    promptInput.addEventListener("keypress", handleKeypress);
  }
  if (attachBtn) {
    attachBtn.removeEventListener("click", handleAttachClick);
    attachBtn.addEventListener("click", handleAttachClick);
  }
  if (fileInput) {
    fileInput.removeEventListener("change", handleFileChange);
    fileInput.addEventListener("change", handleFileChange);
  }

  function handleKeypress(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }
  function handleAttachClick() {
    if (fileInput) fileInput.click();
  }
  function handleFileChange(e) {
    for (const f of e.target.files) addAttachment(f);
    e.target.value = "";
  }

  // Resume the last thread this user had open, else the most recent one.
  refreshSessions().then((sessions) => {
    const stored = localStorage.getItem(activeKey());
    const pick = sessions.find((s) => s.id === stored) || sessions[0];
    if (pick) {
      sessionId = pick.id;
      localStorage.setItem(activeKey(), sessionId);
      loadHistory().then(updateSessionInfo);
    } else {
      newSession();
    }
  });
}

function updateSessionInfo() {
  const el = document.getElementById("sessionInfo");
  if (!el) return;
  el.textContent = sessionId ? "Saved \u00b7 " + sessionId.slice(0, 16) : "No session";
}


function addAttachment(file) {
  const id = Date.now() + '-' + Math.random().toString(36).slice(2);
  attachments.push({ id, file });
  renderAttachments();
}

function removeAttachment(id) {
  attachments = attachments.filter(a => a.id !== id);
  renderAttachments();
}

function renderAttachments() {
  const box = document.getElementById("attachments");
  if (!box) return;
  box.innerHTML = "";
  attachments.forEach(a => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.title = a.file.name + " (" + (a.file.size / 1024).toFixed(1) + " KB)";
    chip.innerHTML =
      '<span class="name">' + esc(a.file.name) + '</span>' +
      '<span class="remove" onclick="removeAttachment(\'' + a.id + '\')">×</span>';
    box.appendChild(chip);
  });
}


async function apiRaw(path, options = {}) {
  const token = await window.getAccessToken();
  const headers = Object.assign({}, options.headers || {});
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(API_BASE + path, Object.assign({}, options, { headers }));
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new Error(
      "Expected JSON from " + path + " but got " + (ct || "no content-type")
    );
  }
  const data = await res.json();
  if (!res.ok) {
    const msg = (data.error && data.error.message) || "HTTP " + res.status;
    throw new Error(msg);
  }
  return data;
}

async function sendMessage() {
  const input = document.getElementById("promptInput");
  const sendBtn = document.getElementById("sendBtn");
  const text = input.value.trim();
  if (!text || isTyping) return;
  input.value = "";
  if (input) input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;

  addMessage("user", text, true);
  const typing = addSystemMessage("&#8230;", true);
  isTyping = true;

  try {
    const token = await window.getAccessToken().catch(() => null);
    const form = new FormData();
    form.append("message", text);
    form.append("sessionId", sessionId || "");
    attachments.forEach(a => form.append("files", a.file));
    attachments = [];
    renderAttachments();
    const headers = {};
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(API_BASE + "/api/dev-agent", {
      method: "POST",
      headers,
      body: form,
    });
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      throw new Error("Expected JSON from API but got " + (ct || "no content-type"));
    }
    const data = await res.json();
    if (!res.ok) {
      const msg = (data.error && data.error.message) || "HTTP " + res.status;
      throw new Error(msg);
    }
    typing.remove();
    if (data.sessionId) {
      sessionId = data.sessionId;
      localStorage.setItem(activeKey(), sessionId);
    }
    addMessage("assistant", data.response || "(no response)", true, data.applied, data.skipped);
    refreshSessions();
    updateSessionInfo();
  } catch (e) {
    console.error("[sendMessage] error:", e);
    typing.remove();
    addSystemMessage("Error: " + esc(e.message));
  } finally {
    isTyping = false;
    if (input) input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
    scrollToBottom();
  }
}

function renderApplied(applied, skipped) {
  const ok = (applied || [])
    .map((a) => '<span class="chip">' + esc(a.path) + "<em>" + esc(a.action) + "</em></span>")
    .join("");
  const bad = (skipped || [])
    .map((s) => '<span class="chip bad">' + esc(s.path) + "<em>" + esc(s.reason) + "</em></span>")
    .join("");
  if (!ok && !bad) return "";
  return (
    '<div class="applied"><div class="applied-title">Written to the repo</div>' +
    ok +
    bad +
    "</div>"
  );
}

function addMessage(role, content, scroll = true, applied, skipped) {
  const messages = document.getElementById("messages");
  const safeRole = role === "user" || role === "assistant" ? role : "system";
  const div = document.createElement("div");
  div.className = "msg " + safeRole;
  div.innerHTML =
    '<div class="msg-bubble">' + renderContent(content) + renderApplied(applied, skipped) + "</div>";
  messages.appendChild(div);
  if (scroll) scrollToBottom();
}

function addSystemMessage(content, scroll = true) {
  const messages = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "msg system";
  div.innerHTML = '<div class="msg-bubble">' + content + "</div>";
  messages.appendChild(div);
  if (scroll) scrollToBottom();
  return div;
}

function scrollToBottom() {
  const messages = document.getElementById("messages");
  messages.scrollTop = messages.scrollHeight;
}
