import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import cliRouter from "./cli/index.js";
import ideRouter from "./ide/index.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/cli", cliRouter);
router.use("/ide", ideRouter);

export default router;
