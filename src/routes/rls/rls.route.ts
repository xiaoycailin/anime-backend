import type { FastifyPluginAsync } from "fastify";
import {
  scrapeReelshortDetail,
  scrapeReelshortEpisodeDetail,
} from "../../services/scraper-service/scrapeReelshort.service";
import { HttpError } from "../../utils/http-error";
import { ok, sendError } from "../../utils/response";

type ReelshortDetailQuery = {
  url?: string;
};

export const rlsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/detail", async (request, reply) => {
    const { url } = request.query as ReelshortDetailQuery;

    if (!url) {
      return sendError(reply, {
        status: 400,
        message: "Query parameter 'url' wajib diisi",
        errorCode: "BAD_REQUEST",
      });
    }

    try {
      const detail = await scrapeReelshortDetail(url);

      reply.header("Cache-Control", "no-store");
      return ok(reply, {
        message: "ReelShort detail scraped",
        data: detail,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return sendError(reply, {
          status: error.statusCode,
          message: error.message,
          errorCode: error.errorCode,
          data: error.details,
        });
      }

      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to scrape ReelShort detail",
        errorCode: "REELSHORT_SCRAPE_FAILED",
      });
    }
  });

  app.get("/detail-mv", async (request, reply) => {
    const { url } = request.query as ReelshortDetailQuery;

    if (!url) {
      return sendError(reply, {
        status: 400,
        message: "Query parameter 'url' wajib diisi",
        errorCode: "BAD_REQUEST",
      });
    }

    try {
      const detail = await scrapeReelshortEpisodeDetail(url);

      reply.header("Cache-Control", "no-store");
      return ok(reply, {
        message: "ReelShort episode detail scraped",
        data: detail,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return sendError(reply, {
          status: error.statusCode,
          message: error.message,
          errorCode: error.errorCode,
          data: error.details,
        });
      }

      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to scrape ReelShort episode detail",
        errorCode: "REELSHORT_EPISODE_SCRAPE_FAILED",
      });
    }
  });
};
