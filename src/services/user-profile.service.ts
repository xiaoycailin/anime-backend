import { prisma } from "../lib/prisma";

export type ProfileStatsDTO = {
  episodeCount: number;
  watchSeconds: number;
  watchHours: number;
  savedCount: number;
};

export function emptyProfileStats(): ProfileStatsDTO {
  return {
    episodeCount: 0,
    watchSeconds: 0,
    watchHours: 0,
    savedCount: 0,
  };
}

function normalizeWatchSeconds(value: number | null | undefined) {
  return Math.max(0, Math.floor(Number(value ?? 0)));
}

export async function getProfileStatsForUsers(
  userIds: number[],
): Promise<Map<number, ProfileStatsDTO>> {
  const ids = Array.from(
    new Set(
      userIds
        .map((id) => Math.floor(Number(id)))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );

  const result = new Map<number, ProfileStatsDTO>();
  for (const id of ids) result.set(id, emptyProfileStats());
  if (ids.length === 0) return result;

  const [watchRows, savedRows] = await Promise.all([
    prisma.watchHistory.groupBy({
      by: ["userId"],
      where: { userId: { in: ids } },
      _count: { _all: true },
      _sum: { progressSec: true },
    }),
    prisma.savedAnime.groupBy({
      by: ["userId"],
      where: { userId: { in: ids } },
      _count: { _all: true },
    }),
  ]);

  for (const row of watchRows) {
    const stats = result.get(row.userId) ?? emptyProfileStats();
    const watchSeconds = normalizeWatchSeconds(row._sum.progressSec);
    result.set(row.userId, {
      ...stats,
      episodeCount: row._count._all,
      watchSeconds,
      watchHours: Math.floor(watchSeconds / 3600),
    });
  }

  for (const row of savedRows) {
    const stats = result.get(row.userId) ?? emptyProfileStats();
    result.set(row.userId, {
      ...stats,
      savedCount: row._count._all,
    });
  }

  return result;
}

export async function getProfileStats(userId: number) {
  const stats = await getProfileStatsForUsers([userId]);
  return stats.get(userId) ?? emptyProfileStats();
}
