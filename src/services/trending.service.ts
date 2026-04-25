import { prisma } from "../lib/prisma";

const TRENDING_DEBOUNCE_MS = 30_000;
const TRENDING_REFRESH_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const lastRecalculatedAt = new Map<number, number>();
const pendingTimers = new Map<number, NodeJS.Timeout>();
let refreshJob: NodeJS.Timeout | null = null;

export function calculateTrendingScore(input: {
  views: number;
  likes: number;
  createdAt: Date;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const hoursSinceCreated = Math.max(
    0,
    (now.getTime() - input.createdAt.getTime()) / HOUR_MS,
  );
  const numerator = input.views * 0.6 + input.likes * 2;
  const denominator = Math.pow(hoursSinceCreated + 2, 1.5);

  return denominator > 0 ? numerator / denominator : 0;
}

export async function recalculateTrendingScore(animeId: number) {
  const anime = await prisma.anime.findUnique({
    where: { id: animeId },
    select: {
      id: true,
      views: true,
      likes: true,
      createdAt: true,
    },
  });

  if (!anime) return null;

  const trendingScore = calculateTrendingScore({
    views: anime.views,
    likes: anime.likes,
    createdAt: anime.createdAt,
  });

  const updated = await prisma.anime.update({
    where: { id: anime.id },
    data: {
      trendingScore,
      trendingScoreUpdatedAt: new Date(),
    },
    select: {
      id: true,
      views: true,
      likes: true,
      trendingScore: true,
      trendingScoreUpdatedAt: true,
    },
  });

  lastRecalculatedAt.set(animeId, Date.now());
  return updated;
}

export function queueTrendingScoreRecalculation(animeId: number) {
  if (pendingTimers.has(animeId)) return;

  const elapsed = Date.now() - (lastRecalculatedAt.get(animeId) ?? 0);
  const delay = Math.max(0, TRENDING_DEBOUNCE_MS - elapsed);

  const timer = setTimeout(() => {
    pendingTimers.delete(animeId);
    recalculateTrendingScore(animeId).catch((error) => {
      console.error(`Failed to recalculate trending score for anime ${animeId}`, error);
    });
  }, delay);

  pendingTimers.set(animeId, timer);
}

export async function refreshLatestTrendingScores(limit = 100) {
  const animes = await prisma.anime.findMany({
    orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }],
    take: limit,
    select: { id: true },
  });

  await Promise.all(animes.map((anime) => recalculateTrendingScore(anime.id)));
  return animes.length;
}

export function startTrendingRefreshJob() {
  if (refreshJob) return;

  refreshJob = setInterval(() => {
    refreshLatestTrendingScores().catch((error) => {
      console.error("Failed to refresh latest trending scores", error);
    });
  }, TRENDING_REFRESH_MS);

  refreshJob.unref?.();
}
