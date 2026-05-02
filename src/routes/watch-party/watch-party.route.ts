import type { FastifyPluginAsync } from "fastify";
import { created, ok } from "../../utils/response";
import {
  createWatchPartyRoom,
  getWatchPartyFeatureStatus,
  getWatchPartyRoomByCode,
  listMyWatchPartyRooms,
} from "../../services/watch-party.service";

export const watchPartyRoutes: FastifyPluginAsync = async (app) => {
  app.get("/feature", async (_request, reply) => {
    return ok(reply, {
      message: "Watch party feature status",
      data: getWatchPartyFeatureStatus(),
    });
  });

  app.post(
    "/rooms",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const body = request.body as { episodeId?: unknown; title?: unknown };
      const room = await createWatchPartyRoom({
        user: request.user,
        episodeId: body?.episodeId,
        title: body?.title,
      });

      return created(reply, {
        message: "Room nonton bareng dibuat",
        data: room,
      });
    },
  );

  app.get(
    "/rooms/mine",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const rooms = await listMyWatchPartyRooms(request.user.id);
      return ok(reply, {
        message: "Room nonton bareng fetched",
        data: rooms,
      });
    },
  );

  app.get("/rooms/:code", async (request, reply) => {
    const params = request.params as { code?: string };
    const room = await getWatchPartyRoomByCode(params.code);
    return ok(reply, {
      message: "Room nonton bareng fetched",
      data: room,
    });
  });
};

export default watchPartyRoutes;
