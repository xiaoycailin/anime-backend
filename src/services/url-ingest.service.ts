import crypto from "crypto";
import { redis } from "../lib/redis";
import {
  appendEncodingLog,
  failSession,
  expireSessionImmediately,
  cleanupUploadTempDir,
  getUploadSession,
  updateSessionStatus,
  type UploadSessionRecord,
  type UrlSourceInput,
  type UrlSourceProgress,
  UPLOAD_SESSION_TTL_MS,
} from "./upload-session.service";
import { RESOLUTION_LADDER } from "./hls-encoder.service";
import {
  getStreamingPublicUrl,
  streamingObjectExists,
  uploadStreamingObject,
} from "../utils/r2-streaming";
import { setEpisodeR2Server } from "./video-pipeline.service";

const REDIS_URL_SEGMENTS_PREFIX = "upload:url-segments:";
const REDIS_URL_PLAYLIST_PREFIX = "upload:url-playlist:";

function segmentSetKey(uploadId: string, resolution: number) {
  return `${REDIS_URL_SEGMENTS_PREFIX}${uploadId}:${resolution}`;
}

function playlistKey(uploadId: string, resolution: number) {
  return `${REDIS_URL_PLAYLIST_PREFIX}${uploadId}:${resolution}`;
}

export type ParsedSegment = {
  index: number;
  durationSec: number;
  url: string;
};

export type ParsedPlaylist = {
  segments: ParsedSegment[];
  targetDuration: number;
  raw: string;
};

/**
 * Parse a media playlist (.m3u8 with #EXTINF + .ts URIs) into segments.
 * Resolves segment URIs relative to the playlist URL.
 * Throws if the playlist is a master playlist (#EXT-X-STREAM-INF).
 */
export function parseMediaPlaylist(
  raw: string,
  baseUrl: string,
): ParsedPlaylist {
  const lines = raw.split(/\r?\n/);
  const segments: ParsedSegment[] = [];
  let pendingDuration = 0;
  let targetDuration = 0;
  let isMaster = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      isMaster = true;
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.split(":")[1]) || 0;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const value = line.slice("#EXTINF:".length).split(",")[0];
      pendingDuration = Number(value) || 0;
      continue;
    }
    if (line.startsWith("#")) continue;

    const resolved = resolveUrl(baseUrl, line);
    segments.push({
      index: segments.length,
      durationSec: pendingDuration,
      url: resolved,
    });
    pendingDuration = 0;
  }

  if (isMaster && segments.length === 0) {
    throw new Error(
      "URL ini adalah master playlist (#EXT-X-STREAM-INF). Pakai URL variant playlist (.ts.m3u8) langsung.",
    );
  }

  if (segments.length === 0) {
    throw new Error("Playlist tidak punya segmen .ts apapun.");
  }

  if (!targetDuration) {
    targetDuration = Math.ceil(
      segments.reduce((max, s) => Math.max(max, s.durationSec), 0),
    );
  }

  return { segments, targetDuration, raw };
}

function resolveUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

export function r2SegmentKey(
  videoId: string,
  resolution: number,
  segmentIndex: number,
) {
  return `videos/${videoId}/${resolution}p/segment_${String(segmentIndex).padStart(5, "0")}.ts`;
}

export function r2PlaylistKey(videoId: string, resolution: number) {
  return `videos/${videoId}/${resolution}p/index.m3u8`;
}

export function r2MasterKey(videoId: string) {
  return `videos/${videoId}/master.m3u8`;
}

// ── Per-segment progress (Redis sets) ────────────────────────────────────────

export async function markSegmentDone(
  uploadId: string,
  resolution: number,
  segmentIndex: number,
) {
  const added = await redis.sadd(
    segmentSetKey(uploadId, resolution),
    String(segmentIndex),
  );
  await redis.pexpire(
    segmentSetKey(uploadId, resolution),
    UPLOAD_SESSION_TTL_MS,
  );
  return added === 1;
}

export async function getDoneSegments(
  uploadId: string,
  resolution: number,
): Promise<number[]> {
  const members = await redis.smembers(segmentSetKey(uploadId, resolution));
  return members
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

export async function clearSegmentSet(
  uploadId: string,
  resolution: number,
) {
  await redis.del(segmentSetKey(uploadId, resolution));
}

// Cache parsed playlist between requests so client doesn't have to upload it
// again on resume. Stored as raw m3u8 text + base URL.
export async function rememberPlaylist(
  uploadId: string,
  resolution: number,
  raw: string,
  baseUrl: string,
) {
  const payload = JSON.stringify({ raw, baseUrl });
  await redis.set(
    playlistKey(uploadId, resolution),
    payload,
    "PX",
    UPLOAD_SESSION_TTL_MS,
  );
}

export async function recallPlaylist(
  uploadId: string,
  resolution: number,
): Promise<{ raw: string; baseUrl: string } | null> {
  const raw = await redis.get(playlistKey(uploadId, resolution));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.raw !== "string" || typeof parsed?.baseUrl !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPlaylistCache(
  uploadId: string,
  resolution: number,
) {
  await redis.del(playlistKey(uploadId, resolution));
}

// ── Server-side fetch (CORS fallback) ────────────────────────────────────────

export async function fetchRemoteText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; movie-anime-uploader/1.0; +https://example.local)",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Fetch playlist gagal (${response.status} ${response.statusText})`,
    );
  }
  return await response.text();
}

export async function fetchRemoteBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; movie-anime-uploader/1.0; +https://example.local)",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Fetch segment gagal (${response.status} ${response.statusText})`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ── Segment upload to R2 ─────────────────────────────────────────────────────

export async function ingestSegmentBuffer(input: {
  uploadId: string;
  videoId: string;
  resolution: number;
  segmentIndex: number;
  buffer: Buffer;
}): Promise<{ key: string; size: number; duplicate: boolean }> {
  const key = r2SegmentKey(input.videoId, input.resolution, input.segmentIndex);
  const exists = await streamingObjectExists(key).catch(() => false);
  if (!exists) {
    await uploadStreamingObject({
      key,
      body: input.buffer,
      contentType: "video/mp2t",
      cacheControl: "public, max-age=31536000, immutable",
    });
  }
  await markSegmentDone(input.uploadId, input.resolution, input.segmentIndex);
  return { key, size: input.buffer.length, duplicate: exists };
}

// ── Playlist + Master assembly ───────────────────────────────────────────────

export function buildLocalIndexPlaylist(input: {
  segments: ParsedSegment[];
  targetDuration: number;
}): string {
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-MEDIA-SEQUENCE:0",
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(input.targetDuration || 1))}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  for (const seg of input.segments) {
    lines.push(`#EXTINF:${seg.durationSec.toFixed(3)},`);
    lines.push(`segment_${String(seg.index).padStart(5, "0")}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

export function buildUrlMasterPlaylist(input: {
  resolutions: number[];
}): string {
  const lines: string[] = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const resolution of input.resolutions) {
    const ladder = RESOLUTION_LADDER[resolution];
    if (!ladder) continue;
    const bandwidth =
      Number.parseInt(ladder.videoBitrate.replace(/[^\d]/g, ""), 10) * 1000 +
      Number.parseInt(ladder.audioBitrate.replace(/[^\d]/g, ""), 10) * 1000;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${ladder.width}x${ladder.height}`,
      `${resolution}p/index.m3u8`,
    );
  }
  return lines.join("\n") + "\n";
}

// ── Progress aggregation ─────────────────────────────────────────────────────

export async function refreshUrlProgress(
  uploadId: string,
): Promise<UploadSessionRecord | null> {
  const session = await getUploadSession(uploadId);
  if (!session || session.mode !== "url") return session;

  const sources = session.urlSources ?? [];
  const previous = session.urlProgress ?? [];
  const next: UrlSourceProgress[] = [];

  let totalSegments = 0;
  let completedSegments = 0;
  let allDone = sources.length > 0;

  for (const source of sources) {
    const prevEntry = previous.find(
      (entry) =>
        entry.resolution === source.resolution && entry.url === source.url,
    );
    const done = await getDoneSegments(uploadId, source.resolution);
    const total = prevEntry?.totalSegments ?? null;

    if (typeof total === "number") {
      totalSegments += total;
      completedSegments += Math.min(done.length, total);
    }

    let status: UrlSourceProgress["status"] = prevEntry?.status ?? "pending";
    if (typeof total === "number" && done.length >= total) {
      status = "completed";
    } else if (done.length > 0 && status === "pending") {
      status = "uploading";
    }

    if (status !== "completed") allDone = false;

    next.push({
      resolution: source.resolution,
      url: source.url,
      totalSegments: total,
      completedSegments: Math.min(done.length, total ?? done.length),
      status,
      errorMessage: prevEntry?.errorMessage ?? null,
    });
  }

  const uploadProgress =
    totalSegments > 0 ? (completedSegments / totalSegments) * 100 : 0;

  const updates: Parameters<typeof updateSessionStatus>[1] = {
    urlProgress: next,
    uploadProgress: Number(uploadProgress.toFixed(2)),
    receivedChunks: completedSegments,
  };
  if (totalSegments > 0) {
    updates.totalChunks = totalSegments;
  }

  return updateSessionStatus(uploadId, updates);
}

export async function setUrlSourceStatus(
  uploadId: string,
  resolution: number,
  url: string,
  patch: Partial<UrlSourceProgress>,
) {
  const session = await getUploadSession(uploadId);
  if (!session) return;
  const list = session.urlProgress ?? [];
  const idx = list.findIndex(
    (entry) => entry.resolution === resolution && entry.url === url,
  );
  if (idx === -1) {
    list.push({
      resolution,
      url,
      totalSegments: null,
      completedSegments: 0,
      status: "pending",
      errorMessage: null,
      ...patch,
    });
  } else {
    list[idx] = { ...list[idx], ...patch };
  }
  await updateSessionStatus(uploadId, { urlProgress: list });
}

// ── Finalize: build per-res index.m3u8 + master, set Episode server ──────────

export async function finalizeUrlSession(
  uploadId: string,
): Promise<{ masterUrl: string; resolutions: number[] }> {
  const session = await getUploadSession(uploadId);
  if (!session) throw new Error("Upload session tidak ditemukan");
  if (session.mode !== "url") throw new Error("Session bukan mode URL");
  if (!session.urlSources || session.urlSources.length === 0) {
    throw new Error("Tidak ada URL source untuk di-finalize");
  }

  const videoId = session.videoId ?? generateVideoId();
  if (!session.videoId) {
    await updateSessionStatus(uploadId, { videoId });
  }

  await appendEncodingLog(
    uploadId,
    "Semua source selesai, membuat playlist per resolusi",
  );

  const completed: number[] = [];
  for (const source of session.urlSources) {
    const cached = await recallPlaylist(uploadId, source.resolution);
    if (!cached) {
      throw new Error(
        `Playlist cache untuk ${source.resolution}p hilang — ulangi upload.`,
      );
    }
    const parsed = parseMediaPlaylist(cached.raw, cached.baseUrl);
    const done = await getDoneSegments(uploadId, source.resolution);
    if (done.length < parsed.segments.length) {
      throw new Error(
        `Segmen ${source.resolution}p belum lengkap (${done.length}/${parsed.segments.length}).`,
      );
    }

    const indexBody = buildLocalIndexPlaylist({
      segments: parsed.segments,
      targetDuration: parsed.targetDuration,
    });
    const indexKey = r2PlaylistKey(videoId, source.resolution);
    await uploadStreamingObject({
      key: indexKey,
      body: Buffer.from(indexBody, "utf8"),
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: "public, max-age=60",
    });
    completed.push(source.resolution);
    await appendEncodingLog(
      uploadId,
      `index.m3u8 untuk ${source.resolution}p ter-upload (${parsed.segments.length} segmen)`,
    );
  }

  completed.sort((a, b) => a - b);

  const masterBody = buildUrlMasterPlaylist({ resolutions: completed });
  const masterKey = r2MasterKey(videoId);
  await uploadStreamingObject({
    key: masterKey,
    body: Buffer.from(masterBody, "utf8"),
    contentType: "application/vnd.apple.mpegurl",
    cacheControl: "public, max-age=60",
  });

  const masterUrl = getStreamingPublicUrl(masterKey);

  await appendEncodingLog(uploadId, "Master playlist siap, set server R2 di episode");
  await setEpisodeR2Server({ episodeId: session.episodeId, masterUrl });

  await updateSessionStatus(uploadId, {
    status: "completed",
    encodingProgress: 100,
    r2UploadProgress: 100,
    uploadProgress: 100,
    masterPlaylistUrl: masterUrl,
    resolutionsDone: completed,
    currentResolution: null,
  });

  await appendEncodingLog(uploadId, "Selesai");

  await expireSessionImmediately(uploadId);
  await cleanupUploadTempDir(uploadId);

  return { masterUrl, resolutions: completed };
}

export async function failUrlSession(
  uploadId: string,
  message: string,
) {
  await appendEncodingLog(uploadId, message, "error");
  await failSession(uploadId, message);
}

function generateVideoId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}
