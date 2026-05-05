import { redis } from "../lib/redis";
import {
  getAnichinScheduleScrapeJobStatus,
  runAnichinScheduleScrapeJob,
  startAnichinScheduleScrapeJob,
  stopAnichinScheduleScrapeJob,
} from "./anichin-schedule-scrape.job";
import {
  getReminderJobStatus,
  startReminderJob,
  stopReminderJob,
  triggerReminderCycle,
} from "./reminder.job";
import {
  getUploadCleanupJobStatus,
  runUploadCleanup,
  startUploadCleanupJob,
  stopUploadCleanupJob,
} from "./upload-cleanup.job";
import {
  runChatCleanupJobCycle,
  startChatCleanupJob,
} from "./chat-cleanup.job";
import {
  runSupportAutoCloseJobCycle,
  startSupportAutoCloseJob,
} from "./support-autoclose.job";
import {
  runSupportFlushJobCycle,
  startSupportFlushJob,
} from "./support-flush.job";

type Logger = {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
};

type JobCategory = "episode" | "reminder" | "maintenance" | "support";
type DesiredState = "active" | "stopped";
type ManagedTimer = NodeJS.Timeout | null;

type ManagedJob = {
  id: string;
  name: string;
  category: JobCategory;
  description: string;
  intervalLabel: string;
  start: (runImmediately?: boolean) => void;
  stop: () => void;
  runNow: () => Promise<unknown>;
  status: () => object;
};

const STATE_KEY_PREFIX = "jobs:control:";
const META_KEY_PREFIX = "jobs:meta:";

let logger: Logger = console;
let chatCleanupTimer: ManagedTimer = null;
let supportFlushTimer: ManagedTimer = null;
let supportAutoCloseTimer: ManagedTimer = null;

function timerStatus(timer: ManagedTimer) {
  return { running: timer !== null, executing: false };
}

function setTimer(current: ManagedTimer, next: ManagedTimer) {
  current?.unref?.();
  next?.unref?.();
  return next;
}

const jobs: ManagedJob[] = [
  {
    id: "anichin-schedule-scrape",
    name: "Anichin episode scraper",
    category: "episode",
    description: "Scrape episode sesuai jadwal Anichin dan retry kalau belum rilis.",
    intervalLabel: "Setiap 1 menit, retry target 30 menit",
    start: (runImmediately = true) => startAnichinScheduleScrapeJob(runImmediately),
    stop: stopAnichinScheduleScrapeJob,
    runNow: runAnichinScheduleScrapeJob,
    status: getAnichinScheduleScrapeJobStatus,
  },
  {
    id: "watch-reminder",
    name: "Watch reminder",
    category: "reminder",
    description: "Kirim reminder nonton sesuai preference dan anti-spam guard.",
    intervalLabel: "Setiap 1 jam",
    start: (runImmediately = true) => startReminderJob(runImmediately),
    stop: stopReminderJob,
    runNow: triggerReminderCycle,
    status: getReminderJobStatus,
  },
  {
    id: "upload-cleanup",
    name: "Upload cleanup",
    category: "maintenance",
    description: "Bersihkan upload session expired dan file temporary.",
    intervalLabel: "Sesuai UPLOAD_SWEEP_INTERVAL_MS",
    start: () => startUploadCleanupJob(logger),
    stop: stopUploadCleanupJob,
    runNow: () => runUploadCleanup(logger),
    status: getUploadCleanupJobStatus,
  },
  {
    id: "chat-cleanup",
    name: "Chat cleanup",
    category: "maintenance",
    description: "Bersihkan room chat aktif yang sudah kedaluwarsa.",
    intervalLabel: "Setiap 1 menit",
    start: () => {
      if (!chatCleanupTimer) {
        chatCleanupTimer = setTimer(chatCleanupTimer, startChatCleanupJob(logger));
      }
    },
    stop: () => {
      if (!chatCleanupTimer) return;
      clearInterval(chatCleanupTimer);
      chatCleanupTimer = null;
    },
    runNow: () => runChatCleanupJobCycle(logger),
    status: () => timerStatus(chatCleanupTimer),
  },
  {
    id: "support-flush",
    name: "Support flush",
    category: "support",
    description: "Flush percakapan support dari Redis ke database.",
    intervalLabel: "30 detik sampai 1 jam",
    start: () => {
      if (!supportFlushTimer) {
        supportFlushTimer = setTimer(supportFlushTimer, startSupportFlushJob(logger));
      }
    },
    stop: () => {
      if (!supportFlushTimer) return;
      clearInterval(supportFlushTimer);
      supportFlushTimer = null;
    },
    runNow: () => runSupportFlushJobCycle(logger),
    status: () => timerStatus(supportFlushTimer),
  },
  {
    id: "support-autoclose",
    name: "Support auto close",
    category: "support",
    description: "Tutup ticket support otomatis setelah idle.",
    intervalLabel: "Setiap 30 detik",
    start: () => {
      if (!supportAutoCloseTimer) {
        supportAutoCloseTimer = setTimer(
          supportAutoCloseTimer,
          startSupportAutoCloseJob(logger),
        );
      }
    },
    stop: () => {
      if (!supportAutoCloseTimer) return;
      clearInterval(supportAutoCloseTimer);
      supportAutoCloseTimer = null;
    },
    runNow: () => runSupportAutoCloseJobCycle(logger),
    status: () => timerStatus(supportAutoCloseTimer),
  },
];

function stateKey(id: string) {
  return `${STATE_KEY_PREFIX}${id}`;
}

function metaKey(id: string) {
  return `${META_KEY_PREFIX}${id}`;
}

async function desiredState(id: string): Promise<DesiredState> {
  const value = await redis.get(stateKey(id));
  if (value === "stopped" || value === "paused") return "stopped";
  return "active";
}

async function writeMeta(id: string, patch: Record<string, unknown>) {
  const raw = await redis.get(metaKey(id));
  const meta = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  await redis.set(metaKey(id), JSON.stringify({ ...meta, ...patch }));
}

export async function startManagedJobs(input: { logger: Logger; ids?: string[] }) {
  logger = input.logger;
  const targetIds = new Set(input.ids ?? jobs.map((job) => job.id));
  for (const job of jobs) {
    if (!targetIds.has(job.id)) continue;
    if ((await desiredState(job.id)) !== "active") continue;
    job.start(true);
  }
}

export async function listManagedJobs(category?: string) {
  const rows = await Promise.all(
    jobs
      .filter((job) => !category || job.category === category)
      .map(async (job) => {
        const [desired, rawMeta] = await Promise.all([
          desiredState(job.id),
          redis.get(metaKey(job.id)),
        ]);
        const runtime = job.status();
        const meta = rawMeta ? (JSON.parse(rawMeta) as Record<string, unknown>) : {};
        return {
          id: job.id,
          name: job.name,
          category: job.category,
          description: job.description,
          intervalLabel: job.intervalLabel,
          desiredState: desired,
          canRunNow: true,
          canPlay: true,
          canStop: true,
          runtime,
          meta,
        };
      }),
  );

  return {
    categories: Array.from(new Set(jobs.map((job) => job.category))),
    jobs: rows,
  };
}

export async function controlManagedJob(id: string, action: string) {
  const job = jobs.find((item) => item.id === id);
  if (!job) throw new Error("Job tidak ditemukan");

  if (action === "run-now") {
    const result = await job.runNow();
    await writeMeta(id, {
      lastManualRunAt: new Date().toISOString(),
      lastManualResult: result ?? null,
      lastManualStatus: "success",
    });
    return { action, result };
  }

  if (action === "stop" || action === "pause") {
    job.stop();
    await redis.set(stateKey(id), "stopped");
    await writeMeta(id, { updatedAt: new Date().toISOString(), lastAction: "stop" });
    return { action: "stop", desiredState: "stopped" };
  }

  if (action === "play") {
    await redis.set(stateKey(id), "active");
    job.start(false);
    await writeMeta(id, { updatedAt: new Date().toISOString(), lastAction: action });
    return { action, desiredState: "active" };
  }

  throw new Error("Action job tidak valid");
}
