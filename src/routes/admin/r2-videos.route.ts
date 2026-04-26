import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../lib/prisma";
import { CacheInvalidator } from "../../lib/cache";
import { badRequest } from "../../utils/http-error";
import { ok } from "../../utils/response";
import {
  deleteStreamingVideo,
  listStreamingVideos,
  type StreamingVideoSummary,
} from "../../utils/r2-streaming";

type ListQuery = {
  cursor?: string;
  limit?: string;
};

type DeleteQuery = {
  detachServers?: string;
};

type LinkedServer = {
  id: number;
  episodeId: number;
  isPrimary: boolean;
  episode: {
    id: number;
    slug: string;
    number: number;
    title: string;
    anime: {
      id: number;
      slug: string;
      title: string;
    };
  };
};

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{6,120}$/;

function videoNeedle(videoId: string) {
  return `/videos/${videoId}/`;
}

function videoWhere(videoIds: string[]) {
  return {
    OR: videoIds.map((videoId) => ({
      value: { contains: videoNeedle(videoId) },
    })),
  };
}

function linkedServerSelect() {
  return {
    id: true,
    episodeId: true,
    isPrimary: true,
    episode: {
      select: {
        id: true,
        slug: true,
        number: true,
        title: true,
        anime: {
          select: {
            id: true,
            slug: true,
            title: true,
          },
        },
      },
    },
  } as const;
}

function shapeLinkedServer(server: LinkedServer) {
  return {
    id: server.id,
    episodeId: server.episodeId,
    isPrimary: server.isPrimary,
    episodeSlug: server.episode.slug,
    episodeNumber: server.episode.number,
    episodeTitle: server.episode.title,
    animeId: server.episode.anime.id,
    animeSlug: server.episode.anime.slug,
    animeTitle: server.episode.anime.title,
  };
}

function attachLinkedServers(
  videos: StreamingVideoSummary[],
  servers: LinkedServer[],
) {
  return videos.map((video) => ({
    ...video,
    linkedServers: servers
      .filter((server) => serverMatchesVideo(server, video.videoId))
      .map(shapeLinkedServer),
  }));
}

function serverMatchesVideo(server: LinkedServer, videoId: string) {
  return (server as LinkedServer & { value?: string }).value?.includes(
    videoNeedle(videoId),
  );
}

export const adminR2VideosRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.get("/", async (request, reply) => {
    const query = request.query as ListQuery;
    const limit = Math.min(50, Math.max(1, Number(query.limit ?? 20) || 20));
    const result = await listStreamingVideos({
      cursor: query.cursor || null,
      limit,
    });

    const videoIds = result.items.map((item) => item.videoId);
    const servers =
      videoIds.length > 0
        ? ((await prisma.server.findMany({
            where: videoWhere(videoIds),
            select: {
              ...linkedServerSelect(),
              value: true,
            },
          })) as unknown as LinkedServer[])
        : [];

    return ok(reply, {
      message: "R2 video list fetched",
      data: attachLinkedServers(result.items, servers),
      meta: {
        bucket: result.bucket,
        nextCursor: result.nextCursor,
        limit,
      },
    });
  });

  app.delete("/:videoId", async (request, reply) => {
    const { videoId } = request.params as { videoId: string };
    const query = request.query as DeleteQuery;
    const detachServers = query.detachServers !== "false";

    if (!VIDEO_ID_PATTERN.test(videoId)) {
      throw badRequest("videoId tidak valid");
    }

    const linkedServers = (await prisma.server.findMany({
      where: videoWhere([videoId]),
      select: {
        ...linkedServerSelect(),
        value: true,
      },
    })) as unknown as (LinkedServer & { value: string })[];

    const deleted = await deleteStreamingVideo(videoId);
    const affectedEpisodes = new Map<
      number,
      { animeSlug: string; episodeSlug: string; primaryDeleted: boolean }
    >();

    for (const server of linkedServers) {
      const existing = affectedEpisodes.get(server.episodeId);
      affectedEpisodes.set(server.episodeId, {
        animeSlug: server.episode.anime.slug,
        episodeSlug: server.episode.slug,
        primaryDeleted: Boolean(existing?.primaryDeleted || server.isPrimary),
      });
    }

    if (detachServers && linkedServers.length > 0) {
      const serverIds = linkedServers.map((server) => server.id);
      await prisma.$transaction(async (tx) => {
        await tx.server.deleteMany({ where: { id: { in: serverIds } } });

        for (const [episodeId, episode] of affectedEpisodes) {
          if (!episode.primaryDeleted) continue;

          const activePrimary = await tx.server.findFirst({
            where: { episodeId, isPrimary: true },
            select: { id: true },
          });
          if (activePrimary) continue;

          const nextServer = await tx.server.findFirst({
            where: { episodeId },
            orderBy: { id: "asc" },
            select: { id: true },
          });
          if (nextServer) {
            await tx.server.update({
              where: { id: nextServer.id },
              data: { isPrimary: true },
            });
          }
        }
      });

      await Promise.all(
        Array.from(affectedEpisodes.values()).map((episode) =>
          CacheInvalidator.onEpisodeChange(
            episode.animeSlug,
            episode.episodeSlug,
          ).catch(() => undefined),
        ),
      );
    }

    return ok(reply, {
      message: "R2 video deleted",
      data: {
        ...deleted,
        detachedServers: detachServers ? linkedServers.map(shapeLinkedServer) : [],
        detachServers,
      },
    });
  });
};
