import dotenv from "dotenv";
import { buildApp } from "./app";
import { startTrendingRefreshJob } from "./services/trending.service";
import { startReminderJob } from "./jobs/reminder.job";

dotenv.config();

const app = buildApp();

async function start() {
  try {
    const port = Number(process.env.PORT || 3000);
    await app.listen({ port, host: "0.0.0.0" });
    startTrendingRefreshJob();
    startReminderJob();
    app.log.info(`Server running on http://localhost:${port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
