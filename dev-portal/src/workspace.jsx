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

const modelOptions = [
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
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
  const modelKey = `dev-agent:model:${accountKey}`;
  const githubRepoKey = `dev-agent:github-repo:${accountKey}`;
  const [selectedModel, setSelectedModel] = useState(() => {
    const saved = localStorage.getItem(modelKey);
    return modelOptions.some((model) => model.id === saved) ? saved : "gpt-4.1-mini";
  });
  const [sessions, setSessions] = useState([]);
  const [githubRepos, setGithubRepos] = useState([]);
  const [githubConfigured, setGithubConfigured] = useState(false);
  const [selectedGithubRepo, setSelectedGithubRepo] = useState(() =>
    localStorage.getItem(githubRepoKey) || "all"
  );
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

  const loadGithubRepos = useCallback(async () => {
    try {
      const data = await api("/api/github/repos");
      const repositories = data.repositories || [];
      setGithubRepos(repositories);
      setGithubConfigured(Boolean(data.configured));
      const remembered = localStorage.getItem(githubRepoKey) || "all";
      const selected = remembered === "all" || repositories.some((repo) => repo.fullName === remembered)
        ? remembered
        : "all";
      setSelectedGithubRepo(selected);
      localStorage.setItem(githubRepoKey, selected);
      return repositories;
    } catch (loadError) {
      setGithubConfigured(false);
      setGithubRepos([]);
      setError(`Could not load GitHub repositories: ${loadError.message}`);
      return [];
    }
  }, [githubRepoKey]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [available] = await Promise.all([refreshSessions(), loadGithubRepos()]);
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
  }, [activeKey, createSession, loadHistory, loadGithubRepos, refreshSessions, setSessionInfo]);

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
        body: JSON.stringify({
          message: text,
          sessionId: currentSession,
          model: selectedModel,
          githubRepo: selectedGithubRepo,
        }),
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
  }, [refreshSessions, selectedGithubRepo, selectedModel, sessionId]);

  const runtimeMessages = useMemo(
    () => messages.map((message, index) => ({ ...message, id: message.id || `message-${index}` })),
    [messages]
  );

  return (
    <div className="chat-layout">
      <aside className="sidebar" aria-label="Saved conversations">
        <div className="sidebar-workspace">
          <span className="sidebar-mark" aria-hidden="true">D</span>
          <span><strong>Dev workspace</strong><small>Fameshire engineering</small></span>
        </div>
        <button className="btn-new" type="button" onClick={newSession} disabled={loading || running}>
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
        </div>
        <div className="sidebar-memory">
          <span className="memory-indicator" aria-hidden="true" />
          <span><strong>Memory enabled</strong><small>Saved to your account</small></span>
        </div>
      </aside>
      <section className="chat-main" aria-label="Conversation">
        <div className="chat-header">
          <div className="chat-heading">
            <span className="chat-overline">MOM DEVELOPER <span>/</span> PRIVATE WORKSPACE</span>
            <h1>Engineering assistant</h1>
            <p>Working as {account.name || account.username || "signed-in user"}</p>
          </div>
          <div className="chat-controls">
            <label className="github-picker">
              <span>Codebase</span>
              <select
                aria-label="Choose GitHub repository scope"
                value={selectedGithubRepo}
                onChange={(event) => {
                  const nextRepo = event.target.value;
                  setSelectedGithubRepo(nextRepo);
                  localStorage.setItem(githubRepoKey, nextRepo);
                }}
                disabled={loading || running || !githubConfigured}
                title={githubConfigured ? "Search all repositories or limit answers to one repository" : "Configure GITHUB_PAT on the server to enable repository search"}
              >
                <option value="all">All repositories</option>
                {githubRepos.map((repo) => (
                  <option key={repo.fullName} value={repo.fullName}>{repo.fullName}</option>
                ))}
              </select>
            </label>
            <label className="model-picker">
              <span>Model</span>
              <select
                aria-label="Choose model"
                value={selectedModel}
                onChange={(event) => {
                  const nextModel = event.target.value;
                  setSelectedModel(nextModel);
                  localStorage.setItem(modelKey, nextModel);
                }}
                disabled={loading || running}
              >
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>{model.label}</option>
                ))}
              </select>
            </label>
            <span className={`status-label${running ? " is-running" : ""}`} role="status">
              <span className="status-dot" aria-hidden="true" />
              {running ? "Working…" : "Ready"}
            </span>
          </div>
        </div>
        {error && <div className="chat-error" role="alert">{error}</div>}
        <RuntimeThread messages={runtimeMessages} onNew={onNew} loading={loading} running={running} />
      </section>
    </div>
  );
}
