import { Router } from "express";
import * as fsP from "fs/promises";
import * as path from "path";

const router = Router();
export const WORKSPACE_ROOT = process.env.REPL_HOME || "/home/runner/workspace";

function safePath(rel: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, rel.replace(/^\/+/, ""));
  if (!resolved.startsWith(WORKSPACE_ROOT)) throw new Error("Path traversal denied");
  return resolved;
}

function relPath(abs: string): string {
  return path.relative(WORKSPACE_ROOT, abs) || ".";
}

type FileNode = {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
};

async function buildTree(dir: string, depth = 0): Promise<FileNode[]> {
  if (depth > 6) return [];
  const entries = await fsP.readdir(dir, { withFileTypes: true });
  const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".pnpm", "coverage"]);
  const nodes: FileNode[] = [];
  for (const e of entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  })) {
    if (IGNORE.has(e.name) || e.name.startsWith(".") && depth === 0) continue;
    const abs = path.join(dir, e.name);
    const node: FileNode = { name: e.name, path: relPath(abs), isDir: e.isDirectory() };
    if (e.isDirectory() && depth < 3) {
      try { node.children = await buildTree(abs, depth + 1); } catch { node.children = []; }
    }
    nodes.push(node);
  }
  return nodes;
}

router.get("/tree", async (req, res) => {
  try {
    const p = req.query.path as string || ".";
    const abs = safePath(p);
    const children = await buildTree(abs);
    res.json({ path: p, children });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/list", async (req, res) => {
  try {
    const p = req.query.path as string || ".";
    const abs = safePath(p);
    const entries = await fsP.readdir(abs, { withFileTypes: true });
    res.json(entries.map(e => ({
      name: e.name,
      path: relPath(path.join(abs, e.name)),
      isDir: e.isDirectory(),
    })));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/read", async (req, res) => {
  try {
    const p = req.query.path as string;
    if (!p) return res.status(400).json({ error: "path required" });
    const abs = safePath(p);
    const stat = await fsP.stat(abs);
    if (stat.size > 5 * 1024 * 1024) return res.status(400).json({ error: "File too large (>5MB)" });
    const content = await fsP.readFile(abs, "utf8");
    res.json({ path: p, content });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/write", async (req, res) => {
  try {
    const { path: p, content } = req.body;
    if (!p) return res.status(400).json({ error: "path required" });
    const abs = safePath(p);
    await fsP.mkdir(path.dirname(abs), { recursive: true });
    await fsP.writeFile(abs, content ?? "", "utf8");
    res.json({ ok: true, path: p });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/mkdir", async (req, res) => {
  try {
    const { path: p } = req.body;
    if (!p) return res.status(400).json({ error: "path required" });
    await fsP.mkdir(safePath(p), { recursive: true });
    res.json({ ok: true, path: p });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/delete", async (req, res) => {
  try {
    const p = req.query.path as string;
    if (!p) return res.status(400).json({ error: "path required" });
    const abs = safePath(p);
    await fsP.rm(abs, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/rename", async (req, res) => {
  try {
    const { from, to } = req.body;
    await fsP.rename(safePath(from), safePath(to));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/copy", async (req, res) => {
  try {
    const { from, to } = req.body;
    await fsP.copyFile(safePath(from), safePath(to));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

// ─── Static preview router (mounted separately at /preview) ──────────────────
// Serves workspace files at /api/ide/preview/<rel-path> so that relative
// asset references (./styles.css, ./script.js, ../img/logo.png) resolve
// correctly inside HTML preview iframes.

import { createReadStream, existsSync } from "fs";

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm:  "text/html; charset=utf-8",
  css:  "text/css; charset=utf-8",
  js:   "text/javascript; charset=utf-8",
  mjs:  "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  ts:   "text/plain; charset=utf-8",
  svg:  "image/svg+xml",
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  gif:  "image/gif",
  webp: "image/webp",
  ico:  "image/x-icon",
  woff: "font/woff",
  woff2:"font/woff2",
  ttf:  "font/ttf",
  mp4:  "video/mp4",
  webm: "video/webm",
  txt:  "text/plain; charset=utf-8",
  xml:  "application/xml",
};

export const previewRouter = Router();

previewRouter.use(async (req, res) => {
  try {
    const rel = req.path.replace(/^\/+/, "");
    const abs = path.resolve(WORKSPACE_ROOT, rel);
    if (!abs.startsWith(WORKSPACE_ROOT)) return res.status(403).send("Forbidden");
    if (!existsSync(abs)) return res.status(404).send("Not found");
    const ext = abs.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME[ext] ?? "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-cache");
    // Allow iframes from same origin
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    createReadStream(abs).pipe(res as any);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});
