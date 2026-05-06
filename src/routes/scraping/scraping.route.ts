import type { FastifyPluginAsync } from "fastify";
import { assert } from "../../utils/assert";
import { ok, sendError } from "../../utils/response";
import scrapeSeriesList from "../../services/scraper-service/scrapeSeriesList";
import getBody from "../../services/scraper-service/getBody";
import { importSokujaAnimePages } from "../../services/scraper-service/importSokujaAnime.service";
import { runSokujaImportJob } from "../../services/scraper-service/importSokujaAnimeJob.service";
import { runSokujaScan } from "../../services/scraper-service/scanSokujaAnime.service";
import { scrapeSokujaAnimePages } from "../../services/scraper-service/scrapeSokujaAnimeList.service";
import {
  deleteProgress,
  getProgress,
  subscribeProgress,
} from "../../lib/progessStore";
import {
  deleteSokujaScan,
  getSokujaScan,
  subscribeSokujaScan,
} from "../../lib/sokujaScanStore";
import { createRoleNotification } from "../../services/notification.service";

function parseBooleanQuery(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  return ["1", "true", "yes", "on"].includes(String(raw ?? "").toLowerCase());
}

function parsePositiveNumber(value: unknown, fallback: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

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

  app.get("/sokuja/anime-list", async (request, reply) => {
    const { page, toPage, includeDetails, includeEpisodeServers } = request.query as {
      page?: string | number;
      toPage?: string | number;
      includeDetails?: string | boolean;
      includeEpisodeServers?: string | boolean;
    };

    const fromPage = Number(page ?? 1);
    const lastPage = Number(toPage ?? fromPage);
    const shouldIncludeEpisodeServers = parseBooleanQuery(includeEpisodeServers);
    const shouldIncludeDetails =
      parseBooleanQuery(includeDetails) || shouldIncludeEpisodeServers;

    try {
      const scraped = await scrapeSokujaAnimePages(fromPage, lastPage, {
        includeDetails: shouldIncludeDetails,
        includeEpisodeServers: shouldIncludeEpisodeServers,
      });

      reply.header("Cache-Control", "no-store");
      return ok(reply, {
        message: "Sokuja anime list scraped",
        data: {
          ...scraped,
          detailsIncluded: shouldIncludeDetails,
          episodeServersIncluded: shouldIncludeEpisodeServers,
          detailCount: scraped.animeDetails?.length ?? 0,
        },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to scrape Sokuja anime list",
        errorCode: "SOKUJA_SCRAPE_FAILED",
      });
    }
  });

  app.post("/sokuja/scan", async (request, reply) => {
    const { page, toPage, episodeMode, episodeLimit } = request.query as {
      page?: string | number;
      toPage?: string | number;
      episodeMode?: "full" | "recent";
      episodeLimit?: string | number;
    };
    const fromPage = parsePositiveNumber(page, 1);
    const lastPage = Math.max(fromPage, parsePositiveNumber(toPage, fromPage));
    const mode = episodeMode === "recent" ? "recent" : "full";
    const limit = parsePositiveNumber(episodeLimit, 2);
    const scanId = `sokuja:${fromPage}-${lastPage}:${mode}:${limit}:${Date.now()}`;

    runSokujaScan({
      id: scanId,
      fromPage,
      toPage: lastPage,
      episodeMode: mode,
      episodeLimit: limit,
    }).catch((error) => request.log.error(error));

    return ok(reply, {
      message: "Sokuja scan started",
      data: {
        scanId,
        streamUrl: `/api/scraping/sokuja/scan/${encodeURIComponent(scanId)}/stream`,
      },
    });
  });

  app.get("/sokuja/scan/:scanId", async (request, reply) => {
    const { scanId } = request.params as { scanId: string };
    const state = getSokujaScan(scanId);
    if (!state) {
      return sendError(reply, {
        status: 404,
        message: "Sokuja scan not found",
        errorCode: "SOKUJA_SCAN_NOT_FOUND",
      });
    }
    return ok(reply, { data: state });
  });

  app.get("/sokuja/scan/:scanId/stream", async (request, reply) => {
    const { scanId } = request.params as { scanId: string };
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

    const writeScan = (payload: unknown) => {
      reply.raw.write("event: scan\n");
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    writeScan(getSokujaScan(scanId) ?? null);
    const unsubscribe = subscribeSokujaScan(scanId, writeScan);
    const heartbeat = setInterval(() => {
      reply.raw.write("event: heartbeat\n");
      reply.raw.write("data: {}\n\n");
    }, 15000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });

  app.delete("/sokuja/scan/:scanId", async (request, reply) => {
    const { scanId } = request.params as { scanId: string };
    const deleted = deleteSokujaScan(scanId);
    if (!deleted) {
      return sendError(reply, {
        status: 404,
        message: "Sokuja scan not found",
        errorCode: "SOKUJA_SCAN_NOT_FOUND",
      });
    }
    return ok(reply, { message: "Sokuja scan deleted", data: { scanId } });
  });

  app.post("/sokuja/import", async (request, reply) => {
    const { page, toPage, dryRun, episodeMode, episodeLimit } = request.query as {
      page?: string | number;
      toPage?: string | number;
      dryRun?: string | boolean;
      episodeMode?: "full" | "recent";
      episodeLimit?: string | number;
    };

    const fromPage = Number(page ?? 1);
    const lastPage = Number(toPage ?? fromPage);
    const shouldDryRun = parseBooleanQuery(dryRun);
    const normalizedEpisodeMode = episodeMode === "recent" ? "recent" : "full";
    const normalizedEpisodeLimit = Number(episodeLimit ?? 2);

    try {
      const imported = await importSokujaAnimePages({
        fromPage,
        toPage: lastPage,
        dryRun: shouldDryRun,
        episodeMode: normalizedEpisodeMode,
        episodeLimit: Number.isFinite(normalizedEpisodeLimit)
          ? Math.max(1, Math.floor(normalizedEpisodeLimit))
          : 2,
      });

      reply.header("Cache-Control", "no-store");
      return ok(reply, {
        message: shouldDryRun ? "Sokuja import preview generated" : "Sokuja anime imported",
        data: imported,
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to import Sokuja anime",
        errorCode: "SOKUJA_IMPORT_FAILED",
      });
    }
  });

  app.post("/sokuja/import-job", async (request, reply) => {
    const { page, toPage, episodeMode, episodeLimit } = request.query as {
      page?: string | number;
      toPage?: string | number;
      episodeMode?: "full" | "recent";
      episodeLimit?: string | number;
    };
    const fromPage = parsePositiveNumber(page, 1);
    const lastPage = Math.max(fromPage, parsePositiveNumber(toPage, fromPage));
    const mode = episodeMode === "recent" ? "recent" : "full";
    const limit = parsePositiveNumber(episodeLimit, 2);
    const importId = `sokuja-import:${fromPage}-${lastPage}:${mode}:${limit}:${Date.now()}`;

    runSokujaImportJob({
      id: importId,
      fromPage,
      toPage: lastPage,
      episodeMode: mode,
      episodeLimit: limit,
    }).catch((error) => request.log.error(error));

    return ok(reply, {
      message: "Sokuja import started",
      data: {
        importId,
        scanId: importId,
        streamUrl: `/api/scraping/sokuja/scan/${encodeURIComponent(importId)}/stream`,
      },
    });
  });
};
