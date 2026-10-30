import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AuiIf,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";

function messageText(content) {
  return (content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("\n");
}

function asThreadMessage(message, index) {
  return {
    id: message.id || `history-${index}`,
    role: message.role,
    content: message.content || "",
  };
}

const starterPrompts = [
  {
    icon: "</>",
    title: "Explore a repository",
    prompt: "Give me an overview of my GitHub repositories and suggest a good place to start.",
  },
  {
    icon: "↗",
    title: "Plan a code change",
    prompt: "Help me plan a code change. Ask any clarifying questions before suggesting an implementation.",
  },
  {
    icon: "◇",
    title: "Review Azure resources",
    prompt: "Summarize the Azure resources available to this agent and how they relate to my project.",
  },
];

async function api(path, options = {}) {
  const token = await window.getAccessToken();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  if (options.body) headers["Content-Type"] = "application/json";

  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Expected JSON from ${path}, received ${contentType || "no content type"}.`);
  }
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `Request failed (HTTP ${response.status}).`);
  }
  return data;
}

function ThreadView({ loading, running, onNew }) {
  return (
    <ThreadPrimitive.Root className="aui-thread">
      <ThreadPrimitive.Viewport className="aui-viewport">
        <div className="aui-message-list" aria-live="polite">
          {loading && <div className="thread-notice">Loading conversation…</div>}
          {!loading && (
            <ThreadPrimitive.Messages>
              {({ message }) => (
                <MessagePrimitive.Root
                  key={message.id}
                  className={`aui-message aui-message--${message.role}`}
                >
                  <MessagePrimitive.Content />
                </MessagePrimitive.Root>
              )}
            </ThreadPrimitive.Messages>
          )}
          {!loading && (
            <ThreadPrimitive.Empty className="thread-welcome">
              <div className="welcome-brand">
                <span className="welcome-mark" aria-hidden="true">✳</span>
                <span>Your development workspace</span>
              </div>
              <h2>Let’s make your<br /><span>next idea shippable.</span></h2>
              <p>Bring a question, a bug, or a half-formed idea. Your conversations stay saved to this account.</p>
              <div className="starter-prompts" aria-label="Suggested prompts">
                {starterPrompts.map((suggestion) => (
                  <button
                    key={suggestion.title}
                    className="starter-prompt"
                    type="button"
                    disabled={loading || running}
                    onClick={() => onNew({
                      content: [{ type: "text", text: suggestion.prompt }],
                    })}
                  >
                    <span className="starter-icon" aria-hidden="true">{suggestion.icon}</span>
                    <span className="starter-copy">
                      <strong>{suggestion.title}</strong>
                      <span>{suggestion.prompt}</span>
                    </span>
                    <span className="starter-arrow" aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
              <div className="welcome-capabilities">
                <span><i aria-hidden="true" />Conversation memory</span>
                <span><i aria-hidden="true" />Azure context</span>
                <span><i aria-hidden="true" />GitHub context</span>
              </div>
            </ThreadPrimitive.Empty>
          )}
        </div>
        <ThreadPrimitive.ViewportFooter className="aui-thread-footer">
          <ComposerPrimitive.Root className="aui-composer">
            <ComposerPrimitive.Input
              aria-label="Message the Dev Agent"
              className="aui-composer-input"
              placeholder="Message the Dev Agent…"
              rows={1}
              disabled={loading || running}
            />
            <div className="aui-composer-footer">
              <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
              <AuiIf condition={(state) => !state.thread.isRunning}>
                <ComposerPrimitive.Send className="composer-send" disabled={loading || running}>
                  Send
                </ComposerPrimitive.Send>
              </AuiIf>
              <AuiIf condition={(state) => state.thread.isRunning}>
                <span className="composer-working" role="status">Working…</span>
              </AuiIf>
            </div>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function RuntimeThread({ messages, onNew, loading, running }) {
  const convertMessage = useCallback((message) => ({
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.content }],
  }), []);
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    onNew,
    isRunning: loading || running,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadView loading={loading} running={running} onNew={onNew} />
    </AssistantRuntimeProvider>
  );
}

export function ChatWorkspace({ account }) {
  const accountKey = account.homeAccountId || account.username || "default";
  const activeKey = `dev-agent:active:${accountKey}`;
  const [sessions, setSessions] = useState([]);
  const [memories, setMemories] = useState([]);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [error, setError] = useState("");

  const setSessionInfo = useCallback((id) => {
    const info = document.getElementById("sessionInfo");
    info.textContent = id ? `Saved · ${id.slice(0, 16)}` : "No session";
  }, []);

  const loadHistory = useCallback(async (id) => {
    const data = await api(`/api/dev-agent/history?sessionId=${encodeURIComponent(id)}`);
    return (data.messages || [])
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map(asThreadMessage);
  }, []);

  const createSession = useCallback(async () => {
    const data = await api("/api/sessions", { method: "POST", body: "{}" });
    return data.session;
  }, []);

  const refreshSessions = useCallback(async () => {
    const data = await api("/api/sessions");
    setSessions(data.sessions || []);
    return data.sessions || [];
  }, []);

  const refreshMemories = useCallback(async () => {
    const data = await api("/api/memory");
    setMemories(data.memories || []);
    return data.memories || [];
  }, []);

  useEffect(() => {
    let active = true;
    refreshMemories().catch((loadError) => {
      if (active) setError(`Could not load long-term memory: ${loadError.message}`);
    });
    return () => {
      active = false;
    };
  }, [refreshMemories]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const available = await refreshSessions();
        if (!active) return;
        const remembered = localStorage.getItem(activeKey);
        const selected = available.find((session) => session.id === remembered) || available[0];
        const session = selected || (await createSession());
        if (!active) return;
        setSessionId(session.id);
        localStorage.setItem(activeKey, session.id);
        setSessionInfo(session.id);
        setSessions((current) =>
          current.some((item) => item.id === session.id) ? current : [session, ...current]
        );
        const history = await loadHistory(session.id);
        if (active) setMessages(history);
      } catch (loadError) {
        if (active) setError(`Could not load saved conversations: ${loadError.message}`);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [activeKey, createSession, loadHistory, refreshSessions, setSessionInfo]);

  const selectSession = useCallback(async (id) => {
    if (running || id === sessionId) return;
    setLoading(true);
    setError("");
    setSessionId(id);
    setMessages([]);
    localStorage.setItem(activeKey, id);
    setSessionInfo(id);
    try {
      setMessages(await loadHistory(id));
    } catch (loadError) {
      setError(`Could not load conversation: ${loadError.message}`);
    } finally {
      setLoading(false);
    }
  }, [activeKey, loadHistory, running, sessionId, setSessionInfo]);

  const newSession = useCallback(async () => {
    if (running) return;
    setLoading(true);
    setError("");
    try {
      const session = await createSession();
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setSessionId(session.id);
      setMessages([]);
      localStorage.setItem(activeKey, session.id);
      setSessionInfo(session.id);
    } catch (createError) {
      setError(`Could not start a new conversation: ${createError.message}`);
    } finally {
      setLoading(false);
    }
  }, [activeKey, createSession, running, setSessionInfo]);

  const deleteSession = useCallback(async (id) => {
    if (running || loading || deletingSessionId) return;
    const session = sessions.find((item) => item.id === id);
    const title = session?.title || "Untitled conversation";
    if (!window.confirm(`Delete “${title}”?\n\nThis permanently deletes this conversation.`)) return;

    const deletingActive = id === sessionId;
    setDeletingSessionId(id);
    setError("");
    if (deletingActive) setLoading(true);

    try {
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      const remaining = sessions.filter((item) => item.id !== id);
      setSessions(remaining);

      if (deletingActive) {
        setMessages([]);
        setSessionId(null);
        localStorage.removeItem(activeKey);
        setSessionInfo(null);

        const replacement = remaining[0] || await createSession();
        if (remaining.length === 0) setSessions([replacement]);
        setSessionId(replacement.id);
        localStorage.setItem(activeKey, replacement.id);
        setSessionInfo(replacement.id);
        setMessages(await loadHistory(replacement.id));
      }
    } catch (deleteError) {
      setError(`Could not delete conversation: ${deleteError.message}`);
    } finally {
      setDeletingSessionId(null);
      if (deletingActive) setLoading(false);
    }
  }, [activeKey, createSession, deletingSessionId, loadHistory, loading, running, sessionId, sessions, setSessionInfo]);

  const saveMemory = useCallback(async (event) => {
    event.preventDefault();
    const text = memoryDraft.trim();
    if (!text || memoryBusy) return;
    setMemoryBusy(true);
    setError("");
    try {
      const data = await api("/api/memory", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      setMemories(data.memories || []);
      setMemoryDraft("");
    } catch (memoryError) {
      setError(`Could not save memory: ${memoryError.message}`);
    } finally {
      setMemoryBusy(false);
    }
  }, [memoryBusy, memoryDraft]);

  const removeMemory = useCallback(async (id) => {
    if (memoryBusy) return;
    setMemoryBusy(true);
    setError("");
    try {
      await api(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
      setMemories((current) => current.filter((item) => item.id !== id));
    } catch (memoryError) {
      setError(`Could not remove memory: ${memoryError.message}`);
    } finally {
      setMemoryBusy(false);
    }
  }, [memoryBusy]);

  const clearMemories = useCallback(async () => {
    if (memoryBusy || memories.length === 0) return;
    if (!window.confirm("Clear all long-term memories? This will not delete conversation history.")) return;
    setMemoryBusy(true);
    setError("");
    try {
      await api("/api/memory", { method: "DELETE" });
      setMemories([]);
    } catch (memoryError) {
      setError(`Could not clear memory: ${memoryError.message}`);
    } finally {
      setMemoryBusy(false);
    }
  }, [memories.length, memoryBusy]);

  const onNew = useCallback(async (message) => {
    const text = messageText(message.content).trim();
    if (!text || !sessionId) return;

    const currentSession = sessionId;
    setError("");
    setRunning(true);
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content: text },
    ]);

    try {
      const data = await api("/api/dev-agent", {
        method: "POST",
        body: JSON.stringify({ message: text, sessionId: currentSession }),
      });
      let response = data.response || "(no response)";
      const applied = (data.applied || []).map((file) => `${file.action}: ${file.path}`);
      const skipped = (data.skipped || []).map((file) => `not written: ${file.path} (${file.reason})`);
      if (applied.length) response += `\n\nFiles written:\n${applied.join("\n")}`;
      if (skipped.length) response += `\n\nFiles skipped:\n${skipped.join("\n")}`;
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", content: response },
      ]);
      await refreshSessions();
      await refreshMemories();
    } catch (requestError) {
      setError(requestError.message);
      await refreshMemories().catch(() => {});
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", content: `Request failed: ${requestError.message}` },
      ]);
    } finally {
      setRunning(false);
    }
  }, [refreshMemories, refreshSessions, sessionId]);

  const runtimeMessages = useMemo(
    () => messages.map((message, index) => ({ ...message, id: message.id || `message-${index}` })),
    [messages]
  );
  const sessionsBusy = loading || running || Boolean(deletingSessionId);

  return (
    <div className="chat-layout">
      <aside className="sidebar" aria-label="Saved conversations">
        <div className="sidebar-workspace">
          <span className="sidebar-mark" aria-hidden="true">D</span>
          <span><strong>Dev workspace</strong><small>Fameshire engineering</small></span>
        </div>
        <button className="btn-new" type="button" onClick={newSession} disabled={sessionsBusy}>
          <span aria-hidden="true">＋</span> New conversation
        </button>
        <div className="sidebar-section">
          <div className="sidebar-label">
            <span>Recent conversations</span>
            <span className="session-count">{sessions.length}</span>
          </div>
          <div className="session-list">
            {sessions.length === 0 && !loading && <div className="session-empty">Your conversation history will appear here.</div>}
            {sessions.map((session) => (
              <div className="session-row" key={session.id}>
                <button
                  type="button"
                  className={`session-item${session.id === sessionId ? " active" : ""}`}
                  onClick={() => selectSession(session.id)}
                  disabled={sessionsBusy}
                  aria-current={session.id === sessionId ? "page" : undefined}
                >
                  <span className="session-title">{session.title || "Untitled conversation"}</span>
                  <span className="session-meta">
                    {session.turns || 0} messages · {session.updatedAt ? new Date(session.updatedAt).toLocaleDateString() : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="session-delete"
                  onClick={() => deleteSession(session.id)}
                  disabled={sessionsBusy}
                  aria-label={`Delete ${session.title || "untitled conversation"}`}
                  title="Delete conversation"
                >
                  <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
                    <path d="M4.5 6h11M8 6V4.5h4V6m2 0-.6 9.1a1 1 0 0 1-1 .9H7.6a1 1 0 0 1-1-.9L6 6m2.5 2.2v5m3-5v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
        <details className="sidebar-memory memory-manager">
          <summary className="memory-summary">
            <span className="memory-indicator" aria-hidden="true" />
            <span><strong>Long-term memory</strong><small>{memories.length} saved {memories.length === 1 ? "note" : "notes"}</small></span>
            <span className="memory-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div className="memory-content">
            {memories.length > 0 ? (
              <ul className="memory-list">
                {memories.map((memory) => (
                  <li key={memory.id} className="memory-item">
                    <span>{memory.text}</span>
                    <button
                      type="button"
                      onClick={() => removeMemory(memory.id)}
                      disabled={memoryBusy}
                      aria-label={`Forget: ${memory.text}`}
                      title="Forget this note"
                    >×</button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="memory-empty">No long-term notes yet. Ask me to remember something or add a note here.</p>
            )}
            <form className="memory-form" onSubmit={saveMemory}>
              <label htmlFor="memoryDraft">Add a memory</label>
              <textarea
                id="memoryDraft"
                value={memoryDraft}
                onChange={(event) => setMemoryDraft(event.target.value)}
                maxLength={500}
                placeholder="A preference, project detail, or useful fact…"
                rows={3}
                disabled={memoryBusy}
              />
              <button type="submit" disabled={memoryBusy || !memoryDraft.trim()}>
                {memoryBusy ? "Saving…" : "Save note"}
              </button>
            </form>
            {memories.length > 0 && (
              <button className="memory-clear" type="button" onClick={clearMemories} disabled={memoryBusy}>
                Clear all memories
              </button>
            )}
          </div>
        </details>
      </aside>
      <section className="chat-main" aria-label="Conversation">
        <div className="chat-header">
          <div className="chat-heading">
            <span className="chat-overline">MOM DEVELOPER <span>/</span> PRIVATE WORKSPACE</span>
            <h1>Engineering assistant</h1>
            <p>Working as {account.name || account.username || "signed-in user"}</p>
          </div>
          <span className={`status-label${running ? " is-running" : ""}`} role="status">
            <span className="status-dot" aria-hidden="true" />
            {running ? "Working…" : "Ready"}
          </span>
        </div>
        {error && <div className="chat-error" role="alert">{error}</div>}
        <RuntimeThread messages={runtimeMessages} onNew={onNew} loading={loading} running={running} />
      </section>
    </div>
  );
}
