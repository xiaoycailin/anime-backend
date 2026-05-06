import type { FastifyPluginAsync } from "fastify";
import { Readable } from "node:stream";
import { sendError } from "../../utils/response";
import { VIDEO_SEGMENT_CACHE_CONTROL } from "../../utils/video-stream-cache";

const FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SOKUJA_REFERER = "https://x5.sokuja.uk/";
const DEFAULT_SKJ_PROXY_BASE_URL = "http://88.80.150.16:8092";
const FORWARDED_HEADERS = [
  "content-type",
  "content-length",
  "accept-ranges",
  "content-range",
  "etag",
  "last-modified",
];

function decodeHexUrl(hexUrl: string) {
  const value = hexUrl
    .trim()
    .replace(/^stream\//i, "")
    .replace(/\.mp4$/i, "");
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) return null;

  try {
    return Buffer.from(value, "hex").toString("utf8");
  } catch {
    return null;
  }
}

function isAllowedSokujaUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "storages.sokuja.id" || url.hostname.endsWith(".sokuja.id"))
    );
  } catch {
    return false;
  }
}

function buildHeaders(requestHeaders: Record<string, unknown>) {
  const headers: Record<string, string> = {
    accept:
      typeof requestHeaders.accept === "string" && requestHeaders.accept
        ? requestHeaders.accept
        : "video/mp4,*/*",
    "accept-language":
      typeof requestHeaders["accept-language"] === "string" &&
      requestHeaders["accept-language"]
        ? requestHeaders["accept-language"]
        : "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    origin: SOKUJA_REFERER.replace(/\/$/, ""),
    referer: SOKUJA_REFERER,
    "sec-fetch-dest": "video",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-site": "same-site",
    "user-agent":
      typeof requestHeaders["user-agent"] === "string" &&
      requestHeaders["user-agent"]
        ? requestHeaders["user-agent"]
        : FALLBACK_USER_AGENT,
  };

  if (typeof requestHeaders.range === "string" && requestHeaders.range) {
    headers.range = requestHeaders.range;
  }

  return headers;
}

function sokujaProxyBaseUrl() {
  return (
    process.env.SKJ_PROXY_BASE_URL?.trim().replace(/\/+$/, "") ||
    DEFAULT_SKJ_PROXY_BASE_URL
  );
}

function shouldRedirectToSokujaProxy(status: number) {
  return status === 403 || status === 429;
}

export const skjRoutes: FastifyPluginAsync = async (app) => {
  async function streamSokuja(request: any, reply: any, method: "GET" | "HEAD") {
    const params = request.params as { "*": string };
    const hexUrl = params["*"];
    const targetUrl = hexUrl ? decodeHexUrl(hexUrl) : null;

    if (!targetUrl || !isAllowedSokujaUrl(targetUrl)) {
      return sendError(reply, {
        status: 400,
        message: "Invalid Sokuja stream URL",
        errorCode: "INVALID_SKJ_STREAM_URL",
      });
    }

    try {
      const upstream = await fetch(targetUrl, {
        method,
        headers: buildHeaders(request.headers as Record<string, unknown>),
      });

      if (!upstream.ok && upstream.status !== 206) {
        if (shouldRedirectToSokujaProxy(upstream.status)) {
          return reply.redirect(`${sokujaProxyBaseUrl()}${request.url}`, 307);
        }

        return sendError(reply, {
          status: upstream.status,
          message: "Upstream Sokuja stream request failed",
          errorCode: "SKJ_UPSTREAM_FAILED",
          data: {
            upstreamStatus: upstream.status,
            upstreamBody: (await upstream.text().catch(() => "")).slice(0, 300),
          },
        });
      }

      reply.code(upstream.status);
      for (const headerName of FORWARDED_HEADERS) {
        const value = upstream.headers.get(headerName);
        if (value) reply.header(headerName, value);
      }
      reply.header("accept-ranges", upstream.headers.get("accept-ranges") ?? "bytes");
      reply.header("cache-control", VIDEO_SEGMENT_CACHE_CONTROL);

      if (method === "HEAD") return reply.send();
      if (!upstream.body) return reply.send();
      return reply.send(Readable.fromWeb(upstream.body as any));
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to proxy Sokuja stream",
        errorCode: "SKJ_PROXY_FAILED",
      });
    }
  }

  app.head("/*", async (request, reply) => {
    return streamSokuja(request, reply, "HEAD");
  });

  app.get("/*", { exposeHeadRoute: false }, async (request, reply) => {
    return streamSokuja(request, reply, "GET");
  });
};
