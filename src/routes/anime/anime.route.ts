import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  queueTrendingScoreRecalculation,
  recalculateTrendingScore,
} from "../../services/trending.service";
import {
  checkGuestWatchLimit,
  getGuestWatchQuota,
  getOrSetGuestWatchId,
  optionalAuthUserId,
} from "../../services/guest-watch-limit.service";
import { ok, paginated, sendError } from "../../utils/response";
import {
  extractBaseTitle,
  extractSeason,
  isSameAnime,
  normalizeTitle,
} from "../../utils/season-parser";
import {
  CACHE_KEYS,
  CACHE_TTL,
  CacheInvalidator,
  buildQueryKey,
  getCache,
  setCache,
  setCacheField,
} from "../../lib/cache";
import { PUBLIC_CACHE, setPublicCache } from "../../utils/cache-control";

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function toAnimeStatus(value: string | null): "Ongoing" | "Completed" {
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("complete")) return "Completed";
  return "Ongoing";
}

function toArray(value: string | undefined) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeStartWith(value: string | undefined) {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === "#") return "#";

  const letter = normalized.charAt(0);
  return /^[A-Z]$/.test(letter) ? letter : null;
}

function buildStartWithFilter(startWith: string) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  if (startWith === "#") {
    return {
      NOT: {
        OR: letters.flatMap((letter) => [
          { title: { startsWith: letter } },
          { title: { startsWith: letter.toLowerCase() } },
        ]),
      },
    } satisfies Prisma.AnimeWhereInput;
  }

  return {
    OR: [
      { title: { startsWith: startWith } },
      { title: { startsWith: startWith.toLowerCase() } },
    ],
  } satisfies Prisma.AnimeWhereInput;
}

type EpisodeAccessInput = {
  id: number;
  number: number;
  anime: { id: number };
};

function episodeAccessInput(payload: unknown): EpisodeAccessInput | null {
  if (!payload || typeof payload !== "object") return null;

  const data = payload as Record<string, unknown>;
  const anime = data.anime as Record<string, unknown> | undefined;
  const id = Number(data.id);
  const number = Number(data.number);
  const animeId = Number(anime?.id);

  if (!Number.isFinite(id) || !Number.isFinite(number) || !Number.isFinite(animeId)) {
    return null;
  }

  return {
    id,
    number,
    anime: { id: animeId },
  };
}

function hasSubtitleTrackCues(payload: Record<string, unknown>) {
  return (
    Array.isArray(payload.subtitleTracks) &&
    payload.subtitleTracks.some(
      (track) => !!track && typeof track === "object" && "cues" in track,
    )
  );
}

function stripPublicSubtitleTrackCues<T extends Record<string, unknown>>(
  payload: T,
): T {
  if (!Array.isArray(payload.subtitleTracks)) return payload;

  return {
    ...payload,
    subtitleTracks: payload.subtitleTracks.map((track) => {
      if (!track || typeof track !== "object" || !("cues" in track)) {
        return track;
      }

      const { cues: _cues, ...publicTrack } = track as Record<
        string,
        unknown
      >;
      return publicTrack;
    }),
  };
}

function parseStatus(
  value: string | undefined,
): "ongoing" | "completed" | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "ongoing") return "ongoing";
  if (normalized === "completed" || normalized === "complete")
    return "completed";
  return null;
}

function formatAnimeCard(
  anime: {
    id: number;
    slug: string;
    title: string;
    thumbnail: string | null;
    bigCover?: string | null;
    status: string | null;
    type?: string | null;
    studio?: string | null;
    rating?: Prisma.Decimal | number | null;
    followed?: number | null;
    views?: number;
    likes?: number;
    trendingScore?: number;
    totalEpisodes?: number | null;
    genres: { genre: { name: string } }[];
    _count?: { episodes: number };
  },
  options: { includeBigCover?: boolean; includeStats?: boolean } = {},
) {
  return {
    id: anime.id,
    slug: anime.slug,
    title: normalizeTitle(anime.title),
    genre: anime.genres.map((item) => item.genre.name),
    thumbnail: anime.thumbnail ?? "",
    ...(options.includeBigCover ? { bigCover: anime.bigCover ?? "" } : {}),
    status: toAnimeStatus(anime.status),
    type: anime.type ?? null,
    studio: anime.studio ?? null,
    ...(options.includeStats
      ? {
          rating: anime.rating ? Number(anime.rating) : null,
          followed: anime.followed ?? null,
          views: anime.views ?? 0,
          likes: anime.likes ?? 0,
          trendingScore: anime.trendingScore ?? 0,
          totalEpisodes: anime.totalEpisodes ?? null,
          episodeCount: anime._count?.episodes ?? 0,
        }
      : {}),
  };
}

function buildOrderBy(
  sortBy: string,
  order: "asc" | "desc",
): Prisma.AnimeOrderByWithRelationInput[] {
  switch (sortBy) {
    case "title":
      return [{ title: order }, { updatedAt: "desc" }];
    case "rating":
      return [{ rating: order }, { updatedAt: "desc" }];
    case "followed":
      return [{ followed: order }, { updatedAt: "desc" }];
    case "latest":
    case "updatedat":
      return [{ updatedAt: order }, { createdAt: "desc" }];
    case "trending":
      return [
        { trendingScore: "desc" },
        { followed: "desc" },
        { rating: "desc" },
        { updatedAt: "desc" },
      ];
    default:
      return [{ updatedAt: "desc" }];
  }
}

function isActivitySort(sortBy: string) {
  return sortBy === "updatedat" || sortBy === "latest";
}

async function getActivityRankedAnimeIds({
  where,
  order,
  skip,
  take,
}: {
  where: Prisma.AnimeWhereInput;
  order: "asc" | "desc";
  skip: number;
  take: number;
}) {
  const rows = await prisma.anime.findMany({
    where,
    select: {
      id: true,
      createdAt: true,
      episodes: {
        select: { createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
      },
    },
  });

  return rows
    .map((anime) => {
      const latestEpisodeAt = anime.episodes[0]?.createdAt;
      const activityAt =
        latestEpisodeAt && latestEpisodeAt > anime.createdAt
          ? latestEpisodeAt
          : anime.createdAt;
      return { id: anime.id, activityAt };
    })
    .sort((left, right) => {
      const diff = left.activityAt.getTime() - right.activityAt.getTime();
      if (diff !== 0) return order === "asc" ? diff : -diff;
      return order === "asc" ? left.id - right.id : right.id - left.id;
    })
    .slice(skip, skip + take)
    .map((item) => item.id);
}

function normalizeComparable(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function countMatches(currentValues: string[], candidateValues: string[]) {
  const current = new Set(currentValues.map(normalizeComparable));
  return candidateValues.reduce((total, value) => {
    return current.has(normalizeComparable(value)) ? total + 1 : total;
  }, 0);
}

function getRandomTieBreaker() {
  return Math.random();
}

type SeasonCandidate = {
  id: number;
  slug: string;
  title: string;
  thumbnail?: string | null;
  bigCover?: string | null;
  rating?: Prisma.Decimal | number | null;
  alternativeTitles?: string | null;
  synopsis?: string | null;
  followed?: number | null;
  views?: number;
  likes?: number;
  trendingScore?: number;
  status?: string | null;
  network?: string | null;
  studio?: string | null;
  released?: string | null;
  duration?: string | null;
  season?: string | null;
  country?: string | null;
  type?: string | null;
  totalEpisodes?: number | null;
  fansub?: string | null;
  genres?: { genre: { name: string } }[];
  tags?: { tag: { slug: string; label: string } }[];
  createdAt?: Date;
  updatedAt?: Date;
};

function formatSeasonAnime(anime: SeasonCandidate) {
  return {
    id: anime.id,
    slug: anime.slug,
    title: normalizeTitle(anime.title),
    thumbnail: anime.thumbnail ?? "",
    bigCover: anime.bigCover ?? "",
    rating: anime.rating ? Number(anime.rating) : null,
    alternativeTitles: anime.alternativeTitles ?? null,
    synopsis: anime.synopsis ?? null,
    followed: anime.followed ?? null,
    views: anime.views ?? 0,
    likes: anime.likes ?? 0,
    trendingScore: anime.trendingScore ?? 0,
    status: anime.status ?? null,
    network: anime.network ?? null,
    studio: anime.studio ?? null,
    released: anime.released ?? null,
    duration: anime.duration ?? null,
    season: anime.season ?? null,
    country: anime.country ?? null,
    type: anime.type ?? null,
    totalEpisodes: anime.totalEpisodes ?? null,
    fansub: anime.fansub ?? null,
    genres: anime.genres?.map((item) => item.genre.name) ?? [],
    tags: anime.tags?.map((item) => item.tag) ?? [],
    createdAt: anime.createdAt ?? null,
    updatedAt: anime.updatedAt ?? null,
  };
}

async function buildEpisodeSeasons(current: {
  title: string;
  anime: SeasonCandidate;
}) {
  const sourceTitle = current.anime.title || current.title;
  const currentSeason = extractSeason(sourceTitle);
  const baseTitle = extractBaseTitle(sourceTitle);

  if (baseTitle.length < 3) {
    return [];
  }

  const relatedAnime = await prisma.anime.findMany({
    where: {
      title: {
        contains: baseTitle,
      },
    },
    orderBy: [{ id: "asc" }],
    take: 80,
    select: {
      id: true,
      slug: true,
      title: true,
      thumbnail: true,
      bigCover: true,
      rating: true,
      alternativeTitles: true,
      synopsis: true,
      followed: true,
      views: true,
      likes: true,
      trendingScore: true,
      status: true,
      network: true,
      studio: true,
      released: true,
      duration: true,
      season: true,
      country: true,
      type: true,
      totalEpisodes: true,
      fansub: true,
      genres: {
        select: {
          genre: {
            select: {
              name: true,
            },
          },
        },
      },
      tags: {
        select: {
          tag: {
            select: {
              slug: true,
              label: true,
            },
          },
        },
      },
      createdAt: true,
      updatedAt: true,
    },
  });

  const seasonMap = new Map<number, SeasonCandidate[]>();

  for (const anime of relatedAnime) {
    const candidateBaseTitle = extractBaseTitle(anime.title);
    if (!candidateBaseTitle || !isSameAnime(baseTitle, candidateBaseTitle)) {
      continue;
    }

    const season = extractSeason(anime.title);
    const existing = seasonMap.get(season) ?? [];
    if (!existing.some((item) => item.id === anime.id)) {
      existing.push(anime);
    }
    seasonMap.set(season, existing);
  }

  if (!seasonMap.has(currentSeason)) {
    seasonMap.set(currentSeason, [current.anime]);
  } else {
    const currentGroup = seasonMap.get(currentSeason) ?? [];
    if (!currentGroup.some((item) => item.id === current.anime.id)) {
      currentGroup.push(current.anime);
    }
  }

  const animeIdToSeason = new Map<number, number>();
  const animeIds = [...seasonMap.entries()].flatMap(([season, animes]) => {
    return animes.map((anime) => {
      animeIdToSeason.set(anime.id, season);
      return anime.id;
    });
  });

  const episodes = await prisma.episode.findMany({
    where: {
      animeId: {
        in: [...new Set(animeIds)],
      },
    },
    orderBy: [{ number: "asc" }, { id: "asc" }],
    select: {
      id: true,
      slug: true,
      number: true,
      title: true,
      sub: true,
      date: true,
      animeId: true,
      anime: {
        select: {
          slug: true,
          title: true,
        },
      },
    },
  });

  const episodesBySeason = new Map<number, typeof episodes>();

  for (const episode of episodes) {
    const season = animeIdToSeason.get(episode.animeId);
    if (!season) continue;

    const currentEpisodes = episodesBySeason.get(season) ?? [];
    currentEpisodes.push(episode);
    episodesBySeason.set(season, currentEpisodes);
  }

  return [...seasonMap.entries()]
    .sort(([left], [right]) => left - right)
    .map(([season, animes]) => {
      const representative =
        animes.find((anime) => anime.id === current.anime.id) ?? animes[0];

      return {
        season,
        title: normalizeTitle(representative.title),
        slug: representative.slug,
        anime: formatSeasonAnime(representative),
        isCurrent: season === currentSeason,
        episodes: (episodesBySeason.get(season) ?? []).map((episode) => ({
          id: episode.id,
          slug: episode.slug,
          number: episode.number,
          episode_number: episode.number,
          title: episode.title,
          sub: episode.sub,
          date: episode.date,
          animeId: episode.animeId,
          animeSlug: episode.anime.slug,
          animeTitle: normalizeTitle(episode.anime.title),
        })),
      };
    })
    .filter((season) => season.episodes.length > 0);
}

export const animeRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Querystring: { animeSlug?: string };
  }>("/debug/guest-watch", async (request, reply) => {
    const animeSlug = request.query.animeSlug?.trim();
    const guestId = getOrSetGuestWatchId(request, reply);

    if (!animeSlug) {
      return ok(reply, {
        message: "Tambahkan query animeSlug untuk cek kuota anime.",
        data: { guestId },
      });
    }

    const quota = await getGuestWatchQuota({ guestId, animeSlug });
    if (!quota) {
      return sendError(reply, {
        status: 404,
        message: "Anime tidak ditemukan",
        errorCode: "ANIME_NOT_FOUND",
      });
    }

    return ok(reply, { data: quota });
  });

  app.get("/", async (request, reply) => {
    const query = request.query as {
      q?: string;
      keyword?: string;
      genre?: string;
      tag?: string;
      status?: string;
      type?: string;
      studio?: string;
      startWith?: string;
      startwith?: string;
      startsWith?: string;
      startswith?: string;
      sortBy?: string;
      sortby?: string;
      order?: string;
      page?: string;
      limit?: string;
    };

    const keyword = (query.q ?? query.keyword ?? "").trim();
    const genres = toArray(query.genre);
    const tags = toArray(query.tag);
    const status = parseStatus(query.status);
    const type = query.type?.trim();
    const studio = query.studio?.trim();
    const startWith = normalizeStartWith(
      query.startWith ?? query.startwith ?? query.startsWith ?? query.startswith,
    );
    const sortBy = (query.sortBy ?? query.sortby ?? "updatedAt").toLowerCase();
    const order = query.order?.toLowerCase() === "asc" ? "asc" : "desc";
    const page = toPositiveInt(query.page, 1);
    const limit = Math.min(toPositiveInt(query.limit, 12), 50);
    const skip = (page - 1) * limit;

    const filters: Prisma.AnimeWhereInput[] = [];

    if (keyword) {
      filters.push({
        OR: [
          { title: { contains: keyword } },
          { slug: { contains: keyword } },
          { alternativeTitles: { contains: keyword } },
          { synopsis: { contains: keyword } },
        ],
      });
    }

    if (genres.length > 0) {
      filters.push({
        AND: genres.map((name) => ({
          genres: { some: { genre: { name: { equals: name } } } },
        })),
      });
    }

    if (tags.length > 0) {
      filters.push({
        AND: tags.map((value) => ({
          tags: {
            some: {
              tag: {
                OR: [{ slug: { equals: value } }, { label: { equals: value } }],
              },
            },
          },
        })),
      });
    }

    if (status === "completed") {
      filters.push({ status: { contains: "complete" } });
    }

    if (status === "ongoing") {
      filters.push({ NOT: { status: { contains: "complete" } } });
    }

    if (type) {
      filters.push({ type: { equals: type } });
    }

    if (studio) {
      filters.push({ studio: { equals: studio } });
    }

    if (startWith) {
      filters.push(buildStartWithFilter(startWith));
    }

    const where: Prisma.AnimeWhereInput =
      filters.length > 0 ? { AND: filters } : {};
    const activitySort = isActivitySort(sortBy);

    const cacheKey = CACHE_KEYS.browse(
      buildQueryKey({
        sortMode: activitySort ? "activity-v2" : "field",
        keyword,
        genres,
        tags,
        status,
        type,
        studio,
        startWith,
        sortBy,
        order,
        page,
        limit,
      }),
    );

    try {
      type BrowsePayload = {
        items: ReturnType<typeof formatAnimeCard>[];
        total: number;
      };

      const cached = await getCache<BrowsePayload>(cacheKey);
      const payload =
        cached ??
        (await (async (): Promise<BrowsePayload> => {
          const total = await prisma.anime.count({ where });
          const ids = activitySort
            ? await getActivityRankedAnimeIds({
                where,
                order,
                skip,
                take: limit,
              })
            : null;

          const animes = await prisma.anime.findMany({
            where: ids ? { id: { in: ids } } : where,
            ...(!ids
              ? { orderBy: buildOrderBy(sortBy, order), skip, take: limit }
              : {}),
            select: {
              id: true,
              slug: true,
              title: true,
              thumbnail: true,
              bigCover: true,
              status: true,
              type: true,
              studio: true,
              rating: true,
              followed: true,
              totalEpisodes: true,
              genres: {
                select: {
                  genre: {
                    select: {
                      name: true,
                    },
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

          const orderedAnimes = ids
            ? ids
                .map((id) => animes.find((anime) => anime.id === id))
                .filter((anime): anime is NonNullable<typeof anime> =>
                  Boolean(anime),
                )
            : animes;

          const result: BrowsePayload = {
            items: orderedAnimes.map((anime) =>
              formatAnimeCard(anime, {
                includeBigCover: true,
                includeStats: true,
              }),
            ),
            total,
          };

          await setCache(cacheKey, result, CACHE_TTL.BROWSE);
          return result;
        })());

      return paginated(reply, {
        items: payload.items,
        page,
        limit,
        total: payload.total,
        message: "Anime list fetched successfully",
        meta: {
          keyword: keyword || null,
          genre: genres,
          tag: tags,
          status,
          type: type || null,
          studio: studio || null,
          startWith,
          sortBy,
          order,
          cache: cached ? "hit" : "miss",
        },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch anime list",
        errorCode: "ANIME_LIST_FETCH_FAILED",
      });
    }
  });

  app.get("/new-release", async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(toPositiveInt(query.limit, 12), 50);
    const cacheKey = CACHE_KEYS.newRelease(limit);

    try {
      setPublicCache(reply, PUBLIC_CACHE.FAST);
      type NewReleaseItem = {
        id: number;
        slug: string;
        title: string;
        genre: string[];
        thumbnail: string;
        status: "Ongoing" | "Completed";
        type: string | null;
        totalEpisodes: number | null;
        episodeCount: number;
      };

      const cached = await getCache<NewReleaseItem[]>(cacheKey);

      if (cached) {
        return ok(reply, {
          message: "New release anime fetched successfully",
          data: cached,
          meta: { limit, cache: "hit" },
        });
      }

      // Rank anime by most recent activity:
      // whichever is newer between the anime's own createdAt and its latest episode's createdAt.
      const ranked = await prisma.$queryRaw<{ id: number }[]>`
        SELECT a.id
        FROM animes a
        LEFT JOIN episodes e ON e.animeId = a.id
        GROUP BY a.id
        ORDER BY GREATEST(a.createdAt, COALESCE(MAX(e.createdAt), a.createdAt)) DESC
        LIMIT ${limit}
      `;

      const ids = ranked.map((r) => Number(r.id));

      if (ids.length === 0) {
        await setCache(cacheKey, [], CACHE_TTL.NEW_RELEASE);
        return ok(reply, {
          message: "New release anime fetched successfully",
          data: [],
          meta: { limit, cache: "miss" },
        });
      }

      const animes = await prisma.anime.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          slug: true,
          title: true,
          thumbnail: true,
          status: true,
          type: true,
          totalEpisodes: true,
          genres: {
            select: {
              genre: {
                select: {
                  name: true,
                },
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

      // Preserve the ranked order
      const animeMap = new Map(animes.map((a) => [a.id, a]));
      const orderedAnimes = ids
        .map((id) => animeMap.get(id))
        .filter((a): a is NonNullable<typeof a> => Boolean(a));

      const data: NewReleaseItem[] = orderedAnimes.map((anime) => ({
        id: anime.id,
        slug: anime.slug,
        title: normalizeTitle(anime.title),
        genre: anime.genres.map((item) => item.genre.name),
        thumbnail: anime.thumbnail ?? "",
        status: toAnimeStatus(anime.status),
        type: anime.type,
        totalEpisodes: anime.totalEpisodes,
        episodeCount: anime._count.episodes,
      }));

      await setCache(cacheKey, data, CACHE_TTL.NEW_RELEASE);

      return ok(reply, {
        message: "New release anime fetched successfully",
        data,
        meta: { limit, cache: "miss" },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch new release anime",
        errorCode: "NEW_RELEASE_FETCH_FAILED",
      });
    }
  });

  app.get("/popular", async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(toPositiveInt(query.limit, 12), 50);
    const cacheKey = CACHE_KEYS.popular(limit);

    try {
      setPublicCache(reply, PUBLIC_CACHE.FAST);
      const cached = await getCache<ReturnType<typeof formatAnimeCard>[]>(
        cacheKey,
      );

      if (cached) {
        return ok(reply, {
          message: "Popular anime fetched successfully",
          data: cached,
          meta: {
            limit,
            ranking: ["followed desc", "rating desc", "updatedAt desc"],
            cache: "hit",
          },
        });
      }

      const animes = await prisma.anime.findMany({
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
          thumbnail: true,
          bigCover: true,
          status: true,
          type: true,
          studio: true,
          rating: true,
          followed: true,
          totalEpisodes: true,
          genres: {
            select: {
              genre: {
                select: {
                  name: true,
                },
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

      const data = animes.map((anime) =>
        formatAnimeCard(anime, {
          includeBigCover: true,
          includeStats: true,
        }),
      );

      await setCache(cacheKey, data, CACHE_TTL.POPULAR);

      return ok(reply, {
        message: "Popular anime fetched successfully",
        data,
        meta: {
          limit,
          ranking: ["followed desc", "rating desc", "updatedAt desc"],
          cache: "miss",
        },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch popular anime",
        errorCode: "POPULAR_ANIME_FETCH_FAILED",
      });
    }
  });

  app.get("/trending", async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(toPositiveInt(query.limit, 9), 50);
    const cacheKey = CACHE_KEYS.trending(limit);

    try {
      setPublicCache(reply, PUBLIC_CACHE.FAST);
      const cached = await getCache<ReturnType<typeof formatAnimeCard>[]>(
        cacheKey,
      );

      if (cached) {
        return ok(reply, {
          message: "Trending anime fetched successfully",
          data: cached,
          meta: {
            limit,
            ranking: [
              "trendingScore desc",
              "views desc",
              "likes desc",
              "updatedAt desc",
            ],
            formula:
              "(views * 0.6 + likes * 2) / (hours_since_created + 2)^1.5",
            cache: "hit",
          },
        });
      }

      const animes = await prisma.anime.findMany({
        orderBy: [
          { trendingScore: "desc" },
          { views: "desc" },
          { likes: "desc" },
          { updatedAt: "desc" },
        ],
        take: limit,
        select: {
          id: true,
          slug: true,
          title: true,
          thumbnail: true,
          bigCover: true,
          status: true,
          type: true,
          studio: true,
          rating: true,
          followed: true,
          views: true,
          likes: true,
          trendingScore: true,
          totalEpisodes: true,
          genres: {
            select: {
              genre: {
                select: {
                  name: true,
                },
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

      const data = animes.map((anime) =>
        formatAnimeCard(anime, {
          includeBigCover: true,
          includeStats: true,
        }),
      );

      await setCache(cacheKey, data, CACHE_TTL.TRENDING);

      return ok(reply, {
        message: "Trending anime fetched successfully",
        data,
        meta: {
          limit,
          ranking: [
            "trendingScore desc",
            "views desc",
            "likes desc",
            "updatedAt desc",
          ],
          formula: "(views * 0.6 + likes * 2) / (hours_since_created + 2)^1.5",
          cache: "miss",
        },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch trending anime",
        errorCode: "TRENDING_ANIME_FETCH_FAILED",
      });
    }
  });

  app.post("/:slug/view", async (request, reply) => {
    const { slug } = request.params as { slug?: string };

    if (!slug) {
      return sendError(reply, {
        status: 400,
        message: "Parameter 'slug' is required",
        errorCode: "SLUG_REQUIRED",
      });
    }

    try {
      const anime = await prisma.anime.update({
        where: { slug },
        data: {
          views: {
            increment: 1,
          },
        },
        select: {
          id: true,
          slug: true,
          title: true,
          views: true,
          likes: true,
          trendingScore: true,
        },
      });

      await setCacheField<Record<string, unknown>>(
        CACHE_KEYS.animeDetail(slug),
        { views: anime.views, trendingScore: anime.trendingScore },
        CACHE_TTL.ANIME_DETAIL,
      );

      queueTrendingScoreRecalculation(anime.id);

      return ok(reply, {
        message: "Anime view recorded successfully",
        data: anime,
        meta: {
          trending: {
            queued: true,
            debounceSeconds: 30,
          },
        },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 404,
        message: "Anime not found",
        errorCode: "ANIME_NOT_FOUND",
      });
    }
  });

  app.post(
    "/:slug/like",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { slug } = request.params as { slug?: string };
      const userId = request.user.id;

      if (!slug) {
        return sendError(reply, {
          status: 400,
          message: "Parameter 'slug' is required",
          errorCode: "SLUG_REQUIRED",
        });
      }

      try {
        const anime = await prisma.anime.findUnique({
          where: { slug },
          select: { id: true },
        });

        if (!anime) {
          return sendError(reply, {
            status: 404,
            message: "Anime not found",
            errorCode: "ANIME_NOT_FOUND",
          });
        }

        let liked = true;

        try {
          await prisma.$transaction([
            prisma.animeLike.create({
              data: {
                animeId: anime.id,
                userId,
              },
            }),
            prisma.anime.update({
              where: { id: anime.id },
              data: {
                likes: {
                  increment: 1,
                },
              },
            }),
          ]);
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ) {
            liked = true;
          } else {
            throw error;
          }
        }

        const updated = await recalculateTrendingScore(anime.id);

        await CacheInvalidator.onAnimeChange(slug);

        return ok(reply, {
          message: "Anime liked successfully",
          data: {
            liked,
            likes: updated?.likes ?? 0,
            views: updated?.views ?? 0,
            trendingScore: updated?.trendingScore ?? 0,
          },
        });
      } catch (error) {
        request.log.error(error);
        return sendError(reply, {
          status: 500,
          message: "Failed to like anime",
          errorCode: "ANIME_LIKE_FAILED",
        });
      }
    },
  );

  app.delete(
    "/:slug/like",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { slug } = request.params as { slug?: string };
      const userId = request.user.id;

      if (!slug) {
        return sendError(reply, {
          status: 400,
          message: "Parameter 'slug' is required",
          errorCode: "SLUG_REQUIRED",
        });
      }

      try {
        const anime = await prisma.anime.findUnique({
          where: { slug },
          select: { id: true },
        });

        if (!anime) {
          return sendError(reply, {
            status: 404,
            message: "Anime not found",
            errorCode: "ANIME_NOT_FOUND",
          });
        }

        const deleted = await prisma.animeLike.deleteMany({
          where: {
            animeId: anime.id,
            userId,
          },
        });

        if (deleted.count > 0) {
          await prisma.anime.update({
            where: { id: anime.id },
            data: {
              likes: {
                decrement: 1,
              },
            },
          });
        }

        const updated = await recalculateTrendingScore(anime.id);

        await CacheInvalidator.onAnimeChange(slug);

        return ok(reply, {
          message: "Anime unliked successfully",
          data: {
            liked: false,
            likes: updated?.likes ?? 0,
            views: updated?.views ?? 0,
            trendingScore: updated?.trendingScore ?? 0,
          },
        });
      } catch (error) {
        request.log.error(error);
        return sendError(reply, {
          status: 500,
          message: "Failed to unlike anime",
          errorCode: "ANIME_UNLIKE_FAILED",
        });
      }
    },
  );

  app.get("/random", async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(toPositiveInt(query.limit, 1), 20);

    try {
      const total = await prisma.anime.count({
        where: {
          episodes: {
            some: {},
          },
        },
      });

      if (total === 0) {
        return ok(reply, {
          message: "Random anime fetched successfully",
          data: [],
          meta: { limit, total },
        });
      }

      const take = Math.min(limit, total);
      const maxSkip = Math.max(total - take, 0);
      const skip = Math.floor(Math.random() * (maxSkip + 1));

      const animes = await prisma.anime.findMany({
        where: {
          episodes: {
            some: {},
          },
        },
        skip,
        take,
        orderBy: [{ id: "asc" }],
        select: {
          id: true,
          slug: true,
          title: true,
          thumbnail: true,
          bigCover: true,
          status: true,
          type: true,
          studio: true,
          rating: true,
          followed: true,
          totalEpisodes: true,
          genres: {
            select: {
              genre: {
                select: {
                  name: true,
                },
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

      return ok(reply, {
        message: "Random anime fetched successfully",
        data: animes
          .map((anime) =>
            formatAnimeCard(anime, {
              includeBigCover: true,
              includeStats: true,
            }),
          )
          .sort(() => Math.random() - 0.5),
        meta: {
          limit,
          total,
        },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch random anime",
        errorCode: "RANDOM_ANIME_FETCH_FAILED",
      });
    }
  });

  app.get("/index", async (request, reply) => {
    const cacheKey = CACHE_KEYS.animeIndex();

    try {
      setPublicCache(reply, PUBLIC_CACHE.SECTION);

      type IndexItem = {
        slug: string;
        title: string;
        type: string | null;
        status: "Ongoing" | "Completed" | null;
        year: number | null;
        totalEpisodes: number | null;
      };

      const cached = await getCache<IndexItem[]>(cacheKey);
      if (cached) {
        return ok(reply, {
          message: "Anime index fetched successfully",
          data: cached,
          meta: { total: cached.length, cache: "hit" },
        });
      }

      const animes = await prisma.anime.findMany({
        select: {
          slug: true,
          title: true,
          type: true,
          status: true,
          released: true,
          totalEpisodes: true,
        },
        orderBy: { title: "asc" },
      });

      const data: IndexItem[] = animes.map((a) => {
        const yearMatch = a.released?.match(/(\d{4})/);
        return {
          slug: a.slug,
          title: a.title,
          type: a.type ?? null,
          status: a.status ? toAnimeStatus(a.status) : null,
          year: yearMatch ? Number(yearMatch[1]) : null,
          totalEpisodes: a.totalEpisodes ?? null,
        };
      });

      await setCache(cacheKey, data, CACHE_TTL.INDEX);

      return ok(reply, {
        message: "Anime index fetched successfully",
        data,
        meta: { total: data.length, cache: "miss" },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch anime index",
        errorCode: "ANIME_INDEX_FETCH_FAILED",
      });
    }
  });

  app.get("/genres", async (request, reply) => {
    const cacheKey = CACHE_KEYS.genres();

    try {
      setPublicCache(reply, PUBLIC_CACHE.STATIC_META);
      const cached = await getCache<
        { id: number; name: string; animeCount: number }[]
      >(cacheKey);

      if (cached) {
        return ok(reply, {
          message: "Anime genres fetched successfully",
          data: cached,
          meta: { cache: "hit" },
        });
      }

      const genres = await prisma.genre.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          _count: {
            select: {
              animes: true,
            },
          },
        },
      });

      const data = genres.map((genre) => ({
        id: genre.id,
        name: genre.name,
        animeCount: genre._count.animes,
      }));

      await setCache(cacheKey, data, CACHE_TTL.GENRES);

      return ok(reply, {
        message: "Anime genres fetched successfully",
        data,
        meta: { cache: "miss" },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch anime genres",
        errorCode: "ANIME_GENRES_FETCH_FAILED",
      });
    }
  });

  app.get("/tags", async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(toPositiveInt(query.limit, 100), 300);

    try {
      const tags = await prisma.tag.findMany({
        orderBy: { label: "asc" },
        take: limit,
        select: {
          id: true,
          slug: true,
          label: true,
          _count: {
            select: {
              animes: true,
            },
          },
        },
      });

      return ok(reply, {
        message: "Anime tags fetched successfully",
        data: tags.map((tag) => ({
          id: tag.id,
          slug: tag.slug,
          label: tag.label,
          animeCount: tag._count.animes,
        })),
        meta: { limit },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch anime tags",
        errorCode: "ANIME_TAGS_FETCH_FAILED",
      });
    }
  });

  app.get("/studios", async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(toPositiveInt(query.limit, 100), 300);

    try {
      const animes = await prisma.anime.findMany({
        where: {
          studio: {
            not: null,
          },
        },
        distinct: ["studio"],
        orderBy: { studio: "asc" },
        take: limit,
        select: {
          studio: true,
        },
      });

      const studios = animes
        .map((anime) => anime.studio?.trim())
        .filter((studio): studio is string => Boolean(studio));

      return ok(reply, {
        message: "Anime studios fetched successfully",
        data: studios.map((studio) => ({ name: studio })),
        meta: {
          limit,
          total: studios.length,
        },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch anime studios",
        errorCode: "ANIME_STUDIOS_FETCH_FAILED",
      });
    }
  });

  app.get("/search", async (request, reply) => {
    const query = request.query as {
      q?: string;
      keyword?: string;
      genre?: string;
      status?: string;
      sortBy?: string;
      sortby?: string;
      order?: string;
      page?: string;
      limit?: string;
    };

    const keyword = (query.q ?? query.keyword ?? "").trim();
    const genres = toArray(query.genre);
    const status = parseStatus(query.status);
    const sortBy = (query.sortBy ?? query.sortby ?? "updatedAt").toLowerCase();
    const order = query.order?.toLowerCase() === "asc" ? "asc" : "desc";
    const page = toPositiveInt(query.page, 1);
    const limit = Math.min(toPositiveInt(query.limit, 12), 50);
    const skip = (page - 1) * limit;
    const cacheKey = CACHE_KEYS.search(
      buildQueryKey({
        keyword,
        genres,
        status,
        sortBy,
        order,
        page,
        limit,
      }),
    );

    const filters: Prisma.AnimeWhereInput[] = [];

    if (keyword) {
      filters.push({
        OR: [
          { title: { contains: keyword } },
          { slug: { contains: keyword } },
          { alternativeTitles: { contains: keyword } },
          { synopsis: { contains: keyword } },
        ],
      });
    }

    if (genres.length > 0) {
      filters.push({
        AND: genres.map((name) => ({
          genres: {
            some: {
              genre: {
                name: {
                  equals: name,
                },
              },
            },
          },
        })),
      });
    }

    if (status === "completed") {
      filters.push({ status: { contains: "complete" } });
    }

    if (status === "ongoing") {
      filters.push({
        NOT: {
          status: { contains: "complete" },
        },
      });
    }

    const where: Prisma.AnimeWhereInput =
      filters.length > 0 ? { AND: filters } : {};

    try {
      type SearchPayload = {
        items: {
          id: number;
          slug: string;
          title: string;
          genre: string[];
          thumbnail: string;
          status: "Ongoing" | "Completed";
        }[];
        total: number;
      };

      const cached = await getCache<SearchPayload>(cacheKey);
      const payload =
        cached ??
        (await (async (): Promise<SearchPayload> => {
          const [total, animes] = await Promise.all([
            prisma.anime.count({ where }),
            prisma.anime.findMany({
              where,
              orderBy: buildOrderBy(sortBy, order),
              skip,
              take: limit,
              select: {
                id: true,
                slug: true,
                title: true,
                thumbnail: true,
                status: true,
                genres: {
                  select: {
                    genre: {
                      select: {
                        name: true,
                      },
                    },
                  },
                },
              },
            }),
          ]);

          const result: SearchPayload = {
            items: animes.map((anime) => ({
              id: anime.id,
              slug: anime.slug,
              title: normalizeTitle(anime.title),
              genre: anime.genres.map((item) => item.genre.name),
              thumbnail: anime.thumbnail ?? "",
              status: toAnimeStatus(anime.status),
            })),
            total,
          };

          await setCache(cacheKey, result, CACHE_TTL.SEARCH);
          return result;
        })());

      return paginated(reply, {
        items: payload.items,
        page,
        limit,
        total: payload.total,
        message: "Anime search fetched successfully",
        meta: {
          keyword: keyword || null,
          genre: genres,
          status,
          sortBy,
          order,
          cache: cached ? "hit" : "miss",
        },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to search anime",
        errorCode: "ANIME_SEARCH_FAILED",
      });
    }
  });

  app.get("/:animeSlug/:episodeSlug", async (request, reply) => {
    const { animeSlug, episodeSlug } = request.params as {
      animeSlug?: string;
      episodeSlug?: string;
    };

    if (!animeSlug || !episodeSlug) {
      return sendError(reply, {
        status: 400,
        message: "Parameters 'animeSlug' and 'episodeSlug' are required",
        errorCode: "EPISODE_PARAMS_REQUIRED",
      });
    }

    const cacheKey = CACHE_KEYS.episodeDetail(animeSlug, episodeSlug);

    try {
      const cached = await getCache<Record<string, unknown>>(cacheKey);
      const cacheHasSourceFields =
        cached &&
        Object.prototype.hasOwnProperty.call(cached, "sourceProvider") &&
        Object.prototype.hasOwnProperty.call(cached, "sourceVideoId");
      const cacheHasAnimeSynopsis =
        cached?.anime &&
        typeof cached.anime === "object" &&
        Object.prototype.hasOwnProperty.call(cached.anime, "synopsis");
      const cacheHasAnimeRating =
        cached?.anime &&
        typeof cached.anime === "object" &&
        Object.prototype.hasOwnProperty.call(cached.anime, "rating");

      if (
        cached &&
        cacheHasSourceFields &&
        cacheHasAnimeSynopsis &&
        cacheHasAnimeRating
      ) {
        const publicData = stripPublicSubtitleTrackCues(cached);
        const accessEpisode = episodeAccessInput(publicData);

        if (accessEpisode) {
          const userId = await optionalAuthUserId(app, request);

          if (!userId) {
            const guestId = getOrSetGuestWatchId(request, reply);
            const guestWatch = await checkGuestWatchLimit({
              guestId,
              episode: {
                id: accessEpisode.id,
                animeId: accessEpisode.anime.id,
                number: accessEpisode.number,
              },
            });

            if (!guestWatch.allowed) {
              return sendError(reply, {
                status: 403,
                message: "Masuk untuk lanjut menonton episode terbaru",
                errorCode: "LOGIN_REQUIRED",
                data: { guestWatch },
              });
            }
          }
        }

        if (hasSubtitleTrackCues(cached)) {
          await setCache(cacheKey, publicData, CACHE_TTL.EPISODE_DETAIL);
        }

        return ok(reply, {
          message: "Episode detail fetched successfully",
          data: publicData,
          meta: { cache: "hit" },
        });
      }

      const episodeDetailSelect = {
        id: true,
        slug: true,
        number: true,
        title: true,
        sub: true,
        date: true,
        createdAt: true,
        views: true,
        skipIntroSeconds: true,
        skipOutroSeconds: true,
        sourceProvider: true,
        sourceVideoId: true,
        servers: {
          orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
          select: {
            id: true,
            label: true,
            value: true,
            isPrimary: true,
          },
        },
        subtitles: {
          orderBy: [{ serverUrl: "asc" }, { language: "asc" }],
          select: {
            id: true,
            episodeId: true,
            serverUrl: true,
            language: true,
            label: true,
            fileUrl: true,
            format: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        subtitleTracks: {
          orderBy: [{ serverUrl: "asc" }, { language: "asc" }],
          select: {
            id: true,
            episodeId: true,
            serverUrl: true,
            language: true,
            label: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        anime: {
          select: {
            id: true,
            slug: true,
            title: true,
            synopsis: true,
            rating: true,
            thumbnail: true,
            bigCover: true,
            status: true,
            studio: true,
            type: true,
            totalEpisodes: true,
            skipIntroSeconds: true,
            skipOutroSeconds: true,
            episodes: {
              orderBy: [{ number: "asc" }, { id: "asc" }],
              select: {
                id: true,
                slug: true,
                number: true,
                title: true,
                sub: true,
                date: true,
              },
            },
            genres: {
              select: {
                genre: {
                  select: {
                    name: true,
                  },
                },
              },
            },
            tags: {
              select: {
                tag: {
                  select: {
                    slug: true,
                    label: true,
                  },
                },
              },
            },
          },
        },
      } satisfies Prisma.EpisodeSelect;

      let episode = await prisma.episode.findFirst({
        where: {
          slug: episodeSlug,
          anime: {
            slug: animeSlug,
          },
        },
        select: episodeDetailSelect,
      });

      if (!episode) {
        episode = await prisma.episode.findUnique({
          where: { slug: episodeSlug },
          select: episodeDetailSelect,
        });
      }

      if (!episode) {
        return sendError(reply, {
          status: 404,
          message: "Episode not found",
          errorCode: "EPISODE_NOT_FOUND",
        });
      }

      const userId = await optionalAuthUserId(app, request);
      let guestWatch: Awaited<ReturnType<typeof checkGuestWatchLimit>> | null = null;

      if (!userId) {
        const guestId = getOrSetGuestWatchId(request, reply);
        guestWatch = await checkGuestWatchLimit({
          guestId,
          episode: {
            id: episode.id,
            animeId: episode.anime.id,
            number: episode.number,
          },
        });

        if (!guestWatch.allowed) {
          return sendError(reply, {
            status: 403,
            message: "Masuk untuk lanjut menonton episode terbaru",
            errorCode: "LOGIN_REQUIRED",
            data: { guestWatch },
          });
        }
      }

      const currentGenres = episode.anime.genres.map((item) => item.genre.name);
      const currentTagSlugs = episode.anime.tags.map((item) => item.tag.slug);
      const strongRelatedFilters: Prisma.AnimeWhereInput[] = [];

      if (currentGenres.length > 0) {
        strongRelatedFilters.push({
          genres: {
            some: {
              genre: {
                name: {
                  in: currentGenres,
                },
              },
            },
          },
        });
      }

      if (currentTagSlugs.length > 0) {
        strongRelatedFilters.push({
          tags: {
            some: {
              tag: {
                slug: {
                  in: currentTagSlugs,
                },
              },
            },
          },
        });
      }

      if (episode.anime.studio) {
        strongRelatedFilters.push({ studio: { equals: episode.anime.studio } });
      }

      const [previousEpisode, nextEpisode, relatedAnimes, seasons] =
        await Promise.all([
          prisma.episode.findFirst({
            where: {
              animeId: episode.anime.id,
              number: { lt: episode.number },
            },
            orderBy: [{ number: "desc" }, { id: "desc" }],
            select: {
              id: true,
              slug: true,
              number: true,
              title: true,
            },
          }),
          prisma.episode.findFirst({
            where: {
              animeId: episode.anime.id,
              number: { gt: episode.number },
            },
            orderBy: [{ number: "asc" }, { id: "asc" }],
            select: {
              id: true,
              slug: true,
              number: true,
              title: true,
            },
          }),
          prisma.anime.findMany({
            where: {
              id: { not: episode.anime.id },
              ...(strongRelatedFilters.length > 0
                ? { OR: strongRelatedFilters }
                : { id: -1 }),
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: 100,
            select: {
              id: true,
              slug: true,
              title: true,
              thumbnail: true,
              bigCover: true,
              status: true,
              studio: true,
              type: true,
              totalEpisodes: true,
              updatedAt: true,
              _count: {
                select: {
                  episodes: true,
                },
              },
              genres: {
                select: {
                  genre: {
                    select: {
                      name: true,
                    },
                  },
                },
              },
              tags: {
                select: {
                  tag: {
                    select: {
                      slug: true,
                      label: true,
                    },
                  },
                },
              },
              episodes: {
                orderBy: [{ number: "desc" }, { id: "desc" }],
                take: 1,
                select: {
                  id: true,
                  slug: true,
                  number: true,
                  title: true,
                  sub: true,
                  date: true,
                },
              },
            },
          }),
          buildEpisodeSeasons({
            title: episode.title,
            anime: {
              id: episode.anime.id,
              slug: episode.anime.slug,
              title: episode.anime.title,
              thumbnail: episode.anime.thumbnail,
              bigCover: episode.anime.bigCover,
              status: episode.anime.status,
              studio: episode.anime.studio,
              type: episode.anime.type,
              totalEpisodes: episode.anime.totalEpisodes,
              genres: episode.anime.genres,
              tags: episode.anime.tags,
            },
          }),
        ]);

      const watchSeasons = seasons.map(({ anime: _anime, ...season }) => season);

      const relatedVideos = relatedAnimes
        .map((anime) => {
          const genres = anime.genres.map((item) => item.genre.name);
          const tags = anime.tags.map((item) => item.tag);
          const genreMatches = countMatches(currentGenres, genres);
          const tagMatches = countMatches(
            currentTagSlugs,
            tags.map((tag) => tag.slug),
          );
          const studioMatches =
            normalizeComparable(anime.studio) ===
              normalizeComparable(episode.anime.studio) && anime.studio
              ? 1
              : 0;
          const typeMatches =
            normalizeComparable(anime.type) ===
              normalizeComparable(episode.anime.type) && anime.type
              ? 1
              : 0;
          const statusMatches =
            normalizeComparable(anime.status) ===
              normalizeComparable(episode.anime.status) && anime.status
              ? 1
              : 0;
          const strongScore =
            tagMatches * 4 + genreMatches * 3 + studioMatches * 3;
          const weakScore = typeMatches + statusMatches;

          return {
            id: anime.id,
            slug: anime.slug,
            title: normalizeTitle(anime.title),
            thumbnail: anime.thumbnail ?? "",
            bigCover: anime.bigCover ?? "",
            status: anime.status,
            studio: anime.studio,
            type: anime.type,
            totalEpisodes: anime.totalEpisodes,
            episodeCount: anime._count.episodes,
            genres,
            tags,
            latestEpisode: anime.episodes[0] ?? null,
            relevance: {
              score: strongScore + weakScore,
              strongScore,
              genreMatches,
              tagMatches,
              studioMatches: Boolean(studioMatches),
              typeMatches: Boolean(typeMatches),
              statusMatches: Boolean(statusMatches),
            },
            updatedAt: anime.updatedAt,
            randomTieBreaker: getRandomTieBreaker(),
          };
        })
        .filter((anime) => {
          return (
            anime.episodeCount > 1 &&
            anime.latestEpisode !== null &&
            anime.relevance.strongScore > 0
          );
        })
        .sort((left, right) => {
          if (right.relevance.score !== left.relevance.score) {
            return right.relevance.score - left.relevance.score;
          }

          if (right.relevance.strongScore !== left.relevance.strongScore) {
            return right.relevance.strongScore - left.relevance.strongScore;
          }

          if (right.episodeCount !== left.episodeCount) {
            return right.episodeCount - left.episodeCount;
          }

          if (right.randomTieBreaker !== left.randomTieBreaker) {
            return right.randomTieBreaker - left.randomTieBreaker;
          }

          return right.updatedAt.getTime() - left.updatedAt.getTime();
        })
        .slice(0, 12)
        .map(
          ({
            updatedAt: _updatedAt,
            randomTieBreaker: _randomTieBreaker,
            ...anime
          }) => anime,
        );

      const responseData = {
        id: episode.id,
        slug: episode.slug,
        number: episode.number,
        title: episode.title,
        sub: episode.sub,
        date: episode.date,
        createdAt: episode.createdAt,
        views: episode.views,
        skipIntroSeconds: episode.skipIntroSeconds,
        skipOutroSeconds: episode.skipOutroSeconds,
        sourceProvider: episode.sourceProvider,
        sourceVideoId: episode.sourceVideoId,
        episodes: watchSeasons.length > 0 ? [] : episode.anime.episodes,
        seasons: watchSeasons,
        anime: {
          id: episode.anime.id,
          slug: episode.anime.slug,
          title: normalizeTitle(episode.anime.title),
          synopsis: episode.anime.synopsis,
          rating: episode.anime.rating,
          thumbnail: episode.anime.thumbnail ?? "",
          bigCover: episode.anime.bigCover ?? "",
          status: episode.anime.status,
          studio: episode.anime.studio,
          type: episode.anime.type,
          totalEpisodes: episode.anime.totalEpisodes,
          skipIntroSeconds: episode.anime.skipIntroSeconds,
          skipOutroSeconds: episode.anime.skipOutroSeconds,
          genres: currentGenres,
          tags: episode.anime.tags.map((item) => item.tag),
        },
        servers: episode.servers,
        subtitles: episode.subtitles,
        subtitleTracks: episode.subtitleTracks,
        navigation: {
          previous: previousEpisode,
          next: nextEpisode,
        },
        relatedVideos,
      };

      await setCache(cacheKey, responseData, CACHE_TTL.EPISODE_DETAIL);

      return ok(reply, {
        message: "Episode detail fetched successfully",
        data: responseData,
        meta: { cache: "miss" },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch episode detail",
        errorCode: "EPISODE_DETAIL_FETCH_FAILED",
      });
    }
  });

  app.get("/:slug", async (request, reply) => {
    const { slug } = request.params as { slug?: string };

    const { include } = request.query as { include?: string };

    if (!slug) {
      return sendError(reply, {
        status: 400,
        message: "Parameter 'slug' is required",
        errorCode: "SLUG_REQUIRED",
      });
    }

    const cacheKey = CACHE_KEYS.animeDetail(slug);

    try {
      const cached = await getCache<Record<string, unknown>>(cacheKey);
      if (cached) {
        return ok(reply, {
          message: "Anime detail fetched successfully",
          data: cached,
          meta: { cache: "hit" },
        });
      }

      const anime = await prisma.anime.findUnique({
        where: { slug },
        select: {
          id: true,
          slug: true,
          title: true,
          thumbnail: true,
          bigCover: true,
          rating: true,
          alternativeTitles: true,
          synopsis: true,
          followed: true,
          views: true,
          likes: true,
          trendingScore: true,
          status: true,
          network: true,
          studio: true,
          released: true,
          duration: true,
          season: true,
          country: true,
          type: true,
          totalEpisodes: true,
          fansub: true,
          genres: {
            select: {
              genre: {
                select: { name: true },
              },
            },
          },
          tags: {
            select: {
              tag: {
                select: {
                  slug: true,
                  label: true,
                },
              },
            },
          },
          episodes: {
            orderBy: [{ number: "desc" }, { id: "desc" }],
            select: {
              id: true,
              slug: true,
              number: true,
              title: true,
              sub: true,
              date: true,
            },
          },
          updatedAt: true,
          createdAt: true,
        },
      });

      if (!anime) {
        return sendError(reply, {
          status: 404,
          message: "Anime not found",
          errorCode: "ANIME_NOT_FOUND",
        });
      }

      const seasons = await buildEpisodeSeasons({
        title: anime.title,
        anime: {
          id: anime.id,
          slug: anime.slug,
          title: anime.title,
          thumbnail: anime.thumbnail,
          bigCover: anime.bigCover,
          rating: anime.rating,
          alternativeTitles: anime.alternativeTitles,
          synopsis: anime.synopsis,
          followed: anime.followed,
          views: anime.views,
          likes: anime.likes,
          trendingScore: anime.trendingScore,
          status: anime.status,
          network: anime.network,
          studio: anime.studio,
          released: anime.released,
          duration: anime.duration,
          season: anime.season,
          country: anime.country,
          type: anime.type,
          totalEpisodes: anime.totalEpisodes,
          fansub: anime.fansub,
          genres: anime.genres,
          tags: anime.tags,
          createdAt: anime.createdAt,
          updatedAt: anime.updatedAt,
        },
      });

      const responseData = {
        id: anime.id,
        slug: anime.slug,
        title: normalizeTitle(anime.title),
        thumbnail: anime.thumbnail ?? "",
        bigCover: anime.bigCover ?? "",
        rating: anime.rating ? Number(anime.rating) : null,
        alternativeTitles: anime.alternativeTitles,
        synopsis: anime.synopsis,
        followed: anime.followed,
        views: anime.views,
        likes: anime.likes,
        trendingScore: anime.trendingScore,
        status: anime.status,
        network: anime.network,
        studio: anime.studio,
        released: anime.released,
        duration: anime.duration,
        season: anime.season,
        country: anime.country,
        type: anime.type,
        totalEpisodes: anime.totalEpisodes,
        fansub: anime.fansub,
        genres: anime.genres.map((item) => item.genre.name),
        tags: anime.tags.map((item) => item.tag),
        episodes: anime.episodes,
        seasons,
        createdAt: anime.createdAt,
        updatedAt: anime.updatedAt,
      };

      await setCache(cacheKey, responseData, CACHE_TTL.ANIME_DETAIL);

      return ok(reply, {
        message: "Anime detail fetched successfully",
        data: responseData,
        meta: { cache: "miss" },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch anime detail",
        errorCode: "ANIME_DETAIL_FETCH_FAILED",
      });
    }
  });
};
