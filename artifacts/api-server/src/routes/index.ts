import { Router, type IRouter } from "express";
import healthRouter from "./health";
import curriculumRouter from "./curriculum";
import geminiRouter from "./gemini";
import adminRouter from "./admin";
import examRouter from "./exam";
import examSolverRouter from "./examSolver";
import examGeneratorRouter from "./examGenerator";

const router: IRouter = Router();

router.use(healthRouter);
router.use('/curriculum', curriculumRouter);
router.use('/gemini', geminiRouter);
router.use('/admin', adminRouter);
router.use('/exams', examRouter);
router.use('/exams/solve', examSolverRouter);
router.use('/exams', examGeneratorRouter);

export default router;
