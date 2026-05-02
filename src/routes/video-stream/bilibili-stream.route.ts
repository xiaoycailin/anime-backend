import { FastifyPluginAsync } from "fastify";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import {
  VIDEO_PLAYLIST_CACHE_CONTROL,
  VIDEO_SEGMENT_CACHE_CONTROL,
} from "../../utils/video-stream-cache";

// ffmpeg-static: bundle binary ffmpeg ke node_modules, no system install needed.
// Fallback ke "ffmpeg" di PATH kalau package tidak terpasang (dev ergonomics).
// eslint-disable-next-line @typescript-eslint/no-var-requires
let FFMPEG_BIN: string = "ffmpeg";
try {
  // require lazy supaya tidak crash kalau package belum diinstall.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegStatic = require("ffmpeg-static") as string | null;
  if (ffmpegStatic) FFMPEG_BIN = ffmpegStatic;
} catch {
  /* pakai "ffmpeg" dari PATH sistem */
}

const BASE_PREFIX_SERVER_PATH = "/api/video-stream/bilibili-stream";

const BILIBILI_PLAYURL_API = "https://api.bilibili.tv/intl/gateway/web/playurl";
const BILIBILI_OGV_PLAY_API =
  "https://api.bilibili.tv/intl/gateway/web/v2/ogv/play/episode";
const BILIBILI_VIDEO_PAGE_BASE = "https://www.bilibili.tv/id/video";
const BILIBILI_REFERER = "https://www.bilibili.tv/";
const BILIBILI_ORIGIN = "https://www.bilibili.tv";

// UA Chrome terbaru (stable channel) — bilibili anti-abuse lebih permisif
// terhadap UA yang recent. Update berkala kalau mulai kena 412 sering.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

// ─── Bilibili login cookie ────────────────────────────────────────────────────
// Cookie login user (SESSDATA + bili_jct + DedeUserID) diperlukan supaya API
// playurl mengembalikan DASH response dengan audio track terpisah. Tanpa login,
// bilibili.tv intl mengembalikan video-only file (HEVC tanpa audio).
//
// Override via env var BILIBILI_COOKIE kalau mau ganti di runtime tanpa rebuild.
const BILIBILI_COOKIE_DEFAULT =
  "buvid3=AAF93E10-7254-3051-E8B8-B8B076925CEE37521infoc; " +
  "b_nut=1775634134; " +
  "buvid4=85DBE707-70EA-B078-5EF4-7CF5E146BAC337521-026040815-1KEjqvN9phEx%2BCBGcIgD5w%3D%3D; " +
  "SESSDATA=8bdc20c7%2C1791186350%2C94593%2A4100c0; " +
  "bili_jct=97061881e23203d5124a8e7e3ea66de3; " +
  "joy_jct=97061881e23203d5124a8e7e3ea66de3; " +
  "DedeUserID=1253627584; " +
  "DedeUserID__ckMd5=992a77d4f50bbf955af6eb9172d720eb; " +
  "mid=1253627584; " +
  "bstar-web-lang=id; " +
  "bsource=search_google";

const BILIBILI_COOKIE = process.env.BILIBILI_COOKIE || BILIBILI_COOKIE_DEFAULT;

// ─── Types ────────────────────────────────────────────────────────────────────

interface BilibiliVideo {
  name: string;
  quality: number;
  url: string; // video .m4s / .mp4
  backup_urls?: string[];
  audio_url?: string; // separate audio .m4s (DASH)
  audio_backup_urls?: string[];
  audio_quality?: number; // 30216=64k, 30232=132k, 30280=192k HiRes
  container?: "m4s" | "mp4"; // hint untuk ffmpeg
}

interface BilibiliMetadata {
  aid: string;
  title?: string;
  videos: BilibiliVideo[];
  has_audio: boolean;
  audio_source?:
    | "playurl.audio"
    | "dash.audio"
    | "video_scan"
    | "mp4_muxed"
    | "none";
  duration_seconds?: number; // dari timelength / ms ÷ 1000
}

interface BilibiliStreamInfo {
  quality: number;
  intact?: boolean;
  new_description?: string;
  display_desc?: string;
  superscript?: string;
  need_vip?: boolean;
}

interface BilibiliVideoResource {
  url?: string;
  backup_url?: string[];
  backurl?: string[];
  quality: number;
  size?: number;
  md5?: string;
  mime_type?: string;
  codecs?: string;
  width?: number;
  height?: number;
  frame_rate?: string;
}

interface BilibiliPlayurlResponseItem {
  stream_info?: BilibiliStreamInfo;
  video_resource?: BilibiliVideoResource;
}

interface BilibiliDashTrack {
  id?: number;
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
  bandwidth?: number;
  mimeType?: string;
  mime_type?: string;
  codecs?: string;
  width?: number;
  height?: number;
}

interface BilibiliPlayurlResponse {
  code: number;
  message?: string;
  data?: {
    playurl?: {
      video?: BilibiliPlayurlResponseItem[];
      audio?: BilibiliPlayurlResponseItem[];
    };
    // Format domestik kadang muncul di endpoint intl juga
    dash?: {
      video?: BilibiliDashTrack[];
      audio?: BilibiliDashTrack[];
    };
    video_info?: {
      title?: string;
      timelength?: number; // ms
      duration?: number; // seconds
    };
    // Top-level timelength (beberapa response bilibili naruh di sini)
    timelength?: number;
  };
}

// ─── Encode / Decode URL token ────────────────────────────────────────────────

function encodeSegmentUrl(url: string): string {
  return Buffer.from(url, "utf8").toString("hex");
}

function decodeSegmentUrl(token: string): string {
  return Buffer.from(token, "hex").toString("utf8");
}

// ─── Quality mapping ──────────────────────────────────────────────────────────
//
//   127=8K, 126=Dolby Vision, 125=HDR, 120=4K,
//   116=1080P60, 112=1080P+, 80=1080P,
//   74=720P60, 64=720P,
//   32=480P, 16=360P, 6=240P

const QN_TO_NAME: Record<number, string> = {
  127: "full",
  126: "full",
  125: "full",
  120: "full",
  116: "full",
  112: "full",
  80: "full",
  74: "hd",
  64: "hd",
  32: "sd",
  16: "low",
  6: "lowest",
};

const NAME_TO_BANDWIDTH: Record<string, number> = {
  full: 4000000,
  hd: 2500000,
  sd: 1000000,
  low: 500000,
  lowest: 300000,
  mobile: 150000,
};

const NAME_TO_RESOLUTION: Record<string, string> = {
  full: "1920x1080",
  hd: "1280x720",
  sd: "640x360",
  low: "480x270",
  lowest: "320x180",
  mobile: "240x134",
};

const QUALITY_ORDER = ["full", "hd", "sd", "low", "lowest", "mobile"];

// ─── Helper: Rewrite M3U8 (future-proof HLS manifest support) ────────────────

function rewriteM3u8(
  content: string,
  baseProxyUrl: string,
  manifestUrl: string,
): string {
  const manifestUrlObj = new URL(manifestUrl);
  const lastSlash = manifestUrlObj.pathname.lastIndexOf("/");
  const baseDir =
    manifestUrlObj.origin + manifestUrlObj.pathname.substring(0, lastSlash + 1);
  const origin = manifestUrlObj.origin;

  function resolveUrl(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      return trimmed;
    } else if (trimmed.startsWith("/")) {
      return `${origin}${trimmed}`;
    } else {
      return `${baseDir}${trimmed}`;
    }
  }

  function proxyUrl(raw: string): string {
    const absolute = resolveUrl(raw);
    const token = encodeSegmentUrl(absolute);
    return `${baseProxyUrl}/segment?t=${token}`;
  }

  function rewriteUriAttrs(line: string): string {
    return line.replace(/URI=(["'])([^"']+)\1/g, (_match, quote, rawUrl) => {
      return `URI=${quote}${proxyUrl(rawUrl)}${quote}`;
    });
  }

  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return line;
      if (trimmed.startsWith("#")) {
        return rewriteUriAttrs(line);
      }
      return proxyUrl(trimmed);
    })
    .join("\n");
}

// ─── Helper: Common Bilibili request headers ─────────────────────────────────

function bilibiliHeaders(aid: string): Record<string, string> {
  // Header lengkap meniru Chrome asli. Bilibili anti-abuse memeriksa kombinasi
  // User-Agent, sec-ch-ua, Sec-Fetch-*, Accept, Accept-Language, Origin.
  // Tanpa ini kadang kena 412 meski cookie valid.
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    Referer: `${BILIBILI_VIDEO_PAGE_BASE}/${aid}`,
    Origin: BILIBILI_ORIGIN,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    // Client hints — browser Chrome 115+ selalu kirim ini
    "sec-ch-ua":
      '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    // Fetch metadata — wajib untuk cross-origin XHR/fetch dari halaman bilibili
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    // DNT optional, tapi bikin request lebih "natural"
    DNT: "1",
    // Connection keepalive
    Connection: "keep-alive",
  };
  if (BILIBILI_COOKIE) {
    headers.Cookie = BILIBILI_COOKIE;
  }
  return headers;
}

// ─── Helper: Fetch playurl untuk satu qn + type ──────────────────────────────

async function fetchPlayurlOnce(
  aid: string,
  qn: number,
  type: "dash" | "mp4" = "dash",
): Promise<BilibiliPlayurlResponse> {
  // fnval: bitmask format yang diminta.
  //   fnval=16 → DASH (audio + video track terpisah)
  //   fnval=80 → DASH + 4K support
  // Tanpa fnval, beberapa response bilibili.tv intl tidak include audio[] array
  // meski type=dash sudah di-set. fnval=16 adalah minimal agar audio[] muncul.
  const fnval = type === "dash" ? "16" : "1";

  const params = new URLSearchParams({
    aid,
    s_locale: "id_ID",
    platform: "web",
    device: "pc",
    tf: "0",
    qn: String(qn),
    type,
    fnval,
  });

  // Retry dengan exponential backoff untuk HTTP 412 (rate-limit anti-abuse).
  // Bilibili kadang throttle request meski cookie login valid.
  const maxRetries = 3;
  let lastStatus = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      // 1s, 3s, 7s
      const delayMs = (2 ** attempt - 1) * 1000;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    const res = await fetch(`${BILIBILI_PLAYURL_API}?${params.toString()}`, {
      headers: bilibiliHeaders(aid),
    });
    lastStatus = res.status;
    if (res.ok) {
      return (await res.json()) as BilibiliPlayurlResponse;
    }
    // 412/429 = rate-limit, retry-able. 4xx lain biasanya permanen.
    if (res.status !== 412 && res.status !== 429 && res.status < 500) {
      throw new Error(
        `Bilibili playurl HTTP ${res.status} for aid ${aid} (type=${type})`,
      );
    }
  }
  throw new Error(
    `Bilibili playurl HTTP ${lastStatus} for aid ${aid} (type=${type}) after ${maxRetries} retries`,
  );
}

// ─── Helper: Multi-strategy audio URL extraction ─────────────────────────────
//
// Bilibili.tv JSON bentuknya bervariasi — kadang `data.playurl.audio[]` (intl),
// kadang `data.dash.audio[]` (format domestik diekspos di endpoint intl),
// kadang audio track ter-embed dalam `data.playurl.video[]` dengan mimeType
// audio (codecs mp4a.*) tanpa entri audio terpisah.
//
// Strategi urut: playurl.audio → dash.audio → scan video[] → null.

function extractAudioUrl(resp: BilibiliPlayurlResponse): {
  url: string | null;
  backups: string[];
  qn?: number;
  source: BilibiliMetadata["audio_source"];
} {
  // Strategy 1: data.playurl.audio[]  (format internasional standar)
  const playurlAudio = resp.data?.playurl?.audio ?? [];
  const bestPlayurl = [...playurlAudio]
    .filter((a) => a.video_resource?.url)
    .sort((a, b) => {
      const qa = a.stream_info?.quality ?? a.video_resource?.quality ?? 0;
      const qb = b.stream_info?.quality ?? b.video_resource?.quality ?? 0;
      return qb - qa;
    })[0];
  if (bestPlayurl?.video_resource?.url) {
    return {
      url: bestPlayurl.video_resource.url,
      backups: bestPlayurl.video_resource.backup_url ?? [],
      qn:
        bestPlayurl.stream_info?.quality ?? bestPlayurl.video_resource.quality,
      source: "playurl.audio",
    };
  }

  // Strategy 2: data.dash.audio[]  (format DASH domestik)
  const dashAudio = resp.data?.dash?.audio ?? [];
  const bestDash = [...dashAudio]
    .filter((a) => a.baseUrl || a.base_url)
    .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
  if (bestDash) {
    const url = bestDash.baseUrl ?? bestDash.base_url ?? null;
    if (url) {
      return {
        url,
        backups: bestDash.backupUrl ?? bestDash.backup_url ?? [],
        qn: bestDash.id,
        source: "dash.audio",
      };
    }
  }

  // Strategy 3: scan data.playurl.video[] untuk entri dengan mime_type/codecs audio
  // (misal codecs "mp4a.40.2" tanpa "avc1" / "hev1"). Ini jarang tapi ada di
  // beberapa respons legacy.
  const videoEntries = resp.data?.playurl?.video ?? [];
  for (const entry of videoEntries) {
    const mime = entry.video_resource?.mime_type ?? "";
    const codecs = entry.video_resource?.codecs ?? "";
    const looksLikeAudio =
      mime.startsWith("audio/") ||
      (codecs.includes("mp4a") &&
        !codecs.includes("avc") &&
        !codecs.includes("hev"));
    if (looksLikeAudio && entry.video_resource?.url) {
      return {
        url: entry.video_resource.url,
        backups: entry.video_resource.backup_url ?? [],
        qn: entry.stream_info?.quality ?? entry.video_resource.quality,
        source: "video_scan",
      };
    }
  }

  return { url: null, backups: [], source: "none" };
}

// ─── Helper: Fetch & parse metadata ──────────────────────────────────────────

async function fetchBilibiliMetadataUncached(
  aid: string,
): Promise<BilibiliMetadata> {
  // Step 1: request kualitas tertinggi dgn type=dash (biasanya kasih video+audio split)
  const initialDash = await fetchPlayurlOnce(aid, 112, "dash");

  if (initialDash.code !== 0 || !initialDash.data?.playurl) {
    throw new Error(
      `Bilibili playurl error code=${initialDash.code} message="${
        initialDash.message ?? "unknown"
      }"`,
    );
  }

  const videoEntries = initialDash.data.playurl.video ?? [];

  // Extract audio menggunakan multi-strategy
  let audioResult = extractAudioUrl(initialDash);

  // ── Map video entries → BilibiliVideo (dedup by name, keep highest qn)
  const byName = new Map<string, BilibiliVideo>();
  for (const entry of videoEntries) {
    const qn = entry.stream_info?.quality ?? entry.video_resource?.quality;
    const url = entry.video_resource?.url;
    if (!qn || !url) continue;

    // Skip kalau entri ini sebenarnya audio (ter-scan oleh strategy 3)
    const codecs = entry.video_resource?.codecs ?? "";
    const mime = entry.video_resource?.mime_type ?? "";
    if (
      mime.startsWith("audio/") ||
      (codecs.includes("mp4a") &&
        !codecs.includes("avc") &&
        !codecs.includes("hev"))
    ) {
      continue;
    }

    const name = QN_TO_NAME[qn] ?? `q${qn}`;
    const existing = byName.get(name);
    if (!existing || qn > existing.quality) {
      byName.set(name, {
        name,
        quality: qn,
        url,
        backup_urls: entry.video_resource?.backup_url ?? [],
        audio_url: audioResult.url ?? undefined,
        audio_backup_urls: audioResult.backups,
        audio_quality: audioResult.qn,
        container: "m4s",
      });
    }
  }

  // ── Fallback A: kalau cuma dapat 1 quality, paralel fetch sisanya (dash)
  if (byName.size <= 1) {
    const fallbackQns = [80, 64, 32, 16];
    await Promise.all(
      fallbackQns.map(async (qn) => {
        try {
          const r = await fetchPlayurlOnce(aid, qn, "dash");
          const v = r.data?.playurl?.video?.[0];
          const url = v?.video_resource?.url;
          const gotQn = v?.stream_info?.quality ?? v?.video_resource?.quality;
          if (r.code === 0 && url && gotQn) {
            const name = QN_TO_NAME[gotQn] ?? `q${gotQn}`;
            if (!byName.has(name)) {
              byName.set(name, {
                name,
                quality: gotQn,
                url,
                backup_urls: v.video_resource?.backup_url ?? [],
                audio_url: audioResult.url ?? undefined,
                audio_backup_urls: audioResult.backups,
                audio_quality: audioResult.qn,
                container: "m4s",
              });
            }
          }
        } catch {
          /* ignore fallback errors */
        }
      }),
    );
  }

  // ── Fallback B: kalau TIDAK dapat audio dari dash, coba type=mp4 sekali.
  //    Response type=mp4 biasanya kasih satu URL muxed (video+audio jadi satu)
  //    — kalau dapat, tambahkan sebagai entri terpisah (container: "mp4") yang
  //    TIDAK butuh audio_url (ffmpeg auto-pick audio dari file muxed).
  if (!audioResult.url) {
    try {
      const mp4Resp = await fetchPlayurlOnce(aid, 112, "mp4");
      if (mp4Resp.code === 0 && mp4Resp.data?.playurl?.video) {
        for (const entry of mp4Resp.data.playurl.video) {
          const qn =
            entry.stream_info?.quality ?? entry.video_resource?.quality;
          const url = entry.video_resource?.url;
          if (!qn || !url) continue;
          const name = QN_TO_NAME[qn] ?? `q${qn}`;
          // override dengan versi mp4-muxed — source audio paling reliable
          byName.set(name, {
            name,
            quality: qn,
            url,
            backup_urls: entry.video_resource?.backup_url ?? [],
            audio_url: undefined, // muxed
            container: "mp4",
          });
        }
        if (mp4Resp.data.playurl.video.some((v) => v.video_resource?.url)) {
          audioResult = {
            url: null,
            backups: [],
            source: "mp4_muxed",
          };
        }
      }
    } catch (err) {
      process.stderr.write(
        `[bilibili/metadata] type=mp4 fallback failed: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  if (byName.size === 0) {
    throw new Error("videos array not found in bilibili playurl response");
  }

  // Extract duration dari berbagai kemungkinan lokasi di response
  const tlMs =
    initialDash.data.video_info?.timelength ?? initialDash.data.timelength;
  const durationSec = tlMs
    ? Math.round((tlMs / 1000) * 100) / 100
    : initialDash.data.video_info?.duration;

  return {
    aid,
    title: initialDash.data.video_info?.title,
    duration_seconds: durationSec,
    videos: Array.from(byName.values()),
    has_audio: Boolean(audioResult.url) || audioResult.source === "mp4_muxed",
    audio_source: audioResult.source,
  };
}

// ─── Helper: stream upstream fetch Response → Fastify reply (Range-aware) ────

/**
 * Forward fetch Response body ke reply.raw, preserving:
 *   • Status code (200 atau 206 Partial Content)
 *   • Content-Type, Content-Length, Content-Range, Accept-Ranges
 *   • CORS headers
 *
 * Bikin browser <video> bisa seek native. Kalau upstream return 206, kita
 * forward 206 ke client. Kalau 200, forward 200.
 */
async function streamMp4Response(
  upstream: Response,
  reply: import("fastify").FastifyReply,
): Promise<void> {
  const status = upstream.status; // 200 atau 206
  const contentType = upstream.headers.get("content-type") ?? "video/mp4";
  const contentLength = upstream.headers.get("content-length");
  const contentRange = upstream.headers.get("content-range");
  const acceptRanges = upstream.headers.get("accept-ranges") ?? "bytes";

  const forwardHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": acceptRanges,
    "Cache-Control": VIDEO_SEGMENT_CACHE_CONTROL,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges",
  };
  if (contentLength) forwardHeaders["Content-Length"] = contentLength;
  if (contentRange) forwardHeaders["Content-Range"] = contentRange;

  reply.hijack();
  reply.raw.writeHead(status, forwardHeaders);

  try {
    await pipeline(
      upstream.body as unknown as NodeJS.ReadableStream,
      reply.raw,
    );
  } catch {
    // Normal kalau client disconnect mid-stream — abaikan.
  }
}

// ─── Helper: cached metadata fetch dengan in-flight dedup ───────────────────
//
// Bilibili playurl API sensitif terhadap rate — kalau di-hit berkali-kali dari
// IP yang sama dalam waktu singkat, return HTTP 412 (precondition failed =
// "anti-abuse"). Ini mudah terjadi karena HLS.js paralel fetch banyak segment
// sekaligus, dan tiap /hls-seg/:aid/:quality/:idx call fetchBilibiliMetadata.
//
// Solusi 2-lapis:
//   1. Cache hasil per aid dengan TTL (CDN token valid ~2 jam, kita pakai 30 menit)
//   2. In-flight dedup: kalau 10 request datang bersamaan untuk aid yang sama,
//      hanya 1 API call ke bilibili, 9 lain nya menunggu hasil yang sama.

const metadataCache = new Map<
  string,
  { metadata: BilibiliMetadata; fetchedAt: number }
>();
const metadataInflight = new Map<string, Promise<BilibiliMetadata>>();
const METADATA_CACHE_TTL = 30 * 60 * 1000; // 30 menit — CDN token biasanya valid ±2 jam

async function fetchBilibiliMetadata(aid: string): Promise<BilibiliMetadata> {
  // Cache hit?
  const cached = metadataCache.get(aid);
  if (cached && Date.now() - cached.fetchedAt < METADATA_CACHE_TTL) {
    return cached.metadata;
  }

  // Ada request yang sedang berjalan? Share Promise-nya.
  const inflight = metadataInflight.get(aid);
  if (inflight) return inflight;

  // Fresh fetch — register di inflight map supaya concurrent call share Promise.
  const promise = fetchBilibiliMetadataUncached(aid)
    .then((metadata) => {
      metadataCache.set(aid, { metadata, fetchedAt: Date.now() });
      return metadata;
    })
    .finally(() => {
      metadataInflight.delete(aid);
    });

  metadataInflight.set(aid, promise);
  return promise;
}

// ─── Helper: probe duration via ffmpeg ────────────────────────────────────────
// Cached per URL supaya tidak probe ulang untuk setiap segment request.

const durationCache = new Map<
  string,
  { durationSec: number; fetchedAt: number }
>();
const DURATION_CACHE_TTL = 10 * 60 * 1000; // 10 menit

async function probeDurationSeconds(
  videoUrl: string,
): Promise<number | undefined> {
  const cached = durationCache.get(videoUrl);
  if (cached && Date.now() - cached.fetchedAt < DURATION_CACHE_TTL) {
    return cached.durationSec;
  }

  const httpHeaders =
    [
      `User-Agent: ${BROWSER_UA}`,
      `Referer: ${BILIBILI_REFERER}`,
      `Origin: ${BILIBILI_ORIGIN}`,
    ].join("\r\n") + "\r\n";

  return new Promise((resolve) => {
    const ff = spawn(
      FFMPEG_BIN,
      [
        "-hide_banner",
        "-headers",
        httpHeaders,
        "-i",
        videoUrl,
        "-t",
        "0",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    const timeout = setTimeout(() => {
      try {
        ff.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve(undefined);
    }, 15_000);

    ff.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    ff.on("close", () => {
      clearTimeout(timeout);
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (match) {
        const h = parseInt(match[1] ?? "0", 10);
        const m = parseInt(match[2] ?? "0", 10);
        const s = parseFloat(match[3] ?? "0");
        const durationSec = h * 3600 + m * 60 + s;
        durationCache.set(videoUrl, { durationSec, fetchedAt: Date.now() });
        resolve(durationSec);
      } else {
        resolve(undefined);
      }
    });
    ff.on("error", () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const proxyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onSend", async (_req, reply) => {
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, OPTIONS")
      .header("Access-Control-Allow-Headers", "*");
  });

  app.options("*", async (_req, reply) => {
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, OPTIONS")
      .header("Access-Control-Allow-Headers", "*")
      .status(204)
      .send();
  });

  /**
   * GET /playlist/:aid
   *
   * Master M3U8 multi-quality.
   * Setiap quality → /media-playlist/:quality?vt=<video>&at=<audio?>
   *
   * Bilibili.tv tidak menyediakan HLS native — hanya DASH (.m4s) atau MP4 muxed.
   * Solusi: SEMUA quality di-wrap ffmpeg → MPEG-TS (progressive streaming + audio).
   */
  app.get<{ Params: { aid: string } }>("/playlist/:aid", async (req, reply) => {
    const { aid } = req.params;

    let metadata: BilibiliMetadata;
    try {
      metadata = await fetchBilibiliMetadata(aid);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: message });
    }

    const port = req.port ? `:${req.port}` : "";
    const baseUrl = `${req.protocol}://${req.hostname}${port}${BASE_PREFIX_SERVER_PATH}`;

    const m3u8Lines = ["#EXTM3U", "#EXT-X-VERSION:3"];

    for (const qualityName of QUALITY_ORDER) {
      const video = metadata.videos.find((v) => v.name === qualityName);
      if (!video) continue;

      const vt = encodeSegmentUrl(video.url);
      const bandwidth = NAME_TO_BANDWIDTH[qualityName];
      const resolution = NAME_TO_RESOLUTION[qualityName];

      // Selalu pakai /media-playlist → /stream (ffmpeg). `at` opsional.
      const subPlaylistUrl = video.audio_url
        ? `${baseUrl}/media-playlist/${qualityName}?vt=${vt}&at=${encodeSegmentUrl(video.audio_url)}`
        : `${baseUrl}/media-playlist/${qualityName}?vt=${vt}`;

      m3u8Lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution},NAME="${qualityName}"`,
        subPlaylistUrl,
      );
    }

    return reply
      .header("Content-Type", "application/vnd.apple.mpegurl")
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
      .send(m3u8Lines.join("\n"));
  });

  /**
   * GET /media-playlist/:quality?vt=<video_hex>&at=<audio_hex?>
   *
   * ★ ROUTING STRATEGY ★
   *
   *   • Ada audio token (`at=`)   → /stream  (ffmpeg mux video+audio → MPEG-TS)
   *   • Tanpa audio token         → /mp4-segment (raw passthrough, 206 Range support)
   *
   * Kenapa beda? Karena bilibili.tv intl sering return muxed MP4 (audio sudah
   * ter-embed di file video .m4s). File itu adalah fragmented MP4 yang valid
   * dan native-seekable oleh browser — tinggal forward Range request dari client
   * ke CDN → return 206 Partial Content. Tidak butuh ffmpeg, tidak ada
   * "download-sampai-selesai" problem.
   *
   * ffmpeg+MPEG-TS hanya dipakai kalau memang butuh MUX dua input HTTP jadi satu
   * stream (DASH dengan audio track terpisah).
   *
   * Backward-compat: `t=` (single token) masih diterima.
   */
  app.get<{
    Params: { quality: string };
    Querystring: { vt?: string; at?: string; t?: string };
  }>("/media-playlist/:quality", async (req, reply) => {
    const { vt, at, t } = req.query;
    const videoToken = vt ?? t;

    if (!videoToken) {
      return reply.status(400).send({ error: "Missing token (vt or t)" });
    }

    try {
      const url = decodeSegmentUrl(videoToken);
      new URL(url);
    } catch {
      return reply.status(400).send({ error: "Invalid video token" });
    }

    const port = req.port ? `:${req.port}` : "";
    const baseUrl = `${req.protocol}://${req.hostname}${port}${BASE_PREFIX_SERVER_PATH}`;
    const quality = req.params.quality;

    // SELALU ke /stream (ffmpeg → MPEG-TS). HLS.js butuh MPEG-TS atau CMAF fMP4
    // segment — tidak bisa play raw fragmented MP4 lewat HLS.
    //
    // UNTUK KASUS muxed MP4 tanpa audio terpisah, gunakan endpoint /mp4/:aid
    // langsung di `<video src="...">` — itu support Range (206) native.
    const segmentUrl = at
      ? `${baseUrl}/stream/${quality}?vt=${videoToken}&at=${at}`
      : `${baseUrl}/stream/${quality}?vt=${videoToken}`;

    const mediaPlaylist = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:86400",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-ALLOW-CACHE:YES",
      `#EXTINF:86400.0,${quality}`,
      segmentUrl,
      "#EXT-X-ENDLIST",
    ].join("\n");

    return reply
      .header("Content-Type", "application/vnd.apple.mpegurl")
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
      .send(mediaPlaylist);
  });

  /**
   * GET /stream/:quality?vt=<video_hex>&at=<audio_hex?>
   *
   * ★ FIX Bug 1 + Bug 2 ★
   *
   * Bilibili.tv men-serve .m4s (MPEG-DASH segment):
   *   Bug 1: Browser perlakukan .m4s sbg MP4 → download seluruhnya dulu
   *          (moov atom harus diparsing lengkap) → progress bar = download.
   *   Bug 2: Audio terpisah di file .m4s lain → video-only proxy = hening.
   *
   * Solusi: ffmpeg muxing + remuxing on-the-fly → MPEG-TS stream.
   *   • MPEG-TS = container streaming sejati; player start play sejak
   *     paket pertama tiba (chunked transfer, no Content-Length).
   *   • Codec copy (no re-encode) → overhead CPU minimal.
   *   • -flush_packets 1 + -fflags +nobuffer → ffmpeg flush ke stdout ASAP
   *     (tanpa ini, ffmpeg buffer beberapa detik dulu sebelum output).
   *   • Dua input HTTP pakai satu blok -headers global (berlaku semua input).
   *
   * Note: output chunked → Range tidak didukung di sini. Seeking tetap jalan
   * di level player: HLS.js akan re-request playlist, browser buat request
   * baru (bukan reseek pada stream yang sama). Ini tradeoff wajar untuk
   * proxy tanpa transcoding.
   */
  app.get<{
    Params: { quality: string };
    Querystring: { vt: string; at?: string };
  }>("/stream/:quality", async (req, reply) => {
    const { vt, at } = req.query;

    if (!vt) {
      return reply.status(400).send({ error: "Missing video token (vt)" });
    }

    let videoUrl: string;
    try {
      videoUrl = decodeSegmentUrl(vt);
      new URL(videoUrl);
    } catch {
      return reply.status(400).send({ error: "Invalid video token" });
    }

    let audioUrl: string | null = null;
    if (at) {
      try {
        const decoded = decodeSegmentUrl(at);
        new URL(decoded);
        audioUrl = decoded;
      } catch {
        audioUrl = null; // graceful degrade ke video-only
      }
    }

    // ── Build ffmpeg args ─────────────────────────────────────────────────────
    //
    // -headers sebagai global AVOption berlaku utk SEMUA HTTP input berikutnya.
    // Format: "Header1: val\r\nHeader2: val\r\n..." (harus diakhiri \r\n).
    //
    const httpHeaders =
      [
        `User-Agent: ${BROWSER_UA}`,
        `Referer: ${BILIBILI_REFERER}`,
        `Origin: ${BILIBILI_ORIGIN}`,
      ].join("\r\n") + "\r\n";

    const ffmpegArgs: string[] = [
      "-hide_banner",
      "-loglevel",
      "warning",
      // Reconnect pada drop koneksi. JANGAN pakai -reconnect_streamed — itu
      // bikin ffmpeg assume input adalah live stream dan TIDAK akan seek
      // untuk baca moov atom di akhir file (penyebab "download-until-done").
      "-reconnect",
      "1",
      "-reconnect_on_network_error",
      "1",
      "-reconnect_delay_max",
      "5",
      "-headers",
      httpHeaders,
      "-i",
      videoUrl,
    ];

    if (audioUrl) {
      ffmpegArgs.push(
        "-reconnect",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-reconnect_delay_max",
        "5",
        "-headers",
        httpHeaders,
        "-i",
        audioUrl,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
      );
    }
    // Single input (tanpa audioUrl): TIDAK pakai -map 0 eksplisit.
    // Biarkan ffmpeg auto-select stream terbaik → pick best video track +
    // best audio track kalau ada. Kalau file video-only, outputnya video saja
    // (tanpa error). -map 0 eksplisit akan maksa output audio stream meski
    // tidak ada = potensi error.

    ffmpegArgs.push(
      "-c:v",
      "copy",
      // Re-encode audio AAC (BUKAN copy). Alasan:
      //   AAC dalam container MP4/M4S = raw AudioSpecificConfig (ASC).
      //   AAC dalam container MPEG-TS = ADTS (harus punya sync word 0xFFF).
      //   `-c:a copy` TIDAK selalu auto-convert → audio sering silent/rusak.
      //   `-c:a aac` di-decode+re-encode → encapsulation ADTS valid.
      // Overhead kecil (AAC encode cepat); jauh lebih reliable.
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",
      "-f",
      "mpegts",
      "-muxdelay",
      "0",
      "-muxpreload",
      "0",
      "-flush_packets",
      "1",
      "-avoid_negative_ts",
      "make_zero",
      "pipe:1",
    );

    // ── Spawn ffmpeg ──────────────────────────────────────────────────────────

    process.stderr.write(
      `[bilibili/stream/${req.params.quality}] spawn: ` +
        `video=${videoUrl.substring(0, 80)}... ` +
        `audio=${audioUrl ? audioUrl.substring(0, 80) + "..." : "(none)"}\n`,
    );

    const ff = spawn(FFMPEG_BIN, ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let ffmpegFailed = false;

    ff.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString();
      if (msg.trim()) {
        process.stderr.write(`[bilibili/stream/${req.params.quality}] ${msg}`);
      }
    });

    ff.on("error", (err) => {
      ffmpegFailed = true;
      process.stderr.write(
        `[bilibili/stream] ffmpeg spawn error: ${err.message}\n` +
          "Pastikan ffmpeg terpasang di server (apt install ffmpeg / brew install ffmpeg).\n",
      );
    });

    // Beri waktu singkat untuk menangkap spawn error sebelum hijack
    await new Promise((r) => setImmediate(r));

    if (ffmpegFailed) {
      return reply
        .status(500)
        .send({ error: "ffmpeg not available on server" });
    }

    // ── Hijack response — raw Node.js HTTP write ─────────────────────────────

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "video/MP2T",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": VIDEO_SEGMENT_CACHE_CONTROL,
      "Transfer-Encoding": "chunked",
    });

    // Kill ffmpeg kalau client disconnect (cegah zombie process)
    const killFfmpeg = () => {
      if (!ff.killed) {
        try {
          ff.kill("SIGTERM");
          setTimeout(() => {
            if (!ff.killed) ff.kill("SIGKILL");
          }, 3000);
        } catch {
          /* ignore */
        }
      }
    };
    reply.raw.on("close", killFfmpeg);
    reply.raw.on("error", killFfmpeg);

    // Pipe ffmpeg stdout → response (chunked streaming)
    ff.stdout.pipe(reply.raw, { end: true });

    // Handler harus return Promise — tunggu ffmpeg exit
    await new Promise<void>((resolve) => {
      ff.on("close", () => resolve());
      ff.on("error", () => resolve());
    });
  });

  /**
   * GET /segment?t=<hex>
   * Reserved — untuk future DASH/HLS manifest rewriting.
   */
  app.get<{ Querystring: { t: string } }>("/segment", async (req, reply) => {
    const { t } = req.query;
    if (!t) return reply.status(400).send({ error: "Missing token" });

    let targetUrl: string;
    try {
      targetUrl = decodeSegmentUrl(t);
      new URL(targetUrl);
    } catch {
      return reply.status(400).send({ error: "Invalid token" });
    }

    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Referer: BILIBILI_REFERER,
        Origin: BILIBILI_ORIGIN,
      },
    });

    if (!upstream.ok || !upstream.body) {
      return reply
        .status(upstream.status)
        .send({ error: "Segment fetch failed" });
    }

    const contentType = upstream.headers.get("content-type") ?? "video/mp2t";
    const looksLikeM3u8ByMeta =
      contentType.includes("mpegurl") || targetUrl.includes(".m3u8");

    if (looksLikeM3u8ByMeta) {
      const bodyText = await upstream.text();

      if (!bodyText.trimStart().startsWith("#EXTM3U")) {
        const buffer = Buffer.from(bodyText, "latin1");
        return reply
          .header("Content-Type", contentType)
          .header("Access-Control-Allow-Origin", "*")
          .header("Cache-Control", "public, max-age=3600")
          .send(buffer);
      }

      const port = req.port ? `:${req.port}` : "";
      const baseUrl = `${req.protocol}://${req.hostname}${port}${BASE_PREFIX_SERVER_PATH}`;
      const rewritten = rewriteM3u8(bodyText, baseUrl, targetUrl);
      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .header("Access-Control-Allow-Origin", "*")
        .send(rewritten);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": "public, max-age=3600",
    });

    await pipeline(
      upstream.body as unknown as NodeJS.ReadableStream,
      reply.raw,
    );
  });

  /**
   * GET /mp4-segment/:quality?t=<hex>
   *
   * DEBUG ONLY — raw video .m4s proxy (video-only, downloads entire file).
   * Tidak dipakai lagi oleh /media-playlist (routing sudah selalu ke /stream).
   * Tetap disediakan untuk debug manual / curl test.
   */
  app.get<{
    Params: { quality: string };
    Querystring: { t: string };
  }>("/mp4-segment/:quality", async (req, reply) => {
    const { t } = req.query;
    if (!t) return reply.status(400).send({ error: "Missing token" });

    let targetUrl: string;
    try {
      targetUrl = decodeSegmentUrl(t);
      new URL(targetUrl);
    } catch {
      return reply.status(400).send({ error: "Invalid token" });
    }

    const rangeHeader = req.headers["range"];
    const headers: Record<string, string> = {
      "User-Agent": BROWSER_UA,
      Referer: BILIBILI_REFERER,
      Origin: BILIBILI_ORIGIN,
    };
    if (rangeHeader) headers["Range"] = rangeHeader;

    const upstream = await fetch(targetUrl, { headers });

    if (!upstream.ok || !upstream.body) {
      return reply.status(upstream.status).send({ error: "MP4 fetch failed" });
    }

    const status = upstream.status; // 200 atau 206
    const forwardHeaders: Record<string, string> = {
      "Content-Type": upstream.headers.get("content-type") ?? "video/mp4",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Accept-Ranges": "bytes",
    };

    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    if (contentLength) forwardHeaders["Content-Length"] = contentLength;
    if (contentRange) forwardHeaders["Content-Range"] = contentRange;

    reply.hijack();
    reply.raw.writeHead(status, forwardHeaders);

    await pipeline(
      upstream.body as unknown as NodeJS.ReadableStream,
      reply.raw,
    );
  });

  /**
   * GET /audio-segment/:aid?t=<hex>
   *
   * Audio-only proxy — untuk frontend yang pakai MSE (Media Source Extensions)
   * alih-alih server-side ffmpeg. Support Range request.
   */
  app.get<{
    Params: { aid: string };
    Querystring: { t: string };
  }>("/audio-segment/:aid", async (req, reply) => {
    const { t } = req.query;
    if (!t) return reply.status(400).send({ error: "Missing token" });

    let targetUrl: string;
    try {
      targetUrl = decodeSegmentUrl(t);
      new URL(targetUrl);
    } catch {
      return reply.status(400).send({ error: "Invalid token" });
    }

    const rangeHeader = req.headers["range"];
    const headers: Record<string, string> = {
      "User-Agent": BROWSER_UA,
      Referer: BILIBILI_REFERER,
      Origin: BILIBILI_ORIGIN,
    };
    if (rangeHeader) headers["Range"] = rangeHeader;

    const upstream = await fetch(targetUrl, { headers });

    if (!upstream.ok || !upstream.body) {
      return reply
        .status(upstream.status)
        .send({ error: "Audio fetch failed" });
    }

    const status = upstream.status;
    const forwardHeaders: Record<string, string> = {
      "Content-Type": upstream.headers.get("content-type") ?? "audio/mp4",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Accept-Ranges": "bytes",
    };

    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    if (contentLength) forwardHeaders["Content-Length"] = contentLength;
    if (contentRange) forwardHeaders["Content-Range"] = contentRange;

    reply.hijack();
    reply.raw.writeHead(status, forwardHeaders);

    await pipeline(
      upstream.body as unknown as NodeJS.ReadableStream,
      reply.raw,
    );
  });

  /**
   * GET /info/:aid
   * Debug — metadata hasil parse (video URLs, audio URL, audio_source flag).
   */
  app.get<{ Params: { aid: string } }>("/info/:aid", async (req, reply) => {
    try {
      const metadata = await fetchBilibiliMetadata(req.params.aid);
      return reply.send(metadata);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: message });
    }
  });

  /**
   * GET /raw/:aid?qn=<number>&type=<dash|mp4>
   * Debug — respons mentah dari bilibili playurl API.
   */
  app.get<{
    Params: { aid: string };
    Querystring: { qn?: string; type?: "dash" | "mp4" };
  }>("/raw/:aid", async (req, reply) => {
    try {
      const qn = parseInt(req.query.qn ?? "112", 10);
      const type = req.query.type === "mp4" ? "mp4" : "dash";
      const raw = await fetchPlayurlOnce(req.params.aid, qn, type);
      return reply.send(raw);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: message });
    }
  });

  /**
   * GET /debug/:aid
   * Debug end-to-end — fetch metadata + tampilkan URL yang akan di-pipe
   * ke ffmpeg, plus ffmpeg args yang akan dipakai /stream/full.
   */
  /**
   * GET /cache/clear  |  GET /cache/clear/:aid
   * Reset metadata cache. Berguna kalau cookie berubah atau URL expired.
   */
  app.get<{ Params: { aid?: string } }>(
    "/cache/clear/:aid",
    async (req, reply) => {
      const { aid } = req.params;
      if (aid) {
        metadataCache.delete(aid);
        metadataInflight.delete(aid);
        return reply.send({ cleared: aid });
      }
      metadataCache.clear();
      metadataInflight.clear();
      durationCache.clear();
      return reply.send({ cleared: "all" });
    },
  );
  app.get("/cache/clear", async (_req, reply) => {
    const beforeCount = metadataCache.size;
    metadataCache.clear();
    metadataInflight.clear();
    durationCache.clear();
    return reply.send({
      cleared: "all",
      previous_metadata_entries: beforeCount,
    });
  });

  app.get<{ Params: { aid: string } }>("/debug/:aid", async (req, reply) => {
    try {
      const metadata = await fetchBilibiliMetadata(req.params.aid);
      const first = metadata.videos[0];
      const port = req.port ? `:${req.port}` : "";
      const baseUrl = `${req.protocol}://${req.hostname}${port}${BASE_PREFIX_SERVER_PATH}`;

      const preview = first && {
        master_playlist: `${baseUrl}/playlist/${req.params.aid}`,
        hls_segmented: `${baseUrl}/hls/${req.params.aid}`,
        direct_mp4: `${baseUrl}/mp4/${req.params.aid}?quality=${first.name}`,
        direct_fmp4: `${baseUrl}/direct/${req.params.aid}?quality=${first.name}`,
        sample_stream_url: first.audio_url
          ? `${baseUrl}/stream/${first.name}?vt=${encodeSegmentUrl(first.url)}&at=${encodeSegmentUrl(first.audio_url)}`
          : `${baseUrl}/stream/${first.name}?vt=${encodeSegmentUrl(first.url)}`,
        video_input: first.url,
        audio_input: first.audio_url ?? "(muxed / none)",
        container_hint: first.container,
      };

      return reply.send({ metadata, preview });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: message });
    }
  });

  /**
   * GET /mp4/:aid?quality=hd
   *
   * ★★ PURE RANGE PASSTHROUGH — untuk tag <video src="..."> ★★
   *
   * Resolve metadata → forward Range request dari client ke CDN bilibili →
   * return 206 Partial Content persis seperti bilibili aslinya.
   *
   * Tidak ada ffmpeg, tidak ada re-encode, tidak ada transmux — raw passthrough.
   * Ini yang bikin:
   *   • 206 Partial Content (bukan 200 download-forever)
   *   • Seeking instant (browser kirim Range: bytes=X-, CDN return 206)
   *   • Zero CPU overhead di server
   *
   * Pemakaian frontend (paling simple, tidak butuh library):
   *   <video controls
   *     src="http://server/api/video-stream/bilibili-stream/mp4/4795530521745409?quality=hd">
   *   </video>
   *
   * Catatan audio: kalau file .m4s bilibili video-only (no audio track),
   * endpoint ini akan play video tanpa suara. Untuk video dengan audio terpisah,
   * gunakan /direct/:aid (ffmpeg mux → fMP4) atau /playlist/:aid (HLS).
   */
  app.get<{
    Params: { aid: string };
    Querystring: { quality?: string };
  }>("/mp4/:aid", async (req, reply) => {
    const { aid } = req.params;
    const quality = req.query.quality ?? "hd";

    let metadata: BilibiliMetadata;
    try {
      metadata = await fetchBilibiliMetadata(aid);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: msg });
    }

    const video =
      metadata.videos.find((v) => v.name === quality) ??
      [...metadata.videos].sort((a, b) => b.quality - a.quality)[0];

    if (!video) {
      return reply.status(404).send({ error: "No video available" });
    }

    // Forward Range kalau ada. Browser <video> biasanya start dengan:
    //   Range: bytes=0-       (initial probe → CDN 206)
    //   Range: bytes=N-       (setelah user seek → CDN 206)
    const rangeHeader = req.headers["range"];
    const upstreamHeaders: Record<string, string> = {
      "User-Agent": BROWSER_UA,
      Referer: BILIBILI_REFERER,
      Origin: BILIBILI_ORIGIN,
    };
    if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;

    const upstream = await fetch(video.url, { headers: upstreamHeaders });

    if (!upstream.ok || !upstream.body) {
      // Coba backup URL kalau primary gagal
      const backup = video.backup_urls?.[0];
      if (backup) {
        const retry = await fetch(backup, { headers: upstreamHeaders });
        if (retry.ok && retry.body) {
          return streamMp4Response(retry, reply);
        }
      }
      return reply
        .status(upstream.status || 502)
        .send({ error: "Upstream fetch failed", status: upstream.status });
    }

    return streamMp4Response(upstream, reply);
  });

  /**
   * GET /direct/:aid?quality=hd
   *
   * ★ ENDPOINT ffmpeg fMP4 — untuk tag <video src="..."> LANGSUNG, tanpa HLS.js ★
   *
   * Output: fragmented MP4 (fMP4) — natively playable di Chrome/Firefox/Safari
   * via tag <video>. fMP4 mulai play dari fragment pertama yang sampai
   * (progressive), tidak perlu download seluruh file dulu.
   *
   * Pemakaian di frontend:
   *   <video controls
   *     src="http://server/api/video-stream/bilibili-stream/direct/4795530521745409?quality=hd">
   *   </video>
   *
   * Keunggulan vs /playlist (HLS + MPEG-TS):
   *   • Tidak butuh hls.js di frontend
   *   • Progressive play instan
   *   • Audio native (AAC di MP4 container, tidak perlu ADTS re-encode yg rentan)
   *   • Seeking lebih baik (browser handle byte-range di buffered portion)
   *
   * flag -movflags:
   *   frag_keyframe        → fragment baru setiap keyframe video
   *   empty_moov           → moov box kosong di awal (full codec info di tiap moof)
   *   default_base_moof    → base offset relatif moof (compat lebih luas)
   */
  app.get<{
    Params: { aid: string };
    Querystring: { quality?: string };
  }>("/direct/:aid", async (req, reply) => {
    const { aid } = req.params;
    const quality = req.query.quality ?? "hd";

    let metadata: BilibiliMetadata;
    try {
      metadata = await fetchBilibiliMetadata(aid);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: msg });
    }

    const video =
      metadata.videos.find((v) => v.name === quality) ??
      [...metadata.videos].sort((a, b) => b.quality - a.quality)[0];

    if (!video) {
      return reply.status(404).send({ error: "No video available" });
    }

    const httpHeaders =
      [
        `User-Agent: ${BROWSER_UA}`,
        `Referer: ${BILIBILI_REFERER}`,
        `Origin: ${BILIBILI_ORIGIN}`,
      ].join("\r\n") + "\r\n";

    const ffmpegArgs: string[] = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-reconnect",
      "1",
      "-reconnect_on_network_error",
      "1",
      "-reconnect_delay_max",
      "5",
      "-headers",
      httpHeaders,
      "-i",
      video.url,
    ];

    if (video.audio_url) {
      ffmpegArgs.push(
        "-reconnect",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-reconnect_delay_max",
        "5",
        "-headers",
        httpHeaders,
        "-i",
        video.audio_url,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
      );
    }
    // Single input → ffmpeg auto-select stream

    ffmpegArgs.push(
      "-c:v",
      "copy",
      // Untuk fMP4 output, -c:a copy biasanya OK (MP4→MP4 sama container).
      // Tapi kalau source punya audio format aneh, fallback ke aac encode.
      "-c:a",
      "copy",
      "-f",
      "mp4",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "pipe:1",
    );

    process.stderr.write(
      `[bilibili/direct/${aid}] quality=${video.name} ` +
        `audio_source=${metadata.audio_source} ` +
        `audio_url=${video.audio_url ? "separate" : "(muxed/none)"}\n`,
    );

    const ff = spawn(FFMPEG_BIN, ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let ffmpegFailed = false;

    ff.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString();
      if (msg.trim()) {
        process.stderr.write(`[bilibili/direct/${aid}] ${msg}`);
      }
    });

    ff.on("error", (err) => {
      ffmpegFailed = true;
      process.stderr.write(`[bilibili/direct] ffmpeg error: ${err.message}\n`);
    });

    await new Promise((r) => setImmediate(r));

    if (ffmpegFailed) {
      return reply.status(500).send({ error: "ffmpeg not available" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "video/mp4",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": VIDEO_SEGMENT_CACHE_CONTROL,
      "Transfer-Encoding": "chunked",
      "X-Accel-Buffering": "no",
    });

    const killFfmpeg = () => {
      if (!ff.killed) {
        try {
          ff.kill("SIGTERM");
          setTimeout(() => {
            if (!ff.killed) ff.kill("SIGKILL");
          }, 3000);
        } catch {
          /* ignore */
        }
      }
    };
    reply.raw.on("close", killFfmpeg);
    reply.raw.on("error", killFfmpeg);

    ff.stdout.pipe(reply.raw, { end: true });

    await new Promise<void>((resolve) => {
      ff.on("close", () => resolve());
      ff.on("error", () => resolve());
    });
  });

  /**
   * GET /probe/:aid?quality=hd
   *
   * Diagnostic — pakai ffmpeg untuk inspect stream info dari URL .m4s
   * bilibili. Berguna untuk verify apakah file-nya:
   *   - punya audio track (has_audio: true/false)
   *   - codec apa (h264/hevc/av1 untuk video; aac/opus untuk audio)
   *   - durasi berapa
   *
   * Kalau has_audio=false di sini, berarti .m4s memang video-only dan
   * kita butuh audio URL terpisah (yang saat ini tidak ada di response API).
   */
  app.get<{
    Params: { aid: string };
    Querystring: { quality?: string };
  }>("/probe/:aid", async (req, reply) => {
    try {
      const metadata = await fetchBilibiliMetadata(req.params.aid);
      const quality = req.query.quality ?? "hd";
      const video =
        metadata.videos.find((v) => v.name === quality) ?? metadata.videos[0];
      if (!video) {
        return reply.status(404).send({ error: "No video available" });
      }

      const httpHeaders =
        [
          `User-Agent: ${BROWSER_UA}`,
          `Referer: ${BILIBILI_REFERER}`,
          `Origin: ${BILIBILI_ORIGIN}`,
        ].join("\r\n") + "\r\n";

      // `ffmpeg -i <url>` tanpa output → cetak info stream ke stderr, exit 1.
      const probeArgs = [
        "-hide_banner",
        "-reconnect",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-headers",
        httpHeaders,
        "-i",
        video.url,
      ];

      const info = await new Promise<string>((resolve) => {
        const fp = spawn(FFMPEG_BIN, probeArgs, {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        fp.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        fp.on("close", () => resolve(stderr));
        fp.on("error", (e) => resolve(`ffmpeg spawn error: ${e.message}`));
        // timeout 15s
        setTimeout(() => {
          if (!fp.killed) fp.kill("SIGKILL");
        }, 15000);
      });

      const hasAudio = /Stream\s*#\d+:\d+.*Audio/i.test(info);
      const hasVideo = /Stream\s*#\d+:\d+.*Video/i.test(info);
      const durationMatch = info.match(/Duration:\s*([\d:.]+)/);
      const videoCodecMatch = info.match(/Video:\s*(\w+)/);
      const audioCodecMatch = info.match(/Audio:\s*(\w+)/);

      return reply.send({
        quality: video.name,
        container: video.container,
        url_preview: video.url.substring(0, 120) + "...",
        has_video: hasVideo,
        has_audio: hasAudio,
        video_codec: videoCodecMatch?.[1] ?? null,
        audio_codec: audioCodecMatch?.[1] ?? null,
        duration: durationMatch?.[1] ?? null,
        raw_ffmpeg_output: info,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: message });
    }
  });

  /**
   * GET /ogv/:epId
   * Optional — konten OGV (anime/series) yang pakai ep_id bukan aid.
   */
  app.get<{ Params: { epId: string } }>("/ogv/:epId", async (req, reply) => {
    const { epId } = req.params;
    const params = new URLSearchParams({
      ep_id: epId,
      s_locale: "id_ID",
      platform: "web",
      device: "pc",
      tf: "0",
      qn: "112",
    });

    try {
      const res = await fetch(`${BILIBILI_OGV_PLAY_API}?${params.toString()}`, {
        headers: bilibiliHeaders(epId),
      });
      if (!res.ok) {
        return reply.status(res.status).send({
          error: `Bilibili OGV HTTP ${res.status}`,
        });
      }
      const json = await res.json();
      return reply.send(json);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: message });
    }
  });

  // ═══ HLS v2: Segmented playlist dengan ffmpeg -ss -t ════════════════════════════
  //
  // Arsitektur:
  //   1. /hls/:aid                    → master M3U8 (quality variants)
  //   2. /hls-list/:aid/:quality      → media M3U8 dengan banyak segment 10-detik
  //   3. /hls-seg/:aid/:quality/:idx  → segment ke-idx (MPEG-TS, ffmpeg -ss N -t 10)
  //
  // KUNCI: ffmpeg -ss <offset> -i <url> pakai byte-range request ke CDN (karena
  // bilibili CDN support 206 Range). Jadi segment ke-100 tidak butuh download
  // segment 0–99 dulu — langsung seek.
  //
  // HLS.js di frontend hanya download segment yang diperlukan → seek instant,
  // no "download-sampai-selesai".

  /**
   * GET /hls/:aid
   * Master playlist dengan quality variants. Tiap variant point ke /hls-list.
   */
  app.get<{ Params: { aid: string } }>("/hls/:aid", async (req, reply) => {
    const { aid } = req.params;
    const port = req.port ? `:${req.port}` : "";
    const baseUrl = `${req.protocol}://${req.hostname}${port}${BASE_PREFIX_SERVER_PATH}`;

    let metadata: BilibiliMetadata;
    try {
      metadata = await fetchBilibiliMetadata(aid);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: msg });
    }

    const bwTable: Record<string, number> = {
      full: 5_000_000,
      hd: 3_000_000,
      sd: 1_500_000,
      low: 800_000,
      lowest: 400_000,
      mobile: 300_000,
    };
    const resTable: Record<string, string> = {
      full: "1920x1080",
      hd: "1280x720",
      sd: "854x480",
      low: "640x360",
      lowest: "426x240",
      mobile: "320x180",
    };

    const lines: string[] = ["#EXTM3U", "#EXT-X-VERSION:3"];
    for (const v of metadata.videos) {
      const bw = bwTable[v.name] ?? 2_000_000;
      const resolution = resTable[v.name] ?? "1280x544";
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${resolution},NAME="${v.name}"`,
        `${baseUrl}/hls-list/${aid}/${v.name}`,
      );
    }

    return reply
      .header("Content-Type", "application/vnd.apple.mpegurl")
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
      .send(lines.join("\n"));
  });

  /**
   * GET /hls-list/:aid/:quality
   * Media playlist dengan banyak segment 10-detik.
   *
   * Duration diambil dari metadata.duration_seconds (dari API timelength).
   * Kalau tidak tersedia, fallback ke probe ffmpeg atau default 3600s.
   */
  app.get<{ Params: { aid: string; quality: string } }>(
    "/hls-list/:aid/:quality",
    async (req, reply) => {
      const { aid, quality } = req.params;
      const port = req.port ? `:${req.port}` : "";
      const baseUrl = `${req.protocol}://${req.hostname}${port}${BASE_PREFIX_SERVER_PATH}`;

      let metadata: BilibiliMetadata;
      try {
        metadata = await fetchBilibiliMetadata(aid);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ error: msg });
      }

      // Resolve duration. Prioritas:
      //   1. metadata.duration_seconds (dari bilibili API timelength)
      //   2. ffprobe via ffmpeg -i (ambil dari stderr)
      //   3. fallback 3600s (60 menit)
      let durationSec = metadata.duration_seconds;
      if (!durationSec) {
        const video =
          metadata.videos.find((v) => v.name === quality) ?? metadata.videos[0];
        if (video) {
          durationSec = await probeDurationSeconds(video.url);
        }
      }
      if (!durationSec || durationSec < 1) durationSec = 3600;

      const SEGMENT_DURATION = 10; // detik per segment
      const totalSegments = Math.ceil(durationSec / SEGMENT_DURATION);

      const lines: string[] = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        `#EXT-X-TARGETDURATION:${SEGMENT_DURATION + 1}`,
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
      ];

      for (let i = 0; i < totalSegments; i++) {
        const segStart = i * SEGMENT_DURATION;
        const segDur = Math.min(SEGMENT_DURATION, durationSec - segStart);
        lines.push(
          `#EXTINF:${segDur.toFixed(3)},`,
          `${baseUrl}/hls-seg/${aid}/${quality}/${i}.ts`,
        );
      }
      lines.push("#EXT-X-ENDLIST");

      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
        .send(lines.join("\n"));
    },
  );

  /**
   * GET /hls-seg/:aid/:quality/:idx.ts
   *
   * Render segment MPEG-TS. Pakai ffmpeg `-ss <offset> -t 10 -i <url>` —
   * ffmpeg akan seek via byte-range request ke CDN (CDN respond 206).
   * Codec copy → ringan CPU. Kalau copy gagal di boundary keyframe,
   * auto-fallback ke re-encode H.264 untuk segment itu.
   */
  app.get<{ Params: { aid: string; quality: string; idx: string } }>(
    "/hls-seg/:aid/:quality/:idx",
    async (req, reply) => {
      const { aid, quality } = req.params;
      const idxRaw = req.params.idx.replace(/\.ts$/, "");
      const idx = parseInt(idxRaw, 10);
      if (!Number.isFinite(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid segment index" });
      }

      let metadata: BilibiliMetadata;
      try {
        metadata = await fetchBilibiliMetadata(aid);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ error: msg });
      }

      const video =
        metadata.videos.find((v) => v.name === quality) ??
        [...metadata.videos].sort((a, b) => b.quality - a.quality)[0];
      if (!video) return reply.status(404).send({ error: "No video" });

      const SEGMENT_DURATION = 10;
      const startSec = idx * SEGMENT_DURATION;

      const httpHeaders =
        [
          `User-Agent: ${BROWSER_UA}`,
          `Referer: ${BILIBILI_REFERER}`,
          `Origin: ${BILIBILI_ORIGIN}`,
        ].join("\r\n") + "\r\n";

      // -ss SEBELUM -i  → input seek (fast, pakai byte-range request ke CDN).
      // -ss SETELAH -i  → output seek (lambat, decode semua lalu discard).
      // Untuk MP4 di HTTP server yang support Range, input seek jalan sempurna.
      const ffmpegArgs: string[] = [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-ss",
        String(startSec),
        "-reconnect",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-reconnect_delay_max",
        "5",
        "-headers",
        httpHeaders,
        "-i",
        video.url,
        "-t",
        String(SEGMENT_DURATION),
        // Copy codec kalau keyframe align, fallback encode. Bilibili HEVC di
        // MPEG-TS kadang butuh re-wrap. -copyts kritis supaya timestamp kontinu
        // antar segment (tidak ada glitch).
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-copyts",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-f",
        "mpegts",
        "pipe:1",
      ];

      const ff = spawn(FFMPEG_BIN, ffmpegArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let ffmpegFailed = false;
      ff.stderr.on("data", (chunk: Buffer) => {
        const msg = chunk.toString();
        if (msg.trim() && !msg.includes("deprecated")) {
          process.stderr.write(`[bilibili/hls-seg/${aid}/${idx}] ${msg}`);
        }
      });
      ff.on("error", (err) => {
        ffmpegFailed = true;
        process.stderr.write(
          `[bilibili/hls-seg] ffmpeg spawn error: ${err.message}\n`,
        );
      });

      await new Promise((r) => setImmediate(r));
      if (ffmpegFailed) {
        return reply.status(500).send({ error: "ffmpeg not available" });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "video/MP2T",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Cache-Control": "public, max-age=3600",
        "Transfer-Encoding": "chunked",
        "X-Accel-Buffering": "no",
      });

      const killFfmpeg = () => {
        if (!ff.killed) {
          try {
            ff.kill("SIGTERM");
            setTimeout(() => {
              if (!ff.killed) ff.kill("SIGKILL");
            }, 2000);
          } catch {
            /* ignore */
          }
        }
      };

      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) killFfmpeg();
      });

      try {
        await pipeline(ff.stdout, reply.raw);
      } catch {
        killFfmpeg();
      }
    },
  );
};
