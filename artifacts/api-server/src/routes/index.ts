import { Router, type IRouter } from "express";
import healthRouter from "./health";
import campusRouter from "./campus";

const router: IRouter = Router();

router.use(healthRouter);
router.use(campusRouter);

export default router;
