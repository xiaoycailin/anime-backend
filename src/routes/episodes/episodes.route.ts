import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Prisma, ReactionType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { addExp } from "../../services/exp.service";
import { createRoleNotification } from "../../services/notification.service";
import { getEpisodeSchedule } from "../../services/episode-schedule.service";
import { ok, sendError } from "../../utils/response";
import { badRequest, notFound } from "../../utils/http-error";
import { normalizeTitle } from "../../utils/season-parser";
import {
  CACHE_KEYS,
  CACHE_TTL,
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

function formatRelativeTime(date: Date) {
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMinutes < 1) return "baru saja";
  if (diffMinutes < 60) return `${diffMinutes}m lalu`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}j lalu`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}h lalu`;
}

function buildAnimeTypeFilter(type: string): Prisma.AnimeWhereInput {
  const trimmed = type.trim();
  const lower = trimmed.toLowerCase();
  const title = lower.charAt(0).toUpperCase() + lower.slice(1);
  const variants = [...new Set([trimmed, lower, title, trimmed.toUpperCase()])];
  return { OR: variants.map((value) => ({ type: { equals: value } })) };
}

async function optionalUserId(
  app: Parameters<FastifyPluginAsync>[0],
  request: FastifyRequest,
) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;

  try {
    const payload = app.jwt.verify<{ id: number }>(
      auth.slice("Bearer ".length),
    );
    return payload.id;
  } catch {
    return null;
  }
}

function reactionPayload(input: {
  episode: { likes: number; dislikes: number };
  userReaction: ReactionType | null;
}) {
  return {
    liked: input.userReaction === "LIKE",
    disliked: input.userReaction === "DISLIKE",
    likeCount: input.episode.likes,
    dislikeCount: input.episode.dislikes,
    userReaction: input.userReaction,
  };
}

export const episodesRoutes: FastifyPluginAsync = async (app) => {
  const VALID_REPORT_REASONS = [
    "video_unavailable",
    "playback_error",
    "wrong_episode",
    "audio_problem",
    "subtitle_problem",
    "slow_loading",
    "other",
  ] as const;

  app.get("/latest", async (request, reply) => {
    const query = request.query as { limit?: string; type?: string };
    const limit = Math.min(toPositiveInt(query.limit, 10), 50);
    const type = query.type?.trim();
    const normalizedType = type ? type.toLowerCase() : "all";
    const cacheKey = CACHE_KEYS.latestEpisodes(limit, normalizedType);
    const where: Prisma.EpisodeWhereInput = type
      ? { anime: buildAnimeTypeFilter(type) }
      : {};

    try {
      setPublicCache(reply, PUBLIC_CACHE.FAST);
      type LatestItem = {
        id: number;
        title: string;
        episode: string;
        time: string;
        thumbnail: string | null;
        href: string;
        animeType: string | null;
        totalEpisodes: number | null;
        episodeCount: number;
      };

      const cached = await getCache<LatestItem[]>(cacheKey);
      if (cached) {
        return ok(reply, {
          message: "Latest episodes fetched successfully",
          data: cached,
          meta: { limit, type: type ?? null, cache: "hit" },
        });
      }

      const episodes = await prisma.episode.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        distinct: ["animeId"],
        take: limit,
        select: {
          id: true,
          animeId: true,
          number: true,
          date: true,
          createdAt: true,
          slug: true,
          thumbnail: true,
          anime: {
            select: {
              slug: true,
              title: true,
              thumbnail: true,
              updatedAt: true,
              type: true,
              totalEpisodes: true,
              _count: {
                select: {
                  episodes: true,
                },
              },
            },
          },
        },
      });

      const data: LatestItem[] = episodes.map((item) => ({
        id: item.id,
        title: normalizeTitle(item.anime.title),
        episode: `Ep ${item.number}`,
        time:
          formatRelativeTime(item.createdAt) ||
          formatRelativeTime(item.anime.updatedAt),
        thumbnail: item.thumbnail ?? item.anime.thumbnail,
        href:
          item.anime.type?.toLowerCase() === "short"
            ? `/short/${item.anime.slug}/${item.slug}`
            : `/anime/${item.anime.slug}/${item.slug}`,
        animeType: item.anime.type,
        totalEpisodes: item.anime.totalEpisodes,
        episodeCount: item.anime._count.episodes,
      }));

      await setCache(cacheKey, data, CACHE_TTL.LATEST_EPISODES);

      return ok(reply, {
        message: "Latest episodes fetched successfully",
        data,
        meta: { limit, type: type ?? null, cache: "miss" },
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch latest episodes",
        errorCode: "LATEST_EPISODES_FETCH_FAILED",
      });
    }
  });

  app.get("/schedule", async (request, reply) => {
    try {
      const result = await getEpisodeSchedule(request.query as Record<string, string>);
      return ok(reply, {
        message: "Episode schedule fetched successfully",
        data: result.data,
        meta: result.meta,
      });
    } catch (error) {
      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch episode schedule",
        errorCode: "EPISODE_SCHEDULE_FETCH_FAILED",
      });
    }
  });

  app.post("/:episodeId/view", async (request, reply) => {
    const params = request.params as { episodeId: string };
    const episodeId = Number(params.episodeId);

    if (!Number.isFinite(episodeId) || episodeId <= 0) {
      throw badRequest("episodeId tidak valid");
    }

    const episode = await prisma.episode.update({
      where: { id: episodeId },
      data: {
        views: {
          increment: 1,
        },
      },
      select: {
        id: true,
        slug: true,
        views: true,
        anime: {
          select: {
            slug: true,
          },
        },
      },
    });

    await setCacheField<Record<string, unknown>>(
      CACHE_KEYS.episodeDetail(episode.anime.slug, episode.slug),
      { views: episode.views },
      CACHE_TTL.EPISODE_DETAIL,
    );

    return ok(reply, {
      message: "Episode view recorded successfully",
      data: {
        id: episode.id,
        views: episode.views,
      },
    });
  });

  app.get("/:episodeId/reaction", async (request, reply) => {
    const params = request.params as { episodeId: string };
    const episodeId = Number(params.episodeId);

    if (!Number.isFinite(episodeId) || episodeId <= 0) {
      throw badRequest("episodeId tidak valid");
    }

    const userId = await optionalUserId(app, request);
    const [episode, existing] = await Promise.all([
      prisma.episode.findUnique({
        where: { id: episodeId },
        select: {
          likes: true,
          dislikes: true,
        },
      }),
      userId
        ? prisma.episodeReaction.findUnique({
            where: {
              userId_episodeId: {
                userId,
                episodeId,
              },
            },
            select: {
              type: true,
            },
          })
        : Promise.resolve(null),
    ]);

    if (!episode) throw notFound("Episode tidak ditemukan");

    return ok(reply, {
      message: "Episode reaction fetched successfully",
      data: reactionPayload({
        episode,
        userReaction: existing?.type ?? null,
      }),
    });
  });

  app.post(
    "/:episodeId/react",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const params = request.params as { episodeId: string };
      const body = request.body as { type?: ReactionType };
      const episodeId = Number(params.episodeId);
      const type = body.type;
      const userId = request.user.id;

      if (!Number.isFinite(episodeId) || episodeId <= 0) {
        throw badRequest("episodeId tidak valid");
      }

      if (type !== "LIKE" && type !== "DISLIKE") {
        throw badRequest("Reaction type tidak valid");
      }

      const episode = await prisma.episode.findUnique({
        where: { id: episodeId },
        select: { id: true },
      });

      if (!episode) throw notFound("Episode tidak ditemukan");

      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.episodeReaction.findUnique({
          where: {
            userId_episodeId: {
              userId,
              episodeId,
            },
          },
        });

        let userReaction: ReactionType | null = type;

        if (!existing) {
          await tx.episodeReaction.create({
            data: {
              userId,
              episodeId,
              type,
            },
          });

          await tx.episode.update({
            where: { id: episodeId },
            data:
              type === "LIKE"
                ? { likes: { increment: 1 } }
                : { dislikes: { increment: 1 } },
          });
        } else if (existing.type === type) {
          await tx.episodeReaction.delete({ where: { id: existing.id } });

          await tx.episode.update({
            where: { id: episodeId },
            data:
              type === "LIKE"
                ? { likes: { decrement: 1 } }
                : { dislikes: { decrement: 1 } },
          });

          userReaction = null;
        } else {
          await tx.episodeReaction.update({
            where: { id: existing.id },
            data: { type },
          });

          await tx.episode.update({
            where: { id: episodeId },
            data:
              type === "LIKE"
                ? {
                    likes: { increment: 1 },
                    dislikes: { decrement: 1 },
                  }
                : {
                    likes: { decrement: 1 },
                    dislikes: { increment: 1 },
                  },
          });
        }

        const updated = await tx.episode.findUniqueOrThrow({
          where: { id: episodeId },
          select: {
            likes: true,
            dislikes: true,
          },
        });

        return reactionPayload({
          episode: updated,
          userReaction,
        });
      });

      const exp =
        result.userReaction === "LIKE"
          ? await addExp(userId, "episode_like", 50, `episode:${episodeId}`)
          : null;

      return ok(reply, {
        message: "Episode reaction updated successfully",
        data: result,
        meta: { exp },
      });
    },
  );

  app.post("/:episodeId/report", async (request, reply) => {
    const params = request.params as { episodeId: string };
    const body = (request.body ?? {}) as {
      reason?: string;
      description?: string;
      contact?: string;
      pageUrl?: string;
      serverLabel?: string;
      deviceId?: string;
    };
    const episodeId = Number(params.episodeId);

    if (!Number.isFinite(episodeId) || episodeId <= 0) {
      throw badRequest("episodeId tidak valid");
    }

    if (
      !body.reason ||
      !VALID_REPORT_REASONS.includes(
        body.reason as (typeof VALID_REPORT_REASONS)[number],
      )
    ) {
      throw badRequest(
        `reason harus salah satu dari: ${VALID_REPORT_REASONS.join(", ")}`,
      );
    }

    const reporterId = await optionalUserId(app, request);
    const [episode, existing] = await Promise.all([
      prisma.episode.findUnique({
        where: { id: episodeId },
        select: {
          id: true,
          number: true,
          title: true,
          slug: true,
          anime: {
            select: {
              slug: true,
              title: true,
              thumbnail: true,
            },
          },
        },
      }),
      reporterId
        ? prisma.episodeReport.findFirst({
            where: {
              reporterId,
              episodeId,
              reason: body.reason as (typeof VALID_REPORT_REASONS)[number],
              status: "pending",
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    if (!episode) throw notFound("Episode tidak ditemukan");
    if (existing) throw badRequest("Kamu sudah pernah mengirim laporan yang sama");

    const description = body.description
      ? String(body.description).trim().slice(0, 800)
      : "";
    const contact = body.contact ? String(body.contact).trim().slice(0, 191) : "";
    const pageUrl = body.pageUrl ? String(body.pageUrl).trim().slice(0, 1000) : "";
    const serverLabel = body.serverLabel
      ? String(body.serverLabel).trim().slice(0, 120)
      : "";
    const deviceId = body.deviceId
      ? String(body.deviceId).trim().slice(0, 191)
      : "";

    const report = await prisma.episodeReport.create({
      data: {
        reporterId,
        deviceId: deviceId || null,
        episodeId,
        reason: body.reason as (typeof VALID_REPORT_REASONS)[number],
        description: description || null,
        contact: contact || null,
        pageUrl: pageUrl || null,
        serverLabel: serverLabel || null,
      },
      select: { id: true },
    });

    await createRoleNotification({
      role: "admin",
      category: "admin_operational",
      type: "episode_broken_report",
      title: "Laporan episode rusak",
      message: `${episode.anime.title} Ep ${episode.number} dilaporkan bermasalah.`,
      link: "/admin/episode-reports",
      image: episode.anime.thumbnail,
      payload: {
        reportId: report.id,
        episodeId,
        animeSlug: episode.anime.slug,
        episodeSlug: episode.slug,
        reason: body.reason,
      },
    }).catch((error) => request.log.error(error));

    return ok(reply, {
      data: { id: report.id },
      message: "Laporan berhasil dikirim, admin akan cek episode ini.",
    });
  });
};
