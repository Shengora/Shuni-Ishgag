import { Router, type IRouter } from "express";
import healthRouter from "./health";
import adminsRouter from "./admins";
import statsRouter from "./stats";
import { requireApiToken } from "../middleware/apiAuth.js";

const router: IRouter = Router();

router.use(healthRouter);

// Admin and stats routes require a valid API token
router.use("/admins", requireApiToken, adminsRouter);
router.use("/stats", requireApiToken, statsRouter);

export default router;
