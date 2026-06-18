import { Router } from "express";
import fsRouter, { previewRouter } from "./fs.js";
import terminalRouter from "./terminal.js";
import agentRouter from "./agent.js";

const router = Router();
router.use("/fs", fsRouter);
router.use("/preview", previewRouter);
router.use("/terminal", terminalRouter);
router.use("/agent", agentRouter);

export default router;
