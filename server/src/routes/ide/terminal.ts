import { Router } from "express";
import { spawn } from "child_process";
import * as path from "path";
import { WORKSPACE_ROOT } from "./fs.js";

const router = Router();
const MAX_OUTPUT = 100_000;

function trimOutput(s: string): string {
  return s.length > MAX_OUTPUT ? `...[truncated]...\n${s.slice(-MAX_OUTPUT)}` : s;
}

// ── Request/response exec (for quick commands) ─────────────────────────────
router.post("/exec", async (req, res) => {
  const { command, cwd, timeout_ms = 30_000 } = req.body;
  if (!command) return res.status(400).json({ error: "command required" });

  const workdir = cwd
    ? path.resolve(WORKSPACE_ROOT, cwd.replace(/^\/+/, ""))
    : WORKSPACE_ROOT;

  try {
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve) => {
        let stdout = "";
        let stderr = "";
        const proc = spawn("bash", ["-c", command], {
          cwd: workdir,
          env: { ...process.env, HOME: process.env.REPL_HOME || "/home/runner" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve({ stdout: trimOutput(stdout), stderr: `Timed out after ${timeout_ms}ms\n${stderr}`, exitCode: -1 });
        }, Math.min(Number(timeout_ms), 120_000));
        proc.on("close", (code) => {
          clearTimeout(timer);
          resolve({ stdout: trimOutput(stdout), stderr: trimOutput(stderr), exitCode: code ?? 0 });
        });
      }
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Streaming exec (SSE — real-time output) ────────────────────────────────
router.post("/stream", (req, res) => {
  const { command, cwd } = req.body;
  if (!command) { res.status(400).json({ error: "command required" }); return; }

  const workdir = cwd
    ? path.resolve(WORKSPACE_ROOT, cwd.replace(/^\/+/, ""))
    : WORKSPACE_ROOT;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (type: string, data: string) =>
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);

  let proc: ReturnType<typeof spawn> | null = null;

  try {
    proc = spawn("bash", ["-c", command], {
      cwd: workdir,
      env: { ...process.env, HOME: process.env.REPL_HOME || "/home/runner" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout!.on("data", (d: Buffer) => send("stdout", d.toString()));
    proc.stderr!.on("data", (d: Buffer) => send("stderr", d.toString()));

    const timer = setTimeout(() => {
      proc?.kill("SIGKILL");
      send("stderr", "\n[Process timed out after 120s]\n");
      send("exit", "-1");
      res.end();
    }, 120_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      send("exit", String(code ?? 0));
      res.end();
    });
  } catch (err: any) {
    send("stderr", err.message);
    send("exit", "-1");
    res.end();
  }

  req.on("close", () => { proc?.kill("SIGKILL"); });
});

export default router;
