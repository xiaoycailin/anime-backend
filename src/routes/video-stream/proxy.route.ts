import type { FastifyPluginAsync } from "fastify";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { sendError } from "../../utils/response";
import {
  readVideoPlaylistCache,
  VIDEO_PLAYLIST_CACHE_CONTROL,
  VIDEO_SEGMENT_CACHE_CONTROL,
  writeVideoPlaylistCache,
} from "../../utils/video-stream-cache";

const PROXY_BASE_PATH = "/api/video-stream/proxy";
const FORWARDED_HEADERS = [
  "content-type",
  "content-length",
  "accept-ranges",
  "content-range",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
];
const FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function toAbsoluteUrl(value: string, baseUrl: string) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function toProxyUrl(basePath: string, targetUrl: string) {
  return `${basePath}?url=${encodeURIComponent(targetUrl)}`;
}

function rewritePlaylistContent(
  content: string,
  sourceUrl: string,
  proxyPath: string,
) {
  const lines = content.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (_full, uriValue: string) => {
        const absoluteUrl = toAbsoluteUrl(uriValue, sourceUrl);
        if (!isHttpUrl(absoluteUrl)) return `URI="${uriValue}"`;
        return `URI="${toProxyUrl(proxyPath, absoluteUrl)}"`;
      });
    }

    const absoluteUrl = toAbsoluteUrl(trimmed, sourceUrl);
    if (!isHttpUrl(absoluteUrl)) return line;
    return toProxyUrl(proxyPath, absoluteUrl);
  });

  return rewritten.join("\n");
}

function shouldRewriteAsPlaylist(contentType: string | null, url: string) {
  const normalized = (contentType ?? "").toLowerCase();
  if (
    normalized.includes("application/vnd.apple.mpegurl") ||
    normalized.includes("application/x-mpegurl")
  ) {
    return true;
  }

  return url.toLowerCase().includes(".m3u8");
}

function isDailymotionLikeHost(hostname: string) {
  return hostname.includes("dailymotion.com") || hostname.includes("dmcdn.net");
}

function buildUpstreamHeaders(
  requestHeaders: Record<string, unknown>,
  target: URL,
) {
  const isDailymotion = target.hostname.includes("dailymotion.com");
  const refererBase = isDailymotion
    ? "https://www.dailymotion.com/"
    : `${target.protocol}//${target.host}/`;
  const originBase = isDailymotion
    ? "https://www.dailymotion.com"
    : `${target.protocol}//${target.host}`;

  const headers: Record<string, string> = {
    "user-agent":
      typeof requestHeaders["user-agent"] === "string" &&
      requestHeaders["user-agent"]
        ? requestHeaders["user-agent"]
        : FALLBACK_USER_AGENT,
    referer: refererBase,
    origin: originBase,
  };

  if (typeof requestHeaders.accept === "string" && requestHeaders.accept) {
    headers.accept = requestHeaders.accept;
  } else {
    headers.accept = "application/vnd.apple.mpegurl,application/x-mpegURL,*/*";
  }

  if (typeof requestHeaders.range === "string" && requestHeaders.range) {
    headers.range = requestHeaders.range;
  }

  if (
    typeof requestHeaders["accept-language"] === "string" &&
    requestHeaders["accept-language"]
  ) {
    headers["accept-language"] = requestHeaders["accept-language"];
  } else {
    headers["accept-language"] = "en-US,en;q=0.9";
  }

  if (isDailymotion) {
    headers["sec-fetch-dest"] = "video";
    headers["sec-fetch-mode"] = "cors";
    headers["sec-fetch-site"] = "cross-site";
  }

  return headers;
}

function extractDailymotionVideoId(targetUrl: string) {
  try {
    const parsed = new URL(targetUrl);
    if (!parsed.hostname.includes("dailymotion.com")) return null;
    const match = parsed.pathname.match(/\/manifest\/video\/([^/]+)\.m3u8$/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function refreshDailymotionManifestUrl(
  videoId: string,
  userAgent: string,
) {
  const metadataUrl = `https://www.dailymotion.com/player/metadata/video/${videoId}`;
  const response = await fetch(metadataUrl, {
    headers: {
      "user-agent": userAgent || FALLBACK_USER_AGENT,
      accept: "application/json,text/plain,*/*",
      referer: "https://www.dailymotion.com/",
      origin: "https://www.dailymotion.com",
    },
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as {
    qualities?: Record<string, Array<{ url?: string }>>;
  };

  const autoQualities = payload?.qualities?.auto ?? [];
  const freshUrl = autoQualities.find(
    (item) => typeof item.url === "string",
  )?.url;
  if (!freshUrl || !isHttpUrl(freshUrl)) return null;

  return freshUrl;
}

async function runCurlRequest(
  targetUrl: string,
  headers: Record<string, string>,
) {
  const headerFile = path.join(tmpdir(), `proxy-headers-${randomUUID()}.txt`);
  const args = [
    "-sS",
    "-L",
    "--http1.1",
    "-D",
    headerFile,
    "--output",
    "-",
    targetUrl,
  ];

  for (const [key, value] of Object.entries(headers)) {
    args.push("-H", `${key}: ${value}`);
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const exitCode: number = await new Promise((resolve, reject) => {
    const child = spawn("curl.exe", args, { windowsHide: true });

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  const headerText = await fs.readFile(headerFile, "utf8").catch(() => "");
  await fs.unlink(headerFile).catch(() => {});

  const blocks = headerText
    .split(/\r?\n\r?\n/g)
    .map((block) => block.trim())
    .filter((block) => block.startsWith("HTTP/"));

  const lastBlock = blocks[blocks.length - 1] ?? "";
  const lines = lastBlock.split(/\r?\n/).filter(Boolean);
  const statusLine = lines[0] ?? "";
  const status =
    Number(statusLine.split(" ")[1]) || (exitCode === 0 ? 200 : 500);
  const responseHeaders = new Map<string, string>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) continue;
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!name || !value) continue;
    responseHeaders.set(name, value);
  }

  return {
    status,
    ok: status >= 200 && status < 300,
    headers: responseHeaders,
    body: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

export const proxyRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (request, reply) => {
    const query = request.query as { url?: string };
    const targetUrl = query.url?.trim();

    if (!targetUrl) {
      return sendError(reply, {
        status: 400,
        message: "Query parameter 'url' is required",
        errorCode: "URL_REQUIRED",
        data: {
          example: `${PROXY_BASE_PATH}?url=${encodeURIComponent("https://example.com/video.m3u8")}`,
        },
      });
    }

    if (!isHttpUrl(targetUrl)) {
      return sendError(reply, {
        status: 400,
        message: "Only http/https URLs are allowed",
        errorCode: "INVALID_URL_PROTOCOL",
      });
    }

    try {
      let effectiveTargetUrl = targetUrl;
      let target = new URL(effectiveTargetUrl);
      let upstreamHeaders = buildUpstreamHeaders(
        request.headers as Record<string, unknown>,
        target,
      );
      const useCurl = isDailymotionLikeHost(target.hostname);

      let upstreamFetch: Response | null = null;
      let upstreamCurl: {
        status: number;
        ok: boolean;
        headers: Map<string, string>;
        body: Buffer;
        stderr: string;
      } | null = null;

      if (useCurl) {
        upstreamCurl = await runCurlRequest(
          effectiveTargetUrl,
          upstreamHeaders,
        );
      } else {
        upstreamFetch = await fetch(effectiveTargetUrl, {
          method: "GET",
          headers: upstreamHeaders,
        });
      }

      if (
        (useCurl
          ? upstreamCurl?.status === 403
          : upstreamFetch?.status === 403) &&
        extractDailymotionVideoId(effectiveTargetUrl)
      ) {
        const videoId = extractDailymotionVideoId(effectiveTargetUrl);
        const freshManifestUrl = videoId
          ? await refreshDailymotionManifestUrl(
              videoId,
              upstreamHeaders["user-agent"],
            )
          : null;

        if (freshManifestUrl) {
          effectiveTargetUrl = freshManifestUrl;
          target = new URL(effectiveTargetUrl);
          upstreamHeaders = buildUpstreamHeaders(
            request.headers as Record<string, unknown>,
            target,
          );
          if (useCurl) {
            upstreamCurl = await runCurlRequest(
              effectiveTargetUrl,
              upstreamHeaders,
            );
          } else {
            upstreamFetch = await fetch(effectiveTargetUrl, {
              method: "GET",
              headers: upstreamHeaders,
            });
          }
        }
      }

      const upstreamStatus = useCurl
        ? (upstreamCurl?.status ?? 500)
        : (upstreamFetch?.status ?? 500);
      const upstreamOk = useCurl
        ? Boolean(upstreamCurl?.ok)
        : Boolean(upstreamFetch?.ok);

      if (!upstreamOk && upstreamStatus !== 206) {
        const body = useCurl
          ? (upstreamCurl?.body.toString("utf8") ?? upstreamCurl?.stderr ?? "")
          : ((await upstreamFetch?.text().catch(() => "")) ?? "");
        return sendError(reply, {
          status: upstreamStatus,
          message: "Upstream video request failed",
          errorCode: "UPSTREAM_FETCH_FAILED",
          data: {
            targetUrl: effectiveTargetUrl,
            originalTargetUrl: targetUrl,
            upstreamStatus,
            upstreamBody: body.slice(0, 500),
          },
        });
      }

      const contentType = useCurl
        ? (upstreamCurl?.headers.get("content-type") ?? null)
        : (upstreamFetch?.headers.get("content-type") ?? null);
      const isPlaylist = shouldRewriteAsPlaylist(
        contentType,
        effectiveTargetUrl,
      );

      if (isPlaylist) {
        const cacheParts = [
          PROXY_BASE_PATH,
          effectiveTargetUrl,
          request.headers.host ?? "",
        ];
        const cached = await readVideoPlaylistCache("proxy:playlist", cacheParts);
        if (cached) {
          reply.code(upstreamStatus);
          reply.header("content-type", "application/vnd.apple.mpegurl");
          reply.header("cache-control", VIDEO_PLAYLIST_CACHE_CONTROL);
          reply.header("x-video-playlist-cache", "hit");
          return reply.send(cached);
        }

        const manifestText = useCurl
          ? (upstreamCurl?.body.toString("utf8") ?? "")
          : ((await upstreamFetch?.text()) ?? "");
        const rewritten = rewritePlaylistContent(
          manifestText,
          effectiveTargetUrl,
          PROXY_BASE_PATH,
        );
        await writeVideoPlaylistCache("proxy:playlist", cacheParts, rewritten);

        reply.code(upstreamStatus);
        reply.header("content-type", "application/vnd.apple.mpegurl");
        reply.header("cache-control", VIDEO_PLAYLIST_CACHE_CONTROL);
        reply.header("x-video-playlist-cache", "miss");
        return reply.send(rewritten);
      }

      reply.code(upstreamStatus);
      for (const headerName of FORWARDED_HEADERS) {
        const headerValue = useCurl
          ? upstreamCurl?.headers.get(headerName)
          : upstreamFetch?.headers.get(headerName);
        if (!headerValue) continue;
        reply.header(headerName, headerValue);
      }
      reply.header("cache-control", VIDEO_SEGMENT_CACHE_CONTROL);

      if (useCurl) {
        return reply.send(upstreamCurl?.body ?? Buffer.alloc(0));
      }

      if (!upstreamFetch?.body) {
        return reply.send();
      }

      return reply.send(Readable.fromWeb(upstreamFetch.body as any));
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to proxy video stream",
        errorCode: "VIDEO_PROXY_FAILED",
      });
    }
  });
};
