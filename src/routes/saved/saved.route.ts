import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../lib/prisma";
import { created, ok, paginated } from "../../utils/response";

type SavedBody = {
  animeId?: number;
  animeSlug?: string;
  animeTitle?: string;
  animeThumbnail?: string;
  animeStatus?: string;
};

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export const savedRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request, reply) => {
    const query = request.query as { page?: string; limit?: string };
    const page = toPositiveInt(query.page, 1);
    const limit = Math.min(toPositiveInt(query.limit, 20), 100);
    const skip = (page - 1) * limit;
    const where = { userId: request.user.id };

    const [total, items] = await Promise.all([
      prisma.savedAnime.count({ where }),
      prisma.savedAnime.findMany({
        where,
        orderBy: { savedAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return paginated(reply, {
      items,
      page,
      limit,
      total,
      message: "Saved anime fetched successfully",
    });
  });

  app.post("/", async (request, reply) => {
    const body = request.body as SavedBody;
    const item = await prisma.savedAnime.upsert({
      where: {
        userId_animeId: {
          userId: request.user.id,
          animeId: Number(body.animeId),
        },
      },
      create: {
        userId: request.user.id,
        animeId: Number(body.animeId),
        animeSlug: body.animeSlug ?? "",
        animeTitle: body.animeTitle ?? "",
        animeThumbnail: body.animeThumbnail ?? "",
        animeStatus: body.animeStatus ?? "Ongoing",
      },
      update: {
        animeSlug: body.animeSlug,
        animeTitle: body.animeTitle,
        animeThumbnail: body.animeThumbnail,
        animeStatus: body.animeStatus,
        savedAt: new Date(),
      },
    });

    return created(reply, {
      message: "Anime saved successfully",
      data: item,
    });
  });

  app.delete("/:animeId", async (request, reply) => {
    const params = request.params as { animeId: string };
    await prisma.savedAnime.deleteMany({
      where: {
        userId: request.user.id,
        animeId: Number(params.animeId),
      },
    });

    return ok(reply, { message: "removed", data: { message: "removed" } });
  });

  app.get("/:animeId/check", async (request, reply) => {
    const params = request.params as { animeId: string };
    const count = await prisma.savedAnime.count({
      where: {
        userId: request.user.id,
        animeId: Number(params.animeId),
      },
    });

    return ok(reply, {
      message: "Saved anime checked",
      data: { saved: count > 0 },
    });
  });
};

export default savedRoutes;
