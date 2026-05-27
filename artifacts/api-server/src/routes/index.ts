import { Router, type IRouter } from "express";
import healthRouter from "./health";
import curriculumRouter from "./curriculum";

const router: IRouter = Router();

router.use(healthRouter);
router.use('/curriculum', curriculumRouter);

export default router;
