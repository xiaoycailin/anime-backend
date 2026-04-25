import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma";
import { badRequest, forbidden, notFound } from "../../utils/http-error";
import { created, ok, paginated } from "../../utils/response";

// ── Helpers ───────────────────────────────────────────────────────────────────

function toInt(v: unknown, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function clampRating(r: unknown): number {
  const n = Number(r);
  if (!Number.isFinite(n)) throw badRequest("Rating harus berupa angka 1–10");
  const clamped = Math.round(n);
  if (clamped < 1 || clamped > 10) throw badRequest("Rating harus antara 1 dan 10");
  return clamped;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const reviewsRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /reviews/anime/:animeId  — public list ────────────────────────────
  app.get<{ Params: { animeId: string }; Querystring: { page?: string; limit?: string } }>(
    "/anime/:animeId",
    async (request, reply) => {
      const animeId = toInt(request.params.animeId, 0);
      if (!animeId) throw badRequest("animeId tidak valid");

      const page  = toInt(request.query.page,  1);
      const limit = Math.min(toInt(request.query.limit, 20), 50);
      const skip  = (page - 1) * limit;

      const [total, reviews] = await Promise.all([
        prisma.animeReview.count({ where: { animeId } }),
        prisma.animeReview.findMany({
          where:   { animeId },
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
          include: {
            user: { select: { id: true, username: true, avatar: true } },
          },
        }),
      ]);

      return paginated(reply, {
        items: reviews,
        total,
        page,
        limit,
      });
    },
  );

  // ── GET /reviews/anime/:animeId/summary  — avg + count (public) ──────────
  app.get<{ Params: { animeId: string } }>(
    "/anime/:animeId/summary",
    async (request, reply) => {
      const animeId = toInt(request.params.animeId, 0);
      if (!animeId) throw badRequest("animeId tidak valid");

      const agg = await prisma.animeReview.aggregate({
        where:   { animeId },
        _avg:    { rating: true },
        _count:  { id: true },
        _min:    { rating: true },
        _max:    { rating: true },
      });

      // Distribution: how many reviews per star (1–10)
      const dist = await prisma.animeReview.groupBy({
        by:      ["rating"],
        where:   { animeId },
        _count:  { id: true },
        orderBy: { rating: "asc" },
      });

      const distribution: Record<number, number> = {};
      for (let i = 1; i <= 10; i++) distribution[i] = 0;
      for (const d of dist) distribution[d.rating] = d._count.id;

      return ok(reply, {
        data: {
          animeId,
          totalReviews: agg._count.id,
          avgRating:    agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : null,
          minRating:    agg._min.rating,
          maxRating:    agg._max.rating,
          distribution,
        },
      });
    },
  );

  // ── GET /reviews/anime/:animeId/me  — own review (auth) ──────────────────
  app.get<{ Params: { animeId: string } }>(
    "/anime/:animeId/me",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const animeId = toInt(request.params.animeId, 0);
      if (!animeId) throw badRequest("animeId tidak valid");

      const userId = (request.user as { id: number }).id;

      const review = await prisma.animeReview.findUnique({
        where: { userId_animeId: { userId, animeId } },
      });

      return ok(reply, { data: review ?? null });
    },
  );

  // ── POST /reviews/anime/:animeId  — upsert own review (auth) ─────────────
  app.post<{
    Params: { animeId: string };
    Body: { rating?: unknown; body?: unknown };
  }>(
    "/anime/:animeId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const animeId = toInt(request.params.animeId, 0);
      if (!animeId) throw badRequest("animeId tidak valid");

      const userId = (request.user as { id: number }).id;
      const rating = clampRating(request.body?.rating);
      const body   = typeof request.body?.body === "string"
        ? request.body.body.trim().slice(0, 2000) || null
        : null;

      // Verify anime exists
      const anime = await prisma.anime.findUnique({
        where:  { id: animeId },
        select: { id: true },
      });
      if (!anime) throw notFound("Anime tidak ditemukan");

      const review = await prisma.animeReview.upsert({
        where:  { userId_animeId: { userId, animeId } },
        create: { userId, animeId, rating, body },
        update: { rating, body, updatedAt: new Date() },
      });

      return created(reply, { data: review });
    },
  );

  // ── DELETE /reviews/anime/:animeId  — delete own review (auth) ───────────
  app.delete<{ Params: { animeId: string } }>(
    "/anime/:animeId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const animeId = toInt(request.params.animeId, 0);
      if (!animeId) throw badRequest("animeId tidak valid");

      const userId = (request.user as { id: number }).id;

      const existing = await prisma.animeReview.findUnique({
        where:  { userId_animeId: { userId, animeId } },
        select: { id: true },
      });
      if (!existing) throw notFound("Review tidak ditemukan");

      await prisma.animeReview.delete({
        where: { userId_animeId: { userId, animeId } },
      });

      return ok(reply, { data: null, message: "Review dihapus" });
    },
  );

  // ── GET /reviews/top  — top-rated animes (public) ─────────────────────────
  // Useful for analytics + homepage widgets
  app.get<{ Querystring: { limit?: string } }>(
    "/top",
    async (request, reply) => {
      const limit = Math.min(toInt(request.query.limit, 10), 50);

      const topAnimes = await prisma.animeReview.groupBy({
        by:      ["animeId"],
        _avg:    { rating: true },
        _count:  { id: true },
        having:  { id: { _count: { gte: 1 } } },
        orderBy: { _avg: { rating: "desc" } },
        take:    limit,
      });

      const animeIds = topAnimes.map((r) => r.animeId);
      const animes   = await prisma.anime.findMany({
        where:  { id: { in: animeIds } },
        select: { id: true, title: true, slug: true, thumbnail: true },
      });
      const animeMap = new Map(animes.map((a) => [a.id, a]));

      return ok(reply, {
        data: topAnimes.map((r) => ({
          anime:       animeMap.get(r.animeId) ?? null,
          avgRating:   r._avg.rating ? Math.round(r._avg.rating * 10) / 10 : null,
          reviewCount: r._count.id,
        })),
      });
    },
  );
};

export default reviewsRoutes;
