import { useState, useRef, useEffect, useCallback } from "react";
import { Link } from "wouter";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { go } from "@codemirror/lang-go";
import { EditorView } from "@codemirror/view";
import {
  useListSessions,
  useCreateSession,
  useDeleteSession,
  useListMessages,
  useRunShellCommand,
  useListFiles,
  useWriteFile,
  useReadFile,
  useExecuteCode,
  useBrowseWeb,
  useGetMemory,
  useSaveMemory,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type Mode = "chat" | "shell" | "files" | "code" | "browse" | "memory" | "agent" | "git";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const terminalTheme = EditorView.theme({
  "&": { backgroundColor: "#000000", color: "#00FF00", fontFamily: "'Space Mono', monospace", fontSize: "12px" },
  ".cm-content": { caretColor: "#00FF00" },
  ".cm-cursor": { borderLeftColor: "#00FF00" },
  ".cm-activeLine": { backgroundColor: "#001100" },
  ".cm-gutters": { backgroundColor: "#000000", color: "#005500", borderRight: "1px solid #003300" },
  ".cm-lineNumbers .cm-gutterElement": { color: "#005500" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "#003300 !important" },
  ".cm-focused .cm-selectionBackground": { backgroundColor: "#003300 !important" },
  "&.cm-focused": { outline: "none" },
  ".cm-keyword": { color: "#00FF88" },
  ".cm-string": { color: "#FFFF00" },
  ".cm-comment": { color: "#006600" },
  ".cm-number": { color: "#FF8800" },
  ".cm-operator": { color: "#00FFFF" },
  ".cm-variableName": { color: "#00FF00" },
  ".cm-typeName": { color: "#00FFAA" },
  ".cm-functionName": { color: "#88FF00" },
  ".cm-propertyName": { color: "#00FF00" },
  ".cm-punctuation": { color: "#888888" },
}, { dark: true });

function getLangExtension(lang: string) {
  switch (lang) {
    case "python": return python();
    case "javascript": return javascript();
    case "typescript": return javascript({ typescript: true });
    case "go": return go();
    default: return javascript();
  }
}

export default function Terminal() {
  const queryClient = useQueryClient();
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [newSessionName, setNewSessionName] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);

  // Chat state
  const [chatInput, setChatInput] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  // Shell state
  const [shellInput, setShellInput] = useState("");
  const [shellHistory, setShellHistory] = useState<{ cmd: string; out: string; err: string; code: number }[]>([]);
  const [shellHistIdx, setShellHistIdx] = useState(-1);
  const [shellCwd, setShellCwd] = useState("");

  // Files state
  const [filePath, setFilePath] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [fileMode, setFileMode] = useState<"browse" | "read" | "write">("browse");
  const [fileOutput, setFileOutput] = useState("");

  // Code state
  const [codeLang, setCodeLang] = useState<"python" | "javascript" | "typescript" | "bash" | "go">("python");
  const [codeInput, setCodeInput] = useState("");
  const [codeOutput, setCodeOutput] = useState("");
  const [codePreview, setCodePreview] = useState("");
  const [aiCompleting, setAiCompleting] = useState(false);

  // Browse state
  const [browseUrl, setBrowseUrl] = useState("");
  const [browseQuery, setBrowseQuery] = useState("");
  const [browseMode, setBrowseMode] = useState<"fetch" | "search">("search");
  const [browseOutput, setBrowseOutput] = useState("");

  // Memory state
  const [memKey, setMemKey] = useState("");
  const [memVal, setMemVal] = useState("");

  // Agent state
  const [agentTask, setAgentTask] = useState("");
  const [agentLog, setAgentLog] = useState<{ type: string; message?: string; tool?: string; args?: any; result?: string; step?: number }[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);

  // Git state
  const [gitOutput, setGitOutput] = useState("");
  const [gitOp, setGitOp] = useState<"status" | "log" | "diff" | "branches">("status");
  const [gitCommitMsg, setGitCommitMsg] = useState("");
  const [gitLoading, setGitLoading] = useState(false);
  const [gitBranch, setGitBranch] = useState("");
  const [gitDiffFile, setGitDiffFile] = useState("");
  const [gitStaged, setGitStaged] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const shellInputRef = useRef<HTMLInputElement>(null);

  const { data: sessions = [], refetch: refetchSessions } = useListSessions();
  const { data: messages = [], refetch: refetchMessages } = useListMessages(activeSessionId!, {
    query: { enabled: !!activeSessionId },
  });
  const { data: memory = [], refetch: refetchMemory } = useGetMemory(activeSessionId!, {
    query: { enabled: !!activeSessionId && mode === "memory" },
  });
  const { data: files } = useListFiles(
    activeSessionId!,
    filePath ? { path: filePath } : {},
    { query: { enabled: !!activeSessionId && mode === "files" && fileMode === "browse" } }
  );

  const createSession = useCreateSession();
  const deleteSession = useDeleteSession();
  const runShell = useRunShellCommand();
  const writeFile = useWriteFile();
  const readFile = useReadFile();
  const executeCode = useExecuteCode();
  const browseWeb = useBrowseWeb();
  const saveMemory = useSaveMemory();

  useEffect(() => {
    if (sessions.length > 0 && !activeSessionId) {
      setActiveSessionId(sessions[0].id);
    }
  }, [sessions]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const handleCreateSession = async () => {
    const name = newSessionName.trim() || `session-${Date.now()}`;
    const result = await createSession.mutateAsync({ name });
    setNewSessionName("");
    setCreatingSession(false);
    setActiveSessionId(result.id);
    refetchSessions();
  };

  const handleDeleteSession = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteSession.mutateAsync({ id });
    if (activeSessionId === id) setActiveSessionId(null);
    refetchSessions();
  };

  const handleChat = async () => {
    if (!chatInput.trim() || !activeSessionId || isStreaming) return;
    const content = chatInput;
    setChatInput("");
    setIsStreaming(true);
    setStreamingContent("");
    try {
      const res = await fetch(`${BASE}/api/cli/sessions/${activeSessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.content) setStreamingContent((p) => p + evt.content);
            if (evt.done || evt.error) { setIsStreaming(false); setStreamingContent(""); refetchMessages(); }
          } catch {}
        }
      }
    } catch { setIsStreaming(false); setStreamingContent(""); }
  };

  const handleShell = async () => {
    if (!shellInput.trim() || !activeSessionId) return;
    const cmd = shellInput;
    setShellInput("");
    setShellHistIdx(-1);
    const result = await runShell.mutateAsync({ id: activeSessionId, data: { command: cmd, cwd: shellCwd } });
    setShellHistory((p) => [...p, { cmd, out: result.stdout, err: result.stderr, code: result.exitCode }]);
    refetchMessages();
  };

  const handleShellKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { handleShell(); return; }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const cmds = shellHistory.map(h => h.cmd);
      const idx = Math.min(shellHistIdx + 1, cmds.length - 1);
      setShellHistIdx(idx);
      setShellInput(cmds[cmds.length - 1 - idx] || "");
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const idx = Math.max(shellHistIdx - 1, -1);
      setShellHistIdx(idx);
      if (idx === -1) setShellInput("");
      else setShellInput(shellHistory[shellHistory.length - 1 - idx]?.cmd || "");
    }
  };

  const handleReadFile = async () => {
    if (!filePath || !activeSessionId) return;
    const result = await readFile.mutateAsync({ id: activeSessionId, data: { path: filePath } });
    setFileContent(result.content);
    setFileOutput(`Read ${result.path} (${result.size} bytes)`);
  };

  const handleWriteFile = async () => {
    if (!filePath || !activeSessionId) return;
    const result = await writeFile.mutateAsync({ id: activeSessionId, data: { path: filePath, content: fileContent } });
    setFileOutput(`Written: ${result.path} (${result.bytes} bytes)`);
    refetchMessages();
  };

  const handleExecute = async () => {
    if (!codeInput.trim() || !activeSessionId) return;
    const result = await executeCode.mutateAsync({ id: activeSessionId, data: { language: codeLang, code: codeInput } });
    const out = result.stdout || result.stderr || "(no output)";
    setCodeOutput(out);
    if (codeLang === "javascript" && codeInput.includes("<html")) {
      setCodePreview(codeInput);
    } else {
      setCodePreview("");
    }
    refetchMessages();
  };

  const handleAiComplete = async () => {
    if (!codeInput.trim() || !activeSessionId || aiCompleting) return;
    setAiCompleting(true);
    try {
      const res = await fetch(`${BASE}/api/cli/sessions/${activeSessionId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: codeInput, language: codeLang }),
      });
      const data = await res.json();
      if (data.completion) setCodeInput((p) => p + data.completion);
    } catch {}
    setAiCompleting(false);
  };

  const handleBrowse = async () => {
    if (!activeSessionId) return;
    const result = await browseWeb.mutateAsync({
      id: activeSessionId,
      data: { mode: browseMode, url: browseUrl || undefined, query: browseQuery || undefined },
    });
    setBrowseOutput(result.content);
    refetchMessages();
  };

  const handleSaveMemory = async () => {
    if (!memKey || !activeSessionId) return;
    await saveMemory.mutateAsync({ id: activeSessionId, data: { key: memKey, value: memVal } });
    setMemKey(""); setMemVal("");
    refetchMemory();
  };

  const handleAgent = async () => {
    if (!agentTask.trim() || !activeSessionId || agentRunning) return;
    setAgentRunning(true);
    setAgentLog([]);
    try {
      const res = await fetch(`${BASE}/api/cli/sessions/${activeSessionId}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: agentTask, maxSteps: 15 }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            setAgentLog((p) => [...p, evt]);
            if (evt.type === "done" || evt.type === "error") { setAgentRunning(false); refetchMessages(); }
          } catch {}
        }
      }
    } catch { setAgentRunning(false); }
  };

  const gitFetch = async (endpoint: string, method = "GET", body?: any) => {
    setGitLoading(true);
    setGitOutput("");
    try {
      const res = await fetch(`${BASE}/api/cli/git/${endpoint}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      setGitOutput(data.output || data.error || JSON.stringify(data));
    } catch (e: any) { setGitOutput(`Error: ${e.message}`); }
    setGitLoading(false);
  };

  const modes: { key: Mode; label: string }[] = [
    { key: "chat", label: "CHAT" },
    { key: "shell", label: "SHELL" },
    { key: "files", label: "FILES" },
    { key: "code", label: "CODE" },
    { key: "browse", label: "BROWSE" },
    { key: "memory", label: "MEMORY" },
    { key: "agent", label: "AGENT" },
    { key: "git", label: "GIT" },
  ];

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground font-mono overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => setSidebarOpen((p) => !p)} className="text-muted-foreground hover:text-foreground transition-colors text-xs">
            [{sidebarOpen ? "−" : "+"}]
          </button>
          <span className="text-primary font-bold tracking-widest text-sm">HAYRE_CLI</span>
          <span className="text-muted-foreground text-xs">v1.0.0</span>
          {activeSessionId && (
            <span className="text-muted-foreground text-xs">:: {sessions.find((s) => s.id === activeSessionId)?.name}</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <Link href="/about" className="text-muted-foreground hover:text-foreground text-xs transition-colors">[?]</Link>
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse inline-block" />
            <span className="text-primary text-xs">ONLINE</span>
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {sidebarOpen && (
          <div className="w-52 border-r border-border flex flex-col bg-card shrink-0">
            <div className="p-3 border-b border-border">
              <div className="text-muted-foreground text-xs mb-2 tracking-widest">SESSIONS</div>
              {!creatingSession ? (
                <button onClick={() => setCreatingSession(true)} className="w-full text-xs text-primary border border-primary px-2 py-1 hover:bg-primary hover:text-primary-foreground transition-colors">
                  + NEW SESSION
                </button>
              ) : (
                <div className="flex gap-1">
                  <input
                    autoFocus
                    value={newSessionName}
                    onChange={(e) => setNewSessionName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleCreateSession(); if (e.key === "Escape") setCreatingSession(false); }}
                    placeholder="session name..."
                    className="flex-1 bg-background border border-border text-foreground text-xs px-2 py-1 focus:outline-none focus:border-primary"
                  />
                  <button onClick={handleCreateSession} className="text-primary text-xs px-1 hover:text-primary-foreground hover:bg-primary transition-colors border border-primary">OK</button>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  onClick={() => setActiveSessionId(s.id)}
                  className={`flex items-center justify-between px-3 py-2 cursor-pointer text-xs border-b border-border group transition-colors ${activeSessionId === s.id ? "bg-primary text-primary-foreground" : "hover:bg-muted text-foreground"}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{s.name}</div>
                    <div className={`text-xs ${activeSessionId === s.id ? "opacity-70" : "text-muted-foreground"}`}>{s.messageCount} msgs</div>
                  </div>
                  <button onClick={(e) => handleDeleteSession(s.id, e)} className={`ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-xs px-1 ${activeSessionId === s.id ? "hover:bg-primary-foreground hover:text-primary" : "hover:bg-destructive hover:text-destructive-foreground"}`}>
                    X
                  </button>
                </div>
              ))}
              {sessions.length === 0 && <div className="p-3 text-muted-foreground text-xs">No sessions yet</div>}
            </div>
          </div>
        )}

        {/* Main area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!activeSessionId ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="text-primary text-2xl font-bold mb-4">HAYRE_CLI</div>
                <div className="text-muted-foreground text-sm mb-6">Create or select a session to begin</div>
                <button onClick={() => { setCreatingSession(true); setSidebarOpen(true); }} className="border border-primary text-primary px-6 py-2 hover:bg-primary hover:text-primary-foreground transition-colors">
                  + CREATE SESSION
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Mode tabs */}
              <div className="flex border-b border-border shrink-0 overflow-x-auto">
                {modes.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => setMode(m.key)}
                    className={`px-4 py-2 text-xs tracking-widest border-r border-border transition-colors whitespace-nowrap ${mode === m.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="flex-1 flex flex-col overflow-hidden">

                {/* ── CHAT ── */}
                {mode === "chat" && (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                      {messages.filter(m => m.role !== "system").map((msg) => (
                        <div key={msg.id} className={`${msg.role === "user" ? "text-right" : ""}`}>
                          {msg.role === "tool" ? (
                            <div className="text-xs border border-border bg-card p-3 text-left">
                              <div className="text-muted-foreground mb-1">[{msg.toolName || "tool"}]</div>
                              <pre className="whitespace-pre-wrap text-xs text-foreground opacity-70 overflow-x-auto">{msg.content}</pre>
                            </div>
                          ) : (
                            <div className="inline-block max-w-full text-left">
                              <div className={`text-xs mb-1 ${msg.role === "user" ? "text-right text-muted-foreground" : "text-primary"}`}>
                                {msg.role === "user" ? "you" : "hayre"}
                              </div>
                              <div className={`px-4 py-2 text-sm leading-relaxed ${msg.role === "user" ? "bg-primary text-primary-foreground" : "border border-border bg-card text-foreground"}`}>
                                <pre className="whitespace-pre-wrap font-mono text-xs">{msg.content}</pre>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                      {streamingContent && (
                        <div>
                          <div className="text-xs mb-1 text-primary">hayre</div>
                          <div className="border border-border bg-card px-4 py-2 text-sm">
                            <pre className="whitespace-pre-wrap font-mono text-xs">{streamingContent}</pre>
                            <span className="animate-pulse text-primary">█</span>
                          </div>
                        </div>
                      )}
                      {isStreaming && !streamingContent && <div className="text-muted-foreground text-xs"><span className="animate-pulse">thinking...</span></div>}
                      <div ref={chatEndRef} />
                    </div>
                    <div className="border-t border-border p-3 shrink-0">
                      <div className="flex gap-2 items-center">
                        <span className="text-primary text-sm">&gt;</span>
                        <input
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChat(); } }}
                          placeholder="ask anything..."
                          disabled={isStreaming}
                          className="flex-1 bg-transparent border-none focus:outline-none text-sm text-foreground placeholder:text-muted-foreground"
                        />
                        <button onClick={handleChat} disabled={isStreaming || !chatInput.trim()} className="text-xs border border-primary text-primary px-3 py-1 hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-30">SEND</button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ── SHELL ── */}
                {mode === "shell" && (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-xs">
                      {shellHistory.map((h, i) => (
                        <div key={i}>
                          <div className="text-primary">$ {h.cmd}</div>
                          {h.out && <pre className="whitespace-pre-wrap text-foreground opacity-90 ml-2">{h.out}</pre>}
                          {h.err && <pre className="whitespace-pre-wrap text-destructive ml-2">{h.err}</pre>}
                          {h.code !== 0 && <div className="text-destructive ml-2">[exit {h.code}]</div>}
                        </div>
                      ))}
                      {shellHistory.length === 0 && <div className="text-muted-foreground">Shell ready. ↑/↓ for history.</div>}
                    </div>
                    <div className="border-t border-border shrink-0">
                      <div className="flex items-center gap-2 px-3 py-1 border-b border-border">
                        <span className="text-muted-foreground text-xs">cwd:</span>
                        <input value={shellCwd} onChange={(e) => setShellCwd(e.target.value)} placeholder="/" className="flex-1 bg-transparent text-xs text-foreground focus:outline-none placeholder:text-muted-foreground" />
                      </div>
                      <div className="flex gap-2 items-center p-3">
                        <span className="text-primary text-sm">$</span>
                        <input
                          ref={shellInputRef}
                          value={shellInput}
                          onChange={(e) => setShellInput(e.target.value)}
                          onKeyDown={handleShellKeyDown}
                          placeholder="command... (↑/↓ history)"
                          className="flex-1 bg-transparent border-none focus:outline-none text-sm text-foreground placeholder:text-muted-foreground"
                        />
                        <button onClick={handleShell} disabled={runShell.isPending} className="text-xs border border-primary text-primary px-3 py-1 hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-30">
                          {runShell.isPending ? "..." : "RUN"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ── FILES ── */}
                {mode === "files" && (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="flex border-b border-border shrink-0">
                      {(["browse", "read", "write"] as const).map((fm) => (
                        <button key={fm} onClick={() => setFileMode(fm)} className={`px-3 py-1.5 text-xs border-r border-border transition-colors ${fileMode === fm ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                          {fm.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    <div className="flex-1 overflow-y-auto p-4">
                      <div className="flex gap-2 mb-3">
                        <span className="text-muted-foreground text-xs self-center">path:</span>
                        <input value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="/home/runner or /tmp/file.py" className="flex-1 bg-background border border-border px-2 py-1 text-xs focus:outline-none focus:border-primary" />
                        {fileMode === "browse" && <button onClick={() => queryClient.invalidateQueries()} className="text-xs border border-primary text-primary px-2 py-1 hover:bg-primary hover:text-primary-foreground">LS</button>}
                        {fileMode === "read" && <button onClick={handleReadFile} disabled={readFile.isPending} className="text-xs border border-primary text-primary px-2 py-1 hover:bg-primary hover:text-primary-foreground disabled:opacity-30">READ</button>}
                      </div>
                      {fileMode === "browse" && files && (
                        <div className="space-y-1 text-xs">
                          <div className="text-muted-foreground mb-2">{files.path}</div>
                          {files.entries.map((e) => (
                            <div key={e.name} onClick={() => { if (e.type === "directory") setFilePath((files.path + "/" + e.name).replace("//", "/")); }} className={`flex items-center gap-2 py-1 px-2 border border-transparent hover:border-border ${e.type === "directory" ? "cursor-pointer hover:bg-muted" : ""}`}>
                              <span className={e.type === "directory" ? "text-primary" : "text-muted-foreground"}>{e.type === "directory" ? "DIR" : "FILE"}</span>
                              <span className={e.type === "directory" ? "text-primary" : "text-foreground"}>{e.name}</span>
                              {e.size != null && <span className="text-muted-foreground ml-auto">{e.size}b</span>}
                            </div>
                          ))}
                        </div>
                      )}
                      {(fileMode === "read" || fileMode === "write") && (
                        <div>
                          {fileOutput && <div className="text-primary text-xs mb-2">{fileOutput}</div>}
                          <CodeMirror
                            value={fileContent}
                            onChange={setFileContent}
                            theme={terminalTheme}
                            extensions={[EditorView.lineWrapping]}
                            height="300px"
                            placeholder={fileMode === "read" ? "File content will appear here..." : "Type file content here..."}
                            className="border border-border"
                          />
                          {fileMode === "write" && (
                            <button onClick={handleWriteFile} disabled={writeFile.isPending} className="mt-2 text-xs border border-primary text-primary px-3 py-1 hover:bg-primary hover:text-primary-foreground disabled:opacity-30">
                              WRITE FILE
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ── CODE ── */}
                {mode === "code" && (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="flex items-center gap-3 p-2 border-b border-border shrink-0 flex-wrap">
                      <span className="text-muted-foreground text-xs">lang:</span>
                      <select value={codeLang} onChange={(e) => setCodeLang(e.target.value as any)} className="bg-background border border-border text-foreground text-xs px-2 py-1 focus:outline-none focus:border-primary">
                        {["python", "javascript", "typescript", "bash", "go"].map((l) => (
                          <option key={l} value={l}>{l}</option>
                        ))}
                      </select>
                      <div className="flex gap-2 ml-auto">
                        <button onClick={handleAiComplete} disabled={aiCompleting || !codeInput.trim()} className="text-xs border border-border text-muted-foreground px-3 py-1 hover:border-primary hover:text-primary transition-colors disabled:opacity-30">
                          {aiCompleting ? "AI..." : "AI COMPLETE"}
                        </button>
                        <button onClick={handleExecute} disabled={executeCode.isPending || !codeInput.trim()} className="text-xs border border-primary text-primary px-3 py-1 hover:bg-primary hover:text-primary-foreground disabled:opacity-30">
                          {executeCode.isPending ? "RUNNING..." : "▶ RUN"}
                        </button>
                      </div>
                    </div>
                    <div className={`flex-1 flex overflow-hidden ${codePreview ? "flex-col" : ""}`}>
                      <div className={`flex flex-col ${codePreview ? "h-1/2" : "flex-1"} border-r border-border`}>
                        <div className="text-muted-foreground text-xs p-2 border-b border-border">EDITOR</div>
                        <div className="flex-1 overflow-auto">
                          <CodeMirror
                            value={codeInput}
                            onChange={setCodeInput}
                            theme={terminalTheme}
                            extensions={[getLangExtension(codeLang), EditorView.lineWrapping]}
                            height="100%"
                            placeholder={`# Write ${codeLang} code here`}
                            className="h-full"
                          />
                        </div>
                      </div>
                      <div className={`flex flex-col ${codePreview ? "h-1/2" : "flex-1"}`}>
                        <div className="text-muted-foreground text-xs p-2 border-b border-border flex items-center justify-between">
                          <span>OUTPUT</span>
                          {codePreview && <button onClick={() => setCodePreview("")} className="text-xs text-muted-foreground hover:text-foreground">✕ preview</button>}
                        </div>
                        {codePreview ? (
                          <iframe
                            srcDoc={codePreview}
                            className="flex-1 bg-white"
                            sandbox="allow-scripts"
                            title="preview"
                          />
                        ) : (
                          <pre className="flex-1 overflow-y-auto p-3 text-xs text-foreground whitespace-pre-wrap">
                            {codeOutput || <span className="text-muted-foreground">Output will appear here after running...</span>}
                          </pre>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* ── BROWSE ── */}
                {mode === "browse" && (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="p-3 border-b border-border shrink-0 space-y-2">
                      <div className="flex gap-2">
                        <button onClick={() => setBrowseMode("search")} className={`text-xs px-3 py-1 border ${browseMode === "search" ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}>SEARCH</button>
                        <button onClick={() => setBrowseMode("fetch")} className={`text-xs px-3 py-1 border ${browseMode === "fetch" ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}>FETCH</button>
                      </div>
                      {browseMode === "search" ? (
                        <div className="flex gap-2">
                          <span className="text-muted-foreground text-xs self-center">query:</span>
                          <input value={browseQuery} onChange={(e) => setBrowseQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleBrowse(); }} placeholder="search the web..." className="flex-1 bg-background border border-border px-2 py-1 text-xs focus:outline-none focus:border-primary" />
                          <button onClick={handleBrowse} disabled={browseWeb.isPending} className="text-xs border border-primary text-primary px-3 py-1 hover:bg-primary hover:text-primary-foreground disabled:opacity-30">SEARCH</button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <span className="text-muted-foreground text-xs self-center">url:</span>
                          <input value={browseUrl} onChange={(e) => setBrowseUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleBrowse(); }} placeholder="https://example.com" className="flex-1 bg-background border border-border px-2 py-1 text-xs focus:outline-none focus:border-primary" />
                          <button onClick={handleBrowse} disabled={browseWeb.isPending} className="text-xs border border-primary text-primary px-3 py-1 hover:bg-primary hover:text-primary-foreground disabled:opacity-30">FETCH</button>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 overflow-y-auto p-4">
                      {browseWeb.isPending && <div className="text-muted-foreground text-xs animate-pulse">fetching...</div>}
                      {browseOutput ? <pre className="whitespace-pre-wrap text-xs text-foreground leading-relaxed">{browseOutput}</pre> : <div className="text-muted-foreground text-xs">Results will appear here...</div>}
                    </div>
                  </div>
                )}

                {/* ── MEMORY ── */}
                {mode === "memory" && (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="p-3 border-b border-border shrink-0">
                      <div className="text-muted-foreground text-xs mb-2">Persistent key-value pairs across sessions</div>
                      <div className="flex gap-2">
                        <input value={memKey} onChange={(e) => setMemKey(e.target.value)} placeholder="key" className="w-32 bg-background border border-border px-2 py-1 text-xs focus:outline-none focus:border-primary" />
                        <input value={memVal} onChange={(e) => setMemVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleSaveMemory(); }} placeholder="value" className="flex-1 bg-background border border-border px-2 py-1 text-xs focus:outline-none focus:border-primary" />
                        <button onClick={handleSaveMemory} disabled={!memKey || saveMemory.isPending} className="text-xs border border-primary text-primary px-3 py-1 hover:bg-primary hover:text-primary-foreground disabled:opacity-30">SAVE</button>
                      </div>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4">
                      {memory.length === 0 ? (
                        <div className="text-muted-foreground text-xs">No memory entries yet.</div>
                      ) : (
                        <div className="space-y-2">
                          {memory.map((m) => (
                            <div key={m.id} className="border border-border bg-card p-3 text-xs">
                              <div className="text-primary mb-1">{m.key}</div>
                              <div className="text-foreground break-all">{m.value}</div>
                              <div className="text-muted-foreground mt-1">{new Date(m.createdAt).toLocaleString()}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ── AGENT ── */}
                {mode === "agent" && (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="p-3 border-b border-border shrink-0">
                      <div className="text-muted-foreground text-xs mb-2">Autonomous agent — builds apps, scripts, and multi-step tasks using all available tools</div>
                      <div className="flex gap-2">
                        <span className="text-primary text-sm self-center">&gt;</span>
                        <input value={agentTask} onChange={(e) => setAgentTask(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleAgent(); }} placeholder='e.g. "write a Python web scraper and run it"' disabled={agentRunning} className="flex-1 bg-transparent border border-border px-2 py-1 text-xs focus:outline-none focus:border-primary disabled:opacity-50" />
                        <button onClick={handleAgent} disabled={agentRunning || !agentTask.trim()} className="text-xs border border-primary text-primary px-3 py-1 hover:bg-primary hover:text-primary-foreground disabled:opacity-30">
                          {agentRunning ? "RUNNING..." : "EXECUTE"}
                        </button>
                        {agentLog.length > 0 && !agentRunning && (
                          <button onClick={() => setAgentLog([])} className="text-xs border border-border text-muted-foreground px-2 py-1 hover:text-foreground">CLR</button>
                        )}
                      </div>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-2">
                      {agentLog.length === 0 && !agentRunning && (
                        <div className="text-muted-foreground text-xs space-y-1">
                          <div>Agent examples:</div>
                          <div className="pl-2">— "write a fibonacci script in Python and run it"</div>
                          <div className="pl-2">— "search for latest AI news and summarize"</div>
                          <div className="pl-2">— "create a hello.html file and read it back"</div>
                        </div>
                      )}
                      {agentLog.map((entry, i) => (
                        <div key={i} className={`text-xs border p-2 ${entry.type === "done" ? "border-primary bg-card" : entry.type === "error" ? "border-destructive" : entry.type === "tool_call" ? "border-border bg-card" : "border-transparent"}`}>
                          {entry.type === "start" && <span className="text-primary">[START] {entry.message}</span>}
                          {entry.type === "thinking" && <span className="text-muted-foreground">[STEP {entry.step}] thinking...</span>}
                          {entry.type === "tool_call" && (
                            <div>
                              <span className="text-primary">[CALL] {entry.tool}</span>
                              {entry.args && <pre className="text-muted-foreground mt-1 whitespace-pre-wrap overflow-x-auto">{JSON.stringify(entry.args, null, 2).substring(0, 300)}</pre>}
                            </div>
                          )}
                          {entry.type === "tool_result" && (
                            <div>
                              <span className="text-muted-foreground">[RESULT] {entry.tool}</span>
                              <pre className="text-foreground mt-1 whitespace-pre-wrap overflow-x-auto">{String(entry.result || "").substring(0, 500)}</pre>
                            </div>
                          )}
                          {entry.type === "done" && (
                            <div>
                              <span className="text-primary font-bold">[DONE]</span>
                              <pre className="text-foreground mt-1 whitespace-pre-wrap">{entry.message}</pre>
                            </div>
                          )}
                          {entry.type === "error" && <span className="text-destructive">[ERROR] {entry.message}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── GIT ── */}
                {mode === "git" && (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="p-3 border-b border-border shrink-0 space-y-2">
                      {/* Read ops */}
                      <div className="flex gap-2 flex-wrap">
                        {(["status", "log", "diff", "branches"] as const).map((op) => (
                          <button
                            key={op}
                            onClick={() => { setGitOp(op); gitFetch(op === "diff" ? `diff${gitDiffFile ? `?file=${encodeURIComponent(gitDiffFile)}` : ""}${gitStaged ? `${gitDiffFile ? "&" : "?"}staged=true` : ""}` : op); }}
                            className={`text-xs px-3 py-1 border transition-colors ${gitOp === op ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary"}`}
                          >
                            {op.toUpperCase()}
                          </button>
                        ))}
                        <button onClick={() => gitFetch("status")} disabled={gitLoading} className="text-xs px-3 py-1 border border-border text-muted-foreground hover:text-foreground ml-auto">
                          {gitLoading ? "..." : "↻"}
                        </button>
                      </div>
                      {/* Diff options */}
                      {gitOp === "diff" && (
                        <div className="flex gap-2 items-center text-xs">
                          <span className="text-muted-foreground">file:</span>
                          <input value={gitDiffFile} onChange={(e) => setGitDiffFile(e.target.value)} placeholder="(all files)" className="w-40 bg-background border border-border px-2 py-1 focus:outline-none focus:border-primary" />
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input type="checkbox" checked={gitStaged} onChange={(e) => setGitStaged(e.target.checked)} className="accent-primary" />
                            <span className="text-muted-foreground">staged</span>
                          </label>
                        </div>
                      )}
                      {/* Write ops */}
                      <div className="flex gap-2 flex-wrap border-t border-border pt-2">
                        <button onClick={() => gitFetch("add", "POST", { files: "." })} className="text-xs px-3 py-1 border border-border text-muted-foreground hover:text-foreground hover:border-primary">GIT ADD .</button>
                        <div className="flex gap-1 flex-1">
                          <input value={gitCommitMsg} onChange={(e) => setGitCommitMsg(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && gitCommitMsg) gitFetch("commit", "POST", { message: gitCommitMsg }); }} placeholder="commit message..." className="flex-1 bg-background border border-border px-2 py-1 text-xs focus:outline-none focus:border-primary" />
                          <button onClick={() => { if (gitCommitMsg) { gitFetch("commit", "POST", { message: gitCommitMsg }); setGitCommitMsg(""); } }} disabled={!gitCommitMsg} className="text-xs px-3 py-1 border border-primary text-primary hover:bg-primary hover:text-primary-foreground disabled:opacity-30">COMMIT</button>
                        </div>
                      </div>
                      {/* Branch checkout */}
                      <div className="flex gap-2 items-center border-t border-border pt-2">
                        <span className="text-muted-foreground text-xs">branch:</span>
                        <input value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} placeholder="branch name" className="w-40 bg-background border border-border px-2 py-1 text-xs focus:outline-none focus:border-primary" />
                        <button onClick={() => { if (gitBranch) gitFetch("checkout", "POST", { branch: gitBranch }); }} disabled={!gitBranch} className="text-xs px-2 py-1 border border-border text-muted-foreground hover:text-foreground disabled:opacity-30">CHECKOUT</button>
                        <button onClick={() => { if (gitBranch) gitFetch("checkout", "POST", { branch: gitBranch, create: true }); }} disabled={!gitBranch} className="text-xs px-2 py-1 border border-border text-muted-foreground hover:text-foreground disabled:opacity-30">NEW BRANCH</button>
                      </div>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4">
                      {gitLoading && <div className="text-muted-foreground text-xs animate-pulse">running git...</div>}
                      {gitOutput ? (
                        <pre className="whitespace-pre-wrap text-xs text-foreground leading-relaxed font-mono">{gitOutput}</pre>
                      ) : (
                        <div className="text-muted-foreground text-xs">Select a git operation above to see output.</div>
                      )}
                    </div>
                  </div>
                )}

              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
