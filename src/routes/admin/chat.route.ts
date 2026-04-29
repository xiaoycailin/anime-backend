import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../utils/response";
import {
  listChatSettings,
  updateGlobalSlowmodeSetting,
} from "../../services/chat-settings.service";
import {
  clearAdminChatMessages,
  deleteAdminChatMessage,
  listAdminChatMessages,
} from "../../services/chat.service";
import { publishChatMessageUpdate } from "../../services/chat-ws.service";
import { notFound } from "../../utils/http-error";

export const adminChatRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.get<{
    Querystring: {
      page?: string;
      limit?: string;
      search?: string;
      roomId?: string;
    };
  }>("/messages", async (request, reply) => {
    const data = await listAdminChatMessages({
      roomId: request.query.roomId,
      page: request.query.page,
      limit: request.query.limit,
      search: request.query.search,
    });

    return ok(reply, {
      message: "Admin chat messages fetched",
      data: data.messages,
      meta: {
        roomId: data.roomId,
        total: data.total,
        page: data.page,
        limit: data.limit,
        search: data.search,
        serverTime: data.serverTime,
      },
    });
  });

  app.get("/settings", async (_request, reply) => {
    const data = await listChatSettings();
    return ok(reply, {
      message: "Admin chat settings fetched",
      data,
    });
  });

  app.patch("/settings/slowmode", async (request, reply) => {
    const body = request.body as { enabled?: boolean; seconds?: number };
    const data = await updateGlobalSlowmodeSetting({
      enabled: body?.enabled,
      seconds: body?.seconds,
      updatedBy: request.user.id,
    });

    return ok(reply, {
      message: "Global slowmode updated",
      data,
    });
  });

  app.delete<{
    Params: { id: string };
    Querystring: { roomId?: string };
  }>("/messages/:id", async (request, reply) => {
    const result = await deleteAdminChatMessage({
      roomId: request.query.roomId,
      messageId: request.params.id,
      deletedBy: request.user.id,
    });
    if (!result.deleted) throw notFound("Chat tidak ditemukan");
    if (result.message) {
      await publishChatMessageUpdate(result.message.roomId, result.message);
    }

    return ok(reply, {
      message: "Chat message deleted",
      data: result,
    });
  });

  app.delete<{ Querystring: { roomId?: string } }>(
    "/messages",
    async (request, reply) => {
      const result = await clearAdminChatMessages({
        roomId: request.query.roomId,
      });

      return ok(reply, {
        message: "Chat messages cleared",
        data: result,
      });
    },
  );
};

export default adminChatRoutes;
