import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../lib/prisma";
import { grantWatchExp } from "../../services/exp.service";
import { badRequest } from "../../utils/http-error";
import { ok, paginated } from "../../utils/response";

type HistoryBody = {
  animeId?: number;
  animeSlug?: string;
  animeTitle?: string;
  animeThumbnail?: string;
  episodeId?: number;
  episodeSlug?: string;
  episodeNumber?: number;
  episodeTitle?: string;
  progressSec?: number;
  durationSec?: number;
};

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function pct(progressSec: number, durationSec: number) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.min(100, Math.max(0, (progressSec / durationSec) * 100));
}

function toSafeSeconds(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export const historyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request, reply) => {
    const query = request.query as { page?: string; limit?: string };
    const page = toPositiveInt(query.page, 1);
    const limit = Math.min(toPositiveInt(query.limit, 20), 100);
    const skip = (page - 1) * limit;

    const where = { userId: request.user.id };
    const [total, items] = await Promise.all([
      prisma.watchHistory.count({ where }),
      prisma.watchHistory.findMany({
        where,
        orderBy: { watchedAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return paginated(reply, {
      items,
      page,
      limit,
      total,
      message: "Watch history fetched successfully",
    });
  });

  app.post("/upsert", async (request, reply) => {
    const body = request.body as HistoryBody;
    const episodeId = Number(body.episodeId);
    const progressSec = toSafeSeconds(body.progressSec);
    const durationSec = toSafeSeconds(body.durationSec);

    if (!Number.isFinite(episodeId) || episodeId <= 0) {
      throw badRequest("episodeId tidak valid");
    }

    const previous = await prisma.watchHistory.findUnique({
      where: {
        userId_episodeId: {
          userId: request.user.id,
          episodeId,
        },
      },
      select: {
        progressSec: true,
      },
    });

    const item = await prisma.watchHistory.upsert({
      where: {
        userId_episodeId: {
          userId: request.user.id,
          episodeId,
        },
      },
      create: {
        userId: request.user.id,
        animeId: Number(body.animeId),
        animeSlug: body.animeSlug ?? "",
        animeTitle: body.animeTitle ?? "",
        animeThumbnail: body.animeThumbnail ?? "",
        episodeId,
        episodeSlug: body.episodeSlug ?? "",
        episodeNumber: Number(body.episodeNumber ?? 0),
        episodeTitle: body.episodeTitle ?? "",
        progressSec,
        durationSec,
        progressPct: pct(progressSec, durationSec),
        watchedAt: new Date(),
      },
      update: {
        animeTitle: body.animeTitle,
        animeThumbnail: body.animeThumbnail,
        episodeTitle: body.episodeTitle,
        progressSec,
        durationSec,
        progressPct: pct(progressSec, durationSec),
        watchedAt: new Date(),
      },
    });

    const exp = await grantWatchExp({
      userId: request.user.id,
      episodeId,
      progressSec,
      durationSec,
      previousProgressSec: previous?.progressSec ?? 0,
    });

    return ok(reply, {
      message: "Watch history saved successfully",
      data: item,
      meta: { exp },
    });
  });

  app.get("/:episodeId", async (request, reply) => {
    const params = request.params as { episodeId: string };
    const item = await prisma.watchHistory.findUnique({
      where: {
        userId_episodeId: {
          userId: request.user.id,
          episodeId: Number(params.episodeId),
        },
      },
    });

    return ok(reply, { message: "Watch history fetched", data: item });
  });

  app.delete("/:episodeId", async (request, reply) => {
    const params = request.params as { episodeId: string };
    await prisma.watchHistory.deleteMany({
      where: {
        userId: request.user.id,
        episodeId: Number(params.episodeId),
      },
    });

    return ok(reply, { message: "deleted", data: { message: "deleted" } });
  });

  app.delete("/", async (request, reply) => {
    await prisma.watchHistory.deleteMany({
      where: { userId: request.user.id },
    });

    return ok(reply, { message: "cleared", data: { message: "cleared" } });
  });
};

export default historyRoutes;
