import { Router } from "express";
import sessionsRouter from "./sessions.js";
import gitRouter from "./git.js";

const router = Router();
router.use("/sessions", sessionsRouter);
router.use("/git", gitRouter);

export default router;
