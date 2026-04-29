import type { FastifyPluginAsync } from "fastify";
import { CACHE_KEYS, CACHE_TTL, getOrSetCache } from "../../lib/cache";
import { prisma } from "../../lib/prisma";
import {
  calculateLevel,
  getCultivationBadge,
  getLevelProgress,
} from "../../services/exp.service";
import { getEquippedDecorations } from "../../services/decoration.service";
import { getProfileStats } from "../../services/user-profile.service";
import { badRequest, notFound } from "../../utils/http-error";
import { ok, paginated } from "../../utils/response";

const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  avatar: true,
  isVerified: true,
  exp: true,
  level: true,
  lastExpGainAt: true,
  createdAt: true,
} as const;

function parseUserId(value: unknown) {
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) {
    throw badRequest("User ID tidak valid");
  }
  return id;
}

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

async function ensureUserExists(userId: number) {
  const exists = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!exists) throw notFound("User tidak ditemukan");
}

export const usersRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/search",
    async (request, reply) => {
      const q = (request.query.q ?? "").trim();
      const limit = Math.min(toPositiveInt(request.query.limit, 8), 12);

      if (q.length < 2) {
        return ok(reply, { message: "Users search fetched", data: [] });
      }

      const users = await prisma.user.findMany({
        where: {
          username: { contains: q },
        },
        orderBy: [{ isVerified: "desc" }, { username: "asc" }],
        take: limit,
        select: {
          id: true,
          username: true,
          avatar: true,
          isVerified: true,
        },
      });

      return ok(reply, { message: "Users search fetched", data: users });
    },
  );

  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const userId = parseUserId(request.params.id);

    const data = await getOrSetCache(
      CACHE_KEYS.publicUser(userId),
      CACHE_TTL.PUBLIC_USER,
      async () => {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: PUBLIC_USER_SELECT,
        });

        if (!user) throw notFound("User tidak ditemukan");

        const exp = user.exp ?? 0;
        const level = user.level ?? calculateLevel(exp);
        const [equipped, profileStats] = await Promise.all([
          getEquippedDecorations(user.id),
          getProfileStats(user.id),
        ]);

        return {
          id: user.id,
          username: user.username,
          avatar: user.avatar,
          isVerified: Boolean(user.isVerified),
          exp,
          level,
          lastExpGainAt: user.lastExpGainAt,
          badge: getCultivationBadge(level),
          levelProgress: getLevelProgress(exp, level),
          profileStats,
          frame: equipped.frame,
          nametag: equipped.nametag,
          effects: equipped.effects ?? [],
          createdAt: user.createdAt,
        };
      },
    );

    return ok(reply, { message: "Public user fetched", data });
  });

  app.get<{ Params: { id: string }; Querystring: { page?: string; limit?: string } }>(
    "/:id/history",
    async (request, reply) => {
      const userId = parseUserId(request.params.id);
      await ensureUserExists(userId);

      const page = toPositiveInt(request.query.page, 1);
      const limit = Math.min(toPositiveInt(request.query.limit, 20), 50);

      const { items, total } = await getOrSetCache(
        CACHE_KEYS.publicUserHistory(userId, page, limit),
        CACHE_TTL.PUBLIC_USER_ACTIVITY,
        async () => {
          const skip = (page - 1) * limit;
          const where = { userId };
          const [total, items] = await Promise.all([
            prisma.watchHistory.count({ where }),
            prisma.watchHistory.findMany({
              where,
              orderBy: { watchedAt: "desc" },
              skip,
              take: limit,
              select: {
                id: true,
                animeId: true,
                animeSlug: true,
                animeTitle: true,
                animeThumbnail: true,
                episodeId: true,
                episodeSlug: true,
                episodeNumber: true,
                episodeTitle: true,
                progressSec: true,
                durationSec: true,
                progressPct: true,
                watchedAt: true,
              },
            }),
          ]);
          return { items, total };
        },
      );

      return paginated(reply, {
        items,
        page,
        limit,
        total,
        message: "Public watch history fetched",
      });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { page?: string; limit?: string } }>(
    "/:id/saved",
    async (request, reply) => {
      const userId = parseUserId(request.params.id);
      await ensureUserExists(userId);

      const page = toPositiveInt(request.query.page, 1);
      const limit = Math.min(toPositiveInt(request.query.limit, 20), 50);

      const { items, total } = await getOrSetCache(
        CACHE_KEYS.publicUserSaved(userId, page, limit),
        CACHE_TTL.PUBLIC_USER_ACTIVITY,
        async () => {
          const skip = (page - 1) * limit;
          const where = { userId };
          const [total, items] = await Promise.all([
            prisma.savedAnime.count({ where }),
            prisma.savedAnime.findMany({
              where,
              orderBy: { savedAt: "desc" },
              skip,
              take: limit,
              select: {
                id: true,
                animeId: true,
                animeSlug: true,
                animeTitle: true,
                animeThumbnail: true,
                animeStatus: true,
                savedAt: true,
              },
            }),
          ]);
          return { items, total };
        },
      );

      return paginated(reply, {
        items,
        page,
        limit,
        total,
        message: "Public saved anime fetched",
      });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { page?: string; limit?: string } }>(
    "/:id/comments",
    async (request, reply) => {
      const userId = parseUserId(request.params.id);
      await ensureUserExists(userId);

      const page = toPositiveInt(request.query.page, 1);
      const limit = Math.min(toPositiveInt(request.query.limit, 20), 50);

      const { items, total } = await getOrSetCache(
        CACHE_KEYS.publicUserComments(userId, page, limit),
        CACHE_TTL.PUBLIC_USER_ACTIVITY,
        async () => {
          const skip = (page - 1) * limit;
          const where = { userId, deletedAt: null };

          const [total, comments] = await Promise.all([
            prisma.comment.count({ where }),
            prisma.comment.findMany({
              where,
              orderBy: { createdAt: "desc" },
              skip,
              take: limit,
              select: {
                id: true,
                animeId: true,
                episodeId: true,
                content: true,
                isEdited: true,
                editedAt: true,
                parentId: true,
                createdAt: true,
                reactions: { select: { type: true } },
                _count: { select: { replies: true } },
              },
            }),
          ]);

          const animeIds = Array.from(new Set(comments.map((c) => c.animeId)));
          const episodeIds = Array.from(
            new Set(
              comments
                .map((c) => c.episodeId)
                .filter((value): value is number => typeof value === "number"),
            ),
          );

          const [animeRows, episodeRows] = await Promise.all([
            animeIds.length > 0
              ? prisma.anime.findMany({
                  where: { id: { in: animeIds } },
                  select: { id: true, slug: true, title: true, thumbnail: true },
                })
              : Promise.resolve([]),
            episodeIds.length > 0
              ? prisma.episode.findMany({
                  where: { id: { in: episodeIds } },
                  select: { id: true, slug: true, number: true, title: true },
                })
              : Promise.resolve([]),
          ]);

          const animeMap = new Map(animeRows.map((row) => [row.id, row]));
          const episodeMap = new Map(episodeRows.map((row) => [row.id, row]));

          const items = comments.map((comment) => {
            const likeCount = comment.reactions.filter((r) => r.type === "LIKE").length;
            const dislikeCount = comment.reactions.filter((r) => r.type === "DISLIKE").length;
            const anime = animeMap.get(comment.animeId) ?? null;
            const episode =
              comment.episodeId !== null && comment.episodeId !== undefined
                ? episodeMap.get(comment.episodeId) ?? null
                : null;

            return {
              id: comment.id,
              content: comment.content,
              isEdited: comment.isEdited,
              editedAt: comment.editedAt,
              parentId: comment.parentId,
              createdAt: comment.createdAt,
              likeCount,
              dislikeCount,
              replyCount: comment._count.replies,
              anime: anime
                ? {
                    id: anime.id,
                    slug: anime.slug,
                    title: anime.title,
                    thumbnail: anime.thumbnail,
                  }
                : null,
              episode: episode
                ? {
                    id: episode.id,
                    slug: episode.slug,
                    number: episode.number,
                    title: episode.title,
                  }
                : null,
            };
          });

          return { items, total };
        },
      );

      return paginated(reply, {
        items,
        page,
        limit,
        total,
        message: "Public user comments fetched",
      });
    },
  );
};

export default usersRoutes;
