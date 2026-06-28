import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { securityHeaders } from "./middleware/securityHeaders";
import { requestId } from "./middleware/requestId";
import { metricsMiddleware } from "./middleware/metricsMiddleware";
import { appCheckMiddleware } from "./middleware/appCheck";

const app: Express = express();

app.use(requestId);
app.use(securityHeaders);
app.use(metricsMiddleware);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          hasAuth: !!req.headers?.authorization,
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// CORS — controlled via ALLOWED_ORIGINS env var (comma-separated).
// In dev (not set) → allows all origins.
// In production → set ALLOWED_ORIGINS=https://yourdomain.com
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : null;

app.use(
  cors({
    origin: allowedOrigins ?? true,
    credentials: true,
  }),
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(appCheckMiddleware);

app.use("/api", router);

export default app;
