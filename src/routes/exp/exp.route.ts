import type { FastifyPluginAsync } from "fastify";
import { addExp, getUserExpProfile } from "../../services/exp.service";
import { ok } from "../../utils/response";
import { unauthorized } from "../../utils/http-error";

export const expRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/me", async (request, reply) => {
    const profile = await getUserExpProfile(request.user.id);
    if (!profile) throw unauthorized("User tidak ditemukan");

    return ok(reply, {
      message: "EXP profile fetched",
      data: profile,
    });
  });

  app.post("/open-app", async (request, reply) => {
    const hourBucket = new Date().toISOString().slice(0, 13);
    const exp = await addExp(request.user.id, "open_app", 50, `open-app:${hourBucket}`);
    const profile = await getUserExpProfile(request.user.id);

    return ok(reply, {
      message: exp.granted ? "Open app EXP granted" : "Open app EXP skipped",
      data: {
        exp,
        profile,
      },
    });
  });
};

export default expRoutes;
