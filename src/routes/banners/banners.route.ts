import type { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  buildQueryKey,
  CACHE_KEYS,
  CACHE_TTL,
  getCache,
  setCache,
} from "../../lib/cache";
import { ok, sendError } from "../../utils/response";
import { normalizeTitle } from "../../utils/season-parser";

const ACCENT_PRESETS = [
  "from-violet-600 to-purple-700",
  "from-rose-600 to-orange-500",
  "from-cyan-600 to-blue-700",
  "from-emerald-600 to-teal-700",
  "from-fuchsia-600 to-pink-700",
];

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseSortBy(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return ["trending", "updatedAt"];
  }

  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function buildOrderBy(
  sortBy: string[],
): Prisma.AnimeOrderByWithRelationInput[] {
  const orderBy: Prisma.AnimeOrderByWithRelationInput[] = [];

  for (const key of sortBy) {
    if (key === "trending") {
      orderBy.push({ followed: "desc" }, { rating: "desc" });
      continue;
    }

    if (key === "updatedat" || key === "updateat" || key === "latest") {
      orderBy.push({ updatedAt: "desc" });
      continue;
    }

    if (key === "rating") {
      orderBy.push({ rating: "desc" });
      continue;
    }
  }

  if (!orderBy.some((item) => "updatedAt" in item)) {
    orderBy.push({ updatedAt: "desc" });
  }

  return orderBy;
}

function formatEpisodeLabel(
  totalEpisodes: number | null,
  episodesCount: number,
) {
  const finalCount =
    totalEpisodes && totalEpisodes > 0 ? totalEpisodes : episodesCount;
  if (!finalCount || finalCount <= 0) return "Episode -";
  return `Episode 1-${finalCount}`;
}

type BannerItem = {
  id: number;
  slug: string;
  title: string;
  description: string;
  genre: string[];
  episode: string;
  rating: string | null;
  status: "Completed" | "Ongoing";
  thumbnail: string;
  banner: string;
  href: string;
  accent: string;
};

export const bannersRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (request, reply) => {
    const query = request.query as {
      limit?: string;
      sortBy?: string;
      sortby?: string;
    };

    const limit = Math.min(toPositiveInt(query.limit, 3), 20);
    const sortBy = parseSortBy(query.sortBy ?? query.sortby);
    const orderBy = buildOrderBy(sortBy);
    const cacheKey = CACHE_KEYS.banners(
      buildQueryKey({
        limit,
        sortBy: sortBy.join(","),
      }),
    );

    try {
      const cached = await getCache<BannerItem[]>(cacheKey);

      if (cached) {
        return ok(reply, {
          message: "Banner data fetched successfully",
          data: cached,
          meta: {
            limit,
            sortBy,
            cache: "hit",
          },
        });
      }

      const animes = await prisma.anime.findMany({
        orderBy,
        take: limit,
        select: {
          id: true,
          slug: true,
          title: true,
          synopsis: true,
          status: true,
          totalEpisodes: true,
          rating: true,
          bigCover: true,
          thumbnail: true,
          episodes: {
            select: { slug: true },
          },
          genres: {
            select: {
              genre: {
                select: { name: true },
              },
            },
          },
          _count: {
            select: {
              episodes: true,
            },
          },
        },
      });

      const data: BannerItem[] = animes.map((anime, index) => ({
        id: anime.id,
        slug: anime.slug,
        title: normalizeTitle(anime.title),
        description: anime.synopsis ?? "",
        genre: anime.genres.map((item) => item.genre.name),
        episode: formatEpisodeLabel(anime.totalEpisodes, anime._count.episodes),
        rating: anime.rating ? Number(anime.rating).toFixed(1) : null,
        status: anime.status?.toLowerCase().includes("complete")
          ? "Completed"
          : "Ongoing",
        thumbnail: anime.thumbnail ?? "",
        banner: anime.bigCover ?? anime.thumbnail ?? "",
        href: `/anime/${anime.slug}/${anime.episodes[0]?.slug}`,
        accent: ACCENT_PRESETS[index % ACCENT_PRESETS.length],
      }));

      await setCache(cacheKey, data, CACHE_TTL.BANNERS);

      return ok(reply, {
        message: "Banner data fetched successfully",
        data,
        meta: {
          limit,
          sortBy,
          cache: "miss",
        },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch banner data",
        errorCode: "BANNER_FETCH_FAILED",
      });
    }
  });
};
