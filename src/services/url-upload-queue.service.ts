import { Queue, Worker, type Job } from "bullmq";
import {
  appendEncodingLog,
  failSession,
  getUploadSession,
  updateSessionStatus,
} from "./upload-session.service";
import { generateVideoId, setEpisodeR2Server } from "./video-pipeline.service";
import {
  fetchRemoteBuffer,
  fetchRemoteText,
  ingestSegmentBuffer,
  parseMediaPlaylist,
  publishUrlIndexPlaylist,
  publishUrlMasterPlaylist,
  refreshUrlProgress,
  rememberPlaylist,
  setUrlSourceStatus,
} from "./url-ingest.service";

const QUEUE_NAME = "url-upload-ingest";
const PLAYLIST_REFRESH_EVERY = Number(process.env.URL_UPLOAD_PLAYLIST_REFRESH_EVERY ?? 5);

type UrlUploadJobData = {
  uploadId: string;
};

function buildRedisConnection() {
  return {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_BULL_DB ?? 6),
    maxRetriesPerRequest: null,
  };
}

let queue: Queue<UrlUploadJobData> | null = null;
let worker: Worker<UrlUploadJobData> | null = null;

export function getUrlUploadQueue() {
  if (!queue) {
    queue = new Queue<UrlUploadJobData>(QUEUE_NAME, {
      connection: buildRedisConnection(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return queue;
}

export async function enqueueUrlUpload(uploadId: string) {
  const session = await getUploadSession(uploadId);
  if (!session) throw new Error("Upload session tidak ditemukan");
  if (session.mode !== "url") throw new Error("Session bukan mode URL");

  const urlQueue = getUrlUploadQueue();
  const existing = await urlQueue.getJob(uploadId);
  if (existing) {
    const state = await existing.getState().catch(() => "unknown");
    if (["active", "waiting", "delayed", "paused"].includes(state)) {
      await appendEncodingLog(uploadId, `URL upload job sudah ada di queue (${state})`);
      return existing;
    }
    await existing.remove().catch(() => undefined);
  }

  await appendEncodingLog(uploadId, "URL upload job masuk queue");
  return urlQueue.add("ingest", { uploadId }, { jobId: uploadId });
}

export async function prepareUrlUploadSession(uploadId: string) {
  const session = await getUploadSession(uploadId);
  if (!session) throw new Error("Upload session tidak ditemukan");

  const videoId = session.videoId ?? generateVideoId();
  const masterUrl = session.masterPlaylistUrl ?? (await publishUrlMasterPlaylist({
    videoId,
    resolutions: [],
  }));

  await updateSessionStatus(uploadId, {
    status: "uploading",
    videoId,
    masterPlaylistUrl: masterUrl,
    errorMessage: null,
  });

  await setEpisodeR2Server({ episodeId: session.episodeId, masterUrl });
  await appendEncodingLog(uploadId, `Master URL disiapkan: ${masterUrl}`);
  return { ...session, videoId, masterPlaylistUrl: masterUrl };
}

async function processSource(input: {
  uploadId: string;
  videoId: string;
  source: { resolution: number; url: string };
  activeResolutions: number[];
}) {
  const { uploadId, videoId, source, activeResolutions } = input;
  await appendEncodingLog(uploadId, `[${source.resolution}p] fetch playlist`);
  await setUrlSourceStatus(uploadId, source.resolution, source.url, {
    status: "fetching-playlist",
    errorMessage: null,
  });

  const raw = await fetchRemoteText(source.url);
  const parsed = parseMediaPlaylist(raw, source.url);
  await rememberPlaylist(uploadId, source.resolution, raw, source.url);
  await setUrlSourceStatus(uploadId, source.resolution, source.url, {
    status: "uploading",
    totalSegments: parsed.segments.length,
    completedSegments: 0,
    errorMessage: null,
  });

  if (!activeResolutions.includes(source.resolution)) {
    activeResolutions.push(source.resolution);
  }
  activeResolutions.sort((a, b) => a - b);
  await publishUrlIndexPlaylist({
    uploadId,
    videoId,
    resolution: source.resolution,
    parsed,
  });
  await publishUrlMasterPlaylist({ videoId, resolutions: activeResolutions });
  await refreshUrlProgress(uploadId);

  for (const segment of parsed.segments) {
    const buffer = await fetchRemoteBuffer(segment.url);
    await ingestSegmentBuffer({
      uploadId,
      videoId,
      resolution: source.resolution,
      segmentIndex: segment.index,
      buffer,
    });

    const isLast = segment.index === parsed.segments.length - 1;
    if (isLast || segment.index % PLAYLIST_REFRESH_EVERY === 0) {
      await publishUrlIndexPlaylist({
        uploadId,
        videoId,
        resolution: source.resolution,
        parsed,
        complete: isLast,
      });
      await refreshUrlProgress(uploadId);
    }
  }

  await setUrlSourceStatus(uploadId, source.resolution, source.url, {
    status: "completed",
    completedSegments: parsed.segments.length,
    totalSegments: parsed.segments.length,
    errorMessage: null,
  });
  await updateSessionStatus(uploadId, {
    resolutionsDone: activeResolutions,
    currentResolution: null,
  });
  await appendEncodingLog(
    uploadId,
    `[${source.resolution}p] selesai (${parsed.segments.length} segmen)`,
  );
}

async function processUrlUploadJob(job: Job<UrlUploadJobData>) {
  const { uploadId } = job.data;
  const session = await prepareUrlUploadSession(uploadId);
  const sources = [...(session.urlSources ?? [])].sort(
    (a, b) => a.resolution - b.resolution,
  );
  if (sources.length === 0) throw new Error("URL sources kosong");

  await appendEncodingLog(uploadId, `Worker mulai proses ${sources.length} source`);
  const activeResolutions = [...session.resolutionsDone].sort((a, b) => a - b);

  for (const source of sources) {
    await updateSessionStatus(uploadId, { currentResolution: source.resolution });
    try {
      await processSource({
        uploadId,
        videoId: session.videoId,
        source,
        activeResolutions,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setUrlSourceStatus(uploadId, source.resolution, source.url, {
        status: "failed",
        errorMessage: message,
      });
      throw error;
    }
  }

  const masterUrl = await publishUrlMasterPlaylist({
    videoId: session.videoId,
    resolutions: activeResolutions,
  });
  await setEpisodeR2Server({ episodeId: session.episodeId, masterUrl });
  await updateSessionStatus(uploadId, {
    status: "completed",
    uploadProgress: 100,
    encodingProgress: 100,
    r2UploadProgress: 100,
    masterPlaylistUrl: masterUrl,
    resolutionsDone: activeResolutions,
    currentResolution: null,
  });
  await refreshUrlProgress(uploadId);
  await appendEncodingLog(uploadId, "URL upload selesai, server R2 terpasang");
  return { masterUrl, resolutions: activeResolutions, videoId: session.videoId };
}

export function startUrlUploadWorker() {
  if (worker) return worker;

  worker = new Worker<UrlUploadJobData>(QUEUE_NAME, processUrlUploadJob, {
    connection: buildRedisConnection(),
    concurrency: Number(process.env.URL_UPLOAD_CONCURRENCY ?? 2),
  });

  worker.on("failed", async (job, error) => {
    if (!job) return;
    const message = error?.message ?? "URL upload gagal";
    console.error(`[url-upload] job ${job.id} failed: ${message}`);
    await appendEncodingLog(job.data.uploadId, message, "error").catch(() => undefined);
    await failSession(job.data.uploadId, message).catch(() => undefined);
  });

  worker.on("error", (error) => {
    console.error("[url-upload] worker error:", error);
  });

  worker.on("ready", () => {
    console.log("[url-upload] worker ready");
  });

  return worker;
}
