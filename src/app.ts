import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { apiRoutes } from "./routes";
import { syncAssetsRoutes } from "./routes/sync-assets/sync-assets.route";
import { authPlugin } from "./plugins/auth";
import { adminGuardPlugin } from "./plugins/adminGuard";
import { registerErrorHandlers } from "./plugins/error-handler";
import { registerChatWebSocket } from "./services/chat-ws.service";
import { registerSupportWebSocket } from "./services/support/support-ws.service";
import { recordRequestMetric } from "./services/health-metrics.service";
import { sendResponse } from "./utils/response";
import fs from "fs";
import path from "path";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://weebin.site",
  "https://www.weebin.site",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

function allowedCorsOrigins() {
  const raw = process.env.CORS_ALLOWED_ORIGINS?.trim();
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isAllowedCorsOrigin(origin: string | undefined) {
  if (!origin) return true;

  const allowed = new Set(allowedCorsOrigins());
  if (allowed.has(origin)) return true;

  try {
    const parsed = new URL(origin);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

export function buildApp() {
  const app = Fastify({
    trustProxy: true,
    logger: {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
          singleLine: true,
        },
      },
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "OPTIONS" || !request.url.startsWith("/api/signals")) {
      return;
    }

    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
      .header("Access-Control-Allow-Headers", "*")
      .status(204)
      .send();
  });

  app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAllowedCorsOrigin(origin));
    },
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-guest-watch-id"],
  });

  app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 1,
    },
  });

  app.register(authPlugin);
  app.register(adminGuardPlugin);

  app.addHook("onRoute", (routeOptions) => {
    const rawMethods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];

    const methods = rawMethods.filter((method) => method !== "HEAD");

    if (methods.length === 0) return;

    app.log.info(`[ROUTE] ${methods.join(", ")} ${routeOptions.url}`);
  });

  app.addHook("onResponse", async (request, reply) => {
    recordRequestMetric(request, reply);
  });

  app.get("/", async (_request, reply) =>
    sendResponse(reply, {
      message: "Starter API is running",
      data: {
        service: "api-movie-list",
      },
    }),
  );
  app.get("/progress", (_request, reply) => {
    const html = fs.readFileSync(
      path.join(__dirname, "static", "progress.html"),
    );
    return reply.type("text/html").send(html);
  });

  app.register(syncAssetsRoutes, { prefix: "/sync-assets" });
  app.register(apiRoutes, { prefix: "/api" });
  registerChatWebSocket(app);
  registerSupportWebSocket(app);
  registerErrorHandlers(app);

  app.ready(() => {
    app.log.info(
      "Registered route tree:\n" +
        app.printRoutes({ includeMeta: false, commonPrefix: false }),
    );
  });

  return app;
}
