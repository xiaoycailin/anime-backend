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
  cleanupUploadTempDir,
  expireSessionImmediately,
  failSession,
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
  return getEncodingQueue().add("encode", data, { jobId: data.uploadId });
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

async function setEpisodeR2Server(input: {
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

  await updateSessionStatus(uploadId, {
    status: "processing",
    encodingProgress: 0,
    r2UploadProgress: 0,
  });

  const tempDir = uploadTempDir(uploadId);
  const assembledPath = inputPath || path.join(tempDir, "source.bin");

  if (!inputPath) {
    await assembleChunksToFile({
      uploadId,
      totalChunks,
      outputPath: assembledPath,
    });
  }

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

    const outputDir = path.join(tempDir, "hls", `${resolution}p`);
    await fs.mkdir(outputDir, { recursive: true });

    await encodeToHls({
      inputPath: assembledPath,
      outputDir,
      resolution,
      streamCopy: matchesSource,
      durationSec: probe.durationSec,
      onProgress: async (ratio) => {
        const overall =
          ((currentStep - 1) / totalSteps) * 100 + (ratio / totalSteps) * 100;
        await updateSessionStatus(uploadId, {
          encodingProgress: Math.min(99, Number(overall.toFixed(2))),
          currentResolution: resolution,
        }).catch(() => undefined);
      },
    });

    const keyPrefix = `videos/${videoId}/${resolution}p`;
    await uploadFolderToR2({
      localDir: outputDir,
      keyPrefix,
      onProgress: async (uploaded, total) => {
        const perResolution = (uploaded / total) * (100 / totalSteps);
        const overall =
          (completed.length / totalSteps) * 100 + perResolution;
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
  }

  const masterPlaylist = buildMasterPlaylist({ resolutions: completed });
  const masterKey = `videos/${videoId}/master.m3u8`;
  await uploadStreamingObject({
    key: masterKey,
    body: Buffer.from(masterPlaylist, "utf8"),
    contentType: "application/vnd.apple.mpegurl",
    cacheControl: "public, max-age=60",
  });

  const masterUrl = getStreamingPublicUrl(masterKey);
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
