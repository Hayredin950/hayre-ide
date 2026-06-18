import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { toast, Toaster } from "sonner";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { EditorView } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API = `${BASE}/api/ide`;
const GIT_API = `${BASE}/api/cli/git`;

// ─── Types ────────────────────────────────────────────────────────────────────
type FileNode = { name: string; path: string; isDir: boolean; children?: FileNode[] };
type OpenFile = { path: string; name: string; content: string; modified: boolean; binary?: boolean };
type TermEntry = { id: string; command: string; output: string; error: string; running: boolean };
type TermSession = { id: string; name: string; history: TermEntry[]; running: boolean };
type ToolCall = { id: string; name: string; args: Record<string, unknown>; result?: string; status: "running" | "done" | "error" };
type AgentMsg = { id: string; role: "user" | "assistant"; content: string; toolCalls?: ToolCall[]; streaming?: boolean };
type Activity = "explorer" | "search" | "git" | null;
type BottomTab = "terminal" | "output" | "problems";
type SearchResult = { file: string; line: number; text: string };
type RecentFile = { path: string; name: string; time: number };
type Settings = { fontSize: number; tabSize: number; wordWrap: boolean; autoSave: boolean; minimap: boolean };

// ─── Theme ────────────────────────────────────────────────────────────────────
const T = {
  bg0: "#0d1117", bg1: "#161b22", bg2: "#1c2128", bg3: "#21262d",
  border: "#30363d", borderLight: "#3d444d",
  accent: "#10b981", accentDim: "#059669", accentGlow: "#10b98122",
  text0: "#f0f6fc", text1: "#c9d1d9", text2: "#8b949e", text3: "#484f58",
  red: "#f85149", yellow: "#e3b341", blue: "#58a6ff", purple: "#d2a8ff", green: "#3fb950",
  activityW: 48,
  minSidebar: 160, maxSidebar: 520,
  minRight: 260, maxRight: 600,
  minBottom: 80, maxBottom: 500,
};

const TOOL_ICONS: Record<string, string> = {
  write_file: "✏️", read_file: "📖", list_directory: "📂", create_directory: "📁",
  delete_path: "🗑", run_command: "⚡", search_web: "🔍", generate_image: "🎨",
};

const DEFAULT_SETTINGS: Settings = { fontSize: 13, tabSize: 2, wordWrap: true, autoSave: true, minimap: false };

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);
const BINARY_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif", "pdf", "zip", "tar", "gz", "exe", "wasm", "mp4", "mp3", "wav", "ogg", "mov"]);

// ─── Utilities ────────────────────────────────────────────────────────────────
function ext(name: string) { return name.split(".").pop()?.toLowerCase() ?? ""; }
function isImage(name: string) { return IMAGE_EXTS.has(ext(name)); }
function isBinary(name: string) { return BINARY_EXTS.has(ext(name)); }

function getLang(name: string) {
  const e = ext(name);
  if (["js", "jsx"].includes(e)) return [javascript({ jsx: true })];
  if (["ts", "tsx"].includes(e)) return [javascript({ jsx: true, typescript: true })];
  if (e === "py") return [python()];
  if (["html", "htm"].includes(e)) return [html()];
  if (e === "css") return [css()];
  if (e === "json") return [json()];
  if (["md", "mdx"].includes(e)) return [markdown()];
  if (e === "go") return [go()];
  if (e === "rs") return [rust()];
  if (e === "sql") return [sql()];
  return [];
}

function langLabel(name: string) {
  const m: Record<string, string> = { js: "JavaScript", jsx: "JSX", ts: "TypeScript", tsx: "TSX", py: "Python", html: "HTML", css: "CSS", json: "JSON", md: "Markdown", go: "Go", rs: "Rust", sql: "SQL", sh: "Shell", yml: "YAML", yaml: "YAML", toml: "TOML", txt: "Text", svg: "SVG" };
  return m[ext(name)] ?? (ext(name).toUpperCase() || "Plain Text");
}

function getFileIcon(name: string, isDir: boolean) {
  if (isDir) return "📁";
  const m: Record<string, string> = { ts: "🔷", tsx: "⚛", js: "🟡", jsx: "⚛", py: "🐍", html: "🌐", css: "🎨", json: "📋", md: "📝", go: "🐹", rs: "🦀", sql: "🗄", sh: "📜", yml: "⚙", yaml: "⚙", toml: "⚙", env: "🔑", png: "🖼", jpg: "🖼", jpeg: "🖼", svg: "🖼", gif: "🖼", webp: "🖼", mp4: "🎬", mp3: "🎵", pdf: "📕", zip: "📦", txt: "📄", lock: "🔒" };
  return m[ext(name)] ?? "📄";
}

function getRunCmd(path: string) {
  const m: Record<string, string> = { py: `python3 "${path}"`, js: `node "${path}"`, ts: `npx tsx "${path}"`, go: `go run "${path}"`, rs: `rustc "${path}" -o /tmp/rs_out && /tmp/rs_out`, sh: `bash "${path}"` };
  return m[ext(path)] ?? null;
}

function renderMd(text: string): string {
  let h = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_,lang,code) => `<pre class="md-pre"><code class="lang-${lang}">${code.trim()}</code></pre>`)
    .replace(/`([^`\n]+)`/g, "<code class=\"md-code\">$1</code>")
    .replace(/^#{4} (.+)$/gm, "<h4>$1</h4>")
    .replace(/^#{3} (.+)$/gm, "<h3>$1</h3>")
    .replace(/^#{2} (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\" target=\"_blank\" rel=\"noopener\">$1</a>")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<img alt=\"$1\" src=\"$2\" style=\"max-width:100%\">")
    .replace(/^---+$/gm, "<hr>")
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^[-*+] (.+)$/gm, "<li>$1</li>")
    .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/\n\n+/g, "\n\n")
    .split("\n\n")
    .map(p => p.startsWith("<") ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return h;
}

// ─── Editor Theme ─────────────────────────────────────────────────────────────
function makeEditorTheme(fontSize: number) {
  return EditorView.theme({
    "&": { background: T.bg2, color: T.text1, fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace", fontSize: `${fontSize}px` },
    ".cm-content": { caretColor: T.accent, padding: "10px 0", minHeight: "100%" },
    ".cm-cursor": { borderLeftColor: T.accent, borderLeftWidth: "2px" },
    ".cm-activeLine": { background: "#ffffff06" },
    ".cm-activeLineGutter": { background: "#ffffff06" },
    ".cm-gutters": { background: T.bg2, color: T.text3, borderRight: `1px solid ${T.border}` },
    ".cm-lineNumbers .cm-gutterElement": { color: T.text3, minWidth: "44px", padding: "0 8px", userSelect: "none" },
    ".cm-selectionBackground, ::selection": { background: "#264f7860 !important" },
    ".cm-focused .cm-selectionBackground": { background: "#264f7860 !important" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { overflow: "auto", fontFamily: "inherit" },
    ".cm-search": { background: T.bg1, borderTop: `1px solid ${T.border}`, padding: "6px 10px", display: "flex", gap: "6px", alignItems: "center" },
    ".cm-textfield": { background: T.bg3, border: `1px solid ${T.border}`, color: T.text0, padding: "3px 8px", borderRadius: "4px", outline: "none", fontSize: "12px" },
    ".cm-button": { background: T.bg3, border: `1px solid ${T.border}`, color: T.text1, padding: "3px 8px", borderRadius: "4px", cursor: "pointer", fontSize: "12px" },
    ".cm-tooltip": { background: T.bg1, border: `1px solid ${T.border}`, borderRadius: "6px", boxShadow: "0 8px 24px #000a" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { background: T.accentGlow, color: T.text0 },
    ".cm-keyword": { color: "#ff79c6" }, ".cm-string": { color: "#a5d6ff" },
    ".cm-comment": { color: T.text3, fontStyle: "italic" }, ".cm-number": { color: "#79c0ff" },
    ".cm-operator": { color: "#ff7b72" }, ".cm-typeName": { color: "#ffa657" },
    ".cm-functionName": { color: "#d2a8ff" }, ".cm-variableName": { color: T.text1 },
    ".cm-tagName": { color: "#7ee787" }, ".cm-attributeName": { color: "#79c0ff" },
    ".cm-propertyName": { color: "#79c0ff" }, ".cm-bool": { color: "#79c0ff" },
    ".cm-punctuation": { color: T.text2 }, ".cm-className": { color: "#ffa657" },
    ".cm-url": { color: T.blue }, ".cm-definition": { color: "#d2a8ff" },
    ".cm-meta": { color: T.text2 },
  }, { dark: true });
}

// ─── localStorage hook ────────────────────────────────────────────────────────
function usePersist<T>(key: string, init: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [val, setVal] = useState<T>(() => {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : init; } catch { return init; }
  });
  const set: React.Dispatch<React.SetStateAction<T>> = useCallback((v) => {
    setVal(prev => {
      const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [key]);
  return [val, set];
}

// ─── Drag-resize hooks ────────────────────────────────────────────────────────
function useDragH(setter: React.Dispatch<React.SetStateAction<number>>, reversed = false) {
  return useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    let last = e.clientX;
    document.body.style.cssText += ";cursor:col-resize;user-select:none";
    const move = (ev: MouseEvent) => {
      const d = ev.clientX - last; last = ev.clientX;
      setter(v => reversed ? Math.max(T.minRight, Math.min(T.maxRight, v - d)) : Math.max(T.minSidebar, Math.min(T.maxSidebar, v + d)));
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }, [setter, reversed]);
}
function useDragV(setter: React.Dispatch<React.SetStateAction<number>>) {
  return useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    let last = e.clientY;
    document.body.style.cssText += ";cursor:row-resize;user-select:none";
    const move = (ev: MouseEvent) => {
      const d = ev.clientY - last; last = ev.clientY;
      setter(v => Math.max(T.minBottom, Math.min(T.maxBottom, v - d)));
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }, [setter]);
}

// ─── File Tree Node ───────────────────────────────────────────────────────────
function FileTreeNode({ node, depth, onOpen, onRefresh, selected, onRename }: {
  node: FileNode; depth: number; onOpen: (p: string) => void; onRefresh: () => void;
  selected: string | null; onRename?: (oldPath: string, newName: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [newItem, setNewItem] = useState<{ type: "file" | "folder"; value: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(node.name);
  const isActive = selected === node.path;

  async function doDelete() {
    setCtx(null);
    if (!confirm(`Delete "${node.name}"?`)) return;
    await fetch(`${API}/fs/delete?path=${encodeURIComponent(node.path)}`, { method: "DELETE" });
    onRefresh();
  }
  async function commitNew() {
    if (!newItem?.value.trim()) { setNewItem(null); return; }
    const base = node.isDir ? node.path : node.path.split("/").slice(0, -1).join("/") || ".";
    const p = `${base}/${newItem.value}`;
    if (newItem.type === "folder") await fetch(`${API}/fs/mkdir`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) });
    else { await fetch(`${API}/fs/write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p, content: "" }) }); onOpen(p); }
    setNewItem(null); onRefresh();
  }
  async function commitRename() {
    const newName = renameVal.trim();
    if (!newName || newName === node.name) { setRenaming(false); return; }
    const dir = node.path.split("/").slice(0, -1).join("/");
    const newPath = dir ? `${dir}/${newName}` : newName;
    await fetch(`${API}/fs/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: node.path, to: newPath }) });
    onRename?.(node.path, newName);
    setRenaming(false); onRefresh();
  }

  const copyPath = () => { navigator.clipboard?.writeText(node.path); setCtx(null); toast.success("Path copied"); };

  return (
    <div>
      <div
        onContextMenu={e => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY }); }}
        onClick={() => node.isDir ? setExpanded(v => !v) : onOpen(node.path)}
        onDoubleClick={e => { e.stopPropagation(); if (!node.isDir) { setRenaming(true); setRenameVal(node.name); } }}
        style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 8px", paddingLeft: 8 + depth * 14, cursor: "pointer", fontSize: 13, userSelect: "none", borderRadius: 4, margin: "1px 4px", color: isActive ? T.accent : T.text1, background: isActive ? T.accentGlow : "transparent", transition: "background 0.1s" }}
        onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = T.bg3; }}
        onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}>
        <span style={{ fontSize: 9, color: T.text3, width: 10, flexShrink: 0 }}>{node.isDir ? (expanded ? "▼" : "▶") : ""}</span>
        <span style={{ fontSize: 12, lineHeight: 1 }}>{getFileIcon(node.name, node.isDir)}</span>
        {renaming ? (
          <input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(false); }}
            onBlur={commitRename}
            style={{ flex: 1, background: T.bg3, border: `1px solid ${T.accent}`, color: T.text0, fontSize: 12, padding: "1px 5px", borderRadius: 3, outline: "none" }} />
        ) : (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{node.name}</span>
        )}
      </div>

      {ctx && (<>
        <div style={{ position: "fixed", inset: 0, zIndex: 999 }} onClick={() => setCtx(null)} />
        <div style={{ position: "fixed", top: ctx.y, left: ctx.x, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, zIndex: 1000, minWidth: 168, boxShadow: "0 8px 32px #000000aa", overflow: "hidden", padding: "4px 0" }}>
          {node.isDir && [{ l: "📄 New File", t: "file" as const }, { l: "📁 New Folder", t: "folder" as const }].map(i => (
            <CtxItem key={i.t} label={i.l} onClick={() => { setCtx(null); setExpanded(true); setNewItem({ type: i.t, value: "" }); }} />
          ))}
          <CtxItem label="✏️ Rename" onClick={() => { setCtx(null); setRenaming(true); setRenameVal(node.name); }} />
          <CtxItem label="📋 Copy Path" onClick={copyPath} />
          <div style={{ borderTop: `1px solid ${T.border}`, margin: "4px 0" }} />
          <CtxItem label="🗑 Delete" onClick={doDelete} color={T.red} />
        </div>
      </>)}

      {expanded && node.isDir && (
        <div>
          {newItem && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, paddingLeft: 8 + (depth + 1) * 14, padding: "3px 8px", margin: "1px 4px" }}>
              <span style={{ fontSize: 12 }}>{newItem.type === "folder" ? "📁" : "📄"}</span>
              <input autoFocus value={newItem.value} onChange={e => setNewItem({ ...newItem, value: e.target.value })}
                onKeyDown={e => { if (e.key === "Enter") commitNew(); if (e.key === "Escape") setNewItem(null); }}
                onBlur={commitNew}
                style={{ flex: 1, background: T.bg3, border: `1px solid ${T.accent}`, color: T.text0, fontSize: 12, padding: "2px 6px", borderRadius: 4, outline: "none" }} />
            </div>
          )}
          {node.children?.map(c => <FileTreeNode key={c.path} node={c} depth={depth + 1} onOpen={onOpen} onRefresh={onRefresh} selected={selected} onRename={onRename} />)}
        </div>
      )}
    </div>
  );
}

function CtxItem({ label, onClick, color }: { label: string; onClick: () => void; color?: string }) {
  return (
    <div onClick={onClick} style={{ padding: "7px 14px", cursor: "pointer", fontSize: 13, color: color || T.text1 }}
      onMouseEnter={e => e.currentTarget.style.background = T.bg3}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>{label}</div>
  );
}

// ─── Command Palette ──────────────────────────────────────────────────────────
type CmdPaletteProps = {
  open: boolean; onClose: () => void;
  allFiles: { path: string; name: string }[];
  recentFiles: RecentFile[];
  onOpen: (p: string) => void;
  commands: { label: string; icon: string; action: () => void }[];
};
function CommandPalette({ open, onClose, allFiles, recentFiles, onOpen, commands }: CmdPaletteProps) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current?.focus(), 50); } }, [open]);

  const isCmd = q.startsWith(">");
  const query = isCmd ? q.slice(1).trim().toLowerCase() : q.toLowerCase();

  const filteredCmds = useMemo(() => isCmd
    ? commands.filter(c => c.label.toLowerCase().includes(query))
    : [], [isCmd, query, commands]);

  const filteredFiles = useMemo(() => {
    if (isCmd) return [];
    if (!query) return recentFiles.map(r => ({ path: r.path, name: r.name, recent: true })).slice(0, 8);
    return allFiles.filter(f => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query)).slice(0, 12);
  }, [isCmd, query, allFiles, recentFiles]);

  const items = isCmd ? filteredCmds.map(c => ({ ...c, isCmd: true })) : filteredFiles.map(f => ({ label: f.name, icon: getFileIcon(f.name, false), path: f.path, recent: (f as any).recent, isCmd: false }));

  function activate(i: number) {
    const item = items[i];
    if (!item) return;
    if (item.isCmd) {
      const cmd = filteredCmds[i];
      if (cmd) cmd.action();
    } else {
      const fp = (item as { path?: string }).path;
      if (fp) onOpen(fp);
    }
    onClose();
  }

  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 80, background: "#00000066", backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 580, background: T.bg1, border: `1px solid ${T.borderLight}`, borderRadius: 12, overflow: "hidden", boxShadow: "0 24px 64px #000000cc" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${T.border}`, gap: 10 }}>
          <span style={{ color: T.text2, fontSize: 14 }}>{isCmd ? "⚡" : "🔍"}</span>
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setSel(0); }}
            placeholder="Search files… (type > for commands)"
            onKeyDown={e => {
              if (e.key === "Escape") { onClose(); return; }
              if (e.key === "ArrowDown") { e.preventDefault(); setSel(v => Math.min(items.length - 1, v + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel(v => Math.max(0, v - 1)); }
              if (e.key === "Enter") activate(sel);
            }}
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: T.text0, fontSize: 14 }} />
          <span style={{ fontSize: 11, color: T.text3, background: T.bg3, padding: "2px 6px", borderRadius: 4 }}>Esc</span>
        </div>
        {!isCmd && !q && <div style={{ padding: "6px 16px 4px", fontSize: 11, color: T.text3, textTransform: "uppercase", letterSpacing: 1 }}>Recent</div>}
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          {items.length === 0 && <div style={{ padding: "20px", color: T.text3, fontSize: 13, textAlign: "center" }}>No results</div>}
          {items.map((item, i) => (
            <div key={i} onClick={() => activate(i)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", cursor: "pointer", background: i === sel ? T.bg3 : "transparent", borderLeft: i === sel ? `2px solid ${T.accent}` : "2px solid transparent", transition: "all 0.1s" }}
              onMouseEnter={() => setSel(i)}>
              <span style={{ fontSize: 13, flexShrink: 0 }}>{item.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: T.text0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</div>
                {!item.isCmd && (item as any).path && <div style={{ fontSize: 11, color: T.text3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(item as any).path}</div>}
              </div>
              {(item as any).recent && <span style={{ fontSize: 10, color: T.text3, background: T.bg3, padding: "1px 6px", borderRadius: 4 }}>recent</span>}
            </div>
          ))}
        </div>
        <div style={{ borderTop: `1px solid ${T.border}`, padding: "6px 14px", display: "flex", gap: 16, fontSize: 11, color: T.text3 }}>
          <span><kbd style={{ background: T.bg3, padding: "1px 5px", borderRadius: 3 }}>↑↓</kbd> navigate</span>
          <span><kbd style={{ background: T.bg3, padding: "1px 5px", borderRadius: 3 }}>Enter</kbd> open</span>
          <span><kbd style={{ background: T.bg3, padding: "1px 5px", borderRadius: 3 }}>&gt;</kbd> commands</span>
        </div>
      </div>
    </div>
  );
}

// ─── Tool Call Card ───────────────────────────────────────────────────────────
function ToolCallCard({ tc }: { tc: ToolCall }) {
  const [exp, setExp] = useState(false);
  return (
    <div style={{ marginBottom: 6, borderRadius: 6, border: `1px solid ${T.border}`, overflow: "hidden", background: T.bg2 }}>
      <div onClick={() => setExp(v => !v)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", cursor: "pointer" }}>
        <span style={{ fontSize: 13 }}>{TOOL_ICONS[tc.name] || "🔧"}</span>
        <span style={{ fontSize: 11, fontFamily: "monospace", color: T.accent, fontWeight: 600 }}>{tc.name}</span>
        <span style={{ fontSize: 10, color: tc.status === "running" ? T.yellow : T.green }}>{tc.status === "running" ? "⟳ running…" : "✓ done"}</span>
        <div style={{ flex: 1 }} />
        {(tc.args as any).path && <span style={{ fontSize: 10, color: T.text3, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(tc.args as any).path}</span>}
        <span style={{ color: T.text3, fontSize: 10 }}>{exp ? "▲" : "▼"}</span>
      </div>
      {exp && (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: "8px 10px" }}>
          <pre style={{ margin: "0 0 6px", fontSize: 11, color: T.text2, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 120, overflow: "auto" }}>{JSON.stringify(tc.args, null, 2)}</pre>
          {tc.result && <pre style={{ margin: 0, fontSize: 11, color: T.green, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 140, overflow: "auto" }}>{tc.result.slice(0, 1000)}</pre>}
        </div>
      )}
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
function SettingsPanel({ open, onClose, settings, onChange }: {
  open: boolean; onClose: () => void;
  settings: Settings; onChange: (s: Settings) => void;
}) {
  if (!open) return null;
  const set = (k: keyof Settings, v: unknown) => onChange({ ...settings, [k]: v });
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", background: "#00000077", backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 440, background: T.bg1, border: `1px solid ${T.borderLight}`, borderRadius: 14, overflow: "hidden", boxShadow: "0 24px 80px #000000cc" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text0 }}>⚙️ Settings</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.text2, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 18 }}>
          <SettingRow label="Font Size" hint={`${settings.fontSize}px`}>
            <input type="range" min={10} max={20} value={settings.fontSize} onChange={e => set("fontSize", +e.target.value)}
              style={{ flex: 1, accentColor: T.accent }} />
          </SettingRow>
          <SettingRow label="Tab Size">
            <div style={{ display: "flex", gap: 6 }}>
              {[2, 4].map(n => (
                <button key={n} onClick={() => set("tabSize", n)}
                  style={{ padding: "4px 14px", borderRadius: 6, background: settings.tabSize === n ? T.accent : T.bg3, color: settings.tabSize === n ? "#000" : T.text1, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{n}</button>
              ))}
            </div>
          </SettingRow>
          <SettingRow label="Word Wrap">
            <Toggle on={settings.wordWrap} onChange={v => set("wordWrap", v)} />
          </SettingRow>
          <SettingRow label="Auto Save" hint="2s after change">
            <Toggle on={settings.autoSave} onChange={v => set("autoSave", v)} />
          </SettingRow>
          <SettingRow label="Minimap">
            <Toggle on={settings.minimap} onChange={v => set("minimap", v)} />
          </SettingRow>
        </div>
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${T.border}`, textAlign: "right" }}>
          <button onClick={onClose} style={{ padding: "7px 20px", borderRadius: 8, background: T.accent, color: "#000", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>Done</button>
        </div>
      </div>
    </div>
  );
}
function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: T.text0, fontWeight: 600 }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div onClick={() => onChange(!on)} style={{ width: 42, height: 24, borderRadius: 12, background: on ? T.accent : T.bg3, cursor: "pointer", position: "relative", flexShrink: 0, transition: "background 0.2s", border: `1px solid ${on ? T.accent : T.border}` }}>
      <div style={{ position: "absolute", top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: "50%", background: on ? "#000" : T.text2, transition: "left 0.2s" }} />
    </div>
  );
}

// ─── Keyboard Shortcuts Panel ─────────────────────────────────────────────────
function KeyboardShortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  const sections = [
    { title: "Files & Tabs", items: [
      ["Ctrl+P / ⌘P", "Command Palette / Open File"],
      ["Ctrl+S / ⌘S", "Save File"],
      ["Ctrl+W / ⌘W", "Close Tab"],
      ["Ctrl+Shift+W", "Close All Tabs"],
      ["Alt+←/→", "Previous / Next Tab"],
    ]},
    { title: "Editor", items: [
      ["Ctrl+F", "Find in File"],
      ["Ctrl+H", "Find & Replace"],
      ["Ctrl+G", "Go to Line"],
      ["Ctrl+/", "Toggle Comment"],
      ["Ctrl+D", "Select Next Occurrence"],
      ["Alt+↑/↓", "Move Line Up/Down"],
      ["Shift+Alt+↑/↓", "Copy Line Up/Down"],
      ["Ctrl+Shift+K", "Delete Line"],
      ["Tab / Shift+Tab", "Indent / Unindent"],
    ]},
    { title: "Panels", items: [
      ["Ctrl+` / ⌘`", "Toggle Terminal"],
      ["Ctrl+B / ⌘B", "Toggle Sidebar"],
      ["Ctrl+Shift+E", "Explorer"],
      ["Ctrl+Shift+F", "Search"],
      ["Ctrl+Shift+G", "Git"],
      ["Ctrl+Shift+A", "AI Agent"],
      ["F1 / Ctrl+?", "Keyboard Shortcuts"],
    ]},
    { title: "Run", items: [
      ["Ctrl+Enter / F5", "Run File"],
      ["Ctrl+Shift+P", "Format Code"],
    ]},
  ];
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", background: "#00000077", backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 600, maxHeight: "80vh", background: T.bg1, border: `1px solid ${T.borderLight}`, borderRadius: 14, overflow: "hidden", boxShadow: "0 24px 80px #000000cc", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text0 }}>⌨️ Keyboard Shortcuts</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.text2, cursor: "pointer", fontSize: 18 }}>×</button>
        </div>
        <div style={{ overflowY: "auto", padding: "16px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px 32px" }}>
          {sections.map(sec => (
            <div key={sec.title}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.text3, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 8 }}>{sec.title}</div>
              {sec.items.map(([k, d]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: `1px solid ${T.border}20` }}>
                  <span style={{ fontSize: 11, color: T.text2 }}>{d}</span>
                  <kbd style={{ fontSize: 11, background: T.bg3, border: `1px solid ${T.border}`, padding: "2px 7px", borderRadius: 5, color: T.text1, whiteSpace: "nowrap", flexShrink: 0, marginLeft: 8 }}>{k}</kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Go to Line Dialog ────────────────────────────────────────────────────────
function GotoLineDialog({ open, onClose, onGoto, maxLine }: { open: boolean; onClose: () => void; onGoto: (n: number) => void; maxLine: number }) {
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setVal(""); setTimeout(() => inputRef.current?.focus(), 50); } }, [open]);
  if (!open) return null;
  function go() { const n = parseInt(val); if (n > 0) onGoto(n); onClose(); }
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 80, background: "#00000044" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 320, background: T.bg1, border: `1px solid ${T.borderLight}`, borderRadius: 10, overflow: "hidden", boxShadow: "0 16px 48px #000000cc" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "12px 14px", gap: 10 }}>
          <span style={{ fontSize: 12, color: T.text2 }}>Go to line</span>
          <input ref={inputRef} value={val} onChange={e => setVal(e.target.value)} type="number" min={1} max={maxLine}
            placeholder={`1 – ${maxLine}`}
            onKeyDown={e => { if (e.key === "Enter") go(); if (e.key === "Escape") onClose(); }}
            style={{ flex: 1, background: T.bg3, border: `1px solid ${T.border}`, color: T.text0, fontSize: 14, padding: "5px 10px", borderRadius: 6, outline: "none" }} />
          <button onClick={go} style={{ padding: "5px 14px", background: T.accent, color: "#000", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 700, fontSize: 13 }}>Go</button>
        </div>
      </div>
    </div>
  );
}

// ─── Markdown Preview ─────────────────────────────────────────────────────────
function MdPreview({ text }: { text: string }) {
  const html = useMemo(() => renderMd(text), [text]);
  return (
    <>
      <style>{`
        .md-preview h1{color:${T.text0};border-bottom:1px solid ${T.border};padding-bottom:8px;margin:0 0 16px;font-size:22px}
        .md-preview h2{color:${T.text0};border-bottom:1px solid ${T.border}40;padding-bottom:6px;margin:20px 0 12px;font-size:18px}
        .md-preview h3,.md-preview h4{color:${T.text0};margin:16px 0 8px;font-size:15px}
        .md-preview p{margin:0 0 12px;line-height:1.75}
        .md-preview a{color:${T.blue};text-decoration:none}
        .md-preview a:hover{text-decoration:underline}
        .md-preview strong{color:${T.text0};font-weight:700}
        .md-preview blockquote{border-left:3px solid ${T.accent};margin:0 0 12px;padding:4px 12px;color:${T.text2};background:${T.bg3};border-radius:0 6px 6px 0}
        .md-preview ul{margin:0 0 12px;padding-left:20px}
        .md-preview li{margin-bottom:4px;line-height:1.6}
        .md-preview hr{border:none;border-top:1px solid ${T.border};margin:20px 0}
        .md-preview .md-pre{background:${T.bg0};border:1px solid ${T.border};border-radius:8px;padding:14px;overflow-x:auto;margin:0 0 14px}
        .md-preview .md-pre code{font-family:'JetBrains Mono',monospace;font-size:12px;color:${T.text1}}
        .md-preview .md-code{background:${T.bg3};border:1px solid ${T.border};border-radius:4px;padding:1px 6px;font-family:'JetBrains Mono',monospace;font-size:12px;color:${T.accent}}
        .md-preview img{max-width:100%;border-radius:8px}
        .md-preview del{color:${T.text3}}
      `}</style>
      <div className="md-preview" style={{ padding: "16px 24px", overflowY: "auto", height: "100%", fontSize: 14, lineHeight: 1.7, color: T.text1, background: T.bg2 }} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

// ─── Main IDE ─────────────────────────────────────────────────────────────────
export default function IDE() {
  // ── Settings & Layout (persisted) ───────────────────────────────────────────
  const [settings, setSettings] = usePersist<Settings>("ide:settings", DEFAULT_SETTINGS);
  const [activity, setActivity] = usePersist<Activity>("ide:activity", "explorer");
  const [sidebarW, setSidebarW] = usePersist("ide:sidebarW", 240);
  const [rightW, setRightW] = usePersist("ide:rightW", 360);
  const [bottomH, setBottomH] = usePersist("ide:bottomH", 200);
  const [showBottom, setShowBottom] = usePersist("ide:showBottom", true);
  const [bottomTab, setBottomTab] = usePersist<BottomTab>("ide:bottomTab", "terminal");

  // ── UI State ─────────────────────────────────────────────────────────────────
  const [showRight, setShowRight] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [mdSplit, setMdSplit] = useState(false);
  const [tabCtx, setTabCtx] = useState<{ path: string; x: number; y: number } | null>(null);

  // ── Files ────────────────────────────────────────────────────────────────────
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeTab, setActiveTab] = usePersist<string | null>("ide:activeTab", null);
  const [saving, setSaving] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [recentFiles, setRecentFiles] = usePersist<RecentFile[]>("ide:recent", []);

  // ── Search ───────────────────────────────────────────────────────────────────
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // ── Git ──────────────────────────────────────────────────────────────────────
  const [gitStatus, setGitStatus] = useState("");
  const [gitBranch, setGitBranch] = useState("main");
  const [gitLog, setGitLog] = useState<string[]>([]);
  const [commitMsg, setCommitMsg] = useState("");
  const [gitLoading, setGitLoading] = useState(false);
  const [gitDiff, setGitDiff] = useState("");
  const [showDiff, setShowDiff] = useState(false);

  // ── Terminal ─────────────────────────────────────────────────────────────────
  const [termSessions, setTermSessions] = useState<TermSession[]>([
    { id: "main", name: "bash", history: [], running: false },
  ]);
  const [activeTermId, setActiveTermId] = useState("main");
  const [termInput, setTermInput] = useState("");
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [cmdHistIdx, setCmdHistIdx] = useState(-1);
  const [outputLog, setOutputLog] = useState<string[]>([]);
  const termEndRef = useRef<HTMLDivElement>(null);

  // ── Agent ────────────────────────────────────────────────────────────────────
  const [agentMsgs, setAgentMsgs] = useState<AgentMsg[]>([]);
  const [agentInput, setAgentInput] = useState("");
  const [agentRunning, setAgentRunning] = useState(false);
  const [conversation, setConversation] = useState<{ role: string; content: string }[]>([]);
  const agentEndRef = useRef<HTMLDivElement>(null);

  // ── Editor ───────────────────────────────────────────────────────────────────
  const [editorHeight, setEditorHeight] = useState(0);
  const editorRoRef = useRef<ResizeObserver | null>(null);
  const editorContainerRef = useCallback((node: HTMLDivElement | null) => {
    if (editorRoRef.current) { editorRoRef.current.disconnect(); editorRoRef.current = null; }
    if (node) {
      setEditorHeight(node.getBoundingClientRect().height);
      editorRoRef.current = new ResizeObserver(entries => setEditorHeight(entries[0].contentRect.height));
      editorRoRef.current.observe(node);
    }
  }, []);
  const editorViewRef = useRef<EditorView | null>(null);
  const editorTheme = useMemo(() => makeEditorTheme(settings.fontSize), [settings.fontSize]);

  // ── Resize handlers ──────────────────────────────────────────────────────────
  const onSidebarDrag = useDragH(setSidebarW);
  const onRightDrag = useDragH(setRightW, true);
  const onBottomDrag = useDragV(setBottomH);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const activeFile = openFiles.find(f => f.path === activeTab) ?? null;
  const hasSidebar = activity !== null;
  const activeSession = termSessions.find(s => s.id === activeTermId) ?? termSessions[0];

  const allFilePaths = useMemo(() => {
    const paths: { path: string; name: string }[] = [];
    function walk(nodes: FileNode[]) { for (const n of nodes) { if (!n.isDir) paths.push({ path: n.path, name: n.name }); if (n.children) walk(n.children); } }
    walk(fileTree);
    return paths;
  }, [fileTree]);

  const changedFiles = useMemo(() =>
    gitStatus.split("\n").filter(l => /^\s*[MAD?U]\s/.test(l) || /^\s*(modified|new file|deleted|untracked)/.test(l)).map(l => l.trim()).filter(Boolean),
    [gitStatus]);

  const lineCount = useMemo(() => activeFile?.content.split("\n").length ?? 0, [activeFile?.content]);

  // ── Load tree & git ───────────────────────────────────────────────────────────
  const loadTree = useCallback(async () => {
    try { const r = await fetch(`${API}/fs/tree?path=.`); const d = await r.json(); setFileTree(d.children || []); } catch {}
  }, []);

  const loadGit = useCallback(async () => {
    setGitLoading(true);
    try {
      const [s, l] = await Promise.all([fetch(`${GIT_API}/status`), fetch(`${GIT_API}/log`)]);
      const sd = await s.json(); const ld = await l.json();
      setGitStatus(sd.output || "");
      setGitLog((ld.output || "").split("\n").filter(Boolean).slice(0, 30));
      const bm = (sd.output || "").match(/On branch (\S+)/);
      if (bm) setGitBranch(bm[1]);
    } catch {} finally { setGitLoading(false); }
  }, []);

  useEffect(() => { loadTree(); loadGit(); }, [loadTree, loadGit]);
  useEffect(() => { termEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [activeSession?.history]);
  useEffect(() => { agentEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [agentMsgs]);

  // ── Auto-save ─────────────────────────────────────────────────────────────────
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!settings.autoSave || !activeFile?.modified) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      setAutoSaving(true);
      const file = activeFile;
      if (file) {
        await fetch(`${API}/fs/write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: file.path, content: file.content }) });
        setOpenFiles(p => p.map(f => f.path === file.path ? { ...f, modified: false } : f));
      }
      setAutoSaving(false);
    }, 2000);
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [activeFile?.content, settings.autoSave]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "p") { e.preventDefault(); setCmdOpen(v => !v); }
      if (mod && !e.shiftKey && e.key === "s") { e.preventDefault(); saveFile(); }
      if (mod && e.key === "`") { e.preventDefault(); setShowBottom(v => !v); }
      if (mod && !e.shiftKey && e.key === "b") { e.preventDefault(); setActivity(v => v ? null : "explorer"); }
      if (mod && e.shiftKey && e.key === "E") { e.preventDefault(); setActivity("explorer"); }
      if (mod && e.shiftKey && e.key === "F") { e.preventDefault(); setActivity("search"); }
      if (mod && e.shiftKey && e.key === "G") { e.preventDefault(); setActivity("git"); }
      if (mod && e.shiftKey && e.key === "A") { e.preventDefault(); setShowRight(v => !v); }
      if (mod && e.shiftKey && e.key === "P") { e.preventDefault(); formatCode(); }
      if (mod && e.key === "g") { e.preventDefault(); setGotoOpen(true); }
      if (mod && e.key === "w") { e.preventDefault(); if (activeTab) closeTab(activeTab); }
      if (mod && e.shiftKey && e.key === "W") { e.preventDefault(); closeAllTabs(); }
      if ((e.key === "F1" || (mod && e.key === "?")) && !e.shiftKey) { e.preventDefault(); setShortcutsOpen(true); }
      if (e.key === "F5" || (mod && e.key === "Enter")) { e.preventDefault(); runFile(); }
      if (e.key === "Escape") { setCmdOpen(false); setGotoOpen(false); setTabCtx(null); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeTab, activeFile]);

  // ── File operations ───────────────────────────────────────────────────────────
  function trackRecent(path: string) {
    const name = path.split("/").pop() || path;
    setRecentFiles(p => [{ path, name, time: Date.now() }, ...p.filter(r => r.path !== path)].slice(0, 20));
  }

  async function openFile(path: string) {
    const exists = openFiles.find(f => f.path === path);
    if (exists) { setActiveTab(path); trackRecent(path); return; }
    const name = path.split("/").pop() || path;
    if (isBinary(path)) {
      setOpenFiles(p => [...p, { path, name, content: "", modified: false, binary: true }]);
      setActiveTab(path); trackRecent(path); return;
    }
    try {
      const r = await fetch(`${API}/fs/read?path=${encodeURIComponent(path)}`);
      if (!r.ok) { toast.error(`Cannot open ${name}`); return; }
      const d = await r.json();
      setOpenFiles(p => [...p, { path, name, content: d.content, modified: false }]);
      setActiveTab(path); trackRecent(path);
    } catch { toast.error("Failed to open file"); }
  }

  function closeTab(path: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    const idx = openFiles.findIndex(f => f.path === path);
    const f = openFiles.find(f => f.path === path);
    if (f?.modified && !confirm(`"${f.name}" has unsaved changes. Close anyway?`)) return;
    const next = openFiles.filter(f => f.path !== path);
    setOpenFiles(next);
    if (activeTab === path) setActiveTab(next[Math.max(0, idx - 1)]?.path ?? null);
    if (preview === path) setPreview(null);
  }

  function closeOtherTabs(path: string) {
    const keep = openFiles.find(f => f.path === path);
    const others = openFiles.filter(f => f.path !== path && f.modified);
    if (others.length > 0 && !confirm(`Close ${others.length} unsaved file(s)?`)) return;
    setOpenFiles(keep ? [keep] : []);
    setActiveTab(keep?.path ?? null);
  }

  function closeAllTabs() {
    const modified = openFiles.filter(f => f.modified);
    if (modified.length > 0 && !confirm(`Close ${modified.length} unsaved file(s)?`)) return;
    setOpenFiles([]); setActiveTab(null); setPreview(null);
  }

  function updateContent(path: string, content: string) {
    setOpenFiles(p => p.map(f => f.path === path ? { ...f, content, modified: true } : f));
  }

  async function saveFile(silent = false) {
    const file = openFiles.find(f => f.path === activeTab);
    if (!file || file.binary) return;
    if (!silent) setSaving(true);
    await fetch(`${API}/fs/write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: file.path, content: file.content }) });
    setOpenFiles(p => p.map(f => f.path === activeTab ? { ...f, modified: false } : f));
    if (!silent) { setSaving(false); toast.success("Saved"); }
  }

  async function runFile() {
    const file = openFiles.find(f => f.path === activeTab);
    if (!file) return;
    await saveFile(true);
    if (file.name.endsWith(".html")) { setPreview(file.path); return; }
    const cmd = getRunCmd(file.path);
    if (cmd) { setShowBottom(true); setBottomTab("terminal"); runTermCmd(cmd); }
    else toast.error(`No runner for .${ext(file.name)}`);
  }

  async function formatCode() {
    const file = openFiles.find(f => f.path === activeTab);
    if (!file || file.binary) return;
    const parserMap: Record<string, string> = { js: "babel", jsx: "babel", ts: "typescript", tsx: "typescript", json: "json", css: "css", html: "html", md: "markdown", yaml: "yaml", yml: "yaml" };
    const parser = parserMap[ext(file.name)];
    if (!parser) { toast.error(`No formatter for .${ext(file.name)}`); return; }
    await saveFile(true);
    toast.info("Formatting…");
    const r = await fetch(`${API}/terminal/exec`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: `npx --yes prettier@3 --parser ${parser} --write ${JSON.stringify(file.path)} 2>&1`, timeout_ms: 60000 }) });
    const d = await r.json();
    if (d.exitCode === 0) {
      const fr = await fetch(`${API}/fs/read?path=${encodeURIComponent(file.path)}`);
      const fd = await fr.json();
      setOpenFiles(p => p.map(f => f.path === file.path ? { ...f, content: fd.content, modified: false } : f));
      toast.success("Formatted");
    } else { toast.error("Format failed: " + (d.stderr || d.stdout || "unknown").slice(0, 100)); }
  }

  function gotoLine(n: number) {
    const view = editorViewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    const lineN = Math.min(Math.max(1, n), doc.lines);
    const line = doc.line(lineN);
    view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
  }

  async function handleRename(oldPath: string, newName: string) {
    setOpenFiles(p => p.map(f => {
      if (f.path === oldPath) {
        const dir = oldPath.split("/").slice(0, -1).join("/");
        const newPath = dir ? `${dir}/${newName}` : newName;
        return { ...f, path: newPath, name: newName };
      }
      return f;
    }));
    if (activeTab === oldPath) {
      const dir = oldPath.split("/").slice(0, -1).join("/");
      const newPath = dir ? `${dir}/${newName}` : newName;
      setActiveTab(newPath);
    }
    toast.success(`Renamed to ${newName}`);
  }

  // ── Search ────────────────────────────────────────────────────────────────────
  async function doSearch() {
    if (!searchQ.trim()) return;
    setSearching(true); setSearchResults([]);
    try {
      const r = await fetch(`${API}/terminal/exec`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: `grep -rn ${JSON.stringify(searchQ)} . --include="*.{js,ts,tsx,jsx,py,html,css,json,md,go,rs,sh,yaml,toml}" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist -m 100 2>/dev/null | head -60`, timeout_ms: 10000 }) });
      const d = await r.json();
      const lines = (d.stdout || "").split("\n").filter(Boolean);
      const results: SearchResult[] = lines.map((l: string) => {
        const m = l.match(/^\.\/(.+?):(\d+):(.*)$/);
        return m ? { file: m[1], line: parseInt(m[2]), text: m[3].trim() } : null;
      }).filter(Boolean) as SearchResult[];
      setSearchResults(results);
    } catch {} finally { setSearching(false); }
  }

  // ── Git ops ───────────────────────────────────────────────────────────────────
  async function gitCommit() {
    if (!commitMsg.trim()) return;
    await fetch(`${API}/terminal/exec`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: `git add -A && git commit -m ${JSON.stringify(commitMsg)}` }) });
    setCommitMsg(""); toast.success("Committed"); loadGit();
  }
  async function gitPush() {
    toast.info("Pushing…");
    const r = await fetch(`${API}/terminal/exec`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "git push 2>&1", timeout_ms: 30000 }) });
    const d = await r.json();
    if (d.exitCode === 0) toast.success("Pushed!"); else toast.error("Push failed: " + (d.stdout || d.stderr).slice(0, 100));
  }
  async function gitPull() {
    toast.info("Pulling…");
    const r = await fetch(`${API}/terminal/exec`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "git pull 2>&1", timeout_ms: 30000 }) });
    const d = await r.json();
    if (d.exitCode === 0) { toast.success("Pulled!"); loadTree(); loadGit(); } else toast.error("Pull failed: " + (d.stdout || d.stderr).slice(0, 100));
  }
  async function gitShowDiff() {
    const r = await fetch(`${API}/terminal/exec`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "git diff HEAD 2>&1 | head -200" }) });
    const d = await r.json();
    setGitDiff(d.stdout || "(no changes)"); setShowDiff(true);
  }

  // ── Terminal ─────────────────────────────────────────────────────────────────
  async function runTermCmd(cmd?: string) {
    const command = (cmd ?? termInput).trim();
    if (!command) return;
    if (!cmd) { setTermInput(""); setCmdHistory(p => [command, ...p.slice(0, 99)]); setCmdHistIdx(-1); }
    const id = `t${Date.now()}`;
    const newEntry: TermEntry = { id, command, output: "", error: "", running: true };

    setTermSessions(p => p.map(s => s.id === activeTermId ? { ...s, running: true, history: [...s.history, newEntry] } : s));

    try {
      const resp = await fetch(`${API}/terminal/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }) });
      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "stdout") {
              setTermSessions(p => p.map(s => s.id === activeTermId ? { ...s, history: s.history.map(e => e.id === id ? { ...e, output: e.output + ev.data } : e) } : s));
              setOutputLog(p => [...p.slice(-500), ev.data]);
            }
            if (ev.type === "stderr") {
              setTermSessions(p => p.map(s => s.id === activeTermId ? { ...s, history: s.history.map(e => e.id === id ? { ...e, error: e.error + ev.data } : e) } : s));
            }
            if (ev.type === "exit") {
              setTermSessions(p => p.map(s => s.id === activeTermId ? { ...s, running: false, history: s.history.map(e => e.id === id ? { ...e, running: false } : e) } : s));
            }
          } catch {}
        }
      }
    } catch (err: any) {
      setTermSessions(p => p.map(s => s.id === activeTermId ? { ...s, running: false, history: s.history.map(e => e.id === id ? { ...e, error: err.message, running: false } : e) } : s));
    }
    setTimeout(() => { loadTree(); if (activity === "git") loadGit(); }, 600);
  }

  function addTermSession() {
    const id = `t${Date.now()}`;
    const n = termSessions.length + 1;
    setTermSessions(p => [...p, { id, name: `bash ${n}`, history: [], running: false }]);
    setActiveTermId(id);
  }

  function removeTermSession(id: string) {
    if (termSessions.length <= 1) return;
    const idx = termSessions.findIndex(s => s.id === id);
    const next = termSessions.filter(s => s.id !== id);
    setTermSessions(next);
    if (activeTermId === id) setActiveTermId(next[Math.max(0, idx - 1)].id);
  }

  function clearTermSession() {
    setTermSessions(p => p.map(s => s.id === activeTermId ? { ...s, history: [] } : s));
  }

  // ── Agent ─────────────────────────────────────────────────────────────────────
  async function sendAgent() {
    const text = agentInput.trim();
    if (!text || agentRunning) return;
    setAgentInput(""); setAgentRunning(true);
    const userMsg: AgentMsg = { id: `u${Date.now()}`, role: "user", content: text };
    const newConv = [...conversation, { role: "user", content: text }];
    setConversation(newConv);
    setAgentMsgs(p => [...p, userMsg]);
    const aId = `a${Date.now()}`;
    setAgentMsgs(p => [...p, { id: aId, role: "assistant", content: "", toolCalls: [], streaming: true }]);
    try {
      const resp = await fetch(`${API}/agent/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: newConv }) });
      const reader = resp.body!.getReader(); const dec = new TextDecoder(); let buf = ""; let fullText = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "text") { fullText += ev.content; setAgentMsgs(p => p.map(m => m.id === aId ? { ...m, content: fullText } : m)); }
            if (ev.type === "tool_call") setAgentMsgs(p => p.map(m => m.id !== aId ? m : { ...m, toolCalls: [...(m.toolCalls || []), { id: ev.id, name: ev.name, args: ev.args, status: "running" }] }));
            if (ev.type === "tool_result") setAgentMsgs(p => p.map(m => m.id !== aId ? m : { ...m, toolCalls: m.toolCalls?.map(tc => tc.id === ev.id ? { ...tc, result: ev.result, status: "done" } : tc) }));
            if (ev.type === "done") { setAgentMsgs(p => p.map(m => m.id === aId ? { ...m, streaming: false } : m)); setConversation(p => [...p, { role: "assistant", content: fullText }]); setTimeout(() => { loadTree(); if (activity === "git") loadGit(); }, 800); }
          } catch {}
        }
      }
    } catch (err: any) { setAgentMsgs(p => p.map(m => m.id === aId ? { ...m, content: `Error: ${err.message}`, streaming: false } : m)); }
    setAgentRunning(false);
  }

  // ── Sidebar content ───────────────────────────────────────────────────────────
  const sidebarContent = useMemo(() => {
    if (activity === "explorer") return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px 6px", flexShrink: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.text2, letterSpacing: 1.2, textTransform: "uppercase" }}>Explorer</span>
          <div style={{ display: "flex", gap: 4 }}>
            {[
              { i: "📄", t: "New File", a: async () => { const n = prompt("File name:"); if (!n) return; await fetch(`${API}/fs/write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: n, content: "" }) }); openFile(n); loadTree(); } },
              { i: "📁", t: "New Folder", a: async () => { const n = prompt("Folder name:"); if (!n) return; await fetch(`${API}/fs/mkdir`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: n }) }); loadTree(); } },
              { i: "↻", t: "Refresh", a: loadTree },
            ].map(b => (
              <button key={b.t} title={b.t} onClick={b.a} style={{ background: "none", border: "none", color: T.text2, cursor: "pointer", fontSize: 14, padding: 3, borderRadius: 4 }}
                onMouseEnter={e => e.currentTarget.style.color = T.text0}
                onMouseLeave={e => e.currentTarget.style.color = T.text2}>{b.i}</button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", paddingBottom: 8 }}>
          {fileTree.map(n => <FileTreeNode key={n.path} node={n} depth={0} onOpen={openFile} onRefresh={loadTree} selected={activeTab} onRename={handleRename} />)}
        </div>
      </div>
    );

    if (activity === "search") return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <div style={{ padding: "10px 12px 8px", flexShrink: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.text2, letterSpacing: 1.2, textTransform: "uppercase" }}>Search</span>
        </div>
        <div style={{ padding: "0 10px 10px", flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") doSearch(); }}
              placeholder="Search in files…"
              style={{ flex: 1, background: T.bg3, border: `1px solid ${T.border}`, color: T.text0, fontSize: 12, padding: "6px 10px", borderRadius: 6, outline: "none" }} />
            <button onClick={doSearch} disabled={searching}
              style={{ padding: "6px 12px", background: T.accent, color: "#000", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>{searching ? "…" : "Go"}</button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 4px" }}>
          {searchResults.length === 0 && !searching && searchQ && <div style={{ padding: "16px", fontSize: 12, color: T.text3, textAlign: "center" }}>No results</div>}
          {searchResults.map((r, i) => (
            <div key={i} onClick={() => openFile(r.file)}
              style={{ padding: "5px 10px", cursor: "pointer", borderRadius: 4, margin: "1px 4px" }}
              onMouseEnter={e => e.currentTarget.style.background = T.bg3}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ fontSize: 11, color: T.accent, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.file}:{r.line}</div>
              <div style={{ fontSize: 12, color: T.text1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "monospace" }}>{r.text.slice(0, 80)}</div>
            </div>
          ))}
        </div>
      </div>
    );

    if (activity === "git") return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <div style={{ padding: "10px 12px 6px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: T.text2, letterSpacing: 1.2, textTransform: "uppercase" }}>Source Control</span>
          <button onClick={loadGit} style={{ background: "none", border: "none", color: T.text2, cursor: "pointer", fontSize: 14 }}>↻</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: T.accent, background: T.accentGlow, padding: "2px 8px", borderRadius: 12, fontWeight: 600 }}>⎇ {gitBranch}</span>
            {gitLoading && <span style={{ fontSize: 11, color: T.text3 }}>⟳</span>}
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            {[{ l: "Pull", a: gitPull }, { l: "Push", a: gitPush }, { l: "Diff", a: gitShowDiff }].map(b => (
              <button key={b.l} onClick={b.a} style={{ flex: 1, padding: "5px 0", background: T.bg3, border: `1px solid ${T.border}`, color: T.text1, borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600 }}
                onMouseEnter={e => e.currentTarget.style.background = T.bg2}
                onMouseLeave={e => e.currentTarget.style.background = T.bg3}>{b.l}</button>
            ))}
          </div>
          <textarea value={commitMsg} onChange={e => setCommitMsg(e.target.value)}
            placeholder="Commit message…"
            style={{ width: "100%", background: T.bg3, border: `1px solid ${T.border}`, color: T.text0, fontSize: 12, padding: "8px 10px", borderRadius: 6, outline: "none", resize: "vertical", minHeight: 64, fontFamily: "inherit", boxSizing: "border-box" }} />
          <button onClick={gitCommit} disabled={!commitMsg.trim()} style={{ width: "100%", padding: "8px", marginTop: 6, background: commitMsg.trim() ? T.accent : T.bg3, color: commitMsg.trim() ? "#000" : T.text3, border: "none", borderRadius: 6, cursor: commitMsg.trim() ? "pointer" : "default", fontSize: 12, fontWeight: 700, transition: "all 0.2s" }}>
            Commit & Stage All
          </button>
          {changedFiles.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, color: T.text3, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Changes ({changedFiles.length})</div>
              {changedFiles.map((f, i) => <div key={i} style={{ fontSize: 12, color: T.yellow, padding: "3px 6px", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", borderRadius: 4, cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = T.bg3}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>{f}</div>)}
            </div>
          )}
          {gitLog.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, color: T.text3, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Recent Commits</div>
              {gitLog.slice(0, 8).map((l, i) => <div key={i} style={{ fontSize: 11, color: T.text2, padding: "3px 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "monospace", borderBottom: `1px solid ${T.border}20` }}>{l}</div>)}
            </div>
          )}
        </div>
      </div>
    );

    return null;
  }, [activity, fileTree, searchQ, searchResults, searching, gitStatus, gitBranch, gitLog, commitMsg, gitLoading, changedFiles, activeTab]);

  // ── Command palette commands ───────────────────────────────────────────────────
  const paletteCommands = useMemo(() => [
    { icon: "💾", label: "Save File", action: saveFile },
    { icon: "▶", label: "Run File", action: runFile },
    { icon: "✨", label: "Format Code", action: formatCode },
    { icon: "🔍", label: "Go to Line…", action: () => setGotoOpen(true) },
    { icon: "⚙️", label: "Settings", action: () => setSettingsOpen(true) },
    { icon: "⌨️", label: "Keyboard Shortcuts", action: () => setShortcutsOpen(true) },
    { icon: "📋", label: "Toggle Word Wrap", action: () => setSettings(s => ({ ...s, wordWrap: !s.wordWrap })) },
    { icon: "↻", label: "Refresh File Tree", action: loadTree },
    { icon: "⎇", label: "Git: Pull", action: gitPull },
    { icon: "⬆", label: "Git: Push", action: gitPush },
    { icon: "✕", label: "Close All Tabs", action: closeAllTabs },
  ], [settings.wordWrap]);

  // ── Breadcrumbs ────────────────────────────────────────────────────────────────
  function Breadcrumbs({ path }: { path: string }) {
    const parts = path.split("/").filter(Boolean);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, color: T.text3, overflow: "hidden", flexShrink: 0, flex: 1 }}>
        {parts.map((p, i) => (
          <span key={i} style={{ display: "flex", alignItems: "center", gap: 2, whiteSpace: "nowrap" }}>
            {i > 0 && <span style={{ color: T.text3, marginRight: 2 }}>›</span>}
            <span style={{ color: i === parts.length - 1 ? T.text1 : T.text3, cursor: i < parts.length - 1 ? "default" : undefined }}>{p}</span>
          </span>
        ))}
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ── RENDER ────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: T.bg0, color: T.text1, fontFamily: "system-ui,-apple-system,sans-serif", overflow: "hidden" }}>
      <Toaster position="bottom-right" theme="dark" toastOptions={{ style: { background: T.bg2, border: `1px solid ${T.border}`, color: T.text0 } }} />
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} allFiles={allFilePaths} recentFiles={recentFiles} onOpen={openFile} commands={paletteCommands} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onChange={setSettings} />
      <KeyboardShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <GotoLineDialog open={gotoOpen} onClose={() => setGotoOpen(false)} onGoto={gotoLine} maxLine={lineCount} />

      {/* Git Diff Overlay */}
      {showDiff && (
        <div style={{ position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", background: "#00000077", backdropFilter: "blur(4px)" }} onClick={() => setShowDiff(false)}>
          <div onClick={e => e.stopPropagation()} style={{ width: "80vw", height: "70vh", background: T.bg1, border: `1px solid ${T.borderLight}`, borderRadius: 12, overflow: "hidden", boxShadow: "0 24px 80px #000000cc", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: T.text0 }}>Git Diff</span>
              <button onClick={() => setShowDiff(false)} style={{ background: "none", border: "none", color: T.text2, cursor: "pointer", fontSize: 18 }}>×</button>
            </div>
            <pre style={{ flex: 1, overflowY: "auto", margin: 0, padding: "12px 16px", fontSize: 12, fontFamily: "monospace", whiteSpace: "pre-wrap", color: T.text1, lineHeight: 1.6 }}>
              {gitDiff.split("\n").map((l, i) => (
                <span key={i} style={{ display: "block", color: l.startsWith("+") && !l.startsWith("+++") ? T.green : l.startsWith("-") && !l.startsWith("---") ? T.red : l.startsWith("@@") ? T.blue : l.startsWith("diff") ? T.text0 : T.text2 }}>{l}</span>
              ))}
            </pre>
          </div>
        </div>
      )}

      {/* Tab context menu */}
      {tabCtx && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 999 }} onClick={() => setTabCtx(null)} />
          <div style={{ position: "fixed", top: tabCtx.y, left: tabCtx.x, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, zIndex: 1000, minWidth: 180, boxShadow: "0 8px 32px #000000aa", padding: "4px 0" }}>
            <CtxItem label="✕ Close Tab" onClick={() => { closeTab(tabCtx.path); setTabCtx(null); }} />
            <CtxItem label="✕ Close Others" onClick={() => { closeOtherTabs(tabCtx.path); setTabCtx(null); }} />
            <CtxItem label="✕ Close All" onClick={() => { closeAllTabs(); setTabCtx(null); }} />
            <div style={{ borderTop: `1px solid ${T.border}`, margin: "4px 0" }} />
            <CtxItem label="📋 Copy Path" onClick={() => { navigator.clipboard?.writeText(tabCtx.path); setTabCtx(null); toast.success("Path copied"); }} />
          </div>
        </>
      )}

      {/* ── Title Bar ─────────────────────────────────────────────────────────── */}
      <div style={{ height: 38, display: "flex", alignItems: "center", padding: "0 12px 0 0", background: T.bg1, borderBottom: `1px solid ${T.border}`, flexShrink: 0, gap: 8, zIndex: 100 }}>
        <div style={{ width: T.activityW, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: T.accent, letterSpacing: -0.5 }}>H</span>
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, color: T.text2, marginRight: 4 }}>Hayre IDE</span>
        {activeFile && <Breadcrumbs path={activeFile.path} />}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => setCmdOpen(true)} style={{ display: "flex", alignItems: "center", gap: 6, background: T.bg3, border: `1px solid ${T.border}`, color: T.text2, borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12 }}
            onMouseEnter={e => e.currentTarget.style.background = "#ffffff10"}
            onMouseLeave={e => e.currentTarget.style.background = T.bg3}>
            <span style={{ fontSize: 11 }}>⌘P</span>
            <span>Search…</span>
          </button>
          {activeFile && !activeFile.binary && (
            <>
              <IdeBtn onClick={() => saveFile()} title="Save (⌘S)" active={saving || autoSaving}>
                {autoSaving ? "⟳" : saving ? "⟳" : "💾"} {saving ? "Saving…" : autoSaving ? "Saving…" : "Save"}
              </IdeBtn>
              <IdeBtn onClick={formatCode} title="Format (⌘⇧P)">✨ Format</IdeBtn>
            </>
          )}
          <IdeBtn onClick={runFile} title="Run (F5)" accent>▶ Run</IdeBtn>
          <IdeBtn onClick={() => setShowRight(v => !v)} title="AI Agent (⌘⇧A)" active={showRight}>🤖</IdeBtn>
          <IdeBtn onClick={() => setSettingsOpen(true)} title="Settings">⚙</IdeBtn>
        </div>
      </div>

      {/* ── Main Body ─────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* Activity Bar */}
        <div style={{ width: T.activityW, background: T.bg1, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", alignItems: "center", padding: "8px 0", gap: 4, flexShrink: 0, zIndex: 50 }}>
          {[
            { id: "explorer", icon: "📁", title: "Explorer (⌘B)" },
            { id: "search", icon: "🔍", title: "Search (⌘⇧F)" },
            { id: "git", icon: "⎇", title: "Git (⌘⇧G)" },
          ].map(item => (
            <button key={item.id} title={item.title}
              onClick={() => setActivity(v => v === item.id ? null : item.id as Activity)}
              style={{ width: 36, height: 36, borderRadius: 8, background: activity === item.id ? T.accentGlow : "transparent", border: activity === item.id ? `1px solid ${T.accent}30` : "1px solid transparent", color: activity === item.id ? T.accent : T.text3, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}
              onMouseEnter={e => { if (activity !== item.id) e.currentTarget.style.color = T.text1; }}
              onMouseLeave={e => { if (activity !== item.id) e.currentTarget.style.color = T.text3; }}>
              {item.icon}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button title="Settings (⚙)" onClick={() => setSettingsOpen(true)}
            style={{ width: 36, height: 36, borderRadius: 8, background: "transparent", border: "1px solid transparent", color: T.text3, cursor: "pointer", fontSize: 16 }}
            onMouseEnter={e => e.currentTarget.style.color = T.text1}
            onMouseLeave={e => e.currentTarget.style.color = T.text3}>⚙</button>
        </div>

        {/* Sidebar */}
        {hasSidebar && (
          <>
            <div style={{ width: sidebarW, minWidth: T.minSidebar, maxWidth: T.maxSidebar, background: T.bg1, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0 }}>
              {sidebarContent}
            </div>
            <div onMouseDown={onSidebarDrag} style={{ width: 4, background: "transparent", cursor: "col-resize", flexShrink: 0, zIndex: 10 }}
              onMouseEnter={e => e.currentTarget.style.background = T.accent + "44"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"} />
          </>
        )}

        {/* Editor + Bottom Panel */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

          {/* Tab Bar */}
          <div style={{ display: "flex", background: T.bg1, borderBottom: `1px solid ${T.border}`, overflowX: "auto", flexShrink: 0, minHeight: 36, alignItems: "stretch", scrollbarWidth: "none" }}>
            {openFiles.length === 0 && (
              <div style={{ display: "flex", alignItems: "center", padding: "0 14px", fontSize: 12, color: T.text3 }}>No files open</div>
            )}
            {openFiles.map(f => (
              <div key={f.path}
                onClick={() => setActiveTab(f.path)}
                onContextMenu={e => { e.preventDefault(); setTabCtx({ path: f.path, x: e.clientX, y: e.clientY }); }}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 12px", cursor: "pointer", borderRight: `1px solid ${T.border}`, whiteSpace: "nowrap", fontSize: 12, flexShrink: 0, background: f.path === activeTab ? T.bg2 : "transparent", color: f.path === activeTab ? T.text0 : T.text2, borderBottom: f.path === activeTab ? `2px solid ${T.accent}` : "2px solid transparent", transition: "all 0.1s", minWidth: 0, maxWidth: 180 }}>
                <span style={{ fontSize: 11 }}>{getFileIcon(f.name, false)}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {f.modified ? <span style={{ color: T.yellow }}>●</span> : ""} {f.name}
                </span>
                <span onClick={e => closeTab(f.path, e)} style={{ marginLeft: 2, color: T.text3, fontSize: 13, lineHeight: 1, padding: "1px 2px", borderRadius: 3 }}
                  onMouseEnter={e => { e.currentTarget.style.color = T.text0; e.currentTarget.style.background = T.bg3; }}
                  onMouseLeave={e => { e.currentTarget.style.color = T.text3; e.currentTarget.style.background = "transparent"; }}>×</span>
              </div>
            ))}
          </div>

          {/* Editor Area */}
          <div style={{ flex: 1, overflow: "hidden", minHeight: 0, position: "relative" }}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); saveFile(); } }}>
            {activeFile ? (
              preview === activeFile.path ? (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
                  <div style={{ padding: "4px 12px", background: T.bg1, borderBottom: `1px solid ${T.border}`, display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: T.text2 }}>🌐 Live Preview —</span>
                    <span style={{ fontSize: 11, color: T.text3, fontFamily: "monospace" }}>{activeFile.path}</span>
                    <div style={{ flex: 1 }} />
                    <button onClick={() => saveFile()} style={smallBtn()}>💾 Save</button>
                    <button onClick={() => setPreview(null)} style={smallBtn()}>← Editor</button>
                  </div>
                  <iframe key={activeFile.path + (activeFile.modified ? "-m" : "")}
                    src={`${API}/preview/${activeFile.path}`}
                    style={{ flex: 1, border: "none", background: "#fff" }}
                    title="Preview"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" />
                </div>
              ) : isImage(activeFile.name) ? (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: T.bg2, gap: 12 }}>
                  <img src={`${API}/preview/${activeFile.path}`} alt={activeFile.name}
                    style={{ maxWidth: "90%", maxHeight: "85%", objectFit: "contain", borderRadius: 8, boxShadow: "0 8px 32px #00000066" }} />
                  <div style={{ fontSize: 12, color: T.text3 }}>{activeFile.name}</div>
                </div>
              ) : (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
                  {/* Editor toolbar */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", background: T.bg1, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
                    {activeFile.name.endsWith(".html") && (
                      <button onClick={() => setPreview(activeFile.path)} style={smallBtn()}>👁 Preview</button>
                    )}
                    {activeFile.name.endsWith(".md") && (
                      <button onClick={() => setMdSplit(v => !v)} style={smallBtn(mdSplit)}>{mdSplit ? "◧ Editor" : "◫ Split"}</button>
                    )}
                    <div style={{ flex: 1 }} />
                    <button onClick={() => setSettings(s => ({ ...s, wordWrap: !s.wordWrap }))} title="Toggle Word Wrap"
                      style={smallBtn(settings.wordWrap)}>⇌ Wrap</button>
                    <span style={{ fontSize: 10, color: T.text3 }}>Ln {cursorPos.line}</span>
                    <span style={{ fontSize: 10, color: T.text3 }}>Col {cursorPos.col}</span>
                  </div>
                  {/* Editor + Markdown split */}
                  <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
                    <div ref={editorContainerRef} style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                      <CodeMirror
                        key={activeFile.path}
                        value={activeFile.content}
                        height={editorHeight ? `${editorHeight}px` : "100%"}
                        extensions={[
                          ...getLang(activeFile.name),
                          editorTheme,
                          ...(settings.wordWrap ? [EditorView.lineWrapping] : []),
                          EditorState.tabSize.of(settings.tabSize),
                        ]}
                        onChange={v => updateContent(activeFile.path, v)}
                        onCreateEditor={view => { editorViewRef.current = view; }}
                        onUpdate={update => {
                          if (update.selectionSet) {
                            const sel = update.state.selection.main;
                            const line = update.state.doc.lineAt(sel.head);
                            setCursorPos({ line: line.number, col: sel.head - line.from + 1 });
                          }
                        }}
                        theme="dark"
                        basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: true, bracketMatching: true, indentOnInput: true, highlightActiveLine: true, searchKeymap: true, historyKeymap: true, closeBrackets: true, drawSelection: true }} />
                    </div>
                    {activeFile.name.endsWith(".md") && mdSplit && (
                      <>
                        <div style={{ width: 1, background: T.border, flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                          <MdPreview text={activeFile.content} />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )
            ) : (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, color: T.text3 }}>
                <div style={{ fontSize: 44, filter: "grayscale(1) opacity(0.3)" }}>💻</div>
                <div style={{ fontSize: 17, color: T.text2, fontWeight: 600 }}>Hayre IDE</div>
                <div style={{ fontSize: 12, color: T.text3 }}>Open a file or ask the AI Agent</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 400, marginTop: 8 }}>
                  {[["Create a website", "Build me a beautiful landing page with HTML/CSS"],
                    ["Python app", "Create a Python CLI tool that converts CSV to JSON"],
                    ["React app", "Build a React todo app with localStorage persistence"],
                    ["Presentation", "Create a Reveal.js presentation about AI trends"]].map(([label, prompt]) => (
                    <button key={label}
                      onClick={() => { setShowRight(true); setAgentInput(prompt); }}
                      style={{ padding: "8px 16px", background: T.bg2, border: `1px solid ${T.border}`, color: T.text1, borderRadius: 8, cursor: "pointer", fontSize: 12, transition: "all 0.2s" }}
                      onMouseEnter={e => { e.currentTarget.style.background = T.bg3; e.currentTarget.style.borderColor = T.accent + "66"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = T.bg2; e.currentTarget.style.borderColor = T.border; }}>{label}</button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Drag handle for bottom panel */}
          {showBottom && (
            <div onMouseDown={onBottomDrag} style={{ height: 4, cursor: "row-resize", background: "transparent", flexShrink: 0 }}
              onMouseEnter={e => e.currentTarget.style.background = T.accent + "44"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"} />
          )}

          {/* Bottom Panel */}
          {showBottom && (
            <div style={{ height: bottomH, background: T.bg0, borderTop: `1px solid ${T.border}`, display: "flex", flexDirection: "column", flexShrink: 0 }}>
              {/* Bottom tab bar */}
              <div style={{ display: "flex", alignItems: "center", background: T.bg1, borderBottom: `1px solid ${T.border}`, flexShrink: 0, paddingLeft: 8, gap: 2 }}>
                {(["terminal", "output", "problems"] as BottomTab[]).map(tab => (
                  <button key={tab} onClick={() => setBottomTab(tab)}
                    style={{ padding: "6px 14px", background: "none", border: "none", borderBottom: bottomTab === tab ? `2px solid ${T.accent}` : "2px solid transparent", color: bottomTab === tab ? T.text0 : T.text2, cursor: "pointer", fontSize: 12, fontWeight: bottomTab === tab ? 600 : 400, textTransform: "capitalize" }}>
                    {tab === "terminal" ? "⚡ Terminal" : tab === "output" ? "📋 Output" : "⚠ Problems"}
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <button onClick={() => setShowBottom(false)} title="Close Panel (⌘`)" style={{ background: "none", border: "none", color: T.text3, cursor: "pointer", padding: "4px 8px", fontSize: 14 }}>×</button>
              </div>

              {/* Terminal */}
              {bottomTab === "terminal" && (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                  {/* Terminal session tabs */}
                  <div style={{ display: "flex", alignItems: "center", background: T.bg1, borderBottom: `1px solid ${T.border}`, padding: "0 4px", overflowX: "auto", flexShrink: 0, scrollbarWidth: "none" }}>
                    {termSessions.map(s => (
                      <div key={s.id} onClick={() => setActiveTermId(s.id)}
                        style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", cursor: "pointer", borderRadius: "4px 4px 0 0", fontSize: 11, background: s.id === activeTermId ? T.bg0 : "transparent", color: s.id === activeTermId ? T.text0 : T.text3, whiteSpace: "nowrap" }}>
                        <span>{s.running ? <span style={{ color: T.yellow }}>⟳</span> : "✓"}</span>
                        <span>{s.name}</span>
                        {termSessions.length > 1 && (
                          <span onClick={e => { e.stopPropagation(); removeTermSession(s.id); }}
                            style={{ color: T.text3, marginLeft: 2, fontSize: 12 }}
                            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = T.red}
                            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = T.text3}>×</span>
                        )}
                      </div>
                    ))}
                    <button onClick={addTermSession} title="New Terminal"
                      style={{ padding: "3px 8px", background: "none", border: "none", color: T.text3, cursor: "pointer", fontSize: 14, lineHeight: 1 }}
                      onMouseEnter={e => e.currentTarget.style.color = T.text0}
                      onMouseLeave={e => e.currentTarget.style.color = T.text3}>+</button>
                    <div style={{ flex: 1 }} />
                    <button onClick={clearTermSession} title="Clear" style={{ padding: "3px 8px", background: "none", border: "none", color: T.text3, cursor: "pointer", fontSize: 11 }}>🗑 Clear</button>
                  </div>
                  {/* Terminal output */}
                  <div style={{ flex: 1, overflowY: "auto", padding: "8px 14px", fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: 12, lineHeight: 1.6 }}>
                    {(!activeSession || activeSession.history.length === 0) && (
                      <div style={{ color: T.text3, fontSize: 12 }}>Terminal ready. Type a command below.</div>
                    )}
                    {activeSession?.history.map(entry => (
                      <div key={entry.id} style={{ marginBottom: 8 }}>
                        <div style={{ color: T.accent }}>$ {entry.command}</div>
                        {entry.output && <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", color: T.text1 }}>{entry.output}</pre>}
                        {entry.error && <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", color: T.red }}>{entry.error}</pre>}
                        {entry.running && <span style={{ color: T.yellow, fontSize: 11 }}>⟳ running…</span>}
                      </div>
                    ))}
                    <div ref={termEndRef} />
                  </div>
                  {/* Terminal input */}
                  <div style={{ display: "flex", alignItems: "center", borderTop: `1px solid ${T.border}`, padding: "6px 10px", gap: 8, flexShrink: 0 }}>
                    <span style={{ color: T.accent, fontSize: 12, fontFamily: "monospace" }}>$</span>
                    <input
                      value={termInput}
                      onChange={e => setTermInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") runTermCmd();
                        if (e.key === "ArrowUp") { e.preventDefault(); const idx = Math.min(cmdHistIdx + 1, cmdHistory.length - 1); setCmdHistIdx(idx); setTermInput(cmdHistory[idx] ?? ""); }
                        if (e.key === "ArrowDown") { e.preventDefault(); const idx = Math.max(cmdHistIdx - 1, -1); setCmdHistIdx(idx); setTermInput(cmdHistory[idx] ?? ""); }
                        if (e.key === "l" && e.ctrlKey) clearTermSession();
                      }}
                      placeholder="Enter command… (↑↓ history)"
                      style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: T.text0, fontSize: 12, fontFamily: "'JetBrains Mono','Fira Code',monospace" }} />
                  </div>
                </div>
              )}

              {/* Output */}
              {bottomTab === "output" && (
                <div style={{ flex: 1, overflowY: "auto", padding: "8px 14px", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }}>
                  {outputLog.length === 0 && <div style={{ color: T.text3 }}>No output yet. Run a command or file.</div>}
                  {outputLog.map((l, i) => <div key={i} style={{ color: T.text2, whiteSpace: "pre-wrap", marginBottom: 2 }}>{l}</div>)}
                </div>
              )}

              {/* Problems */}
              {bottomTab === "problems" && (
                <div style={{ flex: 1, overflowY: "auto", padding: "8px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.text3, fontSize: 12 }}>
                    <span style={{ color: T.green }}>✓</span>
                    <span>No problems detected.</span>
                  </div>
                  <div style={{ marginTop: 12, fontSize: 11, color: T.text3 }}>
                    Run your code to see errors here, or open a TypeScript file for type errors.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Show terminal toggle when bottom panel is hidden */}
          {!showBottom && (
            <div onClick={() => setShowBottom(true)}
              style={{ height: 24, background: T.bg1, borderTop: `1px solid ${T.border}`, display: "flex", alignItems: "center", paddingLeft: 12, cursor: "pointer", fontSize: 11, color: T.text3 }}
              onMouseEnter={e => e.currentTarget.style.color = T.text0}
              onMouseLeave={e => e.currentTarget.style.color = T.text3}>
              ⚡ Terminal (⌘`)
            </div>
          )}
        </div>

        {/* Right AI Agent Panel */}
        {showRight && (
          <>
            <div onMouseDown={onRightDrag} style={{ width: 4, background: "transparent", cursor: "col-resize", flexShrink: 0 }}
              onMouseEnter={e => e.currentTarget.style.background = T.accent + "44"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"} />
            <div style={{ width: rightW, background: T.bg1, borderLeft: `1px solid ${T.border}`, display: "flex", flexDirection: "column", flexShrink: 0 }}>
              {/* Agent header */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 16 }}>🤖</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.text0 }}>Hayre Agent</span>
                  <span style={{ fontSize: 10, background: T.accentGlow, color: T.accent, padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>GPT-5</span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => { setAgentMsgs([]); setConversation([]); }} title="Clear chat" style={{ background: "none", border: "none", color: T.text3, cursor: "pointer", fontSize: 12 }}>Clear</button>
                  <button onClick={() => setShowRight(false)} style={{ background: "none", border: "none", color: T.text3, cursor: "pointer", fontSize: 18 }}>×</button>
                </div>
              </div>
              {/* Messages */}
              <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
                {agentMsgs.length === 0 && (
                  <div style={{ textAlign: "center", padding: "24px 0", color: T.text3, fontSize: 13 }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>✨</div>
                    <div style={{ color: T.text2, marginBottom: 14 }}>I actually BUILD things</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {[["🌐", "Create a website", "Build me a modern portfolio site"],
                        ["🐍", "Python app", "Write a Python script to scrape news headlines"],
                        ["📊", "Data chart", "Create a bar chart of top programming languages"],
                        ["📑", "Presentation", "Make a Reveal.js deck about machine learning"],
                        ["📄", "Document", "Write a technical spec for a REST API"],
                        ["⚛", "React app", "Build a React notes app with dark mode"]].map(([icon, label, prompt]) => (
                        <button key={label} onClick={() => setAgentInput(prompt)}
                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, cursor: "pointer", width: "100%", textAlign: "left", color: T.text1, fontSize: 12, transition: "all 0.2s" }}
                          onMouseEnter={e => { e.currentTarget.style.background = T.bg3; e.currentTarget.style.borderColor = T.accent + "44"; }}
                          onMouseLeave={e => { e.currentTarget.style.background = T.bg2; e.currentTarget.style.borderColor = T.border; }}>
                          <span>{icon}</span><span>{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {agentMsgs.map(msg => (
                  <div key={msg.id} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: msg.role === "user" ? T.blue : T.accent, fontWeight: 600 }}>{msg.role === "user" ? "You" : "Hayre"}</span>
                      {msg.streaming && <span style={{ fontSize: 10, color: T.yellow }}>⟳ working…</span>}
                    </div>
                    {msg.toolCalls?.map(tc => <ToolCallCard key={tc.id} tc={tc} />)}
                    {msg.content && (
                      <div style={{ fontSize: 13, color: T.text1, lineHeight: 1.6, whiteSpace: "pre-wrap", background: msg.role === "user" ? T.bg3 : "transparent", borderRadius: 8, padding: msg.role === "user" ? "8px 10px" : 0 }}>
                        {msg.content}
                      </div>
                    )}
                  </div>
                ))}
                <div ref={agentEndRef} />
              </div>
              {/* Agent input */}
              <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.border}`, flexShrink: 0 }}>
                <textarea
                  value={agentInput}
                  onChange={e => setAgentInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAgent(); } }}
                  placeholder={agentRunning ? "Agent is working…" : "Ask me to create anything… Enter to send, Shift+Enter for newline"}
                  disabled={agentRunning}
                  rows={3}
                  style={{ width: "100%", background: T.bg3, border: `1px solid ${T.border}`, color: T.text0, fontSize: 12, padding: "10px 12px", borderRadius: 8, outline: "none", resize: "none", fontFamily: "inherit", boxSizing: "border-box", lineHeight: 1.5 }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                  <span style={{ fontSize: 10, color: T.text3 }}>↵ send · ⇧↵ newline</span>
                  <button onClick={sendAgent} disabled={agentRunning || !agentInput.trim()}
                    style={{ padding: "6px 18px", background: agentRunning ? T.bg3 : T.accent, color: agentRunning ? T.text3 : "#000", border: "none", borderRadius: 8, cursor: agentRunning ? "default" : "pointer", fontSize: 12, fontWeight: 700, transition: "all 0.2s" }}>
                    {agentRunning ? "⟳" : "Send →"}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Status Bar ──────────────────────────────────────────────────────────── */}
      <div style={{ height: 24, background: T.bg1, borderTop: `1px solid ${T.border}`, display: "flex", alignItems: "center", padding: "0 12px", gap: 16, flexShrink: 0, fontSize: 11 }}>
        <span style={{ color: T.accent, cursor: "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }} onClick={() => setActivity("git")} title="Git branch">
          ⎇ {gitBranch}
        </span>
        {openFiles.filter(f => f.modified).length > 0 && (
          <span style={{ color: T.yellow }} title="Unsaved files">● {openFiles.filter(f => f.modified).length} unsaved</span>
        )}
        <div style={{ flex: 1 }} />
        {autoSaving && <span style={{ color: T.text3 }}>⟳ auto-saving…</span>}
        {activeFile && !activeFile.binary && (
          <>
            <span style={{ color: T.text2 }}>Ln {cursorPos.line}, Col {cursorPos.col}</span>
            <span style={{ color: T.text2 }}>{lineCount} lines</span>
            <span style={{ color: T.text2 }}>{langLabel(activeFile.name)}</span>
            <span style={{ color: T.text2 }}>UTF-8</span>
            <span style={{ color: T.text2 }}>Spaces: {settings.tabSize}</span>
          </>
        )}
        <button onClick={() => setShortcutsOpen(true)} style={{ background: "none", border: "none", color: T.text3, cursor: "pointer", fontSize: 11 }} title="Keyboard shortcuts (F1)">⌨</button>
        <button onClick={() => setShowRight(v => !v)} style={{ padding: "1px 8px", background: showRight ? T.accentGlow : "transparent", border: `1px solid ${showRight ? T.accent + "44" : "transparent"}`, color: showRight ? T.accent : T.text3, cursor: "pointer", borderRadius: 4, fontSize: 11 }}>🤖 Agent</button>
      </div>
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function smallBtn(active = false): React.CSSProperties {
  return { fontSize: 11, background: active ? T.accentGlow : "transparent", border: `1px solid ${active ? T.accent + "44" : T.border}`, color: active ? T.accent : T.text2, borderRadius: 4, padding: "2px 8px", cursor: "pointer", transition: "all 0.15s" };
}

function IdeBtn({ children, onClick, title, active, accent }: { children: React.ReactNode; onClick: () => void; title?: string; active?: boolean; accent?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", background: accent ? T.accent : active || hover ? T.bg3 : "transparent", border: `1px solid ${accent ? T.accent : active ? T.accent + "44" : T.border}`, color: accent ? "#000" : active ? T.accent : T.text1, borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: accent ? 700 : 500, transition: "all 0.15s" }}>
      {children}
    </button>
  );
}
