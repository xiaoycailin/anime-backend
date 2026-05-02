import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../lib/prisma";
import { CACHE_KEYS, CACHE_TTL, getCache, setCache } from "../../lib/cache";
import { ok, sendError } from "../../utils/response";
import { normalizeTitle } from "../../utils/season-parser";
import { PUBLIC_CACHE, setPublicCache } from "../../utils/cache-control";

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

type WeeklyTrendingItem = {
  id: number;
  slug: string;
  title: string;
  genre: string[];
  thumbnail: string | null;
  status: string | null;
};

export const trendingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/weekly", async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(toPositiveInt(query.limit, 9), 50);
    const cacheKey = CACHE_KEYS.trendingWeekly(limit);

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd);
    windowStart.setDate(windowStart.getDate() - 7);

    try {
      setPublicCache(reply, PUBLIC_CACHE.SECTION);
      const cached = await getCache<WeeklyTrendingItem[]>(cacheKey);

      if (cached) {
        return ok(reply, {
          message: "Weekly trending anime fetched successfully",
          data: cached,
          meta: {
            limit,
            windowStart: windowStart.toISOString(),
            windowEnd: windowEnd.toISOString(),
            ranking: ["followed desc", "rating desc", "updatedAt desc"],
            note: "Trending is inferred from recently updated anime and popularity fields.",
            cache: "hit",
          },
        });
      }

      const animes = await prisma.anime.findMany({
        where: {
          updatedAt: {
            gte: windowStart,
          },
        },
        orderBy: [
          { followed: "desc" },
          { rating: "desc" },
          { updatedAt: "desc" },
        ],
        take: limit,
        select: {
          id: true,
          slug: true,
          title: true,
          genres: {
            select: {
              genre: {
                select: {
                  name: true,
                },
              },
            },
          },
          thumbnail: true,
          status: true,
        },
      });

      const data: WeeklyTrendingItem[] = animes.map((anime) => ({
        id: anime.id,
        slug: anime.slug,
        title: normalizeTitle(anime.title),
        genre: anime.genres.map((item) => item.genre.name),
        thumbnail: anime.thumbnail,
        status: anime.status,
      }));

      await setCache(cacheKey, data, CACHE_TTL.TRENDING_WEEKLY);

      return ok(reply, {
        message: "Weekly trending anime fetched successfully",
        data,
        meta: {
          limit,
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          ranking: ["followed desc", "rating desc", "updatedAt desc"],
          note: "Trending is inferred from recently updated anime and popularity fields.",
          cache: "miss",
        },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch weekly trending anime",
        errorCode: "TRENDING_WEEKLY_FETCH_FAILED",
      });
    }
  });
};
