// ── Dev Agent chat ──
let sessionId = null;
let isTyping = false;

function initChat() {
  // Create or resume a session tied to the user
  const stored = sessionStorage.getItem("dev-agent-session-id");
  if (stored) {
    sessionId = stored;
    loadHistory();
  } else {
    sessionId = "sess-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    sessionStorage.setItem("dev-agent-session-id", sessionId);
  }
  document.getElementById("sendBtn").addEventListener("click", sendMessage);
  document.getElementById("promptInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  addSystemMessage("Dev Agent ready. I know your identity, your Azure estate, and your GitHub repos. What would you like to do?");
}

async function loadHistory() {
  try {
    const token = await window.getAccessToken();
    const res = await fetch(`${API_BASE}/api/dev-agent/history?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      const messages = document.getElementById("messages");
      messages.innerHTML = "";
      (data.messages || []).forEach((m) => {
        addMessage(m.role, m.content, false);
      });
      scrollToBottom();
    }
  } catch (e) {
    console.error("History load failed:", e);
  }
}

async function sendMessage() {
  const input = document.getElementById("promptInput");
  const text = input.value.trim();
  if (!text || isTyping) return;
  input.value = "";
  input.disabled = true;
  document.getElementById("sendBtn").disabled = true;

  addMessage("user", text, true);
  addSystemMessage("&#8230;", true);
  isTyping = true;

  try {
    const token = await window.getAccessToken();
    const res = await fetch(`${API_BASE}/api/dev-agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message: text,
        sessionId: sessionId,
      }),
    });

    // Remove typing indicator
    const typing = document.querySelector(".msg-typing");
    if (typing) typing.remove();

    if (!res.ok) {
      const err = await res.text();
      addSystemMessage("Error: " + err, true);
      return;
    }

    const data = await res.json();
    addMessage("assistant", data.response || data.text || "(no response)", true);
    sessionStorage.setItem("dev-agent-session-id", sessionId);
  } catch (e) {
    const typing = document.querySelector(".msg-typing");
    if (typing) typing.remove();
    addSystemMessage("Error: " + e.message, true);
  } finally {
    isTyping = false;
    input.disabled = false;
    document.getElementById("sendBtn").disabled = false;
    input.focus();
    scrollToBottom();
  }
}

function addMessage(role, content, scroll = true) {
  const messages = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.innerHTML = `<div class="msg-bubble">${content}</div>`;
  messages.appendChild(div);
  if (scroll) scrollToBottom();
}

function addSystemMessage(content, scroll = true) {
  const messages = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "msg system msg-typing";
  div.innerHTML = `<div class="msg-bubble">${content}</div>`;
  messages.appendChild(div);
  if (scroll) scrollToBottom();
  return div;
}

function scrollToBottom() {
  const messages = document.getElementById("messages");
  messages.scrollTop = messages.scrollHeight;
}
