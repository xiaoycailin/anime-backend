import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma";
import { forbidden } from "../utils/http-error";

export const adminGuardPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorate("adminAuthenticate", async (request, reply) => {
    await app.authenticate(request, reply);

    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: { role: true },
    });

    if (user?.role !== "admin") {
      throw forbidden("Akses ditolak");
    }

    request.user.role = user.role;
  });
});

export default adminGuardPlugin;
