import { FastifyPluginAsync } from "fastify";
import { pipeline } from "node:stream/promises";
import { STREAMING_HOST_URL } from "./url-config";

const BASE_PREFIX_SERVER_PATH = "/api/video-stream/okru-stream";

const OKRU_EMBED_BASE = "https://ok.ru/videoembed";
const OKRU_REFERER = "https://ok.ru";
const SBCHILL_HOST = "sbchill.com";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OkruVideo {
  name: string;
  url: string;
}

interface OkruMetadata {
  hlsManifestUrl?: string;
  videos: OkruVideo[];
  referer?: string;
}

// ─── Encode/Decode URL token ──────────────────────────────────────────────────

function encodeSegmentUrl(url: string): string {
  return Buffer.from(url, "utf8").toString("hex");
}

function decodeSegmentUrl(token: string): string {
  return Buffer.from(token, "hex").toString("utf8");
}

// ─── Helper: Rewrite semua URL di dalam M3U8 agar lewat proxy /segment ────────
//
// Menangani:
// 1. Baris URL biasa (di bawah #EXT-X-STREAM-INF atau #EXTINF)
// 2. URI="..." di dalam tag #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF, dll.

function rewriteM3u8(
  content: string,
  baseProxyUrl: string,
  manifestUrl: string,
  referer?: string,
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
    const params = new URLSearchParams({ t: token });
    if (referer) params.set("r", referer);
    return `${baseProxyUrl}/segment?${params.toString()}`;
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

// ─── Helper: Fetch & parse metadata dari ok.ru embed page ────────────────────

async function fetchOkruMetadata(videoId: string): Promise<OkruMetadata> {
  const embedUrl = `${OKRU_EMBED_BASE}/${videoId}`;

  const res = await fetch(embedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "Chrome/124.0 Safari/537.36",
      Referer: OKRU_REFERER,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok) {
    throw new Error(`ok.ru returned ${res.status} for videoId ${videoId}`);
  }

  const html = await res.text();

  // Cari div[data-module="OKVideo"] dengan data-options
  const dataOptionsMatch =
    html.match(
      /data-module=["']OKVideo["'][^>]*data-options=["']([^"']+)["']/,
    ) ?? html.match(/data-options=["']([^"']+)["']/);

  if (!dataOptionsMatch) {
    throw new Error("data-options not found in ok.ru embed page");
  }

  // Step 1: HTML-decode entities
  const jsonStr = dataOptionsMatch[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'");

  // Step 2: Parse data-options sebagai JSON
  let dataOptions: { flashvars?: { metadata?: string | OkruMetadata } };
  try {
    dataOptions = JSON.parse(jsonStr);
  } catch {
    throw new Error("Failed to parse data-options JSON from ok.ru");
  }

  const rawMetadata = dataOptions?.flashvars?.metadata;
  if (!rawMetadata) {
    throw new Error("metadata not found inside flashvars");
  }

  // Step 3: flashvars.metadata adalah JSON STRING (double-encoded) — parse lagi
  let metadata: OkruMetadata;
  if (typeof rawMetadata === "string") {
    try {
      metadata = JSON.parse(rawMetadata);
    } catch {
      throw new Error("Failed to parse flashvars.metadata as JSON string");
    }
  } else {
    metadata = rawMetadata as OkruMetadata;
  }

  if (!metadata.videos) {
    throw new Error("videos array not found in metadata");
  }

  return { ...metadata, referer: OKRU_REFERER };
}

async function fetchSbchillMetadata(videoId: string): Promise<OkruMetadata> {
  const embedUrl = `https://${SBCHILL_HOST}/e/${videoId}.html`;
  const referer = `https://${SBCHILL_HOST}/`;

  const res = await fetch(embedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "Chrome/124.0 Safari/537.36",
      Referer: referer,
      Origin: `https://${SBCHILL_HOST}`,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok) {
    throw new Error(`sbchill returned ${res.status} for videoId ${videoId}`);
  }

  const html = await res.text();
  const m3u8Match =
    html.match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/) ??
    html.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/);

  if (!m3u8Match) {
    throw new Error(
      `M3U8 URL not found in sbchill.com embed page for videoId ${videoId}`,
    );
  }

  return { hlsManifestUrl: m3u8Match[1], videos: [], referer };
}

function fetchEmbedMetadata(videoId: string, host?: string) {
  return host === SBCHILL_HOST
    ? fetchSbchillMetadata(videoId)
    : fetchOkruMetadata(videoId);
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
   * GET /playlist/:videoId
   *
   * Case 1: ok.ru punya hlsManifestUrl → proxy manifest + rewrite semua URL.
   *
   * Case 2: tidak ada hlsManifestUrl → buat MASTER M3U8 dari MP4 multi-quality.
   *   Setiap entry di master playlist menunjuk ke /media-playlist/:quality?t=<token>
   *   yang akan return pseudo HLS media playlist wrapping 1 MP4 segment.
   *   (HLS.js butuh sub-playlist M3U8, bukan URL MP4 langsung)
   */
  app.get<{ Params: { videoId: string }; Querystring: { host?: string } }>(
    "/playlist/:videoId",
    async (req, reply) => {
      const { videoId } = req.params;
      const host = req.query.host?.trim().toLowerCase();

      let metadata: OkruMetadata;
      try {
        metadata = await fetchEmbedMetadata(videoId, host);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ error: message });
      }

      // const port = req.port ? `:${req.port}` : "";
      const baseUrl = `${STREAMING_HOST_URL}${BASE_PREFIX_SERVER_PATH}`;

      // ── Case 1: Ada hlsManifestUrl → proxy manifest + rewrite segment URLs
      if (metadata.hlsManifestUrl) {
        const hlsRes = await fetch(metadata.hlsManifestUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
              "Chrome/124.0 Safari/537.36",
            Referer: metadata.referer ?? OKRU_REFERER,
          },
        });

        if (!hlsRes.ok) {
          return reply
            .status(hlsRes.status)
            .send({ error: "Failed to fetch HLS manifest from ok.ru CDN" });
        }

        const m3u8Text = await hlsRes.text();
        const rewritten = rewriteM3u8(
          m3u8Text,
          baseUrl,
          metadata.hlsManifestUrl,
          metadata.referer,
        );

        return reply
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .header("Access-Control-Allow-Origin", "*")
          .header("Cache-Control", "no-cache")
          .send(rewritten);
      }

      // ── Case 2: Tidak ada hlsManifestUrl → generate master M3U8 dari MP4 URLs
      //
      // PENTING: Entry di master playlist harus menunjuk ke /media-playlist/:quality?t=<token>
      // yang mengembalikan M3U8 media playlist pseudo (bukan MP4 langsung).
      // HLS.js mengharapkan sub-playlist M3U8, bukan file MP4 binary.
      const m3u8Lines = ["#EXTM3U", "#EXT-X-VERSION:3"];

      const qualityOrder = ["full", "hd", "sd", "low", "lowest", "mobile"];
      const bandwidthMap: Record<string, number> = {
        full: 4000000,
        hd: 2500000,
        sd: 1000000,
        low: 500000,
        lowest: 300000,
        mobile: 150000,
      };
      const resolutionMap: Record<string, string> = {
        full: "1920x1080",
        hd: "1280x720",
        sd: "640x360",
        low: "480x270",
        lowest: "320x180",
        mobile: "240x134",
      };

      for (const quality of qualityOrder) {
        const video = metadata.videos.find((v) => v.name === quality);
        if (!video) continue;

        const token = encodeSegmentUrl(video.url);
        // Arahkan ke /media-playlist/:quality — ini akan return M3U8 pseudo (bukan MP4 langsung)
        const subPlaylistUrl = `${baseUrl}/media-playlist/${quality}?t=${token}`;

        m3u8Lines.push(
          `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthMap[quality]},RESOLUTION=${resolutionMap[quality]},NAME="${quality}"`,
          subPlaylistUrl,
        );
      }

      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache")
        .send(m3u8Lines.join("\n"));
    },
  );

  /**
   * GET /media-playlist/:quality?t=<hex>
   *
   * Mengembalikan pseudo HLS media playlist yang wrapping 1 MP4 segment.
   * Diperlukan karena HLS.js mengharapkan sub-playlist berupa M3U8, bukan MP4 langsung.
   *
   * Untuk mendapatkan durasi video yang akurat, kita fetch HEAD dari MP4
   * lalu gunakan estimasi, atau fallback ke durasi sangat besar (VOD style).
   */
  app.get<{
    Params: { quality: string };
    Querystring: { t: string };
  }>("/media-playlist/:quality", async (req, reply) => {
    const { t } = req.query;
    if (!t) {
      return reply.status(400).send({ error: "Missing token" });
    }

    let mp4Url: string;
    try {
      mp4Url = decodeSegmentUrl(t);
      new URL(mp4Url);
    } catch {
      return reply.status(400).send({ error: "Invalid token" });
    }

    // const port = req.port ? `:${req.port}` : "";
    const baseUrl = `${STREAMING_HOST_URL}${BASE_PREFIX_SERVER_PATH}`;

    // URL untuk proxy MP4 dengan support Range request
    const proxyMp4Url = `${baseUrl}/mp4-segment/${req.params.quality}?t=${t}`;

    // Pseudo HLS media playlist VOD — 1 "segment" = seluruh file MP4
    // EXTINF duration set ke 86400 (24 jam) sebagai safe fallback untuk VOD
    // HLS.js akan tetap bisa seek karena MP4 proxy support Range request
    const mediaPlaylist = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:86400",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-ALLOW-CACHE:YES",
      `#EXTINF:86400.0,${req.params.quality}`,
      proxyMp4Url,
      "#EXT-X-ENDLIST",
    ].join("\n");

    return reply
      .header("Content-Type", "application/vnd.apple.mpegurl")
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", "no-cache")
      .send(mediaPlaylist);
  });

  /**
   * GET /segment?t=<hex>
   * Proxy segment/sub-playlist dari ok.ru CDN.
   * Jika response adalah M3U8 → rewrite URL di dalamnya.
   * Jika binary (.ts) → stream langsung.
   */
  app.get<{ Querystring: { t: string; r?: string } }>(
    "/segment",
    async (req, reply) => {
    const { t } = req.query;
    if (!t) {
      return reply.status(400).send({ error: "Missing token" });
    }

    let targetUrl: string;
    try {
      targetUrl = decodeSegmentUrl(t);
      new URL(targetUrl);
    } catch {
      return reply.status(400).send({ error: "Invalid token" });
    }

    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "Chrome/124.0 Safari/537.36",
        Referer: req.query.r ?? OKRU_REFERER,
      },
    });

    if (!upstream.ok || !upstream.body) {
      return reply
        .status(upstream.status)
        .send({ error: "Segment fetch failed" });
    }

    const contentType = upstream.headers.get("content-type") ?? "video/mp2t";

    const looksLikeM3u8ByMeta =
      contentType.includes("mpegurl") ||
      targetUrl.includes(".m3u8") ||
      (targetUrl.includes("/video/") && !targetUrl.endsWith(".ts"));

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

      // const port = req.port ? `:${req.port}` : "";
      const baseUrl = `${STREAMING_HOST_URL}${BASE_PREFIX_SERVER_PATH}`;
      const rewritten = rewriteM3u8(bodyText, baseUrl, targetUrl, req.query.r);
      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .header("Access-Control-Allow-Origin", "*")
        .send(rewritten);
    }

    // Binary segment (.ts) — hijack agar onSend hook tidak double-write header
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
   * Proxy MP4 langsung dengan support Range request agar player bisa seek.
   */
  app.get<{
    Params: { quality: string };
    Querystring: { t: string };
  }>("/mp4-segment/:quality", async (req, reply) => {
    const { t } = req.query;
    if (!t) {
      return reply.status(400).send({ error: "Missing token" });
    }

    let targetUrl: string;
    try {
      targetUrl = decodeSegmentUrl(t);
      new URL(targetUrl);
    } catch {
      return reply.status(400).send({ error: "Invalid token" });
    }

    const rangeHeader = req.headers["range"];

    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "Chrome/124.0 Safari/537.36",
      Referer: OKRU_REFERER,
    };
    if (rangeHeader) {
      headers["Range"] = rangeHeader;
    }

    const upstream = await fetch(targetUrl, { headers });

    if (!upstream.ok || !upstream.body) {
      return reply.status(upstream.status).send({ error: "MP4 fetch failed" });
    }

    const status = upstream.status; // 200 atau 206 (partial)
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
   * GET /info/:videoId
   * Debug endpoint — kembalikan raw metadata dari ok.ru.
   */
  app.get<{ Params: { videoId: string } }>(
    "/info/:videoId",
    async (req, reply) => {
      try {
        const metadata = await fetchOkruMetadata(req.params.videoId);
        return reply.send(metadata);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ error: message });
      }
    },
  );
};
