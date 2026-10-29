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

function ThreadView({ loading, running }) {
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
              <h2>What are we working on?</h2>
              <p>Ask about your projects, code, Azure resources, or previous work.</p>
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
      <ThreadView loading={loading} running={running} />
    </AssistantRuntimeProvider>
  );
}

export function ChatWorkspace({ account }) {
  const accountKey = account.homeAccountId || account.username || "default";
  const activeKey = `dev-agent:active:${accountKey}`;
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
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
    } catch (requestError) {
      setError(requestError.message);
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", content: `Request failed: ${requestError.message}` },
      ]);
    } finally {
      setRunning(false);
    }
  }, [refreshSessions, sessionId]);

  const runtimeMessages = useMemo(
    () => messages.map((message, index) => ({ ...message, id: message.id || `message-${index}` })),
    [messages]
  );

  return (
    <div className="chat-layout">
      <aside className="sidebar" aria-label="Saved conversations">
        <button className="btn-new" type="button" onClick={newSession} disabled={loading || running}>
          + New conversation
        </button>
        <div className="sidebar-label">Saved conversations</div>
        <div className="session-list">
          {sessions.length === 0 && !loading && <div className="session-empty">No saved sessions yet.</div>}
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-item${session.id === sessionId ? " active" : ""}`}
              onClick={() => selectSession(session.id)}
              disabled={loading || running}
              aria-current={session.id === sessionId ? "page" : undefined}
            >
              <span className="session-title">{session.title || "Untitled conversation"}</span>
              <span className="session-meta">
                {session.turns || 0} messages · {session.updatedAt ? new Date(session.updatedAt).toLocaleDateString() : ""}
              </span>
            </button>
          ))}
        </div>
      </aside>
      <section className="chat-main" aria-label="Conversation">
        <div className="chat-header">
          <div>
            <h1>Dev Agent</h1>
            <p>{account.name || account.username || "Signed in"}</p>
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
