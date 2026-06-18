import { Router } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { generateImageBuffer } from "@workspace/integrations-openai-ai-server/image";
import * as fsP from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import { WORKSPACE_ROOT } from "./fs.js";

const router = Router();

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCallObj[];
  tool_call_id?: string;
};

type ToolCallObj = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

const IDE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_directory",
      description: "List files and directories at a given path in the workspace. Use '.' for workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to workspace root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the full contents of a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the given content. Parent directories are created automatically. Use this to build complete, working files — HTML, CSS, JS, Python, Markdown, JSON, etc.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root (e.g. 'my-site/index.html')" },
          content: { type: "string", description: "Full file content — write complete, working code" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_directory",
      description: "Create a directory (and any necessary parent directories).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to workspace root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_path",
      description: "Delete a file or directory (recursively).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_command",
      description: "Execute a shell command in the workspace. Use for: npm/pip/pnpm install, running scripts, git operations, compiling code, running servers, creating zip files, converting files. Returns stdout, stderr, and exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute via bash" },
          cwd: { type: "string", description: "Working directory relative to workspace root (optional)" },
          timeout_ms: { type: "number", description: "Timeout milliseconds (default 30000, max 120000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_web",
      description: "Search the web for documentation, APIs, libraries, tutorials, or current information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "generate_image",
      description: "Generate an AI image and save it as a PNG file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed image description" },
          save_path: { type: "string", description: "File path relative to workspace root (e.g. 'assets/hero.png')" },
          size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536"], description: "Image size" },
        },
        required: ["prompt", "save_path"],
      },
    },
  },
];

function safePath(rel: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, rel.replace(/^\/+/, ""));
  if (!resolved.startsWith(WORKSPACE_ROOT)) throw new Error("Path traversal denied");
  return resolved;
}

async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "list_directory": {
      const abs = safePath(args.path || ".");
      const entries = await fsP.readdir(abs, { withFileTypes: true });
      const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".pnpm"]);
      const filtered = entries.filter(e => !IGNORE.has(e.name));
      if (filtered.length === 0) return "(empty directory)";
      return filtered.map(e => `${e.isDirectory() ? "[DIR] " : "[FILE]"} ${e.name}`).join("\n");
    }

    case "read_file": {
      const abs = safePath(args.path);
      const stat = await fsP.stat(abs);
      if (stat.size > 2 * 1024 * 1024) return "File too large (>2MB). Use run_command with head/tail/grep.";
      return await fsP.readFile(abs, "utf8");
    }

    case "write_file": {
      const abs = safePath(args.path);
      await fsP.mkdir(path.dirname(abs), { recursive: true });
      await fsP.writeFile(abs, args.content, "utf8");
      return `✓ Created ${args.path} (${args.content.length} chars)`;
    }

    case "create_directory": {
      await fsP.mkdir(safePath(args.path), { recursive: true });
      return `✓ Directory created: ${args.path}`;
    }

    case "delete_path": {
      await fsP.rm(safePath(args.path), { recursive: true, force: true });
      return `✓ Deleted: ${args.path}`;
    }

    case "run_command": {
      const cwd = args.cwd ? safePath(args.cwd) : WORKSPACE_ROOT;
      const timeout = Math.min(Number(args.timeout_ms || 30_000), 120_000);
      return await new Promise<string>((resolve) => {
        let stdout = "";
        let stderr = "";
        const proc = spawn("bash", ["-c", args.command], {
          cwd,
          env: { ...process.env, HOME: process.env.REPL_HOME || "/home/runner" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve(`TIMEOUT after ${timeout}ms\nstdout: ${stdout.slice(-2000)}\nstderr: ${stderr.slice(-1000)}`);
        }, timeout);
        proc.on("close", (code) => {
          clearTimeout(timer);
          const parts: string[] = [`exit: ${code}`];
          if (stdout) parts.push(`stdout:\n${stdout.slice(-6000)}`);
          if (stderr) parts.push(`stderr:\n${stderr.slice(-2000)}`);
          resolve(parts.join("\n"));
        });
      });
    }

    case "search_web": {
      try {
        const q = encodeURIComponent(args.query);
        const resp = await fetch(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`, {
          headers: { "User-Agent": "HayreIDE/1.0" },
        });
        const data = await resp.json() as any;
        const parts: string[] = [];
        if (data.AbstractText) parts.push(`📖 ${data.AbstractText}`);
        if (data.Answer) parts.push(`✅ ${data.Answer}`);
        if (data.RelatedTopics?.length) {
          data.RelatedTopics.slice(0, 6).forEach((t: any) => {
            if (t.Text) parts.push(`• ${t.Text}`);
          });
        }
        return parts.join("\n") || "No results. Try a more specific query.";
      } catch (err: any) {
        return `Search failed: ${err.message}`;
      }
    }

    case "generate_image": {
      const size = (args.size || "1024x1024") as "1024x1024" | "1536x1024" | "1024x1536";
      const buffer = await generateImageBuffer(args.prompt, size);
      const abs = safePath(args.save_path);
      await fsP.mkdir(path.dirname(abs), { recursive: true });
      await fsP.writeFile(abs, buffer);
      return `✓ Image generated and saved to ${args.save_path} (${(buffer.length / 1024).toFixed(1)}KB)`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

const SYSTEM_PROMPT = `You are Hayre, a fully autonomous AI IDE agent with real access to the workspace filesystem and shell.

CRITICAL RULES:
1. ALWAYS take real action. When asked to create anything (website, app, doc, presentation, image, script), use write_file and run_command to actually create the files. Never just describe — always execute.
2. Use multiple tool calls to build complete, working solutions.
3. Write complete, production-quality code — no placeholders or TODOs.
4. After completing tasks, briefly summarize what was created.

CAPABILITIES YOU MUST USE:
- Websites: write_file for HTML/CSS/JS (create self-contained or multi-file sites)
- React/Vue/Node apps: run_command with create commands, then write files
- Word documents: write well-structured Markdown .md files (or HTML docs)
- Presentations/PPT: write complete Reveal.js HTML slide decks (self-contained, beautiful)
- Python scripts/apps: write_file then run_command to execute
- Data analysis: write Python with pandas/matplotlib, run it, show results
- Images: generate_image tool, then embed in HTML if needed
- APIs: write Express/FastAPI server files, run them
- Git: run_command with git commands
- Install packages: run_command with npm install / pip install / pnpm add
- Web search: search_web for docs, libraries, current info
- Bash scripts: write_file + chmod + run

WORKSPACE: /home/runner/workspace — all paths relative to this.
PRESENTATION STYLE: For slide decks, create reveal.js HTML. Include embedded CSS for beautiful dark themes.
DOCUMENT STYLE: For docs, create well-structured Markdown or styled HTML with table of contents.`;

router.post("/chat", async (req, res) => {
  const { messages: userMessages } = req.body as {
    messages: Array<{ role: string; content: string }>;
  };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...userMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    for (let iter = 0; iter < 25; iter++) {
      const stream = await openai.chat.completions.create({
        model: "gpt-5.1",
        messages: messages as any,
        tools: IDE_TOOLS as any,
        tool_choice: "auto",
        stream: true,
        max_completion_tokens: 8192,
      });

      let assistantContent = "";
      const toolCallMap = new Map<number, ToolCallObj>();

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta as any;

        if (delta.content) {
          assistantContent += delta.content;
          send({ type: "text", content: delta.content });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallMap.has(tc.index)) {
              toolCallMap.set(tc.index, { id: "", type: "function", function: { name: "", arguments: "" } });
            }
            const t = toolCallMap.get(tc.index)!;
            if (tc.id) t.id = tc.id;
            if (tc.function?.name) t.function.name += tc.function.name;
            if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
          }
        }
      }

      const toolCalls = [...toolCallMap.values()].filter(tc => tc.function.name);

      messages.push({
        role: "assistant",
        content: assistantContent || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      if (toolCalls.length === 0) break;

      for (const tc of toolCalls) {
        let args: Record<string, any> = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}

        send({ type: "tool_call", id: tc.id, name: tc.function.name, args });

        let result: string;
        try {
          result = await executeTool(tc.function.name, args);
        } catch (err: any) {
          result = `Error: ${err.message}`;
        }

        send({ type: "tool_result", id: tc.id, name: tc.function.name, result: result.slice(0, 8000) });

        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }
  } catch (err: any) {
    send({ type: "error", message: err.message });
  }

  send({ type: "done" });
  res.end();
});

export default router;
