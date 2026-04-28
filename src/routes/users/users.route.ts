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
import { ok } from "../../utils/response";

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

export const usersRoutes: FastifyPluginAsync = async (app) => {
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
};

export default usersRoutes;
