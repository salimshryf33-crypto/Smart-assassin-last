import { Router, type IRouter } from "express";
import healthRouter from "./health";
import curriculumRouter from "./curriculum";
import geminiRouter from "./gemini";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use('/curriculum', curriculumRouter);
router.use('/gemini', geminiRouter);
router.use('/admin', adminRouter);

export default router;
