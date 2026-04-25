import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { prisma } from "../../lib/prisma";
import {
  listDecorationsForUser,
  syncUnlocks,
} from "../../services/decoration.service";

import { ok } from "../../utils/response";

async function optionalUser(
  app: Parameters<FastifyPluginAsync>[0],
  request: FastifyRequest,
) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const payload = app.jwt.verify<{ id: number }>(
      auth.slice("Bearer ".length),
    );
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, level: true },
    });
    return user;
  } catch {
    return null;
  }
}

export const decorationsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (request, reply) => {
    const user = await optionalUser(app, request);
    const level = user?.level ?? 0;

    if (user) {
      await syncUnlocks(user.id, level);
    }

    const items = await listDecorationsForUser(user?.id ?? null, level);
    return ok(reply, {
      message: "Decorations fetched successfully",
      data: items,
      meta: { total: items.length, userLevel: level },
    });
  });
};

export default decorationsRoutes;
