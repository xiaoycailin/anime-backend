import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { Prisma, type NotificationCategory } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  getCachedConfigs,
  invalidateConfigCache,
} from "../../services/siteConfig.service";
import {
  createSubtitle,
  deleteSubtitle,
  importSubtitle,
  listSubtitles,
  updateSubtitle,
} from "../../services/subtitle.service";
import {
  createBroadcastNotification,
  createRoleNotification,
  createSegmentNotification,
} from "../../services/notification.service";
import { markEpisodeReleasedAndNotifyOnce } from "../../services/release-schedule.service";
import { calculateLevel } from "../../services/exp.service";
import { badRequest, notFound } from "../../utils/http-error";
import { created, ok, paginated } from "../../utils/response";
import { CacheInvalidator } from "../../lib/cache";

type PaginationQuery = {
  page?: string;
  limit?: string;
  search?: string;
  status?: string;
  type?: string;
  sort?: string;
  role?: string;
  animeId?: string;
  animeIds?: string;
  episodeId?: string;
  episodeNumber?: string;
  numberFrom?: string;
  numberTo?: string;
  hasVideo?: string;
  hasSubtitle?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  sortBy?: string;
  userId?: string;
  deleted?: string;
  group?: string;
};

type AnimeBody = {
  slug?: string;
  title?: string;
  thumbnail?: string | null;
  bigCover?: string | null;
  synopsis?: string | null;
  status?: string | null;
  type?: string | null;
  totalEpisodes?: number | null;
  genres?: string[];
  network?: string | null;
  studio?: string | null;
  released?: string | null;
  duration?: string | null;
  season?: string | null;
  country?: string | null;
  rating?: number | null;
};

type EpisodeBody = {
  animeId?: number;
  slug?: string;
  number?: number;
  title?: string;
  sub?: string | null;
  date?: string | null;
  status?: string | null;
  skipIntroSeconds?: number | null;
  scheduledReleaseAt?: string | Date | null;
};

type ServerBody = {
  label?: string;
  value?: string;
  isPrimary?: boolean;
};

type DecorationBody = {
  name?: string;
  type?: string;
  asset?: string | null;
  config?: Record<string, unknown> | null;
  requiredLevel?: number;
  priceExp?: number;
  isActive?: boolean;
  sortOrder?: number;
};

function normalizeDecorationType(
  value: unknown,
): "frame" | "nametag" | "effect" {
  if (value === "nametag") return "nametag";
  if (value === "effect") return "effect";
  return "frame";
}

function cleanDecorationData(body: DecorationBody) {
  const data: Prisma.DecorationUncheckedUpdateInput = {};
  if (body.name !== undefined) data.name = String(body.name).trim();
  if (body.type !== undefined) data.type = normalizeDecorationType(body.type);
  if (body.asset !== undefined) {
    const asset = body.asset?.toString().trim();
    data.asset = asset ? asset : null;
  }
  if (body.config !== undefined) {
    data.config = (body.config ?? {}) as Prisma.InputJsonValue;
  }
  if (body.requiredLevel !== undefined) {
    const level = Math.floor(Number(body.requiredLevel));
    data.requiredLevel = Number.isFinite(level) && level >= 1 ? level : 1;
  }
  if (body.priceExp !== undefined) {
    const price = Math.floor(Number(body.priceExp));
    data.priceExp = Number.isFinite(price) && price >= 0 ? price : 0;
  }
  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
  if (body.sortOrder !== undefined) {
    const sort = Math.floor(Number(body.sortOrder));
    data.sortOrder = Number.isFinite(sort) ? sort : 0;
  }
  return data;
}

function sanitizeEffectConfig(
  input: Record<string, unknown> | null | undefined,
) {
  const cfg = input ?? {};
  const src = typeof cfg.src === "string" ? cfg.src.trim() : "";
  const loop = Boolean(cfg.loop);
  const rawDuration = Number(cfg.duration);
  const duration =
    Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.min(600000, Math.max(500, Math.floor(rawDuration)))
      : undefined;
  const config: Record<string, unknown> = { src, loop };
  if (duration !== undefined) config.duration = duration;
  return { config, src, loop, duration };
}

async function adminDecorationWithCount(id: number) {
  return prisma.decoration.findUnique({
    where: { id },
    include: { _count: { select: { ownedBy: true } } },
  });
}

async function decorationOwnerUserIds(decorationId: number) {
  if (!Number.isFinite(decorationId) || decorationId <= 0) return [];
  const owners = await prisma.userDecoration.findMany({
    where: { decorationId },
    select: { userId: true },
  });
  return owners.map((owner) => owner.userId);
}

type BroadcastBody = {
  title?: string;
  message?: string;
  category?: NotificationCategory;
  type?: string;
  link?: string | null;
  image?: string | null;
  topic?: string | null;
  scope?: "broadcast" | "admins" | "all-users" | "saved-anime" | "genres";
  animeId?: number | null;
  genres?: string[];
};

type SubtitleMultipart = {
  body: Record<string, string>;
  file?: { filename: string; buffer: Buffer };
};

function pageParams(query: PaginationQuery) {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function weekStart() {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  date.setHours(0, 0, 0, 0);
  return date;
}

function cleanAnimeData(body: AnimeBody) {
  return {
    ...(body.slug ? { slug: body.slug.trim() } : {}),
    ...(body.title ? { title: body.title.trim() } : {}),
    ...(body.thumbnail !== undefined ? { thumbnail: body.thumbnail } : {}),
    ...(body.bigCover !== undefined ? { bigCover: body.bigCover } : {}),
    ...(body.synopsis !== undefined ? { synopsis: body.synopsis } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.type !== undefined ? { type: body.type } : {}),
    ...(body.totalEpisodes !== undefined
      ? { totalEpisodes: body.totalEpisodes }
      : {}),
    ...(body.network !== undefined ? { network: body.network } : {}),
    ...(body.studio !== undefined ? { studio: body.studio } : {}),
    ...(body.released !== undefined ? { released: body.released } : {}),
    ...(body.duration !== undefined ? { duration: body.duration } : {}),
    ...(body.season !== undefined ? { season: body.season } : {}),
    ...(body.country !== undefined ? { country: body.country } : {}),
    ...(body.rating !== undefined ? { rating: body.rating } : {}),
  };
}

function cleanEpisodeData(body: EpisodeBody) {
  const skipIntroSeconds =
    body.skipIntroSeconds === null || body.skipIntroSeconds === undefined
      ? body.skipIntroSeconds
      : Math.max(0, Number(body.skipIntroSeconds));
  const scheduledReleaseAt =
    body.scheduledReleaseAt === null || body.scheduledReleaseAt === undefined
      ? body.scheduledReleaseAt
      : new Date(body.scheduledReleaseAt);

  return {
    ...(body.animeId !== undefined ? { animeId: Number(body.animeId) } : {}),
    ...(body.slug ? { slug: body.slug.trim() } : {}),
    ...(body.number !== undefined ? { number: Number(body.number) } : {}),
    ...(body.title ? { title: body.title.trim() } : {}),
    ...(body.sub !== undefined ? { sub: body.sub } : {}),
    ...(body.date !== undefined ? { date: body.date } : {}),
    ...(body.status !== undefined
      ? { status: body.status ?? "published" }
      : {}),
    ...(body.skipIntroSeconds !== undefined
      ? {
          skipIntroSeconds:
            skipIntroSeconds === null || Number.isFinite(skipIntroSeconds)
              ? skipIntroSeconds
              : null,
        }
      : {}),
    ...(body.scheduledReleaseAt !== undefined
      ? {
          scheduledReleaseAt:
            scheduledReleaseAt === null ||
            (scheduledReleaseAt instanceof Date &&
              !Number.isNaN(scheduledReleaseAt.getTime()))
              ? scheduledReleaseAt
              : null,
        }
      : {}),
  };
}

function parseIdList(value?: string) {
  return (value ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function parseStringList(value?: string) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function dateRange(from?: string, to?: string) {
  if (!from && !to) return undefined;

  const range: { gte?: Date; lte?: Date } = {};
  if (from) {
    const date = new Date(from);
    if (!Number.isNaN(date.getTime())) range.gte = date;
  }
  if (to) {
    const date = new Date(to);
    if (!Number.isNaN(date.getTime())) {
      date.setHours(23, 59, 59, 999);
      range.lte = date;
    }
  }

  return Object.keys(range).length > 0 ? range : undefined;
}

function episodeWhere(query: PaginationQuery): Prisma.EpisodeWhereInput {
  const animeIds = parseIdList(query.animeIds);
  const statuses = parseStringList(query.status);
  const numberRange: Prisma.IntFilter = {};
  const exactNumber = query.episodeNumber ? Number(query.episodeNumber) : null;
  const numberFrom = query.numberFrom ? Number(query.numberFrom) : null;
  const numberTo = query.numberTo ? Number(query.numberTo) : null;
  const createdAt = dateRange(query.createdFrom, query.createdTo);
  const updatedAt = dateRange(query.updatedFrom, query.updatedTo);

  if (Number.isFinite(numberFrom)) numberRange.gte = Number(numberFrom);
  if (Number.isFinite(numberTo)) numberRange.lte = Number(numberTo);

  return {
    ...(query.animeId ? { animeId: Number(query.animeId) } : {}),
    ...(animeIds.length > 0 ? { animeId: { in: animeIds } } : {}),
    ...(query.search ? { title: { contains: query.search } } : {}),
    ...(Number.isFinite(exactNumber)
      ? { number: Number(exactNumber) }
      : Object.keys(numberRange).length > 0
        ? { number: numberRange }
        : {}),
    ...(statuses.length === 1 ? { status: statuses[0] } : {}),
    ...(statuses.length > 1 ? { status: { in: statuses } } : {}),
    ...(query.hasVideo === "true" ? { servers: { some: {} } } : {}),
    ...(query.hasVideo === "false" ? { servers: { none: {} } } : {}),
    ...(query.hasSubtitle === "true"
      ? {
          OR: [{ subtitleTracks: { some: {} } }, { subtitles: { some: {} } }],
        }
      : {}),
    ...(query.hasSubtitle === "false"
      ? {
          subtitleTracks: { none: {} },
          subtitles: { none: {} },
        }
      : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function episodeOrderBy(
  sortBy?: string,
): Prisma.EpisodeOrderByWithRelationInput {
  if (sortBy === "oldest") return { createdAt: "asc" };
  if (sortBy === "mostViewed") return { views: "desc" };
  return { createdAt: "desc" };
}

async function syncAnimeGenres(animeId: number, genres?: string[]) {
  if (!Array.isArray(genres)) return;

  await prisma.animeGenre.deleteMany({ where: { animeId } });

  for (const name of genres.map((item) => item.trim()).filter(Boolean)) {
    const genre = await prisma.genre.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    await prisma.animeGenre.create({
      data: { animeId, genreId: genre.id },
    });
  }
}

function validateIds(ids: unknown) {
  if (!Array.isArray(ids) || ids.length === 0)
    throw badRequest("ids wajib diisi");
  return ids.map(Number).filter((id) => Number.isInteger(id) && id > 0);
}

async function parseSubtitlePayload(
  request: FastifyRequest,
): Promise<SubtitleMultipart> {
  const multipartRequest = request as FastifyRequest & {
    isMultipart?: () => boolean;
    parts: () => AsyncIterable<any>;
  };

  if (!multipartRequest.isMultipart?.()) {
    return { body: (request.body ?? {}) as Record<string, string> };
  }

  const body: Record<string, string> = {};
  let file: SubtitleMultipart["file"];

  for await (const part of multipartRequest.parts()) {
    if (part.type === "file") {
      file = {
        filename: part.filename,
        buffer: await part.toBuffer(),
      };
      continue;
    }
    body[part.fieldname] = String(part.value ?? "");
  }

  return { body, file };
}

async function upsertSiteConfig(input: { key: string; value: string }) {
  const existing = await prisma.siteConfig.findUnique({
    where: { key: input.key },
  });
  const group = existing?.group ?? input.key.split(".")[0] ?? "general";
  const type = existing?.type ?? "string";

  return prisma.siteConfig.upsert({
    where: { key: input.key },
    update: { value: input.value },
    create: { key: input.key, value: input.value, group, type },
  });
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.get("/stats", async (_request, reply) => {
    const { start, end } = todayRange();
    const sevenDaysAgo = weekStart();
    const [
      totalAnime,
      totalEpisodes,
      totalUsers,
      totalComments,
      totalWatchHistory,
      newUsersToday,
      newUsersThisWeek,
      activeUsersToday,
      recentComments,
      recentUsers,
      recentHistory,
      groupedHistory,
    ] = await Promise.all([
      prisma.anime.count(),
      prisma.episode.count(),
      prisma.user.count(),
      prisma.comment.count(),
      prisma.watchHistory.count(),
      prisma.user.count({ where: { createdAt: { gte: start, lt: end } } }),
      prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.watchHistory.findMany({
        where: { watchedAt: { gte: start, lt: end } },
        distinct: ["userId"],
        select: { userId: true },
      }),
      prisma.comment.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { user: { select: { username: true, fullName: true } } },
      }),
      prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { username: true, fullName: true, email: true, createdAt: true },
      }),
      prisma.watchHistory.findMany({
        where: { watchedAt: { gte: sevenDaysAgo } },
        select: { watchedAt: true },
      }),
      prisma.watchHistory.groupBy({
        by: ["animeId"],
        _count: { animeId: true },
        orderBy: { _count: { animeId: "desc" } },
        take: 5,
      }),
    ]);

    const animeIds = [
      ...new Set([
        ...recentComments.map((item) => item.animeId),
        ...groupedHistory.map((item) => item.animeId),
      ]),
    ];
    const animes = await prisma.anime.findMany({
      where: { id: { in: animeIds } },
      select: { id: true, title: true, slug: true, thumbnail: true },
    });
    const animeMap = new Map(animes.map((anime) => [anime.id, anime]));
    const watchHistoryByDay = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (6 - index));
      const key = date.toISOString().slice(0, 10);
      return {
        date: key,
        count: recentHistory.filter(
          (item) => item.watchedAt.toISOString().slice(0, 10) === key,
        ).length,
      };
    });

    return ok(reply, {
      data: {
        totalAnime,
        totalEpisodes,
        totalUsers,
        totalComments,
        totalWatchHistory,
        newUsersToday,
        newUsersThisWeek,
        activeUsersToday: activeUsersToday.length,
        topAnime: groupedHistory.map((item) => {
          const anime = animeMap.get(item.animeId);
          return {
            title: anime?.title ?? "Unknown",
            slug: anime?.slug ?? "",
            thumbnail: anime?.thumbnail ?? null,
            viewCount: item._count.animeId,
          };
        }),
        recentComments: recentComments.map((comment) => ({
          content: comment.deletedAt ? "[Komentar dihapus]" : comment.content,
          username: comment.user.username,
          fullName: comment.user.fullName?.trim() || comment.user.username,
          animeTitle: animeMap.get(comment.animeId)?.title ?? "Unknown",
          createdAt: comment.createdAt,
        })),
        recentUsers,
        watchHistoryByDay,
      },
    });
  });

  app.get("/anime", async (request, reply) => {
    const query = request.query as PaginationQuery;
    const { page, limit, skip } = pageParams(query);
    const where = {
      ...(query.search ? { title: { contains: query.search } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const orderBy =
      query.sort === "oldest"
        ? { createdAt: "asc" as const }
        : query.sort === "title"
          ? { title: "asc" as const }
          : query.sort === "episodes"
            ? { totalEpisodes: "desc" as const }
            : { createdAt: "desc" as const };
    const [items, total] = await Promise.all([
      prisma.anime.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: { _count: { select: { episodes: true } } },
      }),
      prisma.anime.count({ where }),
    ]);
    return paginated(reply, { items, page, limit, total });
  });

  app.get("/anime/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const anime = await prisma.anime.findUnique({
      where: { id },
      include: {
        genres: { include: { genre: true } },
        episodes: { orderBy: { number: "desc" } },
        _count: { select: { episodes: true } },
      },
    });
    if (!anime) throw notFound("Anime tidak ditemukan");
    return ok(reply, { data: anime });
  });

  app.post("/anime", async (request, reply) => {
    const body = request.body as AnimeBody;
    if (!body.slug || !body.title)
      throw badRequest("Slug dan judul wajib diisi");
    const anime = await prisma.anime.create({
      data: cleanAnimeData(body) as any,
    });
    await syncAnimeGenres(anime.id, body.genres);
    const result = await prisma.anime.findUnique({
      where: { id: anime.id },
      include: { genres: { include: { genre: true } } },
    });

    await CacheInvalidator.onAnimeChange(anime.slug);

    await Promise.all([
      createBroadcastNotification({
        category: "content_new",
        type: "anime_published",
        title: `Series baru: ${anime.title}`,
        message: `${request.user.username} menambahkan series baru ke katalog.`,
        link: `/anime/${anime.slug}`,
        topic: "anime",
        payload: {
          animeId: anime.id,
          slug: anime.slug,
          title: anime.title,
        },
        createdById: request.user.id,
      }),
      createRoleNotification({
        role: "admin",
        category: "admin_operational",
        type: "admin_anime_created",
        title: `Anime baru dibuat`,
        message: `${request.user.username} membuat series ${anime.title}.`,
        link: `/admin/anime/${anime.id}`,
        topic: "admin-content",
        payload: {
          animeId: anime.id,
          slug: anime.slug,
          title: anime.title,
        },
        createdById: request.user.id,
      }),
    ]);

    return created(reply, { data: result });
  });

  app.put("/anime/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as AnimeBody;
    const previous = await prisma.anime.findUnique({
      where: { id },
      select: { slug: true },
    });
    await prisma.anime.update({
      where: { id },
      data: cleanAnimeData(body) as any,
    });
    await syncAnimeGenres(id, body.genres);
    const anime = await prisma.anime.findUnique({
      where: { id },
      include: { genres: { include: { genre: true } } },
    });

    await Promise.all([
      CacheInvalidator.onAnimeChange(anime?.slug ?? null),
      previous?.slug && previous.slug !== anime?.slug
        ? CacheInvalidator.onAnimeChange(previous.slug)
        : Promise.resolve(),
    ]);

    return ok(reply, { data: anime });
  });

  app.delete("/anime/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const existing = await prisma.anime.findUnique({
      where: { id },
      select: { slug: true },
    });
    await prisma.anime.delete({ where: { id } });
    await CacheInvalidator.onAnimeChange(existing?.slug ?? null);
    return ok(reply, { data: { message: "deleted" } });
  });

  app.post("/anime/bulk-delete", async (request, reply) => {
    const ids = validateIds((request.body as { ids?: number[] }).ids);
    const result = await prisma.anime.deleteMany({
      where: { id: { in: ids } },
    });
    await CacheInvalidator.onBulkAnimeChange();
    return ok(reply, { data: { deleted: result.count } });
  });

  app.get("/episodes", async (request, reply) => {
    const query = request.query as PaginationQuery;
    const { page, limit, skip } = pageParams(query);
    const where = episodeWhere(query);
    const [items, total] = await Promise.all([
      prisma.episode.findMany({
        where,
        skip,
        take: limit,
        orderBy: [episodeOrderBy(query.sortBy), { id: "desc" }],
        include: {
          anime: { select: { id: true, title: true, slug: true } },
          _count: {
            select: { servers: true, subtitles: true, subtitleTracks: true },
          },
        },
      }),
      prisma.episode.count({ where }),
    ]);
    return paginated(reply, { items, page, limit, total });
  });

  app.post("/episodes", async (request, reply) => {
    const body = request.body as EpisodeBody;
    if (
      !body.animeId ||
      !body.slug ||
      !body.title ||
      typeof body.number !== "number"
    )
      throw badRequest("Data episode belum lengkap");
    const episode = await prisma.episode.create({
      data: cleanEpisodeData(body) as any,
      include: {
        anime: { select: { id: true, title: true, slug: true, thumbnail: true } },
      },
    });

    await CacheInvalidator.onEpisodeChange(episode.anime.slug, episode.slug);

    await Promise.all([
      markEpisodeReleasedAndNotifyOnce({
        episode,
        createdById: request.user.id,
      }),
      createRoleNotification({
        role: "admin",
        category: "admin_operational",
        type: "admin_episode_created",
        title: `Episode baru dibuat`,
        message: `${request.user.username} menambahkan ${episode.anime.title} episode ${episode.number}.`,
        link: `/admin/episodes/${episode.id}`,
        topic: "admin-content",
        payload: {
          animeId: episode.anime.id,
          animeSlug: episode.anime.slug,
          animeTitle: episode.anime.title,
          episodeId: episode.id,
          episodeSlug: episode.slug,
          episodeNumber: episode.number,
        },
        createdById: request.user.id,
      }),
    ]);

    return created(reply, { data: episode });
  });

  app.get("/episodes/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const episode = await prisma.episode.findUnique({
      where: { id },
      include: {
        anime: { select: { id: true, title: true, slug: true } },
        servers: true,
        subtitles: true,
        subtitleTracks: true,
      },
    });
    if (!episode) throw notFound("Episode tidak ditemukan");
    return ok(reply, { data: episode });
  });

  app.put("/episodes/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const previous = await prisma.episode.findUnique({
      where: { id },
      select: { slug: true, anime: { select: { slug: true } } },
    });
    const episode = await prisma.episode.update({
      where: { id },
      data: cleanEpisodeData(request.body as EpisodeBody) as any,
      include: { anime: { select: { slug: true } } },
    });

    await Promise.all([
      CacheInvalidator.onEpisodeChange(episode.anime.slug, episode.slug),
      previous && previous.slug !== episode.slug
        ? CacheInvalidator.onEpisodeChange(
            previous.anime?.slug ?? null,
            previous.slug,
          )
        : Promise.resolve(),
    ]);

    return ok(reply, { data: episode });
  });

  app.delete("/episodes/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const existing = await prisma.episode.findUnique({
      where: { id },
      select: { slug: true, anime: { select: { slug: true } } },
    });
    await prisma.episode.delete({ where: { id } });
    await CacheInvalidator.onEpisodeChange(
      existing?.anime?.slug ?? null,
      existing?.slug ?? null,
    );
    return ok(reply, { data: { message: "deleted" } });
  });

  app.get("/episodes/:id/servers", async (request, reply) => {
    const episodeId = Number((request.params as { id: string }).id);
    const servers = await prisma.server.findMany({
      where: { episodeId },
      orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
    });
    return ok(reply, { data: servers });
  });

  app.post("/episodes/:id/servers", async (request, reply) => {
    const episodeId = Number((request.params as { id: string }).id);
    const body = request.body as ServerBody;
    if (!body.label || !body.value)
      throw badRequest("Label dan URL wajib diisi");
    const label = body.label;
    const value = body.value;
    const isPrimary = body.isPrimary === true;
    const server = await prisma.$transaction(async (tx) => {
      if (isPrimary) {
        await tx.server.updateMany({
          where: { episodeId },
          data: { isPrimary: false },
        });
      }
      return tx.server.create({
        data: {
          episodeId,
          label,
          value,
          isPrimary,
        },
      });
    });

    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      include: {
        anime: { select: { id: true, title: true, slug: true } },
      },
    });

    if (episode) {
      await createRoleNotification({
        role: "admin",
        category: "admin_operational",
        type: "episode_server_created",
        title: `Server video baru ditambahkan`,
        message: `${request.user.username} menambahkan server ${body.label} untuk ${episode.anime.title} episode ${episode.number}.`,
        link: `/admin/episodes/${episode.id}`,
        topic: "admin-video",
        payload: {
          episodeId: episode.id,
          animeId: episode.anime.id,
          animeTitle: episode.anime.title,
          animeSlug: episode.anime.slug,
          episodeNumber: episode.number,
          serverLabel: body.label,
        },
        createdById: request.user.id,
      });

      await CacheInvalidator.onEpisodeChange(episode.anime.slug);
    }

    return created(reply, { data: server });
  });

  app.put("/servers/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as ServerBody;
    const existing = await prisma.server.findUnique({
      where: { id },
      include: {
        episode: { select: { slug: true, anime: { select: { slug: true } } } },
      },
    });
    if (!existing) throw notFound("Server tidak ditemukan");
    const server = await prisma.$transaction(async (tx) => {
      if (body.isPrimary === true) {
        await tx.server.updateMany({
          where: { episodeId: existing.episodeId, id: { not: id } },
          data: { isPrimary: false },
        });
      }
      const updated = await tx.server.update({
        where: { id },
        data: body as any,
      });
      if (body.value && body.value !== existing.value) {
        await tx.subtitle.updateMany({
          where: { episodeId: existing.episodeId, serverUrl: existing.value },
          data: { serverUrl: body.value },
        });
        await tx.subtitleTrack.updateMany({
          where: { episodeId: existing.episodeId, serverUrl: existing.value },
          data: { serverUrl: body.value },
        });
      }
      return updated;
    });

    await CacheInvalidator.onEpisodeChange(
      existing.episode?.anime?.slug ?? null,
      existing.episode?.slug ?? null,
    );

    return ok(reply, { data: server });
  });

  app.delete("/servers/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const existing = await prisma.server.findUnique({
      where: { id },
      include: {
        episode: { select: { slug: true, anime: { select: { slug: true } } } },
      },
    });
    if (!existing) throw notFound("Server tidak ditemukan");
    await prisma.$transaction([
      prisma.subtitle.deleteMany({
        where: { episodeId: existing.episodeId, serverUrl: existing.value },
      }),
      prisma.subtitleTrack.deleteMany({
        where: { episodeId: existing.episodeId, serverUrl: existing.value },
      }),
      prisma.server.delete({ where: { id } }),
    ]);

    await CacheInvalidator.onEpisodeChange(
      existing.episode?.anime?.slug ?? null,
      existing.episode?.slug ?? null,
    );

    return ok(reply, { data: { message: "deleted" } });
  });

  app.get("/subtitles", async (request, reply) => {
    const { episodeId } = request.query as { episodeId?: string };
    return ok(reply, { data: await listSubtitles(Number(episodeId)) });
  });

  app.post("/subtitles", async (request, reply) => {
    const { body, file } = await parseSubtitlePayload(request);
    const subtitle = await createSubtitle(body, file);
    const episode = await prisma.episode.findUnique({
      where: { id: subtitle.episodeId },
      include: { anime: { select: { id: true, title: true, slug: true } } },
    });
    if (episode) {
      await createRoleNotification({
        role: "admin",
        category: "admin_operational",
        type: "subtitle_created",
        title: `Subtitle baru ditambahkan`,
        message: `${request.user.username} menambahkan subtitle ${subtitle.language.toUpperCase()} untuk ${episode.anime.title} episode ${episode.number}.`,
        link: `/admin/subtitle-studio/${episode.id}`,
        topic: "admin-subtitle",
        payload: {
          subtitleId: subtitle.id,
          episodeId: episode.id,
          animeId: episode.anime.id,
          animeTitle: episode.anime.title,
          animeSlug: episode.anime.slug,
          episodeNumber: episode.number,
          language: subtitle.language,
        },
        createdById: request.user.id,
      });

      await CacheInvalidator.onEpisodeChange(episode.anime.slug);
    }
    return created(reply, { data: subtitle });
  });

  app.put("/subtitles/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const subtitle = await updateSubtitle(id, request.body as any);
    const episode = await prisma.episode.findUnique({
      where: { id: subtitle.episodeId },
      include: { anime: { select: { id: true, title: true, slug: true } } },
    });
    if (episode) {
      await createRoleNotification({
        role: "admin",
        category: "admin_operational",
        type: "subtitle_updated",
        title: `Subtitle diperbarui`,
        message: `${request.user.username} memperbarui subtitle ${subtitle.language.toUpperCase()} untuk ${episode.anime.title} episode ${episode.number}.`,
        link: `/admin/subtitle-studio/${episode.id}`,
        topic: "admin-subtitle",
        payload: {
          subtitleId: subtitle.id,
          episodeId: episode.id,
          animeId: episode.anime.id,
          animeTitle: episode.anime.title,
          episodeNumber: episode.number,
          language: subtitle.language,
        },
        createdById: request.user.id,
      });

      await CacheInvalidator.onEpisodeChange(episode.anime.slug);
    }
    return ok(reply, { data: subtitle });
  });

  app.delete("/subtitles/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const existing = await prisma.subtitle.findUnique({
      where: { id },
      include: {
        episode: { select: { slug: true, anime: { select: { slug: true } } } },
      },
    });
    const result = await deleteSubtitle(id);
    if (existing) {
      await CacheInvalidator.onEpisodeChange(
        existing.episode?.anime?.slug ?? null,
        existing.episode?.slug ?? null,
      );
    }
    return ok(reply, { data: result });
  });

  app.post("/subtitles/import", async (request, reply) => {
    const subtitle = await importSubtitle(request.body as any);
    const episode = await prisma.episode.findUnique({
      where: { id: subtitle.episodeId },
      include: { anime: { select: { id: true, title: true, slug: true } } },
    });
    if (episode) {
      await createRoleNotification({
        role: "admin",
        category: "admin_operational",
        type: "subtitle_imported",
        title: `Subtitle berhasil diimport`,
        message: `${request.user.username} mengimport subtitle ${subtitle.language.toUpperCase()} untuk ${episode.anime.title} episode ${episode.number}.`,
        link: `/admin/subtitle-studio/${episode.id}`,
        topic: "admin-subtitle",
        payload: {
          subtitleId: subtitle.id,
          episodeId: episode.id,
          animeId: episode.anime.id,
          animeTitle: episode.anime.title,
          episodeNumber: episode.number,
          language: subtitle.language,
        },
        createdById: request.user.id,
      });
    }
    return created(reply, { data: subtitle });
  });

  app.post("/notifications/broadcast", async (request, reply) => {
    const body = request.body as BroadcastBody;
    const title = body.title?.trim();
    const message = body.message?.trim();
    const category = body.category ?? "announcement";
    const type = body.type?.trim() || "manual_broadcast";
    const scope = body.scope ?? "broadcast";

    if (!title || !message) {
      throw badRequest("Judul dan message wajib diisi");
    }

    let result: { data?: unknown; recipientCount?: number } | undefined;

    if (scope === "broadcast") {
      const notification = await createBroadcastNotification({
        category,
        type,
        title,
        message,
        link: body.link,
        image: body.image,
        topic: body.topic,
        payload: {
          manual: true,
          scope,
        },
        createdById: request.user.id,
      });
      result = { data: notification };
    } else if (scope === "admins") {
      const notification = await createRoleNotification({
        role: "admin",
        category,
        type,
        title,
        message,
        link: body.link,
        image: body.image,
        topic: body.topic,
        payload: {
          manual: true,
          scope,
        },
        createdById: request.user.id,
      });
      result = { data: notification };
    } else if (scope === "all-users") {
      result = await createSegmentNotification({
        category,
        type,
        title,
        message,
        link: body.link,
        image: body.image,
        topic: body.topic,
        payload: {
          manual: true,
          scope,
        },
        segment: { type: "all-users" },
        createdById: request.user.id,
      });
    } else if (scope === "saved-anime") {
      if (!body.animeId)
        throw badRequest("animeId wajib diisi untuk segment saved-anime");
      result = await createSegmentNotification({
        category,
        type,
        title,
        message,
        link: body.link,
        image: body.image,
        topic: body.topic,
        payload: {
          manual: true,
          scope,
          animeId: body.animeId,
        },
        segment: { type: "saved-anime", animeId: Number(body.animeId) },
        createdById: request.user.id,
      });
    } else if (scope === "genres") {
      if (!Array.isArray(body.genres) || body.genres.length === 0) {
        throw badRequest("genres wajib diisi untuk segment genres");
      }
      result = await createSegmentNotification({
        category,
        type,
        title,
        message,
        link: body.link,
        image: body.image,
        topic: body.topic,
        payload: {
          manual: true,
          scope,
          genres: body.genres,
        },
        segment: { type: "genres", genres: body.genres },
        createdById: request.user.id,
      });
    }

    return created(reply, {
      message: "Broadcast notifikasi dikirim",
      data: result,
    });
  });

  app.get("/users", async (request, reply) => {
    const query = request.query as PaginationQuery;
    const { page, limit, skip } = pageParams(query);
    const where = {
      ...(query.search
        ? {
            OR: [
              { username: { contains: query.search } },
              { fullName: { contains: query.search } },
              { email: { contains: query.search } },
            ],
          }
        : {}),
      ...(query.role ? { role: query.role } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: query.sort === "oldest" ? "asc" : "desc" },
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          avatar: true,
          role: true,
          isVerified: true,
          exp: true,
          level: true,
          lastExpGainAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.user.count({ where }),
    ]);
    return paginated(reply, { items, page, limit, total });
  });

  app.get("/users/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const [user, watchCount, savedCount, commentCount] = await Promise.all([
      prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          avatar: true,
          role: true,
          isVerified: true,
          exp: true,
          level: true,
          lastExpGainAt: true,
          createdAt: true,
        },
      }),
      prisma.watchHistory.count({ where: { userId: id } }),
      prisma.savedAnime.count({ where: { userId: id } }),
      prisma.comment.count({ where: { userId: id } }),
    ]);
    if (!user) throw notFound("User tidak ditemukan");
    return ok(reply, {
      data: { ...user, stats: { watchCount, savedCount, commentCount } },
    });
  });

  app.put("/users/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as {
      role?: string;
      username?: string;
      avatar?: string | null;
      isVerified?: boolean;
      exp?: number;
      level?: number;
    };
    const data: Prisma.UserUpdateInput = {
      ...(body.role ? { role: body.role } : {}),
      ...(body.username ? { username: body.username } : {}),
      ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
      ...(body.isVerified !== undefined
        ? { isVerified: Boolean(body.isVerified) }
        : {}),
    };

    if (body.exp !== undefined) {
      const exp = Math.floor(Number(body.exp));
      if (!Number.isFinite(exp) || exp < 0) throw badRequest("EXP tidak valid");
      data.exp = exp;
      data.level = body.level !== undefined ? data.level : calculateLevel(exp);
    }

    if (body.level !== undefined) {
      const level = Math.floor(Number(body.level));
      if (!Number.isFinite(level) || level < 1)
        throw badRequest("Level tidak valid");
      data.level = level;
    }

    const user = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
          email: true,
          username: true,
          fullName: true,
          avatar: true,
        role: true,
        isVerified: true,
        exp: true,
        level: true,
        lastExpGainAt: true,
        createdAt: true,
      },
    });
    return ok(reply, { data: user });
  });

  app.delete("/users/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    await prisma.user.delete({ where: { id } });
    return ok(reply, { data: { message: "deleted" } });
  });

  app.get("/comments", async (request, reply) => {
    const query = request.query as PaginationQuery;
    const { page, limit, skip } = pageParams(query);
    const where = {
      ...(query.search ? { content: { contains: query.search } } : {}),
      ...(query.animeId ? { animeId: Number(query.animeId) } : {}),
      ...(query.episodeId ? { episodeId: Number(query.episodeId) } : {}),
      ...(query.userId ? { userId: Number(query.userId) } : {}),
      ...(query.deleted === "true"
        ? { deletedAt: { not: null } }
        : query.deleted === "false"
          ? { deletedAt: null }
          : {}),
    };
    const [items, total] = await Promise.all([
      prisma.comment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, username: true, fullName: true, avatar: true } },
        },
      }),
      prisma.comment.count({ where }),
    ]);
    const animeIds = [...new Set(items.map((item) => item.animeId))];
    const episodeIds = [
      ...new Set(
        items.map((item) => item.episodeId).filter(Boolean) as number[],
      ),
    ];
    const [animes, episodes] = await Promise.all([
      prisma.anime.findMany({
        where: { id: { in: animeIds } },
        select: { id: true, title: true },
      }),
      prisma.episode.findMany({
        where: { id: { in: episodeIds } },
        select: { id: true, title: true, number: true },
      }),
    ]);
    const animeMap = new Map(animes.map((item) => [item.id, item]));
    const episodeMap = new Map(episodes.map((item) => [item.id, item]));
    return paginated(reply, {
      items: items.map((comment) => ({
        ...comment,
        isDeleted: Boolean(comment.deletedAt),
        anime: animeMap.get(comment.animeId) ?? null,
        episode: comment.episodeId
          ? (episodeMap.get(comment.episodeId) ?? null)
          : null,
      })),
      page,
      limit,
      total,
    });
  });

  app.delete("/comments/bulk", async (request, reply) => {
    const body = request.body as { ids?: number[]; hard?: boolean };
    const ids = validateIds(body.ids);
    if (body.hard) {
      const result = await prisma.comment.deleteMany({
        where: { id: { in: ids } },
      });
      return ok(reply, { data: { deleted: result.count } });
    }
    const result = await prisma.comment.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt: new Date(), content: null },
    });
    return ok(reply, { data: { deleted: result.count } });
  });

  app.delete("/comments/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const hard = Boolean((request.body as { hard?: boolean } | null)?.hard);
    if (hard) await prisma.comment.delete({ where: { id } });
    else
      await prisma.comment.update({
        where: { id },
        data: { deletedAt: new Date(), content: null },
      });
    return ok(reply, { data: { message: "deleted" } });
  });

  app.post("/comments/:id/restore", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const comment = await prisma.comment.update({
      where: { id },
      data: { deletedAt: null },
    });
    return ok(reply, { data: comment });
  });

  app.get("/site-config", async (request, reply) => {
    const query = request.query as PaginationQuery;
    return ok(reply, { data: await getCachedConfigs(query.group) });
  });

  app.put("/site-config", async (request, reply) => {
    const body = request.body as { key?: string; value?: string };
    if (!body.key || typeof body.value !== "string")
      throw badRequest("Key dan value wajib diisi");
    const config = await upsertSiteConfig({ key: body.key, value: body.value });
    invalidateConfigCache();
    return ok(reply, { data: config });
  });

  app.put("/site-config/batch", async (request, reply) => {
    const configs = (
      request.body as { configs?: { key: string; value: string }[] }
    ).configs;
    if (!Array.isArray(configs) || configs.length === 0)
      throw badRequest("configs wajib diisi");
    await prisma.$transaction(async (tx) => {
      for (const config of configs) {
        const existing = await tx.siteConfig.findUnique({
          where: { key: config.key },
        });
        await tx.siteConfig.upsert({
          where: { key: config.key },
          update: { value: config.value },
          create: {
            key: config.key,
            value: config.value,
            group: existing?.group ?? config.key.split(".")[0] ?? "general",
            type: existing?.type ?? "string",
          },
        });
      }
    });
    invalidateConfigCache();
    return ok(reply, { data: { updated: configs.length } });
  });

  app.get("/decorations", async (request, reply) => {
    const query = request.query as PaginationQuery;
    const { page, limit, skip } = pageParams(query);
    const where: Prisma.DecorationWhereInput = {
      ...(query.search ? { name: { contains: query.search } } : {}),
      ...(query.type === "frame" ||
      query.type === "nametag" ||
      query.type === "effect"
        ? { type: query.type }
        : {}),
      ...(query.status === "active"
        ? { isActive: true }
        : query.status === "inactive"
          ? { isActive: false }
          : {}),
    };
    const [items, total] = await Promise.all([
      prisma.decoration.findMany({
        where,
        orderBy: [
          { type: "asc" },
          { sortOrder: "asc" },
          { requiredLevel: "asc" },
          { id: "asc" },
        ],
        skip,
        take: limit,
        include: { _count: { select: { ownedBy: true } } },
      }),
      prisma.decoration.count({ where }),
    ]);
    return paginated(reply, { items, page, limit, total });
  });

  app.get("/decorations/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const decoration = await prisma.decoration.findUnique({
      where: { id },
      include: { _count: { select: { ownedBy: true } } },
    });
    if (!decoration) throw notFound("Decoration tidak ditemukan");
    return ok(reply, { data: decoration });
  });

  app.post("/decorations", async (request, reply) => {
    const body = request.body as DecorationBody;
    const name = body.name?.toString().trim();
    const type = normalizeDecorationType(body.type);
    if (!name) throw badRequest("Nama decoration wajib diisi");

    let normalizedConfig = body.config ?? {};

    if (type === "effect") {
      const sanitized = sanitizeEffectConfig(body.config);
      if (!sanitized.src) {
        throw badRequest("URL sumber (src) wajib diisi untuk profile effect");
      }
      normalizedConfig = sanitized.config;
      const price = Math.floor(Number(body.priceExp ?? 0));
      if (!Number.isFinite(price) || price <= 0) {
        throw badRequest("Harga EXP (priceExp) wajib > 0 untuk profile effect");
      }
    }

    const data = cleanDecorationData({
      ...body,
      name,
      type,
      config: normalizedConfig,
    });
    try {
      const createdDecoration = await prisma.decoration.create({
        data: data as unknown as Prisma.DecorationUncheckedCreateInput,
      });
      const decoration = await adminDecorationWithCount(createdDecoration.id);
      if (!decoration) throw notFound("Decoration tidak ditemukan");
      return created(reply, { data: decoration });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw badRequest("Asset sudah dipakai decoration lain");
      }
      throw error;
    }
  });

  app.put("/decorations/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as DecorationBody;
    const ownerUserIds = await decorationOwnerUserIds(id);

    // Cek tipe existing untuk validasi config khusus effect.
    const existing = await prisma.decoration.findUnique({
      where: { id },
      select: { type: true },
    });
    if (!existing) throw notFound("Decoration tidak ditemukan");

    const targetType = body.type
      ? normalizeDecorationType(body.type)
      : normalizeDecorationType(existing.type);

    let payload: DecorationBody = { ...body };
    if (targetType === "effect" && body.config !== undefined) {
      const sanitized = sanitizeEffectConfig(body.config);
      payload = { ...payload, config: sanitized.config };
      if (body.config && !sanitized.src) {
        throw badRequest("URL sumber (src) wajib diisi untuk profile effect");
      }
    }

    try {
      const updatedDecoration = await prisma.decoration.update({
        where: { id },
        data: cleanDecorationData(payload),
      });
      const decoration = await adminDecorationWithCount(updatedDecoration.id);
      if (!decoration) throw notFound("Decoration tidak ditemukan");
      await CacheInvalidator.onPublicUsersChange(ownerUserIds);
      return ok(reply, { data: decoration });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw badRequest("Asset sudah dipakai decoration lain");
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2025"
      ) {
        throw notFound("Decoration tidak ditemukan");
      }
      throw error;
    }
  });

  app.delete("/decorations/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const ownerUserIds = await decorationOwnerUserIds(id);
    try {
      await prisma.decoration.delete({ where: { id } });
      await CacheInvalidator.onPublicUsersChange(ownerUserIds);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2025"
      ) {
        throw notFound("Decoration tidak ditemukan");
      }
      throw error;
    }
    return ok(reply, { data: { message: "deleted" } });
  });

  app.get("/reactions/stats", async (_request, reply) => {
    const [topLiked, topDisliked, sum] = await Promise.all([
      prisma.episode.findMany({
        orderBy: { likes: "desc" },
        take: 10,
        include: { anime: { select: { title: true } } },
      }),
      prisma.episode.findMany({
        orderBy: { dislikes: "desc" },
        take: 10,
        include: { anime: { select: { title: true } } },
      }),
      prisma.episode.aggregate({ _sum: { likes: true, dislikes: true } }),
    ]);

    return ok(reply, {
      data: {
        topLiked: topLiked.map((item) => ({
          episodeTitle: item.title,
          animeTitle: item.anime.title,
          likeCount: item.likes,
        })),
        topDisliked: topDisliked.map((item) => ({
          episodeTitle: item.title,
          animeTitle: item.anime.title,
          dislikeCount: item.dislikes,
        })),
        totalLikes: sum._sum.likes ?? 0,
        totalDislikes: sum._sum.dislikes ?? 0,
      },
    });
  });

  // ── GET /admin/notification-stats ─────────────────────────────────────────
  app.get("/notification-stats", async (_request, reply) => {
    const sevenDaysAgo = weekStart();
    const [totalSent, totalRead, recentRecipients, reviewStats] =
      await Promise.all([
        prisma.notificationRecipient.count(),
        prisma.notificationRecipient.count({ where: { isRead: true } }),
        prisma.notificationRecipient.findMany({
          where: { createdAt: { gte: sevenDaysAgo } },
          select: { createdAt: true, isRead: true },
        }),
        prisma.animeReview.aggregate({
          _count: { id: true },
          _avg: { rating: true },
        }),
      ]);

    const sentByDay = Array.from({ length: 7 }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - (6 - i));
      const key = date.toISOString().slice(0, 10);
      const dayItems = recentRecipients.filter(
        (r) => r.createdAt.toISOString().slice(0, 10) === key,
      );
      return {
        date: key,
        sent: dayItems.length,
        read: dayItems.filter((r) => r.isRead).length,
      };
    });

    return ok(reply, {
      data: {
        totalSent,
        totalRead,
        readRate:
          totalSent > 0 ? Math.round((totalRead / totalSent) * 1000) / 10 : 0,
        sentByDay,
        totalReviews: reviewStats._count.id,
        avgRating: reviewStats._avg.rating
          ? Math.round(reviewStats._avg.rating * 10) / 10
          : null,
      },
    });
  });

  // ── GET /admin/comment-reports ────────────────────────────────────────────
  app.get<{
    Querystring: { page?: string; limit?: string; status?: string };
  }>("/comment-reports", async (request, reply) => {
    const page = Math.max(1, Number(request.query.page) || 1);
    const limit = Math.min(Math.max(1, Number(request.query.limit) || 20), 100);
    const skip = (page - 1) * limit;
    const status = request.query.status as
      | "pending"
      | "resolved"
      | "dismissed"
      | undefined;

    const where = status ? { status } : {};

    const [total, reports] = await Promise.all([
      prisma.commentReport.count({ where }),
      prisma.commentReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          reporter: { select: { id: true, username: true, fullName: true, avatar: true } },
          resolvedBy: { select: { id: true, username: true, fullName: true } },
          comment: {
            select: {
              id: true,
              content: true,
              deletedAt: true,
              user: { select: { id: true, username: true, fullName: true } },
            },
          },
        },
      }),
    ]);

    // Count by status for badge display
    const statusCounts = await prisma.commentReport.groupBy({
      by: ["status"],
      _count: { id: true },
    });
    const counts = { pending: 0, resolved: 0, dismissed: 0 } as Record<
      string,
      number
    >;
    for (const row of statusCounts) counts[row.status] = row._count.id;

    return ok(reply, {
      data: { reports, total, page, limit, counts },
    });
  });

  // ── PATCH /admin/comment-reports/:id ─────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: { status?: "resolved" | "dismissed"; deleteComment?: boolean };
  }>("/comment-reports/:id", async (request, reply) => {
    const reportId = Number(request.params.id);
    if (!Number.isFinite(reportId) || reportId <= 0) {
      return reply.code(400).send({ error: "id tidak valid" });
    }

    const { status, deleteComment } = request.body ?? {};
    if (!status || !["resolved", "dismissed"].includes(status)) {
      return reply
        .code(400)
        .send({ error: "status harus resolved atau dismissed" });
    }

    const report = await prisma.commentReport.findUnique({
      where: { id: reportId },
    });
    if (!report)
      return reply.code(404).send({ error: "Laporan tidak ditemukan" });

    const adminId = (request.user as { id: number }).id;

    await prisma.commentReport.update({
      where: { id: reportId },
      data: {
        status,
        resolvedAt: new Date(),
        resolvedById: adminId,
      },
    });

    // Optionally soft-delete the reported comment
    if (deleteComment && status === "resolved") {
      await prisma.comment.update({
        where: { id: report.commentId },
        data: { deletedAt: new Date(), content: null },
      });
    }

    return ok(reply, { data: null, message: `Laporan ${status}` });
  });

  // ── GET /admin/episode-reports ────────────────────────────────────────────
  app.get<{
    Querystring: { page?: string; limit?: string; status?: string; reason?: string };
  }>("/episode-reports", async (request, reply) => {
    const page = Math.max(1, Number(request.query.page) || 1);
    const limit = Math.min(Math.max(1, Number(request.query.limit) || 20), 100);
    const skip = (page - 1) * limit;
    const status = request.query.status as
      | "pending"
      | "resolved"
      | "dismissed"
      | undefined;
    const reason = request.query.reason as
      | "video_unavailable"
      | "playback_error"
      | "wrong_episode"
      | "audio_problem"
      | "subtitle_problem"
      | "slow_loading"
      | "other"
      | undefined;

    const where = {
      ...(status ? { status } : {}),
      ...(reason ? { reason } : {}),
    };

    const [total, reports, statusCounts] = await Promise.all([
      prisma.episodeReport.count({ where }),
      prisma.episodeReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          reporter: { select: { id: true, username: true, fullName: true, avatar: true } },
          resolvedBy: { select: { id: true, username: true, fullName: true } },
          episode: {
            select: {
              id: true,
              slug: true,
              number: true,
              title: true,
              thumbnail: true,
              status: true,
              anime: {
                select: {
                  id: true,
                  slug: true,
                  title: true,
                  thumbnail: true,
                },
              },
              servers: {
                select: { id: true, label: true, isPrimary: true },
                orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
              },
            },
          },
        },
      }),
      prisma.episodeReport.groupBy({
        by: ["status"],
        _count: { id: true },
      }),
    ]);

    const counts = { pending: 0, resolved: 0, dismissed: 0 } as Record<
      string,
      number
    >;
    for (const row of statusCounts) counts[row.status] = row._count.id;

    return ok(reply, {
      data: { reports, total, page, limit, counts },
    });
  });

  // ── PATCH /admin/episode-reports/:id ─────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: { status?: "resolved" | "dismissed"; note?: string };
  }>("/episode-reports/:id", async (request, reply) => {
    const reportId = Number(request.params.id);
    if (!Number.isFinite(reportId) || reportId <= 0) {
      return reply.code(400).send({ error: "id tidak valid" });
    }

    const { status } = request.body ?? {};
    if (!status || !["resolved", "dismissed"].includes(status)) {
      return reply
        .code(400)
        .send({ error: "status harus resolved atau dismissed" });
    }

    const report = await prisma.episodeReport.findUnique({
      where: { id: reportId },
      select: { id: true },
    });
    if (!report)
      return reply.code(404).send({ error: "Laporan tidak ditemukan" });

    const adminId = (request.user as { id: number }).id;

    await prisma.episodeReport.update({
      where: { id: reportId },
      data: {
        status,
        resolvedAt: new Date(),
        resolvedById: adminId,
      },
    });

    return ok(reply, { data: null, message: `Laporan episode ${status}` });
  });
};

export default adminRoutes;
