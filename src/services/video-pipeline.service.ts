import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { Queue, Worker, type Job } from "bullmq";
import {
  buildMasterPlaylist,
  encodeToHls,
  probeVideo,
  RESOLUTION_LADDER,
  resolutionsToProcess,
} from "./hls-encoder.service";
import {
  appendEncodingLog,
  cleanupUploadTempDir,
  expireSessionImmediately,
  failSession,
  getReceivedChunks,
  type UploadSessionRecord,
  updateSessionStatus,
  uploadTempDir,
} from "./upload-session.service";
import {
  getStreamingPublicUrl,
  uploadStreamingObject,
} from "../utils/r2-streaming";
import { prisma } from "../lib/prisma";
import { CacheInvalidator } from "../lib/cache";

const QUEUE_NAME = "video-encoding";

function buildRedisConnection() {
  return {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_BULL_DB ?? 6),
    maxRetriesPerRequest: null,
  };
}

let queue: Queue | null = null;
let worker: Worker | null = null;

export type VideoEncodeJobData = {
  uploadId: string;
  videoId: string;
  episodeId: number;
  inputPath: string;
  initialResolution: number;
  totalChunks: number;
};

function sameJobData(
  left: Partial<VideoEncodeJobData> | undefined,
  right: VideoEncodeJobData,
) {
  return (
    left?.uploadId === right.uploadId &&
    left?.videoId === right.videoId &&
    Number(left?.episodeId) === right.episodeId &&
    Number(left?.initialResolution) === right.initialResolution &&
    Number(left?.totalChunks) === right.totalChunks
  );
}

function jobDataFromSession(
  session: UploadSessionRecord,
): VideoEncodeJobData | null {
  if (!session.videoId || !session.totalChunks || session.totalChunks <= 0) {
    return null;
  }

  return {
    uploadId: session.id,
    videoId: session.videoId,
    episodeId: session.episodeId,
    inputPath: "",
    initialResolution: session.initialResolution,
    totalChunks: session.totalChunks,
  };
}

export function getEncodingQueue(): Queue<VideoEncodeJobData> {
  if (!queue) {
    queue = new Queue<VideoEncodeJobData>(QUEUE_NAME, {
      connection: buildRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 200,
        attempts: 1,
      },
    });
  }
  return queue;
}

export async function enqueueEncoding(data: VideoEncodeJobData) {
  const encodingQueue = getEncodingQueue();
  const existing = await encodingQueue.getJob(data.uploadId);

  if (existing) {
    const state = await existing.getState().catch(() => "unknown");
    const sameData = sameJobData(existing.data, data);

    if (state === "active") {
      if (!sameData) {
        throw new Error(
          "Encoding job lama masih aktif untuk upload session ini",
        );
      }
      await appendEncodingLog(
        data.uploadId,
        "Encoding job sudah aktif di worker",
      );
      return existing;
    }

    if (sameData && ["waiting", "delayed", "paused"].includes(state)) {
      await appendEncodingLog(
        data.uploadId,
        `Encoding job sudah ada di queue (${state})`,
      );
      return existing;
    }

    await appendEncodingLog(
      data.uploadId,
      `Menghapus encoding job lama (${state}) sebelum requeue`,
      "warn",
    );
    await existing.remove();
  }

  await appendEncodingLog(data.uploadId, "Encoding job masuk queue");
  return encodingQueue.add("encode", data, { jobId: data.uploadId });
}

export async function reconcileEncodingJobForSession(
  session: UploadSessionRecord,
): Promise<{
  state: string | null;
  requeued: boolean;
  failedReason?: string;
}> {
  if (session.status !== "processing") {
    return { state: null, requeued: false };
  }

  const currentData = jobDataFromSession(session);
  if (!currentData) {
    const reason = "Session processing tidak punya data encoding lengkap";
    await appendEncodingLog(session.id, reason, "error");
    await failSession(session.id, reason);
    return { state: "failed", requeued: false, failedReason: reason };
  }

  const encodingQueue = getEncodingQueue();
  const job = await encodingQueue.getJob(session.id);

  if (!job) {
    const receivedChunks = await getReceivedChunks(session.id).catch(() => []);
    const receivedCount = Math.max(session.receivedChunks, receivedChunks.length);
    if (receivedCount >= currentData.totalChunks) {
      await appendEncodingLog(
        session.id,
        "Encoding job tidak ditemukan, membuat queue job baru",
        "warn",
      );
      await enqueueEncoding(currentData);
      return { state: "waiting", requeued: true };
    }

    return { state: null, requeued: false };
  }

  const state = await job.getState().catch(() => "unknown");
  const sameData = sameJobData(job.data, currentData);

  if (state === "failed") {
    if (!sameData) {
      await appendEncodingLog(
        session.id,
        "Encoding job gagal yang lama terdeteksi, requeue dengan data session terbaru",
        "warn",
      );
      await job.remove();
      await enqueueEncoding(currentData);
      return { state: "waiting", requeued: true };
    }

    const reason = job.failedReason || "Encoding job gagal";
    if (session.errorMessage !== reason) {
      await appendEncodingLog(session.id, reason, "error");
      await failSession(session.id, reason);
    }
    return { state: "failed", requeued: false, failedReason: reason };
  }

  if (!sameData && ["waiting", "delayed", "paused", "completed"].includes(state)) {
    await appendEncodingLog(
      session.id,
      `Encoding job ${state} memakai data lama, requeue dengan data terbaru`,
      "warn",
    );
    await job.remove();
    await enqueueEncoding(currentData);
    return { state: "waiting", requeued: true };
  }

  return { state, requeued: false };
}

async function uploadFolderToR2(input: {
  localDir: string;
  keyPrefix: string;
  onProgress?: (uploaded: number, total: number) => void;
}): Promise<{ key: string; size: number }[]> {
  const entries = await fs.readdir(input.localDir);
  const total = entries.length;
  const uploaded: { key: string; size: number }[] = [];

  let count = 0;
  for (const entry of entries) {
    const filePath = path.join(input.localDir, entry);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) continue;

    const buffer = await fs.readFile(filePath);
    const key = `${input.keyPrefix}/${entry}`;
    const contentType = entry.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : "video/mp2t";
    const cacheControl = entry.endsWith(".m3u8")
      ? "public, max-age=60"
      : "public, max-age=31536000, immutable";

    await uploadStreamingObject({ key, body: buffer, contentType, cacheControl });
    uploaded.push({ key, size: stat.size });
    count += 1;
    input.onProgress?.(count, total);
  }

  return uploaded;
}

async function assembleChunksToFile(input: {
  uploadId: string;
  totalChunks: number;
  outputPath: string;
}): Promise<void> {
  const dir = uploadTempDir(input.uploadId);
  const handle = await fs.open(input.outputPath, "w");
  try {
    for (let i = 0; i < input.totalChunks; i++) {
      const chunkPath = path.join(dir, `chunk_${i}`);
      const data = await fs.readFile(chunkPath);
      await handle.write(data);
    }
  } finally {
    await handle.close();
  }
}

export async function setEpisodeR2Server(input: {
  episodeId: number;
  masterUrl: string;
}) {
  const episode = await prisma.episode.findUnique({
    where: { id: input.episodeId },
    select: {
      slug: true,
      anime: { select: { slug: true } },
    },
  });

  if (!episode) {
    throw new Error(`Episode ${input.episodeId} tidak ditemukan`);
  }

  const server = await prisma.$transaction(async (tx) => {
    await tx.server.updateMany({
      where: { episodeId: input.episodeId },
      data: { isPrimary: false },
    });

    const existing = await tx.server.findFirst({
      where: { episodeId: input.episodeId, label: "R2" },
      orderBy: { id: "asc" },
    });

    if (existing) {
      await tx.server.updateMany({
        where: {
          episodeId: input.episodeId,
          label: "R2",
          id: { not: existing.id },
        },
        data: {
          value: input.masterUrl,
          isPrimary: false,
        },
      });

      return tx.server.update({
        where: { id: existing.id },
        data: {
          value: input.masterUrl,
          isPrimary: true,
        },
      });
    }

    return tx.server.create({
      data: {
        episodeId: input.episodeId,
        label: "R2",
        value: input.masterUrl,
        isPrimary: true,
      },
    });
  });

  await CacheInvalidator.onEpisodeChange(episode.anime.slug, episode.slug);

  return server;
}

export async function processVideoJob(job: Job<VideoEncodeJobData>) {
  const {
    uploadId,
    videoId,
    episodeId,
    inputPath,
    initialResolution,
    totalChunks,
  } = job.data;
  const log = (
    message: string,
    level: "info" | "warn" | "error" = "info",
  ) => appendEncodingLog(uploadId, message, level);

  await log("Worker mulai memproses encoding");
  await updateSessionStatus(uploadId, {
    status: "processing",
    encodingProgress: 0,
    r2UploadProgress: 0,
  });

  const tempDir = uploadTempDir(uploadId);
  const assembledPath = inputPath || path.join(tempDir, "source.bin");

  if (!inputPath) {
    await log(`Menggabungkan ${totalChunks} chunk menjadi source video`);
    await assembleChunksToFile({
      uploadId,
      totalChunks,
      outputPath: assembledPath,
    });
  }

  await log("Membaca metadata video dengan ffprobe");
  const probe = await probeVideo(assembledPath).catch((error) => {
    throw new Error(`Source tidak valid: ${error.message ?? error}`);
  });

  if (!probe.durationSec || probe.durationSec <= 0) {
    throw new Error("Durasi video tidak terdeteksi");
  }

  const targetResolutions = resolutionsToProcess(initialResolution);
  if (targetResolutions.length === 0) {
    throw new Error("Tidak ada resolusi target yang valid");
  }

  await log(
    `Source terdeteksi ${probe.width}x${probe.height}, video=${probe.videoCodec ?? "unknown"}, audio=${probe.audioCodec ?? "unknown"}, durasi=${probe.durationSec.toFixed(2)}s`,
  );
  await log(`Target resolusi: ${targetResolutions.map((res) => `${res}p`).join(", ")}`);

  const completed: number[] = [];
  const totalSteps = targetResolutions.length;
  let currentStep = 0;

  for (const resolution of targetResolutions) {
    currentStep += 1;
    await updateSessionStatus(uploadId, {
      currentResolution: resolution,
      encodingProgress: ((currentStep - 1) / totalSteps) * 100,
    });

    const ladder = RESOLUTION_LADDER[resolution];
    const matchesSource =
      probe.height === ladder.height &&
      probe.videoCodec === "h264" &&
      probe.audioCodec === "aac";
    await log(
      `Mulai encode ${resolution}p (${matchesSource ? "stream copy" : "transcode"})`,
    );

    const outputDir = path.join(tempDir, "hls", `${resolution}p`);
    await fs.mkdir(outputDir, { recursive: true });

    let lastLoggedEncodeProgress = -1;
    await encodeToHls({
      inputPath: assembledPath,
      outputDir,
      resolution,
      streamCopy: matchesSource,
      durationSec: probe.durationSec,
      onProgress: async (ratio) => {
        const overall =
          ((currentStep - 1) / totalSteps) * 100 + (ratio / totalSteps) * 100;
        const percent = Math.floor(ratio * 100);
        if (percent >= lastLoggedEncodeProgress + 25 || percent === 100) {
          lastLoggedEncodeProgress = percent;
          await log(`Encode ${resolution}p ${Math.min(100, percent)}%`);
        }
        await updateSessionStatus(uploadId, {
          encodingProgress: Math.min(99, Number(overall.toFixed(2))),
          currentResolution: resolution,
        }).catch(() => undefined);
      },
    });
    await log(`Encode ${resolution}p selesai`);

    const keyPrefix = `videos/${videoId}/${resolution}p`;
    await log(`Upload hasil ${resolution}p ke R2`);
    let lastLoggedUploadProgress = -1;
    await uploadFolderToR2({
      localDir: outputDir,
      keyPrefix,
      onProgress: async (uploaded, total) => {
        const perResolution = (uploaded / total) * (100 / totalSteps);
        const overall =
          (completed.length / totalSteps) * 100 + perResolution;
        const percent = Math.floor((uploaded / total) * 100);
        if (percent >= lastLoggedUploadProgress + 25 || percent === 100) {
          lastLoggedUploadProgress = percent;
          await log(`R2 upload ${resolution}p ${Math.min(100, percent)}%`);
        }
        await updateSessionStatus(uploadId, {
          r2UploadProgress: Math.min(99, Number(overall.toFixed(2))),
        }).catch(() => undefined);
      },
    });

    completed.push(resolution);
    await updateSessionStatus(uploadId, {
      resolutionsDone: completed,
      encodingProgress: (currentStep / totalSteps) * 100,
    });
    await log(`Resolusi ${resolution}p selesai diproses`);
  }

  await log("Membuat master playlist");
  const masterPlaylist = buildMasterPlaylist({ resolutions: completed });
  const masterKey = `videos/${videoId}/master.m3u8`;
  await uploadStreamingObject({
    key: masterKey,
    body: Buffer.from(masterPlaylist, "utf8"),
    contentType: "application/vnd.apple.mpegurl",
    cacheControl: "public, max-age=60",
  });

  const masterUrl = getStreamingPublicUrl(masterKey);
  await log("Menyimpan server R2 ke episode");
  await setEpisodeR2Server({ episodeId, masterUrl });

  await updateSessionStatus(uploadId, {
    status: "completed",
    encodingProgress: 100,
    r2UploadProgress: 100,
    uploadProgress: 100,
    masterPlaylistUrl: masterUrl,
    resolutionsDone: completed,
    currentResolution: null,
  });

  await log("Encoding selesai, master playlist siap");
  await expireSessionImmediately(uploadId);
  await cleanupUploadTempDir(uploadId);

  return { masterUrl, resolutions: completed, videoId };
}

export function startEncodingWorker(): Worker<VideoEncodeJobData> {
  if (worker) return worker;

  worker = new Worker<VideoEncodeJobData>(QUEUE_NAME, processVideoJob, {
    connection: buildRedisConnection(),
    concurrency: Number(process.env.VIDEO_ENCODE_CONCURRENCY ?? 1),
  });

  worker.on("failed", async (job, error) => {
    if (!job) return;
    console.error(
      `[video-pipeline] job ${job.id} failed: ${error?.message ?? error}`,
    );
    await appendEncodingLog(
      job.data.uploadId,
      error?.message ?? "Encoding gagal",
      "error",
    ).catch(() => undefined);
    await failSession(
      job.data.uploadId,
      error?.message ?? "Encoding gagal",
    ).catch(() => undefined);
    await cleanupUploadTempDir(job.data.uploadId).catch(() => undefined);
  });

  worker.on("error", (error) => {
    console.error("[video-pipeline] worker error:", error);
  });

  worker.on("ready", () => {
    console.log("[video-pipeline] encoding worker ready");
  });

  return worker;
}

export function generateVideoId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}
