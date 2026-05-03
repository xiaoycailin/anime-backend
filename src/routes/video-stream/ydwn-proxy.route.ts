import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { STREAMING_HOST_URL } from "./url-config";

const BASE_PREFIX = "/api/video-stream/ydwn-proxy";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function goProxyTarget(requestUrl: string): string {
  if (requestUrl.startsWith(BASE_PREFIX)) {
    return `${STREAMING_HOST_URL}${requestUrl}`;
  }
  return `${STREAMING_HOST_URL}${BASE_PREFIX}${requestUrl}`;
}

function headerValue(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value.join(", ") : value ?? fallback;
}

function streamingPublicURL() {
  try {
    return new URL(STREAMING_HOST_URL);
  } catch {
    return null;
  }
}

function copyResponseHeaders(source: Headers, reply: FastifyReply) {
  source.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      reply.header(key, value);
    }
  });
}

function responseHead(source: Headers) {
  const headers: Record<string, string> = {};
  source.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers[key] = value;
    }
  });
  return headers;
}

export const ydwnProxyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onSend", async (_req, reply) => {
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
      .header("Access-Control-Allow-Headers", "*");
  });

  app.options("*", async (_req, reply) =>
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
      .header("Access-Control-Allow-Headers", "*")
      .status(204)
      .send()
  );

  app.route({
    method: ["GET", "HEAD"],
    url: "*",
    handler: async (req, reply) => {
      let upstream: Response;
      try {
        upstream = await fetch(goProxyTarget(req.url), {
          method: req.method,
          headers: {
            "User-Agent": headerValue(req.headers["user-agent"]),
            Accept: headerValue(req.headers.accept, "*/*"),
            "Accept-Language": headerValue(req.headers["accept-language"], "en-US,en;q=0.9"),
            Range: headerValue(req.headers.range),
            "X-Forwarded-Host": streamingPublicURL()?.host ?? "",
            "X-Forwarded-Proto": streamingPublicURL()?.protocol.replace(":", "") ?? "https",
          },
        });
      } catch (err) {
        return reply.status(502).send({ error: String(err) });
      }

      copyResponseHeaders(upstream.headers, reply);
      reply.status(upstream.status);

      if (!upstream.body || req.method === "HEAD") {
        return reply.send();
      }

      reply.hijack();
      reply.raw.writeHead(upstream.status, responseHead(upstream.headers));
      await pipeline(Readable.fromWeb(upstream.body as never), reply.raw);
    },
  });
};
