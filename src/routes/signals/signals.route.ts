import type { FastifyPluginAsync, FastifyReply } from "fastify";
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

async function analyzePlaylist(url: string) {
  const safeUrl = assertHttpUrl(url);
  const text = await fetchText(safeUrl);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let bandwidth: number | null = null;
  let resolution = inferResolutionFromUrl(safeUrl);
  let firstSegmentUrl: string | null = null;
  let firstSegmentDuration: number | null = null;
  let pendingDuration: number | null = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const parsedBandwidth = Number(parseAttribute(line, "BANDWIDTH"));
      if (Number.isFinite(parsedBandwidth)) bandwidth = parsedBandwidth;
      const res = parseAttribute(line, "RESOLUTION");
      const height = res?.match(/x(\d+)/i)?.[1];
      if (height && Number.isFinite(Number(height))) resolution = Number(height);
      continue;
    }
    if (line.startsWith("#EXTINF")) {
      const duration = Number(line.match(/#EXTINF:([\d.]+)/i)?.[1]);
      if (Number.isFinite(duration)) pendingDuration = duration;
      continue;
    }
    if (!line.startsWith("#")) {
      firstSegmentUrl = resolvePlaylistUrl(safeUrl, line);
      firstSegmentDuration = pendingDuration;
      break;
    }
  }

  const sampleSizeBytes = firstSegmentUrl ? await fetchContentLength(firstSegmentUrl) : null;
  const estimatedBandwidth =
    sampleSizeBytes && firstSegmentDuration
      ? Math.round((sampleSizeBytes * 8) / firstSegmentDuration)
      : null;

  return {
    url: safeUrl,
    resolution,
    bandwidth: bandwidth ?? estimatedBandwidth,
    sampleSizeBytes,
    sampleDurationSeconds: firstSegmentDuration,
    sampleSegmentUrl: firstSegmentUrl,
    detectedFrom: bandwidth ? "playlist" : estimatedBandwidth ? "sample-segment" : "url-pattern",
  };
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
            sampleSizeBytes: null,
            sampleDurationSeconds: null,
            sampleSegmentUrl: null,
            detectedFrom: "url-pattern",
            error: error instanceof Error ? error.message : "Gagal analyze playlist",
          };
        }
      }),
    );

    return ok(reply, {
      message: "Signals analyzed",
      data: results,
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
