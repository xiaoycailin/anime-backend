import { spawn } from "child_process";
import type { ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs/promises";
import path from "path";
import ffmpegStatic from "ffmpeg-static";
import { Queue, Worker, type Job } from "bullmq";
import { youtubeCookiesStatus } from "./youtube-cookies.service";
import { importYouTubeSubtitlesWithYtDlp } from "./youtube-subtitle-import.service";
import { probeVideo } from "./hls-encoder.service";
import {
  appendEncodingLog,
  cleanupUploadTempDir,
  expireSessionImmediately,
  failSession,
  getUploadSession,
  updateSessionStatus,
  uploadTempDir,
} from "./upload-session.service";
import { redis } from "../lib/redis";
import { generateVideoId, setEpisodeR2Server } from "./video-pipeline.service";
import {
  getStreamingPublicUrl,
  uploadStreamingObject,
} from "../utils/r2-streaming";

const FFMPEG_BIN: string = (ffmpegStatic as unknown as string) || "ffmpeg";
const QUEUE_NAME = "youtube-r2-upload";
const DOWNLOAD_TIMEOUT_MS = Number(process.env.YOUTUBE_R2_DOWNLOAD_TIMEOUT_MS ?? 90 * 60 * 1000);
const COPY_HLS_TIME = Number(process.env.YOUTUBE_R2_HLS_TIME ?? 6);
const RESOLUTIONS = [144, 360, 720, 1080];
const CANCEL_TTL_SEC = 12 * 60 * 60;
const activeChildren = new Map<string, Set<ChildProcessWithoutNullStreams>>();

type YoutubeR2JobData = {
  uploadId: string;
  youtubeUrl: string;
};

type Variant = {
  resolution: number;
  width: number;
  height: number;
  bandwidth: number;
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

function ytDlpCommand() {
  const configured = process.env.YT_DLP_PATH?.trim();
  if (configured) return { file: configured, args: [] };
  return { file: "python", args: ["-m", "yt_dlp"] };
}

function ytDlpJsRuntimeArgs() {
  const runtime = process.env.YT_DLP_JS_RUNTIME?.trim();
  if (runtime) return ["--js-runtimes", runtime];

  const nodePath = process.env.YT_DLP_NODE_PATH?.trim() || process.execPath;
  return nodePath ? ["--js-runtimes", `node:${nodePath}`] : [];
}

function ytDlpRemoteComponentArgs() {
  const value = process.env.YT_DLP_REMOTE_COMPONENTS?.trim() || "ejs:github";
  return value ? ["--remote-components", value] : [];
}

function workerConcurrency() {
  const value = Number(process.env.YOUTUBE_R2_UPLOAD_CONCURRENCY ?? 3);
  if (!Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, Math.floor(value)));
}

function isYouTubeUrl(value: string) {
  return /(?:youtube\.com\/watch|youtu\.be\/)/i.test(value);
}

function videoFormatSelector(resolution: number) {
  return [
    `bv*[height=${resolution}][ext=mp4][vcodec^=avc1]`,
    `bv*[height=${resolution}][ext=mp4]`,
    `bv*[height=${resolution}]`,
    `b[height=${resolution}][ext=mp4]`,
    `b[height=${resolution}]`,
  ].join("/");
}

function cancelKey(uploadId: string) {
  return `upload:cancel:youtube:${uploadId}`;
}

async function isCancelRequested(uploadId: string) {
  return (await redis.get(cancelKey(uploadId))) === "1";
}

async function assertNotCancelled(uploadId: string) {
  if (await isCancelRequested(uploadId)) {
    throw new Error("YDWN upload dihentikan admin");
  }
}

function trackChild(uploadId: string, child: ChildProcessWithoutNullStreams) {
  const children = activeChildren.get(uploadId) ?? new Set<ChildProcessWithoutNullStreams>();
  children.add(child);
  activeChildren.set(uploadId, children);
  child.once("close", () => {
    children.delete(child);
    if (children.size === 0) activeChildren.delete(uploadId);
  });
}

async function findDownloadedVideo(dir: string, resolution: number) {
  const entries = await fs.readdir(dir);
  const prefix = `source-${resolution}.`;
  const file = entries.find((entry) => entry.startsWith(prefix));
  return file ? path.join(dir, file) : null;
}

async function findDownloadedAudio(dir: string) {
  const entries = await fs.readdir(dir);
  const file = entries.find((entry) => entry.startsWith("audio."));
  return file ? path.join(dir, file) : null;
}

async function runProcess(input: {
  uploadId: string;
  command: string;
  args: string[];
  timeoutMs: number;
  onStdout?: (text: string) => void;
}) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.command, input.args, { windowsHide: true });
    trackChild(input.uploadId, child);
    let stderr = "";
    let settled = false;
    let cancelPoll: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(input.command)} timeout`));
    }, input.timeoutMs);

    cancelPoll = setInterval(() => {
      void isCancelRequested(input.uploadId).then((cancelled) => {
        if (!cancelled || settled) return;
        child.kill("SIGKILL");
      });
    }, 1000);

    child.stdout.on("data", (chunk: Buffer) => input.onStdout?.(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      if (cancelPoll) clearInterval(cancelPoll);
      reject(error);
    });
    child.on("close", async (code) => {
      settled = true;
      clearTimeout(timeout);
      if (cancelPoll) clearInterval(cancelPoll);
      if (await isCancelRequested(input.uploadId)) {
        reject(new Error("YDWN upload dihentikan admin"));
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-1800) || `exit ${code}`));
    });
  });
}

async function downloadAudio(input: {
  uploadId: string;
  youtubeUrl: string;
  outputDir: string;
}) {
  const command = ytDlpCommand();
  const cookies = await youtubeCookiesStatus();
  const cookieArgs = cookies.exists ? ["--cookies", cookies.path] : [];

  await appendEncodingLog(input.uploadId, "[audio] yt-dlp download m4a");
  let lastProgress = 0;
  await runProcess({
    uploadId: input.uploadId,
    command: command.file,
    args: [
      ...command.args,
      ...cookieArgs,
      ...ytDlpJsRuntimeArgs(),
      ...ytDlpRemoteComponentArgs(),
      "--no-playlist",
      "--newline",
      "-f",
      "ba[ext=m4a]/ba[acodec^=mp4a]/ba",
      "-o",
      path.join(input.outputDir, "audio.%(ext)s"),
      input.youtubeUrl,
    ],
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    onStdout: (text) => {
      const match = text.match(/\[download]\s+([0-9.]+)%/);
      if (!match) return;
      const progress = Math.floor(Number(match[1]));
      if (Number.isFinite(progress) && progress >= lastProgress + 10) {
        lastProgress = progress;
        void updateSessionStatus(input.uploadId, {
          currentResolution: 0,
          uploadProgress: Math.min(99, progress),
        });
      }
    },
  });

  return findDownloadedAudio(input.outputDir);
}

async function downloadVideoVariant(input: {
  uploadId: string;
  youtubeUrl: string;
  outputDir: string;
  resolution: number;
}) {
  const command = ytDlpCommand();
  const cookies = await youtubeCookiesStatus();
  const cookieArgs = cookies.exists ? ["--cookies", cookies.path] : [];
  let lastProgress = 0;

  await appendEncodingLog(input.uploadId, `[${input.resolution}p] yt-dlp download video-only mp4`);
  await runProcess({
    uploadId: input.uploadId,
    command: command.file,
    args: [
      ...command.args,
      ...cookieArgs,
      ...ytDlpJsRuntimeArgs(),
      ...ytDlpRemoteComponentArgs(),
      "--no-playlist",
      "--newline",
      "-f",
      videoFormatSelector(input.resolution),
      "-o",
      path.join(input.outputDir, `source-${input.resolution}.%(ext)s`),
      input.youtubeUrl,
    ],
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    onStdout: (text) => {
      const match = text.match(/\[download]\s+([0-9.]+)%/);
      if (!match) return;
      const progress = Math.floor(Number(match[1]));
      if (Number.isFinite(progress) && progress >= lastProgress + 10) {
        lastProgress = progress;
        void updateSessionStatus(input.uploadId, {
          currentResolution: input.resolution,
          uploadProgress: Math.min(99, progress),
        });
        void appendEncodingLog(input.uploadId, `[${input.resolution}p] download ${progress}%`);
      }
    },
  });

  return findDownloadedVideo(input.outputDir, input.resolution);
}

async function remuxToHls(input: {
  uploadId: string;
  sourcePath: string;
  outputDir: string;
  label: string;
  media: "audio" | "video";
  includeAudio?: boolean;
}) {
  await fs.mkdir(input.outputDir, { recursive: true });
  await appendEncodingLog(input.uploadId, `[${input.label}] package HLS tanpa re-encode`);
  const mapArgs =
    input.media === "audio"
      ? ["-map", "0:a:0", "-vn"]
      : input.includeAudio
        ? ["-map", "0:v:0", "-map", "0:a:0?"]
        : ["-map", "0:v:0", "-an"];
  const audioCopyArgs =
    input.media === "audio" || input.includeAudio
      ? ["-bsf:a", "aac_adtstoasc"]
      : [];
  await runProcess({
    uploadId: input.uploadId,
    command: FFMPEG_BIN,
    args: [
      "-y",
      "-i",
      input.sourcePath,
      ...mapArgs,
      "-c",
      "copy",
      ...audioCopyArgs,
      "-hls_time",
      String(COPY_HLS_TIME),
      "-hls_playlist_type",
      "vod",
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      "init.mp4",
      "-hls_segment_filename",
      path.join(input.outputDir, "segment_%05d.m4s"),
      "-f",
      "hls",
      path.join(input.outputDir, "index.m3u8"),
    ],
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
  const playlistPath = path.join(input.outputDir, "index.m3u8");
  const playlist = await fs.readFile(playlistPath, "utf8");
  await fs.writeFile(
    playlistPath,
    playlist.replace(/#EXT-X-MAP:URI="[^"]*init\.mp4"/, '#EXT-X-MAP:URI="init.mp4"'),
    "utf8",
  );
}

async function uploadFolder(input: {
  localDir: string;
  keyPrefix: string;
  uploadId: string;
  resolution: number;
}) {
  const entries = await fs.readdir(input.localDir);
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(input.localDir, entry);
    const stat = await fs.stat(filePath);
    if (stat.isFile()) files.push(entry);
  }

  let uploaded = 0;
  const label = input.resolution > 0 ? `${input.resolution}p` : "audio";
  await updateSessionStatus(input.uploadId, {
    currentResolution: input.resolution,
    totalChunks: files.length,
    receivedChunks: 0,
    r2UploadProgress: 0,
  });

  for (const entry of files) {
    const filePath = path.join(input.localDir, entry);

    const contentType = entry.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : entry.endsWith(".m4s")
        ? "video/iso.segment"
        : "video/mp4";
    await uploadStreamingObject({
      key: `${input.keyPrefix}/${entry}`,
      body: await fs.readFile(filePath),
      contentType,
      cacheControl: entry.endsWith(".m3u8")
        ? "public, max-age=60"
        : "public, max-age=31536000, immutable",
    });

    uploaded += 1;
    const progress = files.length > 0 ? (uploaded / files.length) * 100 : 100;
    await updateSessionStatus(input.uploadId, {
      currentResolution: input.resolution,
      receivedChunks: uploaded,
      totalChunks: files.length,
      r2UploadProgress: Number(progress.toFixed(2)),
    });

    if (uploaded === files.length || uploaded % 10 === 0) {
      await appendEncodingLog(
        input.uploadId,
        `[${label}] R2 ${uploaded}/${files.length} file`,
      );
    }
  }
}

function buildMasterPlaylist(variants: Variant[], hasAudio: boolean) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  if (hasAudio) {
    lines.push(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"',
    );
  }
  for (const item of variants.sort((a, b) => a.resolution - b.resolution)) {
    const audioAttr = hasAudio ? ',AUDIO="audio"' : "";
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${item.bandwidth},RESOLUTION=${item.width}x${item.height}${audioAttr}`,
      `${item.resolution}p/index.m3u8`,
    );
  }
  return `${lines.join("\n")}\n`;
}

let queue: Queue<YoutubeR2JobData> | null = null;
let worker: Worker<YoutubeR2JobData> | null = null;

export function getYoutubeR2UploadQueue() {
  if (!queue) {
    queue = new Queue<YoutubeR2JobData>(QUEUE_NAME, {
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

export async function enqueueYoutubeR2Upload(uploadId: string, youtubeUrl: string) {
  if (!isYouTubeUrl(youtubeUrl)) throw new Error("URL YouTube tidak valid");
  const session = await getUploadSession(uploadId);
  if (!session) throw new Error("Upload session tidak ditemukan");

  await redis.del(cancelKey(uploadId));
  await appendEncodingLog(uploadId, "YDWN upload job masuk queue");
  return getYoutubeR2UploadQueue().add("import", { uploadId, youtubeUrl }, { jobId: uploadId });
}

export async function cancelYoutubeR2Upload(uploadId: string) {
  await redis.set(cancelKey(uploadId), "1", "EX", CANCEL_TTL_SEC);
  const children = activeChildren.get(uploadId);
  for (const child of children ?? []) {
    child.kill("SIGKILL");
  }

  const job = await getYoutubeR2UploadQueue().getJob(uploadId).catch(() => null);
  const state = await job?.getState().catch(() => "unknown");
  if (job && state && state !== "active") {
    await job.remove().catch(() => undefined);
  }

  await appendEncodingLog(uploadId, "Stop YDWN diminta admin", "warn");
  return { jobState: state ?? null, killedProcesses: children?.size ?? 0 };
}

async function processYoutubeJob(job: Job<YoutubeR2JobData>) {
  const { uploadId, youtubeUrl } = job.data;
  const session = await getUploadSession(uploadId);
  if (!session) throw new Error("Upload session tidak ditemukan");

  const videoId = session.videoId ?? generateVideoId();
  const tempDir = uploadTempDir(uploadId);
  const variants: Variant[] = [];
  let hasAudio = false;

  await updateSessionStatus(uploadId, {
    status: "processing",
    videoId,
    fileName: youtubeUrl,
    uploadProgress: 0,
    encodingProgress: 0,
    r2UploadProgress: 0,
    receivedChunks: 0,
    totalChunks: null,
    currentResolution: null,
    errorMessage: null,
  });

  await assertNotCancelled(uploadId);
  await updateSessionStatus(uploadId, { currentResolution: 0 });
  const audioPath = await downloadAudio({ uploadId, youtubeUrl, outputDir: tempDir }).catch(
    async (error) => {
      await appendEncodingLog(
        uploadId,
        `[audio] skip audio terpisah: ${error instanceof Error ? error.message : String(error)}`,
        "warn",
      );
      return null;
    },
  );
  await assertNotCancelled(uploadId);
  if (audioPath) {
    const audioDir = path.join(tempDir, "hls", "audio");
    await updateSessionStatus(uploadId, {
      currentResolution: 0,
      encodingProgress: 0,
      receivedChunks: 0,
      totalChunks: null,
    });
    await remuxToHls({ uploadId, sourcePath: audioPath, outputDir: audioDir, label: "audio", media: "audio" });
    await updateSessionStatus(uploadId, { currentResolution: 0, encodingProgress: 100 });
    await uploadFolder({
      localDir: audioDir,
      keyPrefix: `videos/${videoId}/audio`,
      uploadId,
      resolution: 0,
    });
    hasAudio = true;
  }

  for (const resolution of RESOLUTIONS) {
    await assertNotCancelled(uploadId);
    await updateSessionStatus(uploadId, { currentResolution: resolution });
    let sourcePath: string | null = null;
    try {
      sourcePath = await downloadVideoVariant({ uploadId, youtubeUrl, outputDir: tempDir, resolution });
    } catch (error) {
      await appendEncodingLog(
        uploadId,
        `[${resolution}p] skip: ${error instanceof Error ? error.message : String(error)}`,
        "warn",
      );
      continue;
    }
    if (!sourcePath) continue;

    await assertNotCancelled(uploadId);
    const probe = await probeVideo(sourcePath);
    if (!probe.durationSec || !probe.height) continue;
    const possibleResolutions = RESOLUTIONS.filter((res) => res <= probe.height);
    const actualResolution =
      possibleResolutions[possibleResolutions.length - 1] ?? resolution;
    if (variants.some((variant) => variant.resolution === actualResolution)) {
      await appendEncodingLog(uploadId, `[${resolution}p] duplicate ${actualResolution}p, skip`, "warn");
      continue;
    }

    const outputDir = path.join(tempDir, "hls", `${actualResolution}p`);
    await updateSessionStatus(uploadId, {
      currentResolution: actualResolution,
      encodingProgress: 0,
      receivedChunks: 0,
      totalChunks: null,
    });
    await remuxToHls({
      uploadId,
      sourcePath,
      outputDir,
      label: `${actualResolution}p`,
      media: "video",
      includeAudio: !hasAudio,
    });
    await updateSessionStatus(uploadId, {
      currentResolution: actualResolution,
      encodingProgress: 100,
    });
    await uploadFolder({
      localDir: outputDir,
      keyPrefix: `videos/${videoId}/${actualResolution}p`,
      uploadId,
      resolution: actualResolution,
    });
    await assertNotCancelled(uploadId);

    const stat = await fs.stat(sourcePath);
    const bandwidth = Math.max(128_000, Math.ceil((stat.size * 8) / probe.durationSec));
    variants.push({
      resolution: actualResolution,
      width: probe.width,
      height: probe.height,
      bandwidth,
    });
    await updateSessionStatus(uploadId, {
      uploadProgress: Math.min(99, Number(((variants.length / RESOLUTIONS.length) * 100).toFixed(2))),
      encodingProgress: Math.min(99, Number(((variants.length / RESOLUTIONS.length) * 100).toFixed(2))),
      r2UploadProgress: Math.min(99, Number(((variants.length / RESOLUTIONS.length) * 100).toFixed(2))),
      receivedChunks: 0,
      totalChunks: null,
      resolutionsDone: variants.map((variant) => variant.resolution).sort((a, b) => a - b),
    });
  }

  await assertNotCancelled(uploadId);
  if (variants.length === 0) throw new Error("Tidak ada format YouTube yang berhasil didownload");

  const masterKey = `videos/${videoId}/master.m3u8`;
  await uploadStreamingObject({
    key: masterKey,
    body: Buffer.from(buildMasterPlaylist(variants, hasAudio), "utf8"),
    contentType: "application/vnd.apple.mpegurl",
    cacheControl: "public, max-age=60",
  });

  const masterUrl = getStreamingPublicUrl(masterKey);
  await setEpisodeR2Server({ episodeId: session.episodeId, masterUrl });
  await updateSessionStatus(uploadId, {
    masterPlaylistUrl: masterUrl,
    uploadProgress: 100,
    encodingProgress: 100,
    r2UploadProgress: 100,
    currentResolution: null,
    receivedChunks: 0,
    totalChunks: null,
  });

  await appendEncodingLog(uploadId, "Import semua subtitle YouTube");
  const subtitles = await importYouTubeSubtitlesWithYtDlp({
    episodeId: session.episodeId,
    serverUrl: youtubeUrl,
    targetServerUrl: masterUrl,
  });
  const subtitleMessage = subtitles.message ?? "Subtitle import selesai";
  await appendEncodingLog(
    uploadId,
    subtitleMessage,
    subtitles.imported.length > 0 ? "info" : "warn",
  );
  if (subtitles.imported.length > 0) {
    await appendEncodingLog(
      uploadId,
      `Subtitle tersimpan: ${subtitles.imported
        .map((track) => `${track.language} (${track.cueCount})`)
        .join(", ")}`,
    );
  }
  await updateSessionStatus(uploadId, { status: "completed" });
  await appendEncodingLog(uploadId, "YDWN R2 upload selesai");
  await redis.del(cancelKey(uploadId));
  await expireSessionImmediately(uploadId);
  await cleanupUploadTempDir(uploadId);

  return { masterUrl, resolutions: variants.map((item) => item.resolution), videoId, subtitles };
}

export function startYoutubeR2UploadWorker() {
  if (worker) return worker;

  const concurrency = workerConcurrency();
  worker = new Worker<YoutubeR2JobData>(QUEUE_NAME, processYoutubeJob, {
    connection: buildRedisConnection(),
    concurrency,
  });

  worker.on("failed", async (job, error) => {
    if (!job) return;
    const message = error?.message ?? "YDWN upload gagal";
    console.error(`[youtube-r2-upload] job ${job.id} failed: ${message}`);
    await appendEncodingLog(job.data.uploadId, message, "error").catch(() => undefined);
    await failSession(job.data.uploadId, message).catch(() => undefined);
    await cleanupUploadTempDir(job.data.uploadId).catch(() => undefined);
  });

  worker.on("error", (error) => {
    console.error("[youtube-r2-upload] worker error:", error);
  });

  worker.on("ready", () => {
    console.log(`[youtube-r2-upload] worker ready concurrency=${concurrency}`);
  });

  return worker;
}
