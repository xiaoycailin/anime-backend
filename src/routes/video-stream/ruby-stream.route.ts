import { FastifyPluginAsync } from "fastify";
import { pipeline } from "node:stream/promises";
import { STREAMING_HOST_URL } from "./url-config";
import {
  readVideoPlaylistCache,
  VIDEO_PLAYLIST_CACHE_CONTROL,
  VIDEO_SEGMENT_CACHE_CONTROL,
  writeVideoPlaylistCache,
} from "../../utils/video-stream-cache";

const BASE_PREFIX_SERVER_PATH = "/api/video-stream/ruby-stream";

const RUBY_EMBED_BASE = "https://rubyvidhub.com/embed-";
const RUBY_REFERER = "https://rubyvidhub.com/";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RubyMetadata {
  masterM3u8Url: string;
  videoId: string;
}

// ─── Helper: Unpack Dean Edwards P,A,C,K,E,R ─────────────────────────────────
//
// Format: eval(function(p,a,c,k,e,d){while(c--)...}('PACKED',BASE,COUNT,'kw0|kw1|...'.split('|')))
//
// Catatan penting:
// - \b (word boundary) TIDAK bekerja untuk token seperti "1u", "4d", "9w" karena
//   digit+huruf = semua \w, sehingga \b1u\b tidak match di dalam string seperti "1u://"
// - Solusi: gunakan negative lookbehind/lookahead (?<!\w)TOKEN(?!\w)
// - Keyword array di-extract dari AKHIR block (dari .split('|') ke belakang)
//   karena packed string bisa mengandung single-quote yang memotong regex greedy.

function unpackJS(rawBlock: string): string {
  // Extract args dari akhir block
  const splitPos = rawBlock.lastIndexOf(".split('|')");
  if (splitPos === -1) return rawBlock;

  const beforeSplit = rawBlock.substring(0, splitPos);

  // Cari: ,<base>,<count>,'<keywords> — dari belakang beforeSplit
  const kwStartMatch = beforeSplit.match(/,(\d+),(\d+),'([\s\S]*)$/);
  if (!kwStartMatch) return rawBlock;

  const base = parseInt(kwStartMatch[1], 10);
  const count = parseInt(kwStartMatch[2], 10);
  const k = kwStartMatch[3].split("|");

  // Packed string: dari setelah }(' sampai sebelum ,base,count,'
  const packedStart = rawBlock.indexOf("}'(");
  const packedStartIdx =
    packedStart !== -1 ? packedStart + 3 : rawBlock.indexOf("}('") + 3;
  const metaSuffix = "," + base + "," + count + ",'";
  const packedEndIdx = beforeSplit.lastIndexOf(metaSuffix);

  if (packedEndIdx === -1 || packedStartIdx <= 0) return rawBlock;

  let p = rawBlock.substring(packedStartIdx, packedEndIdx);

  // Urutkan dari key terpanjang dulu agar tidak ada partial replace
  const pairs = k
    .map((kw, i) => ({ kw, key: i.toString(base) }))
    .filter((x) => x.kw)
    .sort((a, b) => b.key.length - a.key.length);

  for (const { key, kw } of pairs) {
    // Gunakan (?<!\w) dan (?!\w) bukan \b — agar token mix digit+huruf (1u, 4d, dll) ter-replace
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    p = p.replace(new RegExp("(?<!\\w)" + escaped + "(?!\\w)", "g"), kw);
  }

  return p;
}

// ─── Helper: Fetch & parse M3U8 URL dari embed page ──────────────────────────

async function fetchRubyMetadata(videoId: string): Promise<RubyMetadata> {
  const embedUrl = `${RUBY_EMBED_BASE}${videoId}.html`;

  const res = await fetch(embedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "Chrome/124.0 Safari/537.36",
      Referer: RUBY_REFERER,
      Origin: "https://rubyvidhub.com",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  if (!res.ok) {
    throw new Error(`rubyvidhub returned ${res.status} for videoId ${videoId}`);
  }

  const html = await res.text();

  let masterM3u8Url: string | null = null;

  // ── Tahap 1: cari di eval(function(p,a,c,k,e,d){...}) blocks ───────────────
  // Ambil semua blok eval, unpack, lalu cari .m3u8
  // Cari semua posisi eval block via indexOf, extract raw block sampai </script>, lalu unpack.
  // TIDAK menggunakan regex greedy match di seluruh HTML karena packed string bisa mengandung
  // single-quote yang memotong regex match. Gunakan indexOf + substring sebagai gantinya.
  let searchPos = 0;
  while (!masterM3u8Url) {
    const evalIdx = html.indexOf("eval(function(p,a,c,k,e,d){", searchPos);
    if (evalIdx === -1) break;

    const scriptEnd = html.indexOf("</script>", evalIdx);
    const rawBlock =
      scriptEnd !== -1
        ? html.substring(evalIdx, scriptEnd).trim()
        : html.substring(evalIdx, evalIdx + 12000).trim();

    let unpacked: string;
    try {
      unpacked = unpackJS(rawBlock);
    } catch {
      searchPos = evalIdx + 1;
      continue;
    }

    const m3u8Match = unpacked.match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/);
    if (m3u8Match) {
      masterM3u8Url = m3u8Match[1];
    }

    searchPos = evalIdx + 1;
  }

  // ── Tahap 2: fallback — cari langsung di HTML (kadang tidak di-pack) ────────
  if (!masterM3u8Url) {
    const directMatch = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/);
    if (directMatch) {
      masterM3u8Url = directMatch[1];
    }
  }

  // ── Tahap 3: fallback — cari di sources:[{file:"..."}] pattern ──────────────
  if (!masterM3u8Url) {
    const sourcesMatch = html.match(
      /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/,
    );
    if (sourcesMatch) {
      masterM3u8Url = sourcesMatch[1];
    }
  }

  if (!masterM3u8Url) {
    throw new Error(
      `M3U8 URL not found in rubyvidhub embed page for videoId ${videoId}`,
    );
  }

  return { masterM3u8Url, videoId };
}

// ─── Encode/Decode token ──────────────────────────────────────────────────────

function encodeToken(url: string): string {
  return Buffer.from(url, "utf8").toString("hex");
}

function decodeToken(token: string): string {
  return Buffer.from(token, "hex").toString("utf8");
}

// ─── Rewrite M3U8 — semua URL lewat proxy ────────────────────────────────────
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

// ─── Routes ───────────────────────────────────────────────────────────────────

export const rubyProxyRoutes: FastifyPluginAsync = async (app) => {
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
   * Fetch embed page → extract M3U8 URL → rewrite → return proxied M3U8
   * videoId = bagian setelah "embed-" dan sebelum ".html"
   * contoh: https://rubyvidhub.com/embed-fqpkrsvfz6i5.html → videoId = fqpkrsvfz6i5
   */
  app.get<{ Params: { videoId: string } }>(
    "/playlist/:videoId",
    async (req, reply) => {
      const { videoId } = req.params;

      let meta: RubyMetadata;
      try {
        meta = await fetchRubyMetadata(videoId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ error: message });
      }

      // const port = req.port ? `:${req.port}` : "";
      const baseUrl = `${STREAMING_HOST_URL}${BASE_PREFIX_SERVER_PATH}`;
      const cacheParts = [baseUrl, meta.masterM3u8Url];
      const cached = await readVideoPlaylistCache("ruby:master", cacheParts);

      if (cached) {
        return reply
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .header("Access-Control-Allow-Origin", "*")
          .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
          .header("X-Video-Playlist-Cache", "hit")
          .send(cached);
      }

      // Fetch master M3U8 dari CDN streamruby
      const hlsRes = await fetch(meta.masterM3u8Url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "Chrome/124.0 Safari/537.36",
          Referer: RUBY_REFERER,
        },
      });

      if (!hlsRes.ok) {
        return reply
          .status(hlsRes.status)
          .send({ error: "Failed to fetch M3U8 from streamruby CDN" });
      }

      const m3u8Text = await hlsRes.text();
      const rewritten = rewriteM3u8(m3u8Text, baseUrl, meta.masterM3u8Url);
      await writeVideoPlaylistCache("ruby:master", cacheParts, rewritten);

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
   * Proxy segment atau sub-playlist dari CDN streamruby.
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
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "Chrome/124.0 Safari/537.36",
        Referer: RUBY_REFERER,
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
      targetUrl.includes("master") ||
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
      const cached = await readVideoPlaylistCache("ruby:segment", cacheParts);
      if (cached) {
        return reply
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .header("Access-Control-Allow-Origin", "*")
          .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
          .header("X-Video-Playlist-Cache", "hit")
          .send(cached);
      }
      const rewritten = rewriteM3u8(bodyText, baseUrl, targetUrl);
      await writeVideoPlaylistCache("ruby:segment", cacheParts, rewritten);

      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", VIDEO_PLAYLIST_CACHE_CONTROL)
        .header("X-Video-Playlist-Cache", "miss")
        .send(rewritten);
    }

    // Binary segment (.ts) — hijack agar onSend hook tidak double-write header
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

  /**
   * GET /info/:videoId
   * Debug — return raw metadata (masterM3u8Url).
   */
  app.get<{ Params: { videoId: string } }>(
    "/info/:videoId",
    async (req, reply) => {
      try {
        const meta = await fetchRubyMetadata(req.params.videoId);
        return reply.send(meta);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ error: message });
      }
    },
  );
};
