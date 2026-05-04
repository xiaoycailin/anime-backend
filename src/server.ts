import dotenv from "dotenv";

dotenv.config();

import { buildApp } from "./app";
import { startTrendingRefreshJob } from "./services/trending.service";
import { startReminderJob } from "./jobs/reminder.job";
import { startEncodingWorker } from "./services/video-pipeline.service";
import { startUrlUploadWorker } from "./services/url-upload-queue.service";
import { startYoutubeR2UploadWorker } from "./services/youtube-r2-upload-queue.service";
import { startUploadCleanupJob } from "./jobs/upload-cleanup.job";
import { startChatCleanupJob } from "./jobs/chat-cleanup.job";
import { closeRedis, redis, isRedisReady } from "./lib/redis";
import { setCacheLogger } from "./lib/cache";

const app = buildApp();
let redisDependentJobsStarted = false;

function startRedisDependentJobs() {
  if (redisDependentJobsStarted) return;
  redisDependentJobsStarted = true;
  startEncodingWorker();
  startUrlUploadWorker();
  startYoutubeR2UploadWorker();
  startChatCleanupJob({
    info: (msg) => app.log.info(msg),
    error: (msg, err) => app.log.error({ err }, msg),
  });
}

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
    startUploadCleanupJob({
      info: (msg) => app.log.info(msg),
      error: (msg, err) => app.log.error({ err }, msg),
    });
    if (isRedisReady()) {
      startRedisDependentJobs();
    } else {
      app.log.warn(
        { redisStatus: redis.status },
        "Redis belum ready; worker upload/video dan chat cleanup ditunda",
      );
      redis.once("ready", () => {
        app.log.info("Redis ready; starting Redis-dependent jobs");
        startRedisDependentJobs();
      });
    }
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
