import type { FastifyPluginAsync } from "fastify";
import { CACHE_KEYS, CACHE_TTL, getCache, setCache } from "../../lib/cache";
import {
  getHomeSections,
  type HomeSections,
} from "../../services/home-sections.service";
import { PUBLIC_CACHE, setPublicCache } from "../../utils/cache-control";
import { ok, sendError } from "../../utils/response";

export const homeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/sections", async (request, reply) => {
    const cacheKey = CACHE_KEYS.home();
    setPublicCache(reply, PUBLIC_CACHE.FAST);

    try {
      const cached = await getCache<HomeSections>(cacheKey);

      if (cached) {
        return ok(reply, {
          message: "Home sections fetched successfully",
          data: cached,
          meta: {
            cache: "hit",
            sections: [
              "banners",
              "trending",
              "newEpisodes",
              "newRelease",
              "popular",
              "genres",
            ],
          },
        });
      }

      const data = await getHomeSections();
      await setCache(cacheKey, data, CACHE_TTL.HOME);

      return ok(reply, {
        message: "Home sections fetched successfully",
        data,
        meta: {
          cache: "miss",
          sections: [
            "banners",
            "trending",
            "newEpisodes",
            "newRelease",
            "popular",
            "genres",
          ],
        },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch home sections",
        errorCode: "HOME_SECTIONS_FETCH_FAILED",
      });
    }
  });
};
