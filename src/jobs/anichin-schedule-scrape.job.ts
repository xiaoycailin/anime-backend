import { redis } from "../lib/redis";
import { prisma } from "../lib/prisma";
import {
  getAnichinSchedule,
  type AnichinScheduleItem,
} from "../services/anichin-schedule.service";
import { createRoleNotification } from "../services/notification.service";
import { scrapeAnichinScheduleTarget } from "../services/scraper-service/scrapeAnichinScheduleTarget.service";

const JOB_INTERVAL_MS = 60 * 1000;
const RETRY_DELAY_SECONDS = 30 * 60;
const MAX_ATTEMPTS = 5;
const DUE_LOOKBACK_MS = 36 * 60 * 60 * 1000;
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

type JobState = {
  attempts: number;
  nextRunAt: string | null;
  completedAt: string | null;
  lastStatus: "pending" | "retrying" | "completed" | "exhausted" | "failed";
};

let timer: NodeJS.Timeout | null = null;
let isRunning = false;
let lastRunAt: Date | null = null;
let lastError: string | null = null;
let totalRuns = 0;
let totalItemsCompleted = 0;

function stateKey(item: AnichinScheduleItem) {
  const episodeKey =
    item.episodeNumber > 0
      ? `ep-${item.episodeNumber}`
      : `unknown-${item.scheduledAt.slice(0, 10)}`;
  return `anichin:schedule-job:${item.animeSlug}:${episodeKey}`;
}

function lockKey(item: AnichinScheduleItem) {
  return `${stateKey(item)}:lock`;
}

function parseState(raw: string | null): JobState {
  if (!raw) {
    return {
      attempts: 0,
      nextRunAt: null,
      completedAt: null,
      lastStatus: "pending",
    };
  }

  try {
    return JSON.parse(raw) as JobState;
  } catch {
    return {
      attempts: 0,
      nextRunAt: null,
      completedAt: null,
      lastStatus: "pending",
    };
  }
}

async function saveState(key: string, state: JobState) {
  await redis.set(key, JSON.stringify(state), "EX", STATE_TTL_SECONDS);
}

function isDue(item: AnichinScheduleItem, now: Date) {
  const scheduledAt = new Date(item.scheduledAt);
  const diff = now.getTime() - scheduledAt.getTime();
  return diff >= 0 && diff <= DUE_LOOKBACK_MS && item.animeSlug && item.sourceUrl;
}

function shouldRun(state: JobState, now: Date) {
  if (state.completedAt || state.lastStatus === "exhausted") return false;
  if (!state.nextRunAt) return true;
  return new Date(state.nextRunAt).getTime() <= now.getTime();
}

async function hasTargetEpisode(item: AnichinScheduleItem) {
  if (!item.animeSlug || item.episodeNumber <= 0) return false;

  const episode = await prisma.episode.findFirst({
    where: {
      number: item.episodeNumber,
      anime: { slug: item.animeSlug },
    },
    select: { id: true },
  });

  return Boolean(episode);
}

async function notifyAdmin(input: {
  title: string;
  message: string;
  item: AnichinScheduleItem;
  attempts: number;
  status: string;
}) {
  await createRoleNotification({
    role: "admin",
    category: "admin_operational",
    type: "anichin_schedule_job",
    title: input.title,
    message: input.message,
    link: "/admin/scraping-progress",
    topic: "admin-scraping",
    payload: {
      animeSlug: input.item.animeSlug,
      animeTitle: input.item.animeTitle,
      episodeNumber: input.item.episodeNumber,
      scheduledAt: input.item.scheduledAt,
      attempts: input.attempts,
      status: input.status,
      source: "anichin.schedule",
    },
  });
}

async function runItem(item: AnichinScheduleItem, now: Date) {
  const key = stateKey(item);
  const lock = await redis.set(lockKey(item), "1", "EX", 15 * 60, "NX");
  if (!lock) return;

  try {
    const state = parseState(await redis.get(key));
    if (state.completedAt || state.lastStatus === "exhausted") return;

    if (await hasTargetEpisode(item)) {
      const attempts = state.attempts;
      await saveState(key, {
        attempts,
        nextRunAt: null,
        completedAt: new Date().toISOString(),
        lastStatus: "completed",
      });
      totalItemsCompleted += 1;
      await notifyAdmin({
        title: "Job scraping Anichin selesai",
        message: `${item.animeTitle} sudah punya episode target, tidak perlu retry.`,
        item,
        attempts,
        status: "completed",
      });
      return;
    }

    if (!shouldRun(state, now)) return;

    const attempts = state.attempts + 1;
    await notifyAdmin({
      title: "Job scraping Anichin dijalankan",
      message: `Job scraping dijalankan untuk ${item.animeTitle} ${item.episode}. Percobaan ${attempts}/${MAX_ATTEMPTS}.`,
      item,
      attempts,
      status: "running",
    });

    const result = await scrapeAnichinScheduleTarget({
      animeTitle: item.animeTitle,
      animeSlug: item.animeSlug,
      sourceUrl: item.sourceUrl,
      episodeNumber: item.episodeNumber,
    });

    if (result.newEpisodesAdded > 0 || result.matchedEpisodes > 0) {
      await saveState(key, {
        attempts,
        nextRunAt: null,
        completedAt: new Date().toISOString(),
        lastStatus: "completed",
      });
      totalItemsCompleted += 1;
      await notifyAdmin({
        title: "Job scraping Anichin selesai",
        message:
          result.newEpisodesAdded > 0
            ? `${result.newEpisodesAdded} ep baru ditambahkan untuk ${result.animeTitle}.`
            : `${result.animeTitle} sudah punya episode target, tidak perlu retry.`,
        item,
        attempts,
        status: "completed",
      });
      return;
    }

    const exhausted = attempts >= MAX_ATTEMPTS;
    const nextRunAt = new Date(
      now.getTime() + RETRY_DELAY_SECONDS * 1000,
    ).toISOString();

    await saveState(key, {
      attempts,
      nextRunAt: exhausted ? null : nextRunAt,
      completedAt: exhausted ? new Date().toISOString() : null,
      lastStatus: exhausted ? "exhausted" : "retrying",
    });

    await notifyAdmin({
      title: exhausted
        ? "Job scraping Anichin berhenti"
        : "Job scraping Anichin retry dijadwalkan",
      message: exhausted
        ? `Tidak ada ep baru untuk ${item.animeTitle} setelah ${MAX_ATTEMPTS} percobaan.`
        : `Belum ada ep baru untuk ${item.animeTitle}. Retry ${attempts + 1}/${MAX_ATTEMPTS} akan jalan 30 menit lagi.`,
      item,
      attempts,
      status: exhausted ? "exhausted" : "retrying",
    });
  } catch (error) {
    const state = parseState(await redis.get(key));
    const attempts = Math.max(state.attempts + 1, 1);
    const exhausted = attempts >= MAX_ATTEMPTS;

    await saveState(key, {
      attempts,
      nextRunAt: exhausted
        ? null
        : new Date(now.getTime() + RETRY_DELAY_SECONDS * 1000).toISOString(),
      completedAt: exhausted ? new Date().toISOString() : null,
      lastStatus: exhausted ? "exhausted" : "failed",
    });

    await notifyAdmin({
      title: "Job scraping Anichin gagal",
      message: `${item.animeTitle}: ${(error as Error).message}. ${
        exhausted ? "Retry habis." : "Akan dicoba lagi 30 menit."
      }`,
      item,
      attempts,
      status: exhausted ? "exhausted" : "failed",
    });
  } finally {
    await redis.del(lockKey(item));
  }
}

export async function runAnichinScheduleScrapeJob() {
  if (isRunning) return;
  isRunning = true;

  try {
    totalRuns += 1;
    lastRunAt = new Date();
    const now = new Date();
    const schedule = await getAnichinSchedule();
    const dueItems = schedule.filter((item) => isDue(item, now));

    for (const item of dueItems) {
      const state = parseState(await redis.get(stateKey(item)));
      const hasExistingTarget =
        !state.completedAt &&
        state.lastStatus !== "exhausted" &&
        (await hasTargetEpisode(item));
      if (shouldRun(state, now) || hasExistingTarget) {
        await runItem(item, now);
      }
    }
    lastError = null;
    return {
      checked: dueItems.length,
      completed: totalItemsCompleted,
      runAt: lastRunAt.toISOString(),
    };
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    isRunning = false;
  }
}

export function startAnichinScheduleScrapeJob(runImmediately = true) {
  if (timer) return;
  if (runImmediately) {
    void runAnichinScheduleScrapeJob().catch((error) => {
      console.error("[anichin-schedule-job] run failed", error);
    });
  }
  timer = setInterval(() => {
    void runAnichinScheduleScrapeJob().catch((error) => {
      console.error("[anichin-schedule-job] run failed", error);
    });
  }, JOB_INTERVAL_MS);
}

export function stopAnichinScheduleScrapeJob() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function getAnichinScheduleScrapeJobStatus() {
  return {
    running: timer !== null,
    executing: isRunning,
    intervalMs: JOB_INTERVAL_MS,
    retryDelaySeconds: RETRY_DELAY_SECONDS,
    maxAttempts: MAX_ATTEMPTS,
    totalRuns,
    totalItemsCompleted,
    lastRunAt,
    lastError,
  };
}
