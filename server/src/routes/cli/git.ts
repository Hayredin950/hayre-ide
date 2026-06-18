import { Router } from "express";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const router = Router({ mergeParams: true });

const WORKSPACE = process.env.REPL_HOME || "/home/runner/workspace";

async function git(cmd: string, cwd = WORKSPACE) {
  try {
    const { stdout, stderr } = await execAsync(`git ${cmd}`, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "HayreCLI",
        GIT_AUTHOR_EMAIL: "hayre@cli.local",
        GIT_COMMITTER_NAME: "HayreCLI",
        GIT_COMMITTER_EMAIL: "hayre@cli.local",
      },
    });
    return { output: stdout || stderr || "(no output)", error: false };
  } catch (e: any) {
    return { output: e.stderr || e.stdout || e.message, error: true };
  }
}

router.get("/status", async (req, res) => {
  res.json(await git("status"));
});

router.get("/log", async (req, res) => {
  const n = Math.min(Number(req.query.n) || 20, 100);
  res.json(await git(`log --oneline -n ${n} --graph --decorate`));
});

router.get("/diff", async (req, res) => {
  const { file, staged } = req.query as { file?: string; staged?: string };
  const stagedFlag = staged === "true" ? "--staged" : "";
  const fileArg = file ? `-- "${file}"` : "";
  res.json(await git(`diff ${stagedFlag} ${fileArg}`.trim()));
});

router.get("/branches", async (req, res) => {
  res.json(await git("branch -a"));
});

router.post("/add", async (req, res) => {
  const { files = "." } = req.body as { files?: string };
  res.json(await git(`add ${files}`));
});

router.post("/commit", async (req, res) => {
  const { message } = req.body as { message: string };
  if (!message) return res.status(400).json({ error: "message required" });
  const safe = message.replace(/"/g, '\\"').replace(/`/g, "\\`");
  res.json(await git(`commit -m "${safe}"`));
});

router.post("/checkout", async (req, res) => {
  const { branch, create } = req.body as { branch: string; create?: boolean };
  if (!branch) return res.status(400).json({ error: "branch required" });
  const flag = create ? "-b" : "";
  res.json(await git(`checkout ${flag} ${branch}`.trim()));
});

router.get("/stash", async (req, res) => {
  res.json(await git("stash list"));
});

router.post("/stash", async (req, res) => {
  const { action = "push" } = req.body as { action?: "push" | "pop" };
  res.json(await git(`stash ${action}`));
});

export default router;
