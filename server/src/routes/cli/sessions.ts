import { Router } from "express";
import { db } from "@workspace/db";
import { sessionsTable, messagesTable, memoryTable } from "@workspace/db";
import { eq, desc, count, sql } from "drizzle-orm";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import { openai } from "@workspace/integrations-openai-ai-server";

const execAsync = promisify(exec);
const router = Router();

const WORKSPACE_DIR = process.env.HOME || "/home/runner";

router.get("/", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: sessionsTable.id,
        name: sessionsTable.name,
        createdAt: sessionsTable.createdAt,
        updatedAt: sessionsTable.updatedAt,
        messageCount: count(messagesTable.id),
      })
      .from(sessionsTable)
      .leftJoin(messagesTable, eq(messagesTable.sessionId, sessionsTable.id))
      .groupBy(sessionsTable.id)
      .orderBy(desc(sessionsTable.updatedAt));
    res.json(rows.map(r => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      messageCount: Number(r.messageCount),
    })));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name } = req.body;
    const [session] = await db.insert(sessionsTable).values({ name }).returning();
    res.status(201).json({
      ...session,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messageCount: 0,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id));
    if (!session) return res.status(404).json({ error: "Not found" });
    const messages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, id))
      .orderBy(messagesTable.createdAt);
    res.json({
      ...session,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messages: messages.map(m => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get session" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(sessionsTable).where(eq(sessionsTable.id, id));
    res.status(204).end();
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

router.get("/:id/messages", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const messages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, id))
      .orderBy(messagesTable.createdAt);
    res.json(messages.map(m => ({ ...m, createdAt: m.createdAt.toISOString() })));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to list messages" });
  }
});

router.post("/:id/chat", async (req, res) => {
  const id = parseInt(req.params.id);
  const { content } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id));
    if (!session) {
      res.write(`data: ${JSON.stringify({ error: "Session not found" })}\n\n`);
      return res.end();
    }

    await db.insert(messagesTable).values({ sessionId: id, role: "user", content });

    const history = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, id))
      .orderBy(messagesTable.createdAt);

    const memories = await db.select().from(memoryTable).where(eq(memoryTable.sessionId, id));
    const memoryContext = memories.length > 0
      ? `\n\nSession memory:\n${memories.map(m => `${m.key}: ${m.value}`).join("\n")}`
      : "";

    const chatMessages = [
      {
        role: "system" as const,
        content: `You are HayreCLI, an advanced AI terminal agent — like Claude, Kimi, and the world's best coding assistants combined. You can help users:
- Chat and answer any question intelligently
- Explain how to run shell commands and what they do
- Read, write, and edit files
- Execute code in Python, JavaScript, TypeScript, Bash, Ruby, Go
- Browse the web and search for information
- Remember information across the session
- Plan and execute multi-step agent tasks

Be concise, direct, and technically precise. Use markdown formatting. ${memoryContext}`,
      },
      ...history.filter(m => m.role !== "system").map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

    let fullResponse = "";
    const stream = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
      messages: chatMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) {
        fullResponse += token;
        res.write(`data: ${JSON.stringify({ content: token })}\n\n`);
      }
    }

    await db.insert(messagesTable).values({ sessionId: id, role: "assistant", content: fullResponse });
    await db.update(sessionsTable)
      .set({ updatedAt: new Date() })
      .where(eq(sessionsTable.id, id));

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err: any) {
    req.log.error(err);
    res.write(`data: ${JSON.stringify({ error: String(err?.message || err) })}\n\n`);
    res.end();
  }
});

router.post("/:id/shell", async (req, res) => {
  const id = parseInt(req.params.id);
  const { command, cwd } = req.body;
  const start = Date.now();

  try {
    const safeCwd = cwd ? path.resolve(WORKSPACE_DIR, cwd.replace(/^\//, "")) : WORKSPACE_DIR;
    const { stdout, stderr } = await execAsync(command, {
      cwd: safeCwd,
      timeout: 30000,
      env: { ...process.env, HOME: WORKSPACE_DIR },
    });

    const result = { stdout: stdout || "", stderr: stderr || "", exitCode: 0, duration: Date.now() - start };

    await db.insert(messagesTable).values({
      sessionId: id,
      role: "tool",
      content: `$ ${command}\n${stdout || stderr}`,
      toolName: "shell",
      toolInput: command,
      toolOutput: stdout || stderr,
    });
    await db.update(sessionsTable).set({ updatedAt: new Date() }).where(eq(sessionsTable.id, id));

    res.json(result);
  } catch (err: any) {
    const result = {
      stdout: err.stdout || "",
      stderr: err.stderr || String(err.message),
      exitCode: err.code || 1,
      duration: Date.now() - start,
    };
    await db.insert(messagesTable).values({
      sessionId: id,
      role: "tool",
      content: `$ ${command}\n[Error] ${result.stderr}`,
      toolName: "shell",
      toolInput: command,
      toolOutput: result.stderr,
    });
    res.json(result);
  }
});

router.get("/:id/files", async (req, res) => {
  try {
    const dirPath = req.query.path
      ? path.resolve(WORKSPACE_DIR, String(req.query.path).replace(/^\//, ""))
      : WORKSPACE_DIR;

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (e) => {
        try {
          const stat = await fs.stat(path.join(dirPath, e.name));
          return {
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
            size: e.isFile() ? stat.size : null,
            modified: stat.mtime.toISOString(),
          };
        } catch {
          return { name: e.name, type: e.isDirectory() ? "directory" : "file", size: null, modified: null };
        }
      })
    );

    res.json({ path: dirPath, entries: items });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to list files" });
  }
});

router.post("/:id/files", async (req, res) => {
  const id = parseInt(req.params.id);
  const { path: filePath, content } = req.body;
  try {
    const fullPath = path.resolve(WORKSPACE_DIR, filePath.replace(/^\//, ""));
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    const stat = await fs.stat(fullPath);

    await db.insert(messagesTable).values({
      sessionId: id,
      role: "tool",
      content: `Wrote file: ${filePath} (${stat.size} bytes)`,
      toolName: "write_file",
      toolInput: filePath,
      toolOutput: `${stat.size} bytes`,
    });
    await db.update(sessionsTable).set({ updatedAt: new Date() }).where(eq(sessionsTable.id, id));

    res.json({ path: filePath, bytes: stat.size });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to write file" });
  }
});

router.post("/:id/files/read", async (req, res) => {
  const { path: filePath } = req.body;
  try {
    const fullPath = path.resolve(WORKSPACE_DIR, filePath.replace(/^\//, ""));
    const content = await fs.readFile(fullPath, "utf-8");
    const stat = await fs.stat(fullPath);
    res.json({ path: filePath, content, size: stat.size });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to read file" });
  }
});

router.post("/:id/execute", async (req, res) => {
  const id = parseInt(req.params.id);
  const { language, code } = req.body;
  const start = Date.now();

  const langCommands: Record<string, { ext: string; cmd: string }> = {
    python: { ext: "py", cmd: "python3" },
    javascript: { ext: "js", cmd: "node" },
    typescript: { ext: "ts", cmd: "npx ts-node" },
    bash: { ext: "sh", cmd: "bash" },
    ruby: { ext: "rb", cmd: "ruby" },
    go: { ext: "go", cmd: "go run" },
  };

  const lang = langCommands[language];
  if (!lang) return res.status(400).json({ error: `Unsupported language: ${language}` });

  const tmpFile = `/tmp/hayre_exec_${Date.now()}.${lang.ext}`;
  try {
    await fs.writeFile(tmpFile, code);
    const { stdout, stderr } = await execAsync(`${lang.cmd} ${tmpFile}`, { timeout: 30000 });
    const result = { stdout: stdout || "", stderr: stderr || "", exitCode: 0, duration: Date.now() - start };

    await db.insert(messagesTable).values({
      sessionId: id,
      role: "tool",
      content: `Executed ${language}:\n${stdout || stderr}`,
      toolName: "execute_code",
      toolInput: `${language}: ${code.substring(0, 200)}`,
      toolOutput: stdout || stderr,
    });
    await db.update(sessionsTable).set({ updatedAt: new Date() }).where(eq(sessionsTable.id, id));

    res.json(result);
  } catch (err: any) {
    const result = {
      stdout: err.stdout || "",
      stderr: err.stderr || String(err.message),
      exitCode: err.code || 1,
      duration: Date.now() - start,
    };
    res.json(result);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
});

router.post("/:id/browse", async (req, res) => {
  const id = parseInt(req.params.id);
  const { url, query, mode } = req.body;

  try {
    let content = "";
    let title: string | null = null;
    let finalUrl: string | null = null;

    if (mode === "search" && query) {
      const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const r = await fetch(searchUrl);
      const data: any = await r.json();
      const results = (data.RelatedTopics || [])
        .filter((t: any) => t.Text)
        .slice(0, 8)
        .map((t: any) => `• ${t.Text}${t.FirstURL ? `\n  URL: ${t.FirstURL}` : ""}`)
        .join("\n");
      content = results || `No results found for: "${query}"`;
      title = `Search: ${query}`;
      finalUrl = searchUrl;
    } else if (url) {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 HayreCLI/1.0" },
        signal: AbortSignal.timeout(15000),
      });
      const text = await r.text();
      const stripped = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .substring(0, 8000);
      content = stripped;
      const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
      title = titleMatch ? titleMatch[1].trim() : null;
      finalUrl = url;
    } else {
      return res.status(400).json({ error: "Provide url or query" });
    }

    await db.insert(messagesTable).values({
      sessionId: id,
      role: "tool",
      content: `Browsed: ${finalUrl}\n${content.substring(0, 500)}`,
      toolName: "browse",
      toolInput: url || query,
      toolOutput: content.substring(0, 500),
    });
    await db.update(sessionsTable).set({ updatedAt: new Date() }).where(eq(sessionsTable.id, id));

    res.json({ content, title, url: finalUrl });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to browse" });
  }
});

router.get("/:id/memory", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const entries = await db.select().from(memoryTable).where(eq(memoryTable.sessionId, id)).orderBy(memoryTable.createdAt);
    res.json(entries.map(e => ({ ...e, createdAt: e.createdAt.toISOString() })));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get memory" });
  }
});

router.post("/:id/memory", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { key, value } = req.body;
    const existing = await db.select().from(memoryTable).where(sql`${memoryTable.sessionId} = ${id} AND ${memoryTable.key} = ${key}`);
    let entry;
    if (existing.length > 0) {
      [entry] = await db.update(memoryTable).set({ value }).where(eq(memoryTable.id, existing[0].id)).returning();
    } else {
      [entry] = await db.insert(memoryTable).values({ sessionId: id, key, value }).returning();
    }
    res.json({ ...entry, createdAt: entry.createdAt.toISOString() });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to save memory" });
  }
});

router.post("/:id/agent", async (req, res) => {
  const id = parseInt(req.params.id);
  const { task, maxSteps = 10 } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    sendEvent({ type: "start", message: `Starting agent task: ${task}` });

    await db.insert(messagesTable).values({ sessionId: id, role: "user", content: `[AGENT TASK] ${task}` });

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "run_shell",
          description: "Run a shell command and return stdout/stderr",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "write_file",
          description: "Write content to a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "read_file",
          description: "Read content from a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "execute_code",
          description: "Execute code in python, javascript, bash, or typescript",
          parameters: {
            type: "object",
            properties: {
              language: { type: "string", enum: ["python", "javascript", "typescript", "bash"] },
              code: { type: "string" },
            },
            required: ["language", "code"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "browse_web",
          description: "Fetch a URL or search the web",
          parameters: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["fetch", "search"] },
              url: { type: "string" },
              query: { type: "string" },
            },
            required: ["mode"],
          },
        },
      },
    ];

    const agentMessages: any[] = [
      {
        role: "system",
        content: `You are HayreCLI, an autonomous agent. Complete the user's task by using your tools step by step. Be thorough but concise. Report each step clearly. When done, summarize what you accomplished.`,
      },
      { role: "user", content: task },
    ];

    let steps = 0;
    let running = true;

    while (running && steps < maxSteps) {
      steps++;
      sendEvent({ type: "thinking", step: steps });

      const response = await openai.chat.completions.create({
        model: "gpt-5.4",
        max_completion_tokens: 4096,
        messages: agentMessages,
        tools,
        tool_choice: "auto",
      });

      const choice = response.choices[0];
      agentMessages.push(choice.message);

      if (choice.finish_reason === "stop" || !choice.message.tool_calls?.length) {
        const finalContent = choice.message.content || "Task complete.";
        sendEvent({ type: "done", message: finalContent });
        await db.insert(messagesTable).values({ sessionId: id, role: "assistant", content: `[AGENT] ${finalContent}` });
        running = false;
        break;
      }

      for (const toolCall of choice.message.tool_calls || []) {
        const fn = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        sendEvent({ type: "tool_call", tool: fn, args });

        let toolResult = "";
        try {
          if (fn === "run_shell") {
            const { stdout, stderr } = await execAsync(args.command, { timeout: 30000, cwd: WORKSPACE_DIR }).catch(e => ({ stdout: e.stdout || "", stderr: e.stderr || e.message }));
            toolResult = stdout || stderr;
          } else if (fn === "write_file") {
            const fp = path.resolve(WORKSPACE_DIR, args.path.replace(/^\//, ""));
            await fs.mkdir(path.dirname(fp), { recursive: true });
            await fs.writeFile(fp, args.content);
            toolResult = `Written: ${args.path}`;
          } else if (fn === "read_file") {
            const fp = path.resolve(WORKSPACE_DIR, args.path.replace(/^\//, ""));
            toolResult = await fs.readFile(fp, "utf-8");
          } else if (fn === "execute_code") {
            const langMap: Record<string, { ext: string; cmd: string }> = {
              python: { ext: "py", cmd: "python3" },
              javascript: { ext: "js", cmd: "node" },
              typescript: { ext: "ts", cmd: "npx ts-node" },
              bash: { ext: "sh", cmd: "bash" },
            };
            const l = langMap[args.language];
            const tmp = `/tmp/agent_${Date.now()}.${l.ext}`;
            await fs.writeFile(tmp, args.code);
            const { stdout, stderr } = await execAsync(`${l.cmd} ${tmp}`, { timeout: 30000 }).catch(e => ({ stdout: e.stdout || "", stderr: e.stderr || e.message }));
            await fs.unlink(tmp).catch(() => {});
            toolResult = stdout || stderr;
          } else if (fn === "browse_web") {
            if (args.mode === "search") {
              const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1`);
              const d: any = await r.json();
              toolResult = (d.RelatedTopics || []).filter((t: any) => t.Text).slice(0, 5).map((t: any) => t.Text).join("\n");
            } else {
              const r = await fetch(args.url, { headers: { "User-Agent": "HayreCLI" }, signal: AbortSignal.timeout(15000) });
              const t = await r.text();
              toolResult = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 4000);
            }
          }
        } catch (e: any) {
          toolResult = `Error: ${e.message}`;
        }

        sendEvent({ type: "tool_result", tool: fn, result: toolResult.substring(0, 500) });

        agentMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
        });

        await db.insert(messagesTable).values({
          sessionId: id,
          role: "tool",
          content: `[${fn}] ${toolResult.substring(0, 500)}`,
          toolName: fn,
          toolInput: JSON.stringify(args).substring(0, 500),
          toolOutput: toolResult.substring(0, 500),
        });
      }
    }

    if (steps >= maxSteps) {
      sendEvent({ type: "done", message: "Reached maximum steps limit." });
    }

    await db.update(sessionsTable).set({ updatedAt: new Date() }).where(eq(sessionsTable.id, id));
    res.end();
  } catch (err: any) {
    req.log.error(err);
    sendEvent({ type: "error", message: String(err?.message || err) });
    res.end();
  }
});

router.post("/:id/complete", async (req, res) => {
  const id = parseInt(req.params.id);
  const { code, language = "python", cursor = "" } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a ${language} code completion assistant. The user has written partial code. Return ONLY the completion text to append at the cursor position — no explanation, no markdown fences, no repetition of existing code.`,
        },
        {
          role: "user",
          content: `Complete this ${language} code at the cursor:\n\n${code}${cursor ? `\n\n(cursor is after: ${cursor})` : ""}`,
        },
      ],
      max_tokens: 512,
    });
    res.json({ completion: response.choices[0]?.message?.content?.trim() || "" });
  } catch (err: any) {
    req.log.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;
