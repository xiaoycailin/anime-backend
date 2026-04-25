import dotenv from "dotenv";

dotenv.config();

import { buildApp } from "./app";
import { startTrendingRefreshJob } from "./services/trending.service";
import { startReminderJob } from "./jobs/reminder.job";
import { closeRedis, redis } from "./lib/redis";
import { setCacheLogger } from "./lib/cache";

const app = buildApp();

setCacheLogger({
  info: (msg) => app.log.debug({ scope: "cache" }, msg),
  warn: (msg) => app.log.warn({ scope: "cache" }, msg),
  error: (msg, err) => app.log.error({ scope: "cache", err }, msg),
});

async function shutdown(signal: string) {
  app.log.info(`Received ${signal}, shutting down...`);
  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
  }
  await closeRedis();
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function start() {
  try {
    const port = Number(process.env.PORT || 3000);
    await app.listen({ port, host: "0.0.0.0" });
    startTrendingRefreshJob();
    startReminderJob();
    app.log.info(
      { redisStatus: redis.status },
      `Server running on http://localhost:${port}`,
    );
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
