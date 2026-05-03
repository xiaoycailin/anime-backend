import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../lib/prisma";
import { ok } from "../../utils/response";

type RecommendationReason = {
  type: "genre" | "popular";
  label: string;
  weight: number;
};

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function addScore(scores: Map<string, number>, genre: string | null | undefined, weight: number) {
  const key = genre?.trim();
  if (!key) return;
  scores.set(key, (scores.get(key) ?? 0) + weight);
}

function mapAnime(
  anime: {
    id: number;
    slug: string;
    title: string;
    thumbnail: string | null;
    bigCover: string | null;
    status: string | null;
    type: string | null;
    totalEpisodes: number | null;
    rating: unknown;
    views: number;
    likes: number;
    genres: { genre: { name: string } }[];
    _count: { episodes: number };
  },
  reasons: RecommendationReason[],
) {
  return {
    id: anime.id,
    slug: anime.slug,
    title: anime.title,
    thumbnail: anime.thumbnail ?? anime.bigCover ?? "",
    status: anime.status ?? "Ongoing",
    type: anime.type,
    totalEpisodes: anime.totalEpisodes,
    episodeCount: anime._count.episodes,
    rating: anime.rating ? Number(anime.rating) : null,
    genres: anime.genres.map((item) => item.genre.name),
    views: anime.views,
    likes: anime.likes,
    reasons,
  };
}

export const recommendationsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/personal", { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(toPositiveInt(query.limit, 12), 30);
    const userId = request.user.id;

    const [history, saved, reviews, animeLikes, episodeLikes] = await Promise.all([
      prisma.watchHistory.findMany({
        where: { userId },
        orderBy: { watchedAt: "desc" },
        take: 60,
        select: { animeId: true },
      }),
      prisma.savedAnime.findMany({
        where: { userId },
        orderBy: { savedAt: "desc" },
        take: 60,
        select: { animeId: true },
      }),
      prisma.animeReview.findMany({
        where: { userId, rating: { gte: 7 } },
        orderBy: { updatedAt: "desc" },
        take: 40,
        select: { animeId: true, rating: true },
      }),
      prisma.animeLike.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { animeId: true },
      }),
      prisma.episodeReaction.findMany({
        where: { userId, type: "LIKE" },
        orderBy: { updatedAt: "desc" },
        take: 60,
        select: {
          episode: {
            select: {
              animeId: true,
              anime: {
                select: {
                  genres: { select: { genre: { select: { name: true } } } },
                },
              },
            },
          },
        },
      }),
    ]);

    const genreScores = new Map<string, number>();
    const excludedAnimeIds = new Set<number>();
    const sourceWeights = new Map<number, number>();

    for (const item of history) {
      excludedAnimeIds.add(item.animeId);
      sourceWeights.set(item.animeId, (sourceWeights.get(item.animeId) ?? 0) + 4);
    }

    for (const item of saved) {
      excludedAnimeIds.add(item.animeId);
      sourceWeights.set(item.animeId, (sourceWeights.get(item.animeId) ?? 0) + 5);
    }

    for (const item of reviews) {
      excludedAnimeIds.add(item.animeId);
      sourceWeights.set(
        item.animeId,
        (sourceWeights.get(item.animeId) ?? 0) + Math.max(3, Number(item.rating ?? 7) - 4),
      );
    }

    for (const item of animeLikes) {
      excludedAnimeIds.add(item.animeId);
      sourceWeights.set(item.animeId, (sourceWeights.get(item.animeId) ?? 0) + 4);
    }

    for (const item of episodeLikes as Array<{
      episode?: {
        animeId?: number;
        anime?: { genres?: { genre: { name: string } }[] };
      };
    }>) {
      if (item.episode?.animeId) excludedAnimeIds.add(item.episode.animeId);
      for (const row of item.episode?.anime?.genres ?? []) addScore(genreScores, row.genre.name, 3);
    }

    const sourceAnimes =
      sourceWeights.size > 0
        ? await prisma.anime.findMany({
            where: { id: { in: [...sourceWeights.keys()] } },
            select: { id: true, genres: { select: { genre: { select: { name: true } } } } },
          })
        : [];

    for (const anime of sourceAnimes) {
      const weight = sourceWeights.get(anime.id) ?? 0;
      for (const row of anime.genres) addScore(genreScores, row.genre.name, weight);
    }

    const topGenres = [...genreScores.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8);

    const baseSelect = {
      id: true,
      slug: true,
      title: true,
      thumbnail: true,
      bigCover: true,
      status: true,
      type: true,
      totalEpisodes: true,
      rating: true,
      views: true,
      likes: true,
      genres: { select: { genre: { select: { name: true } } } },
      _count: { select: { episodes: true } },
    } as const;

    const candidates =
      topGenres.length > 0
        ? await prisma.anime.findMany({
            where: {
              id: excludedAnimeIds.size > 0 ? { notIn: [...excludedAnimeIds] } : undefined,
              genres: {
                some: {
                  genre: { name: { in: topGenres.map(([name]) => name) } },
                },
              },
            },
            select: baseSelect,
            take: limit * 3,
          })
        : [];

    const scored = candidates
      .map((anime) => {
        const reasons = anime.genres
          .map((item) => {
            const weight = genreScores.get(item.genre.name) ?? 0;
            return weight > 0
              ? ({ type: "genre", label: item.genre.name, weight } satisfies RecommendationReason)
              : null;
          })
          .filter(Boolean) as RecommendationReason[];
        const score =
          reasons.reduce((total, reason) => total + reason.weight, 0) +
          Math.log10(Math.max(1, anime.views)) +
          Math.log10(Math.max(1, anime.likes + 1));
        return { anime, score, reasons: reasons.sort((a, b) => b.weight - a.weight).slice(0, 3) };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    let items = scored.map((item) => mapAnime(item.anime, item.reasons));

    if (items.length < limit) {
      const existingIds = new Set([...excludedAnimeIds, ...items.map((item) => item.id)]);
      const fallback = await prisma.anime.findMany({
        where: {
          id: existingIds.size > 0 ? { notIn: [...existingIds] } : undefined,
        },
        orderBy: [{ trendingScore: "desc" }, { views: "desc" }, { createdAt: "desc" }],
        select: baseSelect,
        take: limit - items.length,
      });
      items = [
        ...items,
        ...fallback.map((anime) =>
          mapAnime(anime, [{ type: "popular", label: "Populer sekarang", weight: 1 }]),
        ),
      ];
    }

    return ok(reply, {
      message: "Personal recommendations fetched successfully",
      data: items,
      meta: {
        topGenres: topGenres.map(([name, score]) => ({ name, score })),
        source: topGenres.length > 0 ? "personalized" : "popular-fallback",
      },
    });
  });
};

export default recommendationsRoutes;
