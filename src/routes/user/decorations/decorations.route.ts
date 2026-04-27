import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../../lib/prisma";
import {
  equipDecoration,
  getEquippedDecorations,
  listOwnedDecorations,
  purchaseDecorationWithExp,
  syncUnlocks,
  unequipDecoration,
  type DecorationType,
  MAX_EQUIPPED_EFFECTS,
} from "../../../services/decoration.service";
import { getCultivationBadge, getLevelProgress } from "../../../services/exp.service";
import { badRequest, conflict, notFound, unauthorized } from "../../../utils/http-error";
import { ok } from "../../../utils/response";

function normalizeDecorationType(value: unknown): DecorationType | undefined {
  if (value === "frame") return "frame";
  if (value === "nametag") return "nametag";
  if (value === "effect") return "effect";
  return undefined;
}

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
        effects: equipped.effects,
        maxEffects: MAX_EQUIPPED_EFFECTS,
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

    const result = await equipDecoration(request.user.id, decorationId);
    if (!result.ok) {
      if (result.reason === "max_effects_reached") {
        throw conflict(
          `Maksimum ${result.max ?? MAX_EQUIPPED_EFFECTS} profile effect bisa dipasang. Lepas salah satu dulu.`,
        );
      }
      throw notFound("Dekorasi belum dimiliki atau tidak ditemukan");
    }

    // Setelah perubahan, kirim balik state lengkap effects supaya client tidak
    // perlu fetch ulang untuk sinkronisasi.
    const equipped = await getEquippedDecorations(request.user.id);

    return ok(reply, {
      message: "Dekorasi terpasang",
      data: { equipped: result.equipped, type: result.type },
      meta: {
        equipped,
        frame: equipped.frame,
        nametag: equipped.nametag,
        effects: equipped.effects,
        maxEffects: MAX_EQUIPPED_EFFECTS,
      },
    });
  });

  app.post("/:id/unequip", async (request, reply) => {
    const params = request.params as { id: string };
    const decorationId = Number(params.id);
    if (!Number.isFinite(decorationId) || decorationId <= 0) {
      throw badRequest("ID dekorasi tidak valid");
    }

    await unequipDecoration(request.user.id, { decorationId });
    const equipped = await getEquippedDecorations(request.user.id);

    return ok(reply, {
      message: "Dekorasi dilepas",
      data: { equipped: null, decorationId },
      meta: {
        equipped,
        frame: equipped.frame,
        nametag: equipped.nametag,
        effects: equipped.effects,
        maxEffects: MAX_EQUIPPED_EFFECTS,
      },
    });
  });

  app.post("/unequip", async (request, reply) => {
    const body = request.body as
      | { type?: DecorationType; decorationId?: number | string }
      | null;
    const type = normalizeDecorationType(body?.type);
    const rawId = body?.decorationId;
    const decorationId =
      rawId !== undefined && rawId !== null && rawId !== ""
        ? Number(rawId)
        : undefined;

    await unequipDecoration(request.user.id, {
      type,
      decorationId:
        Number.isFinite(decorationId) && (decorationId as number) > 0
          ? (decorationId as number)
          : undefined,
    });

    const equipped = await getEquippedDecorations(request.user.id);
    return ok(reply, {
      message: "Dekorasi dilepas",
      data: { equipped: null, type: type ?? null, decorationId: decorationId ?? null },
      meta: {
        equipped,
        frame: equipped.frame,
        nametag: equipped.nametag,
        effects: equipped.effects,
        maxEffects: MAX_EQUIPPED_EFFECTS,
      },
    });
  });

  app.post("/:id/purchase", async (request, reply) => {
    const params = request.params as { id: string };
    const decorationId = Number(params.id);
    if (!Number.isFinite(decorationId) || decorationId <= 0) {
      throw badRequest("ID dekorasi tidak valid");
    }

    const outcome = await purchaseDecorationWithExp(request.user.id, decorationId);
    if (!outcome.ok) {
      if (outcome.reason === "not_found") throw notFound("Dekorasi tidak ditemukan");
      if (outcome.reason === "user_not_found") throw unauthorized("User tidak ditemukan");
      if (outcome.reason === "not_purchasable") {
        throw badRequest("Dekorasi ini tidak bisa dibeli dengan EXP");
      }
      if (outcome.reason === "already_owned") {
        throw conflict("Kamu sudah memiliki dekorasi ini");
      }
      if (outcome.reason === "insufficient_exp") {
        throw badRequest(
          `EXP kamu (${outcome.current}) tidak cukup. Butuh ${outcome.required} EXP.`,
        );
      }
      throw badRequest("Gagal membeli dekorasi");
    }

    const equipped = await getEquippedDecorations(request.user.id);

    return ok(reply, {
      message: "Dekorasi dibeli",
      data: {
        decoration: outcome.result.decoration,
        spentExp: outcome.result.spentExp,
        exp: outcome.result.exp,
        level: outcome.result.level,
        badge: getCultivationBadge(outcome.result.level),
        levelProgress: getLevelProgress(outcome.result.exp, outcome.result.level),
      },
      meta: {
        equipped,
        frame: equipped.frame,
        nametag: equipped.nametag,
        effects: equipped.effects,
        maxEffects: MAX_EQUIPPED_EFFECTS,
      },
    });
  });
};

export default userDecorationsRoutes;
