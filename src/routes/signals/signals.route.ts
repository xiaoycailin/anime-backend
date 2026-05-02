import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { probeHlsSegmentDimensions } from "../../services/hls-probe.service";
import { badRequest } from "../../utils/http-error";
import { created, ok } from "../../utils/response";

type SignalType =
  | "playlist"
  | "manifest"
  | "subtitle"
  | "segment"
  | "video"
  | "audio"
  | "stream"
  | "text"
  | "binary"
  | "other";

type SignalBody = {
  url?: string;
  type?: SignalType | string;
  source?: string;
  method?: string;
  contentType?: string;
  pageUrl?: string;
  statusCode?: number;
  requestId?: string;
  capturedAt?: number;
};

type SignalRecord = {
  id: string;
  url: string;
  type: string;
  source?: string;
  method?: string;
  contentType?: string;
  pageUrl?: string;
  statusCode?: number;
  requestId?: string;
  capturedAt?: number;
  receivedAt: string;
};

type AnalyzeBody = {
  urls?: string[];
};

type PlaylistAnalysis = {
  url: string;
  resolution: number | null;
  hintedResolution: number | null;
  bandwidth: number | null;
  sampleSizeBytes: number | null;
  sampleDurationSeconds: number | null;
  sampleSegmentUrl: string | null;
  sampleCount: number;
  probedResolution: number | null;
  probedWidth: number | null;
  probedHeight: number | null;
  detectedFrom: string;
  error?: string;
};

type SubtitleLanguage = {
  code: string;
  label: string;
  aliases: string[];
  markers: string[];
};

const MAX_SIGNALS = 300;
const signalClients = new Set<FastifyReply>();
const signals: SignalRecord[] = [];
const SUBTITLE_LANGUAGES: SubtitleLanguage[] = [
  {
    code: "id",
    label: "Bahasa Indonesia",
    aliases: ["id", "ind", "ina", "indonesia", "bahasa"],
    markers: ["yang", "dan", "aku", "kamu", "tidak", "dengan", "untuk", "dari", "ini", "itu", "akan"],
  },
  {
    code: "en",
    label: "English",
    aliases: ["en", "eng", "english"],
    markers: ["the", "and", "you", "not", "with", "that", "this", "for", "from", "will", "what"],
  },
  {
    code: "ms",
    label: "Bahasa Melayu",
    aliases: ["ms", "msa", "may", "malay", "melayu"],
    markers: ["yang", "dan", "saya", "awak", "tidak", "dengan", "untuk", "daripada"],
  },
  {
    code: "ja",
    label: "Japanese",
    aliases: ["ja", "jpn", "japanese", "nihongo"],
    markers: [],
  },
  {
    code: "ko",
    label: "Korean",
    aliases: ["ko", "kor", "korean"],
    markers: [],
  },
  {
    code: "zh",
    label: "Chinese",
    aliases: ["zh", "chi", "zho", "chinese", "cn", "sc", "tc"],
    markers: [],
  },
];

function setOpenCors(reply: FastifyReply) {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "*");
}

function normalizeSignal(body: SignalBody): SignalRecord {
  const url = body?.url?.trim();
  const type = body?.type?.trim();

  if (!url) throw badRequest("Signal URL wajib diisi");
  if (!type) throw badRequest("Signal type wajib diisi");

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw badRequest("Signal URL harus URL http/https yang valid");
  }

  return {
    id: crypto.randomUUID(),
    url,
    type,
    source: body.source,
    method: body.method,
    contentType: body.contentType,
    pageUrl: body.pageUrl,
    statusCode: body.statusCode,
    requestId: body.requestId,
    capturedAt: body.capturedAt,
    receivedAt: new Date().toISOString(),
  };
}

function assertHttpUrl(rawUrl: string) {
  const url = rawUrl.trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
    return parsed.toString();
  } catch {
    throw badRequest("Signal URL harus URL http/https yang valid");
  }
}

function resolvePlaylistUrl(baseUrl: string, path: string) {
  return new URL(path, baseUrl).toString();
}

function parseAttribute(line: string, key: string) {
  const match = line.match(new RegExp(`${key}=([^,]+)`, "i"));
  return match?.[1]?.replace(/^"|"$/g, "");
}

function inferResolutionFromUrl(url: string): number | null {
  const match = url.match(/\.f(\d{6})\.ts\.m3u8/i);
  if (!match) return null;
  const code = match[1];
  const tail = code.slice(-3);
  const wetvMap: Record<string, number> = {
    "007": 144,
    "004": 360,
    "003": 480,
    "002": 720,
    "001": 1080,
  };
  return wetvMap[tail] ?? null;
}

function resolutionLadder(count: number) {
  if (count >= 6) return [144, 240, 360, 480, 720, 1080].slice(-count);
  if (count === 5) return [144, 360, 480, 720, 1080];
  if (count === 4) return [360, 480, 720, 1080];
  if (count === 3) return [480, 720, 1080];
  if (count === 2) return [720, 1080];
  return [1080];
}

function snapProbeResolution(width: number, height: number) {
  if (width >= 3600 || height >= 1600) return 2160;
  if (width >= 1600 || height >= 800) return 1080;
  if (width >= 1100 || height >= 600) return 720;
  if (width >= 720 || height >= 400) return 480;
  if (width >= 540 || height >= 300) return 360;
  if (width >= 360 || height >= 200) return 240;
  return 144;
}

async function fetchText(url: string, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 AnimeAdminSignalAnalyzer/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw badRequest(`Gagal fetch playlist: HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchContentLength(url: string, timeoutMs = 10000) {
  const parsed = new URL(url);
  const byteRangeStart = Number(parsed.searchParams.get("brs"));
  const byteRangeEnd = Number(parsed.searchParams.get("bre"));
  if (Number.isFinite(byteRangeStart) && Number.isFinite(byteRangeEnd) && byteRangeEnd >= byteRangeStart) {
    return byteRangeEnd - byteRangeStart + 1;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0 AnimeAdminSignalAnalyzer/1.0" },
      signal: controller.signal,
    });
    if (!response.ok || !response.headers.get("content-length")) {
      response = await fetch(url, {
        headers: {
          Range: "bytes=0-0",
          "User-Agent": "Mozilla/5.0 AnimeAdminSignalAnalyzer/1.0",
        },
        signal: controller.signal,
      });
    }
    const range = response.headers.get("content-range");
    const rangeSize = range?.match(/\/(\d+)$/)?.[1];
    const length = response.headers.get("content-length") ?? rangeSize;
    return length ? Number(length) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function analyzePlaylist(url: string): Promise<PlaylistAnalysis> {
  const safeUrl = assertHttpUrl(url);
  const text = await fetchText(safeUrl);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hintedResolution = inferResolutionFromUrl(safeUrl);
  let bandwidth: number | null = null;
  let resolution: number | null = null;
  const samples: Array<{ url: string; duration: number | null }> = [];
  let pendingDuration: number | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const parsedBandwidth = Number(parseAttribute(line, "BANDWIDTH"));
      if (Number.isFinite(parsedBandwidth)) bandwidth = parsedBandwidth;
      const res = parseAttribute(line, "RESOLUTION");
      const height = res?.match(/x(\d+)/i)?.[1];
      if (height && Number.isFinite(Number(height))) resolution = Number(height);
      const variantUrl = lines[index + 1];
      if (variantUrl && !variantUrl.startsWith("#")) {
        samples.push({ url: resolvePlaylistUrl(safeUrl, variantUrl), duration: null });
      }
      continue;
    }
    if (line.startsWith("#EXTINF")) {
      const duration = Number(line.match(/#EXTINF:([\d.]+)/i)?.[1]);
      if (Number.isFinite(duration)) pendingDuration = duration;
      continue;
    }
    if (!line.startsWith("#")) {
      samples.push({ url: resolvePlaylistUrl(safeUrl, line), duration: pendingDuration });
      pendingDuration = null;
      if (samples.length >= 3) break;
    }
  }

  const measuredSamples = await Promise.all(
    samples.slice(0, 3).map(async (sample) => ({
      ...sample,
      size: await fetchContentLength(sample.url),
    })),
  );
  const validSamples = measuredSamples.filter((sample) => sample.size && sample.duration);
  const sampleSizeBytes = validSamples.reduce((sum, sample) => sum + Number(sample.size), 0) || null;
  const sampleDurationSeconds = validSamples.reduce((sum, sample) => sum + Number(sample.duration), 0) || null;
  const probedVideo = samples[0]?.url ? await probeHlsSegmentDimensions(samples[0].url) : null;
  const snappedProbeResolution = probedVideo ? snapProbeResolution(probedVideo.width, probedVideo.height) : null;
  const estimatedBandwidth =
    sampleSizeBytes && sampleDurationSeconds
      ? Math.round((sampleSizeBytes * 8) / sampleDurationSeconds)
      : null;

  return {
    url: safeUrl,
    resolution: snappedProbeResolution ?? resolution,
    hintedResolution,
    bandwidth: bandwidth ?? estimatedBandwidth,
    sampleSizeBytes,
    sampleDurationSeconds,
    sampleSegmentUrl: samples[0]?.url ?? null,
    sampleCount: validSamples.length,
    probedResolution: snappedProbeResolution,
    probedWidth: probedVideo?.width ?? null,
    probedHeight: probedVideo?.height ?? null,
    detectedFrom: probedVideo ? "segment-probe" : resolution ? "playlist-resolution" : bandwidth ? "playlist-bandwidth" : estimatedBandwidth ? "sample-segments" : "url-pattern",
  };
}

function applyRankedResolutions(results: PlaylistAnalysis[]) {
  const unresolved = results
    .filter((item) => !item.resolution && item.bandwidth)
    .sort((a, b) => Number(a.bandwidth) - Number(b.bandwidth));
  const ladder = resolutionLadder(unresolved.length);
  unresolved.forEach((item, index) => {
    item.resolution = ladder[index] ?? item.hintedResolution ?? null;
    item.detectedFrom = "ranked-segments";
  });

  for (const item of results) {
    if (!item.resolution && item.hintedResolution) {
      item.resolution = item.hintedResolution;
      item.detectedFrom = "url-pattern";
    }
  }
  return results;
}

function stripSubtitleText(text: string) {
  return text
    .replace(/WEBVTT[^\n]*/gi, " ")
    .replace(/\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}[^\n]*/g, " ")
    .replace(/^\d+$/gm, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\{\\[^}]+\}/g, " ")
    .replace(/[^\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}

function detectLanguageFromUrl(url: string) {
  const normalized = decodeURIComponent(url).toLowerCase();
  for (const language of SUBTITLE_LANGUAGES) {
    if (
      language.aliases.some((alias) =>
        new RegExp(`(^|[._/=&?-])${alias}([._/=&?-]|$)`, "i").test(normalized),
      )
    ) {
      return { language, confidence: 0.85, detectedFrom: "url" };
    }
  }
  return null;
}

function detectLanguageFromText(sample: string) {
  if (!sample) return null;
  const totalChars = sample.length;
  const japaneseChars = (sample.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length;
  if (japaneseChars / Math.max(totalChars, 1) > 0.08) {
    return { language: SUBTITLE_LANGUAGES.find((item) => item.code === "ja")!, confidence: 0.95, detectedFrom: "text-sample" };
  }
  const koreanChars = (sample.match(/\p{Script=Hangul}/gu) ?? []).length;
  if (koreanChars / Math.max(totalChars, 1) > 0.08) {
    return { language: SUBTITLE_LANGUAGES.find((item) => item.code === "ko")!, confidence: 0.95, detectedFrom: "text-sample" };
  }
  const chineseChars = (sample.match(/\p{Script=Han}/gu) ?? []).length;
  if (chineseChars / Math.max(totalChars, 1) > 0.12) {
    return { language: SUBTITLE_LANGUAGES.find((item) => item.code === "zh")!, confidence: 0.9, detectedFrom: "text-sample" };
  }

  const words = sample.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length === 0) return null;
  const scores = SUBTITLE_LANGUAGES.filter((language) => language.markers.length > 0).map((language) => {
    const markerSet = new Set(language.markers);
    const hits = words.filter((word) => markerSet.has(word)).length;
    return { language, hits };
  });
  scores.sort((a, b) => b.hits - a.hits);
  const best = scores[0];
  if (!best || best.hits === 0) return null;
  const confidence = Math.min(0.95, 0.35 + best.hits / Math.max(words.length * 0.08, 1) * 0.25);
  return { language: best.language, confidence: Number(confidence.toFixed(2)), detectedFrom: "text-sample" };
}

async function analyzeSubtitle(url: string) {
  const safeUrl = assertHttpUrl(url);
  const urlDetection = detectLanguageFromUrl(safeUrl);
  const text = await fetchText(safeUrl);
  const sample = stripSubtitleText(text);
  const textDetection = detectLanguageFromText(sample);
  const detection =
    textDetection && (!urlDetection || textDetection.confidence >= urlDetection.confidence)
      ? textDetection
      : urlDetection;
  const cueCount = (text.match(/\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/g) ?? []).length;

  return {
    url: safeUrl,
    language: detection?.language.code ?? "unknown",
    label: detection?.language.label ?? "Unknown",
    confidence: detection?.confidence ?? 0,
    detectedFrom: detection?.detectedFrom ?? "unknown",
    sampleCueCount: cueCount,
    sampleText: sample.slice(0, 180),
  };
}

function writeSse(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastSignal(signal: SignalRecord) {
  for (const client of signalClients) {
    writeSse(client, "signal", signal);
  }
}

function broadcastClear() {
  for (const client of signalClients) {
    writeSse(client, "clear", { clearedAt: new Date().toISOString() });
  }
}

export const signalsRoutes: FastifyPluginAsync = async (app) => {
  app.options("/", async (_request, reply) => {
    setOpenCors(reply);
    return reply.status(204).send();
  });

  app.options("/*", async (_request, reply) => {
    setOpenCors(reply);
    return reply.status(204).send();
  });

  app.addHook("onRequest", async (_request, reply) => {
    setOpenCors(reply);
  });

  app.post("/", async (request, reply) => {
    const signal = normalizeSignal((request.body ?? {}) as SignalBody);
    signals.unshift(signal);
    if (signals.length > MAX_SIGNALS) signals.length = MAX_SIGNALS;
    broadcastSignal(signal);

    return created(reply, {
      message: "Signal diterima",
      data: signal,
    });
  });

  app.post("/analyze", async (request, reply) => {
    const body = (request.body ?? {}) as AnalyzeBody;
    const urls = Array.isArray(body.urls)
      ? Array.from(new Set(body.urls.filter((url) => typeof url === "string").slice(0, 12)))
      : [];
    if (urls.length === 0) throw badRequest("Minimal satu URL playlist wajib dikirim");

    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          return await analyzePlaylist(url);
        } catch (error) {
          return {
            url,
            resolution: inferResolutionFromUrl(url),
            bandwidth: null,
            hintedResolution: inferResolutionFromUrl(url),
            sampleSizeBytes: null,
            sampleDurationSeconds: null,
            sampleSegmentUrl: null,
            sampleCount: 0,
            probedResolution: null,
            probedWidth: null,
            probedHeight: null,
            detectedFrom: "url-pattern",
            error: error instanceof Error ? error.message : "Gagal analyze playlist",
          };
        }
      }),
    );

    return ok(reply, {
      message: "Signals analyzed",
      data: applyRankedResolutions(results),
    });
  });

  app.post("/analyze-subtitles", async (request, reply) => {
    const body = (request.body ?? {}) as AnalyzeBody;
    const urls = Array.isArray(body.urls)
      ? Array.from(new Set(body.urls.filter((url) => typeof url === "string").slice(0, 20)))
      : [];
    if (urls.length === 0) throw badRequest("Minimal satu URL subtitle wajib dikirim");

    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          return await analyzeSubtitle(url);
        } catch (error) {
          return {
            url,
            language: detectLanguageFromUrl(url)?.language.code ?? "unknown",
            label: detectLanguageFromUrl(url)?.language.label ?? "Unknown",
            confidence: detectLanguageFromUrl(url)?.confidence ?? 0,
            detectedFrom: detectLanguageFromUrl(url)?.detectedFrom ?? "unknown",
            sampleCueCount: 0,
            sampleText: "",
            error: error instanceof Error ? error.message : "Gagal analyze subtitle",
          };
        }
      }),
    );

    return ok(reply, {
      message: "Subtitles analyzed",
      data: results,
    });
  });

  app.get("/", async (_request, reply) =>
    ok(reply, {
      message: "Signals fetched",
      data: signals,
    }),
  );

  app.delete("/", async (_request, reply) => {
    const cleared = signals.length;
    signals.length = 0;
    broadcastClear();

    return ok(reply, {
      message: "Signals cleared",
      data: { cleared },
    });
  });

  app.get("/stream", async (request, reply) => {
    setOpenCors(reply);
    reply.raw.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    signalClients.add(reply);
    writeSse(reply, "ready", { signals: signals.slice(0, 20) });

    request.raw.on("close", () => {
      signalClients.delete(reply);
    });
  });
};
