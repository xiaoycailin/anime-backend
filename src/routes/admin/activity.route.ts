import { Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../lib/prisma";
import {
  activityPresenceConfig,
  getActivityPresenceSnapshot,
  isActivityOnline,
} from "../../services/activity-presence.service";

type ActivityQuery = {
  q?: string;
  onlineOnly?: string;
  limit?: string;
};

function clampLimit(value?: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 40;
  return Math.min(Math.max(Math.trunc(parsed), 10), 100);
}

function searchWhere(q?: string): Prisma.UserWhereInput | undefined {
  const keyword = q?.trim();
  if (!keyword) return undefined;

  return {
    OR: [
      { username: { contains: keyword } },
      { fullName: { contains: keyword } },
      { email: { contains: keyword } },
    ],
  };
}

function groupByUser<T extends { userId: number }>(items: T[], limit: number) {
  const grouped = new Map<number, T[]>();
  for (const item of items) {
    const list = grouped.get(item.userId) ?? [];
    if (list.length < limit) list.push(item);
    grouped.set(item.userId, list);
  }
  return grouped;
}

const adminActivityRoute: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.get<{ Querystring: ActivityQuery }>("/users", async (request, reply) => {
    const limit = clampLimit(request.query.limit);
    const onlineOnly = request.query.onlineOnly === "true";
    const presence = getActivityPresenceSnapshot();
    const onlineIds = presence
      .filter((item) => isActivityOnline(item.lastSeenAt))
      .map((item) => item.userId);

    const [recentHistory, recentSaved, recentComments] = await Promise.all([
      prisma.watchHistory.findMany({
        orderBy: { updatedAt: "desc" },
        take: limit * 3,
        select: { userId: true },
      }),
      prisma.savedAnime.findMany({
        orderBy: { savedAt: "desc" },
        take: limit * 2,
        select: { userId: true },
      }),
      prisma.comment.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: limit * 2,
        select: { userId: true },
      }),
    ]);

    const candidateIds = [
      ...presence.map((item) => item.userId),
      ...recentHistory.map((item) => item.userId),
      ...recentSaved.map((item) => item.userId),
      ...recentComments.map((item) => item.userId),
    ];
    const uniqueIds = [...new Set(candidateIds)].slice(0, limit * 2);
    const where = searchWhere(request.query.q);

    const users = await prisma.user.findMany({
      where: {
        AND: [
          where ?? {},
          onlineOnly ? { id: { in: onlineIds.length ? onlineIds : [-1] } } : {},
          uniqueIds.length && !where ? { id: { in: uniqueIds } } : {},
        ],
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        avatar: true,
        role: true,
        createdAt: true,
        _count: {
          select: { watchHistory: true, savedAnime: true, comments: true },
        },
      },
    });

    const userIds = users.map((user) => user.id);
    const [histories, saved, comments] = await Promise.all([
      prisma.watchHistory.findMany({
        where: { userId: { in: userIds } },
        orderBy: { updatedAt: "desc" },
        take: userIds.length * 5,
      }),
      prisma.savedAnime.findMany({
        where: { userId: { in: userIds } },
        orderBy: { savedAt: "desc" },
        take: userIds.length * 4,
      }),
      prisma.comment.findMany({
        where: { userId: { in: userIds }, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: userIds.length * 2,
        select: {
          id: true,
          userId: true,
          animeId: true,
          episodeId: true,
          content: true,
          createdAt: true,
        },
      }),
    ]);

    const presenceByUser = new Map(presence.map((item) => [item.userId, item]));
    const historyByUser = groupByUser(histories, 5);
    const savedByUser = groupByUser(saved, 4);
    const commentsByUser = groupByUser(comments, 2);

    const animeIds = [...new Set(comments.map((item) => item.animeId))];
    const episodeIds = [
      ...new Set(comments.map((item) => item.episodeId).filter(Boolean) as number[]),
    ];
    const [animeRows, episodeRows] = await Promise.all([
      animeIds.length
        ? prisma.anime.findMany({
            where: { id: { in: animeIds } },
            select: { id: true, title: true, slug: true },
          })
        : [],
      episodeIds.length
        ? prisma.episode.findMany({
            where: { id: { in: episodeIds } },
            select: { id: true, title: true, slug: true, number: true },
          })
        : [],
    ]);

    const animeById = new Map(animeRows.map((item) => [item.id, item]));
    const episodeById = new Map(episodeRows.map((item) => [item.id, item]));
    const rows = users
      .map((user) => {
        const userPresence = presenceByUser.get(user.id);
        const lastSeenAt = userPresence?.lastSeenAt ?? null;
        const lastComments = commentsByUser.get(user.id) ?? [];

        return {
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            fullName: user.fullName,
            avatar: user.avatar,
            role: user.role,
            createdAt: user.createdAt,
          },
          online: isActivityOnline(lastSeenAt),
          lastSeenAt,
          current: userPresence
            ? {
                path: userPresence.path,
                title: userPresence.title,
                watching: userPresence.watching,
              }
            : null,
          counts: {
            history: user._count.watchHistory,
            saved: user._count.savedAnime,
            comments: user._count.comments,
          },
          lastComment: lastComments[0]
            ? {
                ...lastComments[0],
                anime: animeById.get(lastComments[0].animeId) ?? null,
                episode: lastComments[0].episodeId
                  ? episodeById.get(lastComments[0].episodeId) ?? null
                  : null,
              }
            : null,
          recentSaved: savedByUser.get(user.id) ?? [],
          recentHistory: historyByUser.get(user.id) ?? [],
        };
      })
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return (
          new Date(b.lastSeenAt ?? 0).getTime() -
          new Date(a.lastSeenAt ?? 0).getTime()
        );
      });

    return reply.send({
      status: 200,
      message: null,
      errorCode: null,
      data: {
        rows,
        summary: {
          online: rows.filter((item) => item.online).length,
          watching: rows.filter((item) => item.current?.watching).length,
          tracked: rows.length,
          pollingSeconds: 60,
          ...activityPresenceConfig(),
        },
      },
    });
  });
};

export default adminActivityRoute;
