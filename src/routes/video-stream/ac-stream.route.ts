import { FastifyPluginAsync } from "fastify";
import { pipeline } from "node:stream/promises";
import { STREAMING_HOST_URL } from "./url-config";
import {
  readVideoPlaylistCache,
  VIDEO_PLAYLIST_CACHE_CONTROL,
  VIDEO_SEGMENT_CACHE_CONTROL,
  writeVideoPlaylistCache,
} from "../../utils/video-stream-cache";

const BASE_PREFIX_SERVER_PATH = "/api/video-stream/ac-stream";
const ANICHIN_BASE = "https://anichin.stream";

// ─── Encode/Decode token ──────────────────────────────────────────────────────

function encodeToken(url: string): string {
  return Buffer.from(url, "utf8").toString("hex");
}

function decodeToken(token: string): string {
  return Buffer.from(token, "hex").toString("utf8");
}

// ─── Helper: Rewrite M3U8 ────────────────────────────────────────────────────
//
// Menangani:
// 1. Baris URL biasa (di bawah #EXT-X-STREAM-INF atau #EXTINF)
// 2. URI="..." di dalam tag #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF, dll.

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
    const token = encodeToken(absolute);
    return `${baseProxyUrl}/segment?t=${token}`;
  }

  function rewriteUriAttrs(line: string): string {
    // Rewrite URI="..." atau URI='...' di dalam tag #EXT-X-*
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
        // Baris tag — rewrite URI= attributes jika ada
        return rewriteUriAttrs(line);
      }
      // Baris URL biasa
      return proxyUrl(trimmed);
    })
    .join("\n");
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const proxyRoutes: FastifyPluginAsync = async (app) => {
  // CORS untuk semua response
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
   * Fetch master M3U8 dari anichin.stream lalu rewrite semua URL.
   */
  app.get<{ Params: { videoId: string } }>(
    "/playlist/:videoId",
    async (req, reply) => {
      const { videoId } = req.params;
      const upstreamUrl = `${ANICHIN_BASE}/hls/${videoId}.m3u8`;
      const baseUrl = `${STREAMING_HOST_URL}${BASE_PREFIX_SERVER_PATH}`;
      const cacheParts = [baseUrl, upstreamUrl];
      const cached = await readVideoPlaylistCache("ac:master", cacheParts);

      if (cached) {
        return reply
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .header("Access-Control-Allow-Origin", "*")
          .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
          .header("X-Video-Playlist-Cache", "hit")
          .send(cached);
      }

      const upstream = await fetch(upstreamUrl, {
        headers: {
          Referer: ANICHIN_BASE,
          Origin: ANICHIN_BASE,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        },
      });

      if (!upstream.ok) {
        return reply
          .status(upstream.status)
          .send({ error: "Upstream error", status: upstream.status });
      }

      const text = await upstream.text();

      const rewritten = rewriteM3u8(text, baseUrl, upstreamUrl);
      await writeVideoPlaylistCache("ac:master", cacheParts, rewritten);

      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
        .header("X-Video-Playlist-Cache", "miss")
        .send(rewritten);
    },
  );

  /**
   * GET /segment?t=<hex>
   * Proxy segment atau sub-playlist dari CDN manapun.
   * Jika response adalah M3U8 → rewrite URL di dalamnya.
   * Jika binary (.ts) → stream langsung.
   */
  app.get<{ Querystring: { t: string } }>("/segment", async (req, reply) => {
    const { t } = req.query;
    if (!t) {
      return reply.status(400).send({ error: "Missing token" });
    }

    let targetUrl: string;
    try {
      targetUrl = decodeToken(t);
      new URL(targetUrl);
    } catch {
      return reply.status(400).send({ error: "Invalid token" });
    }

    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        Referer: ANICHIN_BASE,
        Origin: ANICHIN_BASE,
      },
    });

    if (!upstream.ok || !upstream.body) {
      return reply
        .status(upstream.status)
        .send({ error: "Segment fetch failed" });
    }

    const contentType = upstream.headers.get("content-type") ?? "video/mp2t";

    // Deteksi M3U8 dari content-type atau URL
    const mightBeM3u8 =
      contentType.includes("mpegurl") ||
      targetUrl.includes(".m3u8") ||
      // 1a-1791.com pakai query param r_file=chunklist.m3u8
      targetUrl.includes("r_file=chunklist.m3u8") ||
      targetUrl.includes("chunklist");

    if (mightBeM3u8) {
      const bodyText = await upstream.text();

      if (!bodyText.trimStart().startsWith("#EXTM3U")) {
        // Bukan M3U8 — kirim as-is
        const buffer = Buffer.from(bodyText, "latin1");
        return reply
          .header("Content-Type", contentType)
          .header("Access-Control-Allow-Origin", "*")
          .header("Cache-Control", VIDEO_SEGMENT_CACHE_CONTROL)
          .send(buffer);
      }

      // const port = req.port ? `:${req.port}` : "";
      const baseUrl = `${STREAMING_HOST_URL}${BASE_PREFIX_SERVER_PATH}`;
      const cacheParts = [baseUrl, targetUrl];
      const cached = await readVideoPlaylistCache("ac:segment", cacheParts);
      if (cached) {
        return reply
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .header("Access-Control-Allow-Origin", "*")
          .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
          .header("X-Video-Playlist-Cache", "hit")
          .send(cached);
      }
      const rewritten = rewriteM3u8(bodyText, baseUrl, targetUrl);
      await writeVideoPlaylistCache("ac:segment", cacheParts, rewritten);

      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
        .header("X-Video-Playlist-Cache", "miss")
        .send(rewritten);
    }

    // Binary segment (.ts) — hijack agar Fastify tidak inject header lagi
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": VIDEO_SEGMENT_CACHE_CONTROL,
    });

    await pipeline(
      upstream.body as unknown as NodeJS.ReadableStream,
      reply.raw,
    );
  });
};
