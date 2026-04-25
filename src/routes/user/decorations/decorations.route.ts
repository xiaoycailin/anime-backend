import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../../lib/prisma";
import {
  equipDecoration,
  getEquippedDecorations,
  listOwnedDecorations,
  syncUnlocks,
  unequipDecoration,
  type DecorationType,
} from "../../../services/decoration.service";
import { badRequest, notFound, unauthorized } from "../../../utils/http-error";
import { ok } from "../../../utils/response";

export const userDecorationsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request, reply) => {
    const profile = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: { level: true },
    });
    if (!profile) throw unauthorized("User tidak ditemukan");

    await syncUnlocks(request.user.id, profile.level);

    const items = await listOwnedDecorations(request.user.id);
    const equipped = await getEquippedDecorations(request.user.id);

    return ok(reply, {
      message: "Owned decorations fetched successfully",
      data: items,
      meta: {
        equipped,
        frame: equipped.frame,
        nametag: equipped.nametag,
        total: items.length,
      },
    });
  });

  app.post("/:id/equip", async (request, reply) => {
    const params = request.params as { id: string };
    const decorationId = Number(params.id);
    if (!Number.isFinite(decorationId) || decorationId <= 0) {
      throw badRequest("ID dekorasi tidak valid");
    }

    const equipped = await equipDecoration(request.user.id, decorationId);
    if (!equipped) {
      throw notFound("Dekorasi belum dimiliki atau tidak ditemukan");
    }

    return ok(reply, {
      message: "Dekorasi terpasang",
      data: { equipped },
    });
  });

  app.post("/unequip", async (request, reply) => {
    const body = request.body as { type?: DecorationType } | null;
    const type = body?.type === "nametag" ? "nametag" : body?.type === "frame" ? "frame" : undefined;
    await unequipDecoration(request.user.id, type);
    return ok(reply, {
      message: "Dekorasi dilepas",
      data: { equipped: null, type: type ?? null },
    });
  });
};

export default userDecorationsRoutes;
