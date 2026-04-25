import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Comment, CommentReaction, ReactionType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { addExp, getCultivationBadge } from "../../services/exp.service";
import {
  getEquippedDecorationsForUsers,
  type EquippedDecorationsDTO,
} from "../../services/decoration.service";
import { createUserNotification } from "../../services/notification.service";
import { HttpError, badRequest, forbidden, notFound } from "../../utils/http-error";
import { created, ok, paginated } from "../../utils/response";

const COMMENT_COOLDOWN_MS = 5 * 60 * 1000;

type CommentBody = {
  animeId?: number;
  episodeId?: number | null;
  content?: string;
  parentId?: number | null;
};

type ReactionBody = {
  type?: ReactionType;
};

type CommentRecord = Comment & {
  user: { id: number; username: string; avatar: string | null; isVerified: boolean; exp: number; level: number };
  reactions: CommentReaction[];
  _count: { replies: number };
};

const COMMENT_USER_SELECT = {
  id: true,
  username: true,
  avatar: true,
  isVerified: true,
  exp: true,
  level: true,
} as const;

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeContent(content: unknown) {
  const value = typeof content === "string" ? content.trim() : "";
  if (value.length < 3) {
    throw badRequest("Komentar minimal 3 karakter");
  }
  if (value.length > 1000) {
    throw badRequest("Komentar maksimal 1000 karakter");
  }
  return value;
}

function formatWait(ms: number) {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return { totalSeconds, message: `Tunggu ${minutes} menit ${seconds} detik sebelum komentar lagi` };
}

function previewComment(content: string | null | undefined, maxLength = 72) {
  const normalized = (content ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "Komentar";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

async function optionalUserId(app: Parameters<FastifyPluginAsync>[0], request: FastifyRequest) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const payload = app.jwt.verify<{ id: number }>(auth.slice("Bearer ".length));
    return payload.id;
  } catch {
    return null;
  }
}

function formatComment(
  comment: CommentRecord,
  userId: number | null,
  equipped: EquippedDecorationsDTO = { frame: null, nametag: null },
) {
  const likeCount = comment.reactions.filter((item) => item.type === "LIKE").length;
  const dislikeCount = comment.reactions.filter((item) => item.type === "DISLIKE").length;
  const userReaction =
    comment.reactions.find((item) => item.userId === userId)?.type ?? null;
  const isDeleted = Boolean(comment.deletedAt);

  return {
    id: comment.id,
    animeId: comment.animeId,
    episodeId: comment.episodeId,
    content: isDeleted ? "[Komentar dihapus]" : comment.content,
    isDeleted,
    isEdited: comment.isEdited,
    editedAt: comment.editedAt,
    parentId: comment.parentId,
    replyCount: comment._count.replies,
    likeCount,
    dislikeCount,
    userReaction,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    user: {
      ...comment.user,
      badge: getCultivationBadge(comment.user.level),
      frame: equipped.frame,
      nametag: equipped.nametag,
    },
  };
}

async function attachFrames(comments: CommentRecord[]) {
  const userIds = Array.from(new Set(comments.map((c) => c.user.id)));
  return getEquippedDecorationsForUsers(userIds);
}

async function findCommentForOwner(id: number, userId: number) {
  const comment = await prisma.comment.findUnique({ where: { id } });
  if (!comment) throw notFound("Komentar tidak ditemukan");
  if (comment.userId !== userId) throw forbidden("Tidak bisa mengubah komentar orang lain");
  if (comment.deletedAt) throw badRequest("Komentar sudah dihapus");
  return comment;
}

async function buildCommentTargetLink(animeId: number, episodeId?: number | null) {
  const targetEpisode =
    episodeId !== null && episodeId !== undefined
      ? await prisma.episode.findUnique({
          where: { id: episodeId },
          select: {
            slug: true,
            anime: {
              select: {
                slug: true,
              },
            },
          },
        })
      : null;

  const targetAnime =
    targetEpisode?.anime ??
    (await prisma.anime.findUnique({
      where: { id: animeId },
      select: { slug: true },
    }));

  if (episodeId !== null && episodeId !== undefined && targetEpisode?.slug && targetAnime?.slug) {
    return `/anime/${targetAnime.slug}/${targetEpisode.slug}`;
  }

  return targetAnime?.slug ? `/anime/${targetAnime.slug}` : null;
}

export const commentsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (request, reply) => {
    const query = request.query as {
      animeId?: string;
      episodeId?: string;
      page?: string;
      limit?: string;
      sort?: string;
    };

    const animeId = Number(query.animeId);
    if (!Number.isFinite(animeId) || animeId <= 0) {
      throw badRequest("animeId wajib diisi");
    }

    const hasEpisode = query.episodeId !== undefined && query.episodeId !== "";
    const episodeId = hasEpisode ? Number(query.episodeId) : null;
    if (hasEpisode && (!Number.isFinite(episodeId) || Number(episodeId) <= 0)) {
      throw badRequest("episodeId tidak valid");
    }

    const page = toPositiveInt(query.page, 1);
    const limit = Math.min(toPositiveInt(query.limit, 20), 50);
    const sort = query.sort === "oldest" || query.sort === "top" ? query.sort : "newest";
    const userId = await optionalUserId(app, request);
    const where = {
      animeId,
      episodeId: episodeId as number | null,
      parentId: null,
    };

    const total = await prisma.comment.count({ where });

    let comments: CommentRecord[];
    if (sort === "top") {
      const all = await prisma.comment.findMany({
        where,
        include: {
          user: { select: COMMENT_USER_SELECT },
          reactions: true,
          _count: { select: { replies: true } },
        },
      });
      comments = all
        .sort((a, b) => {
          const scoreA =
            a.reactions.filter((item) => item.type === "LIKE").length -
            a.reactions.filter((item) => item.type === "DISLIKE").length;
          const scoreB =
            b.reactions.filter((item) => item.type === "LIKE").length -
            b.reactions.filter((item) => item.type === "DISLIKE").length;
          return scoreB - scoreA || b.createdAt.getTime() - a.createdAt.getTime();
        })
        .slice((page - 1) * limit, page * limit);
    } else {
      comments = await prisma.comment.findMany({
        where,
        orderBy: { createdAt: sort === "oldest" ? "asc" : "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: COMMENT_USER_SELECT },
          reactions: true,
          _count: { select: { replies: true } },
        },
      });
    }

    const frames = await attachFrames(comments);

    return paginated(reply, {
      items: comments.map((comment) =>
        formatComment(comment, userId, frames.get(comment.user.id) ?? undefined),
      ),
      page,
      limit,
      total,
      message: "Comments fetched successfully",
      meta: { sort, animeId, episodeId },
    });
  });

  app.get("/:id/replies", async (request, reply) => {
    const params = request.params as { id: string };
    const query = request.query as { page?: string; limit?: string };
    const commentId = Number(params.id);
    const page = toPositiveInt(query.page, 1);
    const limit = Math.min(toPositiveInt(query.limit, 10), 30);
    const userId = await optionalUserId(app, request);
    const where = { parentId: commentId };

    const [total, comments] = await Promise.all([
      prisma.comment.count({ where }),
      prisma.comment.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: COMMENT_USER_SELECT },
          reactions: true,
          _count: { select: { replies: true } },
        },
      }),
    ]);

    const frames = await attachFrames(comments);

    return paginated(reply, {
      items: comments.map((comment) =>
        formatComment(comment, userId, frames.get(comment.user.id) ?? undefined),
      ),
      page,
      limit,
      total,
      message: "Replies fetched successfully",
    });
  });

  app.post("/", { preHandler: app.authenticate }, async (request, reply) => {
    const body = request.body as CommentBody;
    const animeId = Number(body.animeId);
    const episodeId =
      body.episodeId === undefined || body.episodeId === null ? null : Number(body.episodeId);
    const parentId =
      body.parentId === undefined || body.parentId === null ? null : Number(body.parentId);
    const content = normalizeContent(body.content);

    if (!Number.isFinite(animeId) || animeId <= 0) throw badRequest("animeId wajib diisi");
    if (episodeId !== null && (!Number.isFinite(episodeId) || episodeId <= 0)) {
      throw badRequest("episodeId tidak valid");
    }
    if (parentId !== null && (!Number.isFinite(parentId) || parentId <= 0)) {
      throw badRequest("parentId tidak valid");
    }

    if (parentId !== null) {
      const parent = await prisma.comment.findUnique({ where: { id: parentId } });
      if (!parent) throw notFound("Komentar parent tidak ditemukan");
      if (parent.parentId !== null) throw badRequest("Reply hanya boleh 1 level");
      if (parent.animeId !== animeId || parent.episodeId !== episodeId) {
        throw badRequest("Reply tidak cocok dengan halaman komentar");
      }
    }

    const now = new Date();
    const rate = await prisma.commentRateLimit.findUnique({
      where: { userId: request.user.id },
    });
    if (rate) {
      const elapsed = now.getTime() - rate.lastComment.getTime();
      if (elapsed < COMMENT_COOLDOWN_MS) {
        const wait = formatWait(COMMENT_COOLDOWN_MS - elapsed);
        throw new HttpError(429, wait.message, "COMMENT_RATE_LIMIT", {
          cooldownRemaining: wait.totalSeconds,
        });
      }
    }

    const comment = await prisma.$transaction(async (tx) => {
      const createdComment = await tx.comment.create({
        data: {
          userId: request.user.id,
          animeId,
          episodeId,
          parentId,
          content,
        },
        include: {
          user: { select: COMMENT_USER_SELECT },
          reactions: true,
          _count: { select: { replies: true } },
        },
      });

      await tx.commentRateLimit.upsert({
        where: { userId: request.user.id },
        create: { userId: request.user.id, lastComment: now },
        update: { lastComment: now },
      });

      return createdComment;
    });

    if (parentId !== null) {
      const parent = await prisma.comment.findUnique({ where: { id: parentId } });
      if (parent && parent.userId !== request.user.id) {
        const targetLink = await buildCommentTargetLink(animeId, episodeId);

        await createUserNotification({
          userId: parent.userId,
          category: "personal_activity",
          type: "comment_replied",
          title: "Komentar kamu dibalas",
          message: `${request.user.username} membalas komentar kamu "${previewComment(content)}"`,
          link: targetLink,
          topic: "comment",
          payload: {
            commentId: comment.id,
            parentId,
            animeId,
            episodeId,
          },
          createdById: request.user.id,
        });
      }
    }

    const exp = await addExp(request.user.id, "comment", 10, `comment:${comment.id}`);
    const frames = await attachFrames([comment]);

    return created(reply, {
      message: "Comment posted successfully",
      data: formatComment(
        comment,
        request.user.id,
        frames.get(comment.user.id) ?? undefined,
      ),
      meta: { cooldownRemaining: Math.ceil(COMMENT_COOLDOWN_MS / 1000), exp },
    });
  });

  app.put("/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const params = request.params as { id: string };
    const id = Number(params.id);
    const body = request.body as { content?: string };
    const content = normalizeContent(body.content);

    await findCommentForOwner(id, request.user.id);

    const comment = await prisma.comment.update({
      where: { id },
      data: { content, isEdited: true, editedAt: new Date() },
      include: {
        user: { select: COMMENT_USER_SELECT },
        reactions: true,
        _count: { select: { replies: true } },
      },
    });

    const frames = await attachFrames([comment]);

    return ok(reply, {
      message: "Comment updated successfully",
      data: formatComment(
        comment,
        request.user.id,
        frames.get(comment.user.id) ?? undefined,
      ),
    });
  });

  app.delete("/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const params = request.params as { id: string };
    const id = Number(params.id);

    await findCommentForOwner(id, request.user.id);
    await prisma.comment.update({
      where: { id },
      data: { content: null, deletedAt: new Date() },
    });

    return ok(reply, { message: "deleted", data: { message: "deleted" } });
  });

  app.post("/:id/react", { preHandler: app.authenticate }, async (request, reply) => {
    const params = request.params as { id: string };
    const id = Number(params.id);
    const body = request.body as ReactionBody;
    const type = body.type;

    if (type !== "LIKE" && type !== "DISLIKE") {
      throw badRequest("Reaction type tidak valid");
    }

    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment || comment.deletedAt) throw notFound("Komentar tidak ditemukan");

    const existing = await prisma.commentReaction.findUnique({
      where: {
        userId_commentId: {
          userId: request.user.id,
          commentId: id,
        },
      },
    });

    if (!existing) {
      await prisma.commentReaction.create({
        data: { userId: request.user.id, commentId: id, type },
      });
    } else if (existing.type === type) {
      await prisma.commentReaction.delete({ where: { id: existing.id } });
    } else {
      await prisma.commentReaction.update({
        where: { id: existing.id },
        data: { type },
      });
    }

    const finalReaction = !existing
      ? type
      : existing.type === type
        ? null
        : type;

    let exp = null;
    if (type === "LIKE" && comment.userId !== request.user.id) {
      if (finalReaction === "LIKE") {
        exp = await addExp(request.user.id, "comment_like", 50, `comment:${id}`);
        await createUserNotification({
          userId: comment.userId,
          category: "personal_activity",
          type: "comment_liked",
          title: "Komentar kamu disukai",
          message: `${request.user.username} menyukai komentar kamu "${previewComment(comment.content)}"`,
          link: await buildCommentTargetLink(comment.animeId, comment.episodeId),
          topic: "comment",
          payload: {
            commentId: comment.id,
            animeId: comment.animeId,
            episodeId: comment.episodeId,
          },
          createdById: request.user.id,
        });
      }
    }

    const reactions = await prisma.commentReaction.findMany({
      where: { commentId: id },
    });
    const likeCount = reactions.filter((item) => item.type === "LIKE").length;
    const dislikeCount = reactions.filter((item) => item.type === "DISLIKE").length;
    const userReaction = reactions.find((item) => item.userId === request.user.id)?.type ?? null;

    return ok(reply, {
      message: "Reaction updated successfully",
      data: {
        liked: userReaction === "LIKE",
        disliked: userReaction === "DISLIKE",
        likeCount,
        dislikeCount,
      },
      meta: { exp },
    });
  });

  // ── POST /:id/report  — laporkan komentar (auth) ──────────────────────────
  const VALID_REASONS = ["spam", "harassment", "hate_speech", "misinformation", "inappropriate", "other"] as const;
  type ReportBody = { reason?: string; description?: string };

  app.post<{ Params: { id: string }; Body: ReportBody }>(
    "/:id/report",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const commentId = Number(request.params.id);
      if (!Number.isFinite(commentId) || commentId <= 0) throw badRequest("id tidak valid");

      const reporterId = request.user.id;
      const { reason, description } = request.body ?? {};

      if (!reason || !VALID_REASONS.includes(reason as typeof VALID_REASONS[number])) {
        throw badRequest(`reason harus salah satu dari: ${VALID_REASONS.join(", ")}`);
      }

      const comment = await prisma.comment.findUnique({
        where: { id: commentId },
        select: { id: true, userId: true, deletedAt: true },
      });
      if (!comment || comment.deletedAt) throw notFound("Komentar tidak ditemukan");
      if (comment.userId === reporterId) throw badRequest("Tidak bisa melaporkan komentar sendiri");

      const existing = await prisma.commentReport.findUnique({
        where: { reporterId_commentId: { reporterId, commentId } },
      });
      if (existing) throw badRequest("Kamu sudah pernah melaporkan komentar ini");

      await prisma.commentReport.create({
        data: {
          reporterId,
          commentId,
          reason: reason as typeof VALID_REASONS[number],
          description: description ? String(description).trim().slice(0, 500) || null : null,
        },
      });

      return ok(reply, { data: null, message: "Laporan berhasil dikirim, terima kasih!" });
    },
  );
};

export default commentsRoutes;
