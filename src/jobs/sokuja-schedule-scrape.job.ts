import { redis } from "../lib/redis";
import { prisma } from "../lib/prisma";
import {
  getSokujaSchedule,
  type SokujaScheduleItem,
} from "../services/sokuja-schedule.service";
import { createRoleNotification } from "../services/notification.service";
import {
  scrapeSokujaAnimeDetail,
  type SokujaAnimeCard,
} from "../services/scraper-service/scrapeSokujaAnimeList.service";
import { importOneSokujaAnime } from "../services/scraper-service/importSokujaAnime.service";

const JOB_INTERVAL_MS = 60 * 1000;
const RETRY_DELAY_SECONDS = 30 * 60;
const MAX_ATTEMPTS = 5;
const DUE_LOOKBACK_MS = 36 * 60 * 60 * 1000;
const STATE_TTL_SECONDS = 14 * 24 * 60 * 60;
const RECENT_EPISODE_LIMIT = 2;

type JobState = {
  attempts: number;
  nextRunAt: string | null;
  completedAt: string | null;
  lastStatus: "pending" | "retrying" | "completed" | "exhausted" | "failed";
};

export type SokujaEpisodeJobTarget = {
  id: string;
  animeTitle: string;
  animeSlug: string;
  scheduledAt: string;
  releaseTime: string;
  sourceUrl: string;
  scheduleStatus: SokujaScheduleItem["scheduleStatus"];
  jobStatus:
    | "waiting"
    | "pending"
    | "retrying"
    | "running"
    | "completed"
    | "exhausted"
    | "failed";
  attempts: number;
  maxAttempts: number;
  nextRunAt: string | null;
  completedAt: string | null;
};

let timer: NodeJS.Timeout | null = null;
let isRunning = false;
let lastRunAt: Date | null = null;
let lastError: string | null = null;
let totalRuns = 0;
let totalItemsCompleted = 0;

function scheduleDateKey(item: SokujaScheduleItem) {
  return item.scheduledAt.slice(0, 10);
}

function targetId(item: SokujaScheduleItem) {
  return `${scheduleDateKey(item)}:${item.animeSlug}`;
}

function stateKey(item: SokujaScheduleItem) {
  return `sokuja:schedule-job:${targetId(item)}`;
}

function lockKey(item: SokujaScheduleItem) {
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

function isDue(item: SokujaScheduleItem, now: Date) {
  const scheduledAt = new Date(item.scheduledAt);
  const diff = now.getTime() - scheduledAt.getTime();
  return diff >= 0 && diff <= DUE_LOOKBACK_MS && item.animeSlug && item.sourceUrl;
}

function shouldRun(state: JobState, now: Date) {
  if (state.completedAt || state.lastStatus === "exhausted") return false;
  if (!state.nextRunAt) return true;
  return new Date(state.nextRunAt).getTime() <= now.getTime();
}

function targetJobStatus(input: {
  item: SokujaScheduleItem;
  state: JobState;
  locked: boolean;
  now: Date;
}): SokujaEpisodeJobTarget["jobStatus"] {
  if (input.locked) return "running";
  if (input.state.completedAt) return "completed";
  if (input.state.lastStatus === "exhausted") return "exhausted";
  if (input.state.lastStatus === "failed") return "failed";
  if (input.state.lastStatus === "retrying") return "retrying";
  return isDue(input.item, input.now) ? "pending" : "waiting";
}

function cardFromSchedule(item: SokujaScheduleItem): SokujaAnimeCard {
  return {
    source: "sokuja",
    sourceUrl: item.sourceUrl,
    page: 0,
    title: item.animeTitle,
    slug: item.animeSlug,
    detailUrl: item.sourceUrl,
    thumbnail: item.thumbnail,
    bigCover: item.thumbnail,
    rating: null,
    status: "Ongoing",
    released: null,
    type: item.animeType,
  };
}

function detailEpisodeSlugs(detailUrl: string, episodes: Array<{ href?: string | null }>) {
  return episodes
    .map((episode) => {
      const href = episode.href ?? "";
      if (!href) return "";
      try {
        return new URL(href, detailUrl).pathname.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
      } catch {
        return href.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
      }
    })
    .filter(Boolean);
}

async function existingEpisodeSlugs(animeSlug: string) {
  const anime = await prisma.anime.findUnique({
    where: { slug: animeSlug },
    select: {
      episodes: {
        select: { slug: true },
      },
    },
  });

  return new Set(anime?.episodes.map((episode) => episode.slug) ?? []);
}

function parseRelativeDate(text: string, now = new Date()) {
  const value = text.toLowerCase();
  if (/baru saja/.test(value)) return now;

  const match = value.match(/(\d+)\s+(menit|jam|hari|minggu)\s+lalu/);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const multipliers: Record<string, number> = {
    menit: 60 * 1000,
    jam: 60 * 60 * 1000,
    hari: 24 * 60 * 60 * 1000,
    minggu: 7 * 24 * 60 * 60 * 1000,
  };

  return new Date(now.getTime() - amount * multipliers[match[2]]);
}

function hasRecentEpisodeDate(
  episodes: Array<{ date?: string | null }>,
  scheduledAt: string,
  now = new Date(),
) {
  const minimum = new Date(scheduledAt).getTime() - 3 * 60 * 60 * 1000;

  return episodes.some((episode) => {
    const parsed = parseRelativeDate(episode.date ?? "", now);
    return parsed ? parsed.getTime() >= minimum : false;
  });
}

async function notifyAdmin(input: {
  title: string;
  message: string;
  item: SokujaScheduleItem;
  attempts: number;
  status: string;
}) {
  await createRoleNotification({
    role: "admin",
    category: "admin_operational",
    type: "sokuja_schedule_job",
    title: input.title,
    message: input.message,
    link: "/admin/jobs",
    topic: "admin-scraping",
    payload: {
      animeSlug: input.item.animeSlug,
      animeTitle: input.item.animeTitle,
      scheduledAt: input.item.scheduledAt,
      attempts: input.attempts,
      status: input.status,
      source: "sokuja.schedule",
    },
  });
}

async function runItem(item: SokujaScheduleItem, now: Date) {
  const key = stateKey(item);
  const lock = await redis.set(lockKey(item), "1", "EX", 15 * 60, "NX");
  if (!lock) return;

  try {
    const state = parseState(await redis.get(key));
    if (!shouldRun(state, now)) return;

    const attempts = state.attempts + 1;
    await notifyAdmin({
      title: "Job scraping Sokuja dijalankan",
      message: `Cek rilis Sokuja untuk ${item.animeTitle}. Percobaan ${attempts}/${MAX_ATTEMPTS}.`,
      item,
      attempts,
      status: "running",
    });

    const beforeSlugs = await existingEpisodeSlugs(item.animeSlug);
    const detail = await scrapeSokujaAnimeDetail(cardFromSchedule(item), {
      includeEpisodeServers: true,
      episodeMode: "recent",
      episodeLimit: RECENT_EPISODE_LIMIT,
    });
    const episodeSlugs = detailEpisodeSlugs(item.sourceUrl, detail.episodes);
    const hasNewEpisode = episodeSlugs.some((slug) => !beforeSlugs.has(slug));

    if (detail.episodes.length) {
      await importOneSokujaAnime(
        {
          slug: item.animeSlug,
          title: item.animeTitle,
          thumbnail: item.thumbnail,
          bigCover: item.thumbnail,
          rating: null,
          status: "Ongoing",
          released: null,
          type: item.animeType,
        },
        detail,
      );
    }

    const completed = hasNewEpisode || hasRecentEpisodeDate(detail.episodes, item.scheduledAt, now);
    if (completed) {
      await saveState(key, {
        attempts,
        nextRunAt: null,
        completedAt: new Date().toISOString(),
        lastStatus: "completed",
      });
      totalItemsCompleted += 1;
      await notifyAdmin({
        title: "Job scraping Sokuja selesai",
        message: `${item.animeTitle} sudah diproses dari jadwal Sokuja.`,
        item,
        attempts,
        status: "completed",
      });
      return;
    }

    const exhausted = attempts >= MAX_ATTEMPTS;
    await saveState(key, {
      attempts,
      nextRunAt: exhausted
        ? null
        : new Date(now.getTime() + RETRY_DELAY_SECONDS * 1000).toISOString(),
      completedAt: exhausted ? new Date().toISOString() : null,
      lastStatus: exhausted ? "exhausted" : "retrying",
    });

    await notifyAdmin({
      title: exhausted
        ? "Job scraping Sokuja berhenti"
        : "Job scraping Sokuja retry dijadwalkan",
      message: exhausted
        ? `Tidak ada episode baru untuk ${item.animeTitle} setelah ${MAX_ATTEMPTS} percobaan.`
        : `Belum ada episode baru untuk ${item.animeTitle}. Retry ${attempts + 1}/${MAX_ATTEMPTS} akan jalan 30 menit lagi.`,
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
      title: "Job scraping Sokuja gagal",
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

export async function runSokujaScheduleScrapeJob() {
  if (isRunning) return;
  isRunning = true;

  try {
    totalRuns += 1;
    lastRunAt = new Date();
    const now = new Date();
    const schedule = await getSokujaSchedule();
    const dueItems = schedule.filter((item) => isDue(item, now));

    for (const item of dueItems) {
      const state = parseState(await redis.get(stateKey(item)));
      if (shouldRun(state, now)) await runItem(item, now);
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

export async function listSokujaEpisodeJobTargets() {
  const now = new Date();
  const schedule = await getSokujaSchedule();

  return Promise.all(
    schedule.map(async (item): Promise<SokujaEpisodeJobTarget> => {
      const state = parseState(await redis.get(stateKey(item)));
      const locked = Boolean(await redis.exists(lockKey(item)));

      return {
        id: targetId(item),
        animeTitle: item.animeTitle,
        animeSlug: item.animeSlug,
        scheduledAt: item.scheduledAt,
        releaseTime: item.releaseTime,
        sourceUrl: item.sourceUrl,
        scheduleStatus: item.scheduleStatus,
        jobStatus: targetJobStatus({ item, state, locked, now }),
        attempts: state.attempts,
        maxAttempts: MAX_ATTEMPTS,
        nextRunAt: state.nextRunAt,
        completedAt: state.completedAt,
      };
    }),
  );
}

export async function runSokujaEpisodeJobTarget(id: string) {
  const schedule = await getSokujaSchedule();
  const item = schedule.find((target) => targetId(target) === id);
  if (!item) throw new Error("Target episode job Sokuja tidak ditemukan");

  await runItem(item, new Date());
  return {
    id: targetId(item),
    animeTitle: item.animeTitle,
  };
}

export function startSokujaScheduleScrapeJob(runImmediately = true) {
  if (timer) return;
  if (runImmediately) {
    void runSokujaScheduleScrapeJob().catch((error) => {
      console.error("[sokuja-schedule-job] run failed", error);
    });
  }
  timer = setInterval(() => {
    void runSokujaScheduleScrapeJob().catch((error) => {
      console.error("[sokuja-schedule-job] run failed", error);
    });
  }, JOB_INTERVAL_MS);
}

export function stopSokujaScheduleScrapeJob() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function getSokujaScheduleScrapeJobStatus() {
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

