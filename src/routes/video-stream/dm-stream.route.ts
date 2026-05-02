import { FastifyPluginAsync } from "fastify";
import { pipeline } from "node:stream/promises";
import {
  readVideoPlaylistCache,
  VIDEO_PLAYLIST_CACHE_CONTROL,
  VIDEO_SEGMENT_CACHE_CONTROL,
  writeVideoPlaylistCache,
} from "../../utils/video-stream-cache";

const BASE_PREFIX_SERVER_PATH = "/api/video-stream/dm-stream";
const DM_BASE = "https://www.dailymotion.com";
const DM_REFERER = "https://www.dailymotion.com/";

// ─── Encode/Decode token ──────────────────────────────────────────────────────

function encodeToken(url: string): string {
  return Buffer.from(url, "utf8").toString("hex");
}

function decodeToken(token: string): string {
  return Buffer.from(token, "hex").toString("utf8");
}

// ─── Helper: Extract video ID dari berbagai format URL DM ─────────────────────
//
// Format yang didukung:
// - https://www.dailymotion.com/embed/video/{videoId}
// - https://geo.dailymotion.com/player/xid0t.html?video={videoId}
// - {videoId} langsung (plain)

function extractVideoId(input: string): string | null {
  // Format embed
  const embedMatch = input.match(
    /dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/,
  );
  if (embedMatch) return embedMatch[1];

  // Format geo player
  const geoMatch = input.match(/[?&]video=([a-zA-Z0-9]+)/);
  if (geoMatch) return geoMatch[1];

  // Plain video ID (hanya alphanumeric, panjang 4–12 karakter)
  if (/^[a-zA-Z0-9]{4,12}$/.test(input.trim())) return input.trim();

  return null;
}

// ─── Helper: Ambil master M3U8 URL dari metadata API ─────────────────────────
//
// Returns: { masterUrl: string; dmvk: string }
// dmvk = nilai dmV1st dari query param URL m3u8 → dipakai sebagai Cookie

interface DmMeta {
  masterUrl: string;
  dmvk: string;
}

async function fetchDmMeta(videoId: string): Promise<DmMeta> {
  const metaUrl = `${DM_BASE}/player/metadata/video/${videoId}`;

  const res = await fetch(metaUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: DM_REFERER,
      Origin: DM_BASE,
      Accept: "application/json, text/plain, */*",
    },
  });

  if (!res.ok) {
    throw new Error(`DM metadata fetch failed: ${res.status}`);
  }

  const json: any = await res.json();

  // Ambil URL m3u8 dari qualities.auto atau qualities['auto']
  const qualities: { type: string; url: string }[] =
    json?.qualities?.auto ?? [];

  const m3u8Entry = qualities.find(
    (q) =>
      q.type === "application/x-mpegURL" ||
      q.type?.includes("mpegURL") ||
      q.url?.includes(".m3u8"),
  );

  if (!m3u8Entry?.url) {
    throw new Error("No HLS stream found in DM metadata");
  }

  const masterUrl = m3u8Entry.url;

  // Ekstrak dmV1st dari query param URL master m3u8 → jadikan Cookie dmvk
  let dmvk = "";
  try {
    const urlObj = new URL(masterUrl);
    dmvk = urlObj.searchParams.get("dmV1st") ?? "";
  } catch {
    // ignore
  }

  return { masterUrl, dmvk };
}

// ─── Helper: Resolve relative URL terhadap base URL ──────────────────────────

function resolveUrl(raw: string, manifestUrl: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  const manifestUrlObj = new URL(manifestUrl);

  if (trimmed.startsWith("/")) {
    return `${manifestUrlObj.origin}${trimmed}`;
  }

  // Relative path — resolve terhadap directory manifest
  const lastSlash = manifestUrlObj.pathname.lastIndexOf("/");
  const baseDir =
    manifestUrlObj.origin + manifestUrlObj.pathname.substring(0, lastSlash + 1);

  // Gunakan URL constructor untuk handle ../ dll
  return new URL(trimmed, baseDir).toString();
}

// ─── Helper: Rewrite M3U8 ────────────────────────────────────────────────────
//
// Menangani:
// 1. Baris URL biasa (di bawah #EXT-X-STREAM-INF atau #EXTINF)
// 2. URI="..." di dalam tag #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF, dll.
// 3. Strip fragment (#cell=...) dari URL sebelum di-proxy

function stripFragment(url: string): string {
  const hashIdx = url.indexOf("#");
  return hashIdx !== -1 ? url.substring(0, hashIdx) : url;
}

function rewriteM3u8(
  content: string,
  baseProxyUrl: string,
  manifestUrl: string,
): string {
  function proxyUrl(raw: string): string {
    const absolute = resolveUrl(raw.trim(), manifestUrl);
    const clean = stripFragment(absolute);
    const token = encodeToken(clean);
    return `${baseProxyUrl}/segment?t=${token}`;
  }

  function rewriteUriAttrs(line: string): string {
    return line.replace(/URI=([\"'])([^\"']+)\1/g, (_match, quote, rawUrl) => {
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
      // Baris URL biasa (segment atau sub-playlist)
      return proxyUrl(trimmed);
    })
    .join("\n");
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const dmProxyRoutes: FastifyPluginAsync = async (app) => {
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
   * GET /playlist
   * Query params:
   *   - v  : video ID atau URL DM (embed/geo format)
   *
   * Flow:
   * 1. Extract video ID
   * 2. Fetch metadata → dapat master M3U8 URL + dmvk cookie
   * 3. Fetch master M3U8 dengan Cookie: dmvk={dmvk}
   * 4. Rewrite semua URL → proxied
   * 5. Return rewritten M3U8
   */
  app.get<{ Querystring: { v: string } }>("/playlist", async (req, reply) => {
    const { v } = req.query;
    if (!v) {
      return reply.status(400).send({ error: "Missing video param (v)" });
    }

    const videoId = extractVideoId(v);
    if (!videoId) {
      return reply
        .status(400)
        .send({ error: "Cannot extract video ID from v" });
    }

    let meta: DmMeta;
    try {
      meta = await fetchDmMeta(videoId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: msg });
    }

    const { masterUrl, dmvk } = meta;

    // Fetch master M3U8
    const masterUrlClean = stripFragment(masterUrl);
    const port = req.port ? `:${req.port}` : "";
    const baseUrl = `${req.protocol}://${req.hostname}${port}${BASE_PREFIX_SERVER_PATH}`;
    const cacheParts = [baseUrl, masterUrlClean, dmvk ?? ""];
    const cached = await readVideoPlaylistCache("dm:master", cacheParts);

    if (cached) {
      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
        .header("X-Video-Playlist-Cache", "hit")
        .send(cached);
    }

    const masterRes = await fetch(masterUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: DM_REFERER,
        Origin: DM_BASE,
        ...(dmvk ? { Cookie: `dmvk=${dmvk}` } : {}),
      },
    });

    if (!masterRes.ok) {
      return reply
        .status(masterRes.status)
        .send({ error: `Master M3U8 fetch failed: ${masterRes.status}` });
    }

    const masterText = await masterRes.text();

    const rewritten = rewriteM3u8(masterText, baseUrl, masterUrlClean);
    await writeVideoPlaylistCache("dm:master", cacheParts, rewritten);

    return reply
      .header("Content-Type", "application/vnd.apple.mpegurl")
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
      .header("X-Video-Playlist-Cache", "miss")
      .send(rewritten);
  });

  /**
   * GET /segment?t=<hex>
   * Proxy segment (.ts) atau sub-playlist (media M3U8) dari CDN Dailymotion.
   * - Jika response adalah M3U8 → rewrite URL di dalamnya
   * - Jika binary (.ts) → stream langsung dengan reply.hijack()
   */
  app.get<{ Querystring: { t: string } }>("/segment", async (req, reply) => {
    const { t } = req.query;
    if (!t) {
      return reply.status(400).send({ error: "Missing token" });
    }

    let targetUrl: string;
    try {
      targetUrl = decodeToken(t);
      new URL(targetUrl); // validasi
    } catch {
      return reply.status(400).send({ error: "Invalid token" });
    }

    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: DM_REFERER,
        Origin: DM_BASE,
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

      const port = req.port ? `:${req.port}` : "";
      const baseUrl = `${req.protocol}://${req.hostname}${port}${BASE_PREFIX_SERVER_PATH}`;
      const cacheParts = [baseUrl, targetUrl];
      const cached = await readVideoPlaylistCache("dm:segment", cacheParts);
      if (cached) {
        return reply
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .header("Access-Control-Allow-Origin", "*")
          .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
          .header("X-Video-Playlist-Cache", "hit")
          .send(cached);
      }
      const rewritten = rewriteM3u8(bodyText, baseUrl, targetUrl);
      await writeVideoPlaylistCache("dm:segment", cacheParts, rewritten);

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
