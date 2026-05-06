import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../lib/prisma";
import { CACHE_KEYS, CACHE_TTL, setCacheField } from "../../lib/cache";
import { fetchSokujaEpisodeMirrors } from "../../services/scraper-service/scrapeSokujaAnimeList.service";
import { HttpError, badRequest, notFound } from "../../utils/http-error";
import { ok, sendError } from "../../utils/response";

type VideoMirrorBody = {
  episodeId?: number | string;
};

function normalizeLabel(label: string) {
  const quality = label.match(/(\d{3,4})\s*p/i)?.[1];
  return quality ? `${quality}P` : label.replace(/^sokuja\s*/i, "").trim() || "Server";
}

function parsePositiveInt(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export const skjRoutes: FastifyPluginAsync = async (app) => {
  app.post("/video-mirrors", async (request, reply) => {
    const body = (request.body ?? {}) as VideoMirrorBody;
    const episodeId = parsePositiveInt(body.episodeId);

    if (!episodeId) throw badRequest("episodeId tidak valid");

    try {
      const episode = await prisma.episode.findUnique({
        where: { id: episodeId },
        select: {
          id: true,
          slug: true,
          sourceProvider: true,
          sourceVideoId: true,
          anime: {
            select: {
              slug: true,
            },
          },
        },
      });

      if (!episode) throw notFound("Episode tidak ditemukan");
      if (episode.sourceProvider !== "sokuja" || !episode.sourceVideoId) {
        throw badRequest("Episode belum punya source video Sokuja");
      }

      const sourceVideoId = parsePositiveInt(episode.sourceVideoId);
      if (!sourceVideoId) throw badRequest("sourceVideoId Sokuja tidak valid");

      const referer = `https://x5.sokuja.uk/${episode.slug}/`;
      const mirrors = await fetchSokujaEpisodeMirrors(sourceVideoId, referer);
      const servers = mirrors.filter((server) => server.value);

      await prisma.$transaction(async (tx) => {
        await tx.server.deleteMany({
          where: {
            episodeId: episode.id,
            OR: [
              { value: { contains: "sokuja" } },
              { value: { contains: "storages.sokuja.id" } },
            ],
          },
        });

        if (servers.length) {
          await tx.server.createMany({
            data: servers.map((server, index) => ({
              episodeId: episode.id,
              label: normalizeLabel(server.label),
              value: server.value ?? "",
              isPrimary: server.isPrimary ?? index === 0,
            })),
          });
        }
      });

      const savedServers = await prisma.server.findMany({
        where: { episodeId: episode.id },
        orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
        select: {
          id: true,
          label: true,
          value: true,
          isPrimary: true,
        },
      });

      await setCacheField<Record<string, unknown>>(
        CACHE_KEYS.episodeDetail(episode.anime.slug, episode.slug),
        { servers: savedServers },
        CACHE_TTL.EPISODE_DETAIL,
      );

      return ok(reply, {
        message: "Sokuja video mirrors fetched",
        data: {
          servers: savedServers,
          count: savedServers.length,
        },
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return sendError(reply, {
          status: error.statusCode,
          message: error.message,
          errorCode: error.errorCode,
          data: error.details,
        });
      }

      request.log.error(error);
      return sendError(reply, {
        status: 500,
        message: "Failed to fetch Sokuja video mirrors",
        errorCode: "SOKUJA_VIDEO_MIRRORS_FAILED",
      });
    }
  });
};
