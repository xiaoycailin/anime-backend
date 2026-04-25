import { FastifyPluginAsync } from "fastify";
import { pipeline } from "node:stream/promises";

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_PREFIX_SERVER_PATH = "/api/video-stream/wetv-stream";
const WETV_REFERER = "https://wetv.vip/";
const WETV_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Parameter tetap yang selalu dikirim ke getvinfo
const STATIC_PARAMS: Record<string, string> = {
  charge: "0",
  otype: "json",
  defnpayver: "0",
  spau: "1",
  spaudio: "1",
  spwm: "1",
  sphls: "2",
  host: "wetv.vip",
  refer: "wetv.vip",
  sphttps: "1",
  clip: "4",
  platform: "4830201",
  sdtfrom: "1002",
  appVer: "2.8.44",
  fhdswitch: "0",
  dtype: "3",
  spsrt: "2",
  lang_code: "1491937",
  spgzip: "1",
  spcaptiontype: "1",
  cmd: "2",
  country_code: "153560",
  drm: "0",
  multidrm: "0",
  defn: "shd",
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface WeTVStreamInfo {
  m3u8Url: string; // full URL = base + "/" + hls.pt
  baseUrl: string; // CDN base URL (tanpa trailing slash)
}

// ─── Helper: Encode/decode token ─────────────────────────────────────────────

function encodeToken(url: string): string {
  return Buffer.from(url, "utf8").toString("hex");
}

function decodeToken(token: string): string {
  return Buffer.from(token, "hex").toString("utf8");
}

// ─── Helper: Fetch getvinfo & extract M3U8 URL ───────────────────────────────
//
// WeTV menggunakan cKey v9.2 yang tidak bisa di-generate server-side karena
// algoritmanya berbeda dari v8.1 (format base64url, bukan hex). Oleh karena itu
// cKey dan guid HARUS dikirim dari client (browser) yang sudah menjalankan
// player WeTV dan mendapatkan cKey yang valid.
//
// Flow:
// 1. Client load halaman WeTV → player generate cKey + guid
// 2. Client intercept getvinfo request → ambil cKey, guid, tm, vid, cid
// 3. Client kirim ke proxy: /playlist?vid=...&cid=...&cKey=...&guid=...&tm=...
// 4. Proxy forward ke getvinfo → dapat M3U8 URL → rewrite → return

async function fetchWeTVStreamInfo(
  vid: string,
  cid: string,
  cKey: string,
  guid: string,
  tm: string,
  ehost?: string,
): Promise<WeTVStreamInfo> {
  const params = new URLSearchParams({
    ...STATIC_PARAMS,
    vid,
    cid,
    cKey,
    guid,
    tm,
    flowid: generateFlowId(),
    ehost: ehost || `https://wetv.vip/`,
  });

  const url = `https://play.wetv.vip/getvinfo?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": WETV_UA,
      Referer: WETV_REFERER,
      Cookie: `guid=${guid}; country_code=153560; lang_code=1491937`,
    },
  });

  if (!res.ok) {
    throw new Error(`getvinfo returned ${res.status}`);
  }

  const raw = await res.text();

  // Response format: QZOutputJson={...}{...}  (dua JSON sekaligus)
  // Ambil JSON pertama saja
  let body = raw;
  if (body.startsWith("QZOutputJson="))
    body = body.slice("QZOutputJson=".length);
  const decoder = JSON as { parse: (s: string) => unknown };
  let data: Record<string, unknown>;
  try {
    // raw_decode equivalent: cari posisi akhir JSON pertama
    let depth = 0,
      inStr = false,
      escape = false,
      endIdx = 0;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }
    data = JSON.parse(body.slice(0, endIdx)) as Record<string, unknown>;
  } catch {
    throw new Error("Failed to parse getvinfo response");
  }

  // Cek error
  const em = (data as Record<string, unknown>).em;
  if (em && em !== 0) {
    const msg = (data as Record<string, unknown>).msg ?? "unknown error";
    throw new Error(`getvinfo error em=${em}: ${msg}`);
  }

  // Ekstrak stream URL: vl.vi[0].ul.ui[0]
  const vl = (data as Record<string, Record<string, unknown>>).vl;
  const viList = vl?.vi as Array<Record<string, unknown>>;
  if (!viList?.length) throw new Error("No video info in getvinfo response");

  const vi = viList[0];
  const ul = vi.ul as Record<string, Array<Record<string, unknown>>>;
  const ui = ul?.ui;
  if (!ui?.length) throw new Error("No stream URL in getvinfo response");

  // Ambil CDN URL pertama yang paling reliable (CDN ke-4 = wetvvarietyts.wetvinfo.com seringkali stabil)
  // Prioritas: coba CDN wetvinfo.com dulu, fallback ke CDN lainnya
  let chosen =
    ui.find(
      (u) =>
        typeof u.url === "string" && (u.url as string).includes("wetvinfo.com"),
    ) ?? ui[0];

  const baseUrl = (chosen.url as string).replace(/\/$/, "");
  const hls = chosen.hls as Record<string, string>;
  const hlsPt = hls?.pt;
  if (!hlsPt) throw new Error("No HLS path in stream info");

  const m3u8Url = `${baseUrl}/${hlsPt}`;

  return { m3u8Url, baseUrl };
}

// ─── Helper: generate random flowid (hex 32 char) ────────────────────────────

function generateFlowId(): string {
  const arr = new Uint8Array(16);
  for (let i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Helper: resolve relative URL ────────────────────────────────────────────

function resolveUrl(raw: string, manifestUrl: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://"))
    return trimmed;
  const base = new URL(manifestUrl);
  if (trimmed.startsWith("/")) return `${base.origin}${trimmed}`;
  const dir =
    base.origin +
    base.pathname.substring(0, base.pathname.lastIndexOf("/") + 1);
  return new URL(trimmed, dir).toString();
}

// ─── Helper: rewrite M3U8 ────────────────────────────────────────────────────

function rewriteM3u8(
  content: string,
  baseProxyUrl: string,
  manifestUrl: string,
): string {
  function proxyUrl(raw: string): string {
    const absolute = resolveUrl(raw.trim(), manifestUrl);
    return `${baseProxyUrl}/segment?t=${encodeToken(absolute)}`;
  }
  function rewriteUri(line: string): string {
    return line.replace(
      /URI=(["'])([^"']+)\1/g,
      (_m, q, u) => `URI=${q}${proxyUrl(u)}${q}`,
    );
  }
  return content
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) return rewriteUri(line);
      return proxyUrl(t);
    })
    .join("\n");
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const wetvProxyRoutes: FastifyPluginAsync = async (app) => {
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
   *
   * Query params (WAJIB):
   *   vid   — video ID, contoh: r4102zqaqyj
   *   cid   — cover/series ID, contoh: 19q8yj9d3bzqfqk
   *   cKey  — cKey v9.2 yang di-intercept dari browser (URL-encoded)
   *   guid  — GUID dari cookie browser wetv.vip
   *   tm    — Unix timestamp saat cKey di-generate
   *
   * Query params (opsional):
   *   ehost — URL halaman WeTV (untuk cKey validation), default https://wetv.vip/
   *   defn  — kualitas: ld/sd/hd/shd/fhd, default shd
   *
   * Cara dapat params:
   *   1. Buka wetv.vip di browser
   *   2. DevTools → Network → filter "getvinfo"
   *   3. Copy: cKey, guid, tm dari URL request tersebut
   *   4. Tambahkan vid dan cid dari URL halaman
   */
  app.get<{
    Querystring: {
      vid: string;
      cid: string;
      cKey: string;
      guid: string;
      tm: string;
      ehost?: string;
      defn?: string;
    };
  }>("/playlist", async (req, reply) => {
    const { vid, cid, cKey, guid, tm, ehost, defn } = req.query;

    if (!vid || !cid || !cKey || !guid || !tm) {
      return reply.status(400).send({
        error: "Missing required params: vid, cid, cKey, guid, tm",
        hint: "Intercept the getvinfo request from wetv.vip DevTools Network tab",
      });
    }

    // Override defn jika ada
    if (defn) STATIC_PARAMS.defn = defn;

    let info: WeTVStreamInfo;
    try {
      info = await fetchWeTVStreamInfo(vid, cid, cKey, guid, tm, ehost);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: msg });
    }

    const port = req.port ? `:${req.port}` : "";
    const baseUrl = `${req.protocol}://${req.hostname}${port}${BASE_PREFIX_SERVER_PATH}`;

    // Fetch master M3U8
    const m3u8Res = await fetch(info.m3u8Url, {
      headers: { "User-Agent": WETV_UA, Referer: WETV_REFERER },
    });

    if (!m3u8Res.ok) {
      return reply
        .status(m3u8Res.status)
        .send({ error: "Failed to fetch WeTV M3U8" });
    }

    const m3u8Text = await m3u8Res.text();
    const rewritten = rewriteM3u8(m3u8Text, baseUrl, info.m3u8Url);

    return reply
      .header("Content-Type", "application/vnd.apple.mpegurl")
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", "no-cache")
      .send(rewritten);
  });

  /**
   * GET /segment?t=<hex>
   * Proxy segment .ts atau sub-playlist dari CDN WeTV.
   */
  app.get<{ Querystring: { t: string } }>("/segment", async (req, reply) => {
    const { t } = req.query;
    if (!t) return reply.status(400).send({ error: "Missing token" });

    let targetUrl: string;
    try {
      targetUrl = decodeToken(t);
      new URL(targetUrl);
    } catch {
      return reply.status(400).send({ error: "Invalid token" });
    }

    const upstream = await fetch(targetUrl, {
      headers: { "User-Agent": WETV_UA, Referer: WETV_REFERER },
    });

    if (!upstream.ok || !upstream.body) {
      return reply
        .status(upstream.status)
        .send({ error: "Segment fetch failed" });
    }

    const contentType = upstream.headers.get("content-type") ?? "video/mp2t";
    const mightBeM3u8 =
      contentType.includes("mpegurl") || targetUrl.includes(".m3u8");

    if (mightBeM3u8) {
      const bodyText = await upstream.text();
      if (!bodyText.trimStart().startsWith("#EXTM3U")) {
        return reply
          .header("Content-Type", contentType)
          .header("Access-Control-Allow-Origin", "*")
          .send(Buffer.from(bodyText, "latin1"));
      }
      const port = req.port ? `:${req.port}` : "";
      const baseUrl = `${req.protocol}://${req.hostname}${port}${BASE_PREFIX_SERVER_PATH}`;
      return reply
        .header("Content-Type", "application/vnd.apple.mpegurl")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache")
        .send(rewriteM3u8(bodyText, baseUrl, targetUrl));
    }

    // Binary .ts segment
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    });
    await pipeline(
      upstream.body as unknown as NodeJS.ReadableStream,
      reply.raw,
    );
  });
};
