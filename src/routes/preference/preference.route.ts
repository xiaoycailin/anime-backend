import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../lib/prisma";
import { ok } from "../../utils/response";

type PreferenceBody = {
  theme?: string;
  defaultQuality?: string;
  autoPlay?: boolean;
  defaultVolume?: number;
  autoNextEpisode?: boolean;
  skipIntroEnabled?: boolean;
  subtitleEnabled?: boolean;
  subtitleLang?: string;
  subtitleFontSize?: string;
  subtitleFontFamily?: string;
  subtitleColor?: string;
  subtitleBg?: string;
  subtitleShadow?: string;
  subtitlePosition?: string;
  subtitleOpacity?: number;
  subtitleMaxWidth?: string;
};

function cleanPreference(body: PreferenceBody) {
  return {
    ...(body.theme ? { theme: body.theme } : {}),
    ...(body.defaultQuality ? { defaultQuality: body.defaultQuality } : {}),
    ...(typeof body.autoPlay === "boolean" ? { autoPlay: body.autoPlay } : {}),
    ...(typeof body.defaultVolume === "number"
      ? { defaultVolume: Math.min(1, Math.max(0, body.defaultVolume)) }
      : {}),
    ...(typeof body.autoNextEpisode === "boolean" ? { autoNextEpisode: body.autoNextEpisode } : {}),
    ...(typeof body.skipIntroEnabled === "boolean" ? { skipIntroEnabled: body.skipIntroEnabled } : {}),
    ...(typeof body.subtitleEnabled === "boolean" ? { subtitleEnabled: body.subtitleEnabled } : {}),
    ...(body.subtitleLang ? { subtitleLang: body.subtitleLang } : {}),
    ...(body.subtitleFontSize ? { subtitleFontSize: body.subtitleFontSize } : {}),
    ...(body.subtitleFontFamily ? { subtitleFontFamily: body.subtitleFontFamily } : {}),
    ...(body.subtitleColor ? { subtitleColor: body.subtitleColor } : {}),
    ...(body.subtitleBg !== undefined ? { subtitleBg: body.subtitleBg } : {}),
    ...(body.subtitleShadow !== undefined ? { subtitleShadow: body.subtitleShadow } : {}),
    ...(body.subtitlePosition ? { subtitlePosition: body.subtitlePosition } : {}),
    ...(typeof body.subtitleOpacity === "number"
      ? { subtitleOpacity: Math.min(1, Math.max(0, body.subtitleOpacity)) }
      : {}),
    ...(body.subtitleMaxWidth ? { subtitleMaxWidth: body.subtitleMaxWidth } : {}),
  };
}

export const preferenceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request, reply) => {
    const pref = await prisma.userPreference.upsert({
      where: { userId: request.user.id },
      create: { userId: request.user.id },
      update: {},
    });

    return ok(reply, {
      message: "Preference fetched successfully",
      data: pref,
    });
  });

  app.put("/", async (request, reply) => {
    const body = request.body as PreferenceBody;
    const pref = await prisma.userPreference.upsert({
      where: { userId: request.user.id },
      create: {
        userId: request.user.id,
        ...cleanPreference(body),
      },
      update: cleanPreference(body),
    });

    return ok(reply, {
      message: "Preference updated successfully",
      data: pref,
    });
  });
};

export default preferenceRoutes;
