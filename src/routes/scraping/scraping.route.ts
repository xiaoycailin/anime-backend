import type { FastifyPluginAsync } from "fastify";
import { assert } from "../../utils/assert";
import { ok, sendError } from "../../utils/response";
import scrapeSeriesList from "../../services/scraper-service/scrapeSeriesList";
import getBody from "../../services/scraper-service/getBody";
import {
  deleteProgress,
  getProgress,
  subscribeProgress,
} from "../../lib/progessStore";
import { createRoleNotification } from "../../services/notification.service";

export const scrapingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.get("/", async (request, reply) => {
    const { url, episodeLimit } = request.query as {
      url?: string;
      episodeLimit?: string | number;
    };

    assert(url, "Query parameter 'url' is required", {
      example: "/api?url=https://example.com",
    });
    const parsedEpisodeLimit = Number(episodeLimit);
    const recentEpisodeLimit = Number.isFinite(parsedEpisodeLimit)
      ? Math.max(1, Math.min(2, parsedEpisodeLimit))
      : 2;

    try {
      scrapeSeriesList(url, {
        initiatedById: request.user.id,
        initiatedByUsername: request.user.username,
        recentEpisodeLimit,
      }).catch((err) => {
        request.log.error(err);
        createRoleNotification({
          role: "admin",
          category: "admin_operational",
          type: "scraping_failed",
          title: "Scraping gagal",
          message: `${request.user.username} mengalami error saat scraping: ${(err as Error).message}`,
          link: "/admin/scraping-progress",
          topic: "admin-scraping",
          payload: {
            url,
            error: (err as Error).message,
          },
          createdById: request.user.id,
        }).catch(() => null);
      });
      return ok(reply, {
        message: "running",
        data: {
          progressUrl: `/progress?url=${encodeURIComponent(url)}`,
          recentEpisodeLimit,
        },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to scrape target URL",
        errorCode: "SCRAPE_FAILED",
      });
    }
  });

  // ─── CEK PROGRESS ─────────────────────────────────────────────────────────────
  app.get("/progress", async (request, reply) => {
    const { url } = request.query as { url?: string };

    assert(url, "Query parameter 'url' is required");

    const progress = getProgress(url);
    if (!progress) {
      return sendError(reply, {
        status: 404,
        message: "No progress found for this URL",
        errorCode: "PROGRESS_NOT_FOUND",
      });
    }

    return ok(reply, { data: progress });
  });
  app.get("/progress/stream", async (request, reply) => {
    const { url } = request.query as { url?: string };

    assert(url, "Query parameter 'url' is required");
    const origin = request.headers.origin;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    });

    const writeProgress = (payload: unknown) => {
      reply.raw.write(`event: progress\n`);
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    writeProgress(getProgress(url) ?? null);

    const unsubscribe = subscribeProgress(url, (state) => {
      writeProgress(state);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(`event: heartbeat\n`);
      reply.raw.write(`data: {}\n\n`);
    }, 15000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });

  // ─── DELETE PROGRESS ──────────────────────────────────────────────────────────
  app.delete("/deleteprogress", async (request, reply) => {
    const { url } = request.query as { url?: string };

    assert(url, "Query parameter 'url' is required");

    const deleted = deleteProgress(url);
    if (!deleted) {
      return sendError(reply, {
        status: 404,
        message: "No progress found for this URL",
        errorCode: "PROGRESS_NOT_FOUND",
      });
    }

    return ok(reply, { message: "Progress deleted", data: { url } });
  });

  app.get("/body", async (request, reply) => {
    const { url, type, selector } = request.query as {
      url?: string;
      type?: string;
      selector?: string;
    };

    assert(url, "Query parameter 'url' is required", {
      example: "/api?url=https://example.com",
    });

    try {
      const scraped = await getBody(url, selector);

      reply.type(type ?? "text/html").send(scraped);
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to scrape target URL",
        errorCode: "SCRAPE_FAILED",
      });
    }
  });
};
