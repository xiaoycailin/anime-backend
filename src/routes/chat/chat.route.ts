import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../utils/response";
import {
  listChatRoomsForUser,
  loadChatMessages,
} from "../../services/chat.service";
import { searchChatContexts } from "../../services/chat-context.service";

export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.get("/rooms", async (request, reply) => {
    const rooms = await listChatRoomsForUser(request.user?.id);
    return ok(reply, {
      message: "Chat rooms fetched",
      data: rooms,
    });
  });

  app.get("/messages", async (request, reply) => {
    const query = request.query as {
      limit?: string;
      before?: string;
      after?: string;
      cursor?: string;
    };

    const data = await loadChatMessages({
      user: request.user,
      limit: query.limit,
      before: query.before ?? query.cursor,
      after: query.after,
    });

    return ok(reply, {
      message: "Chat messages fetched",
      data,
    });
  });

  app.get("/messages/poll", async (request, reply) => {
    const query = request.query as { after?: string; limit?: string };
    const data = await loadChatMessages({
      user: request.user,
      limit: query.limit ?? "50",
      after: query.after,
    });

    return ok(reply, {
      message: "Chat poll fetched",
      data: {
        messages: data.messages,
        serverTime: data.serverTime,
        slowmode: data.slowmode,
      },
    });
  });

  app.get("/context/search", async (request, reply) => {
    const query = request.query as {
      q?: string;
      type?: string;
      limit?: string;
    };
    const data = await searchChatContexts(query);

    return ok(reply, {
      message: "Chat context search fetched",
      data,
    });
  });

  app.get("/rooms/:roomId/messages", async (request, reply) => {
    const params = request.params as { roomId: string };
    const query = request.query as {
      limit?: string;
      before?: string;
      after?: string;
      cursor?: string;
    };

    const data = await loadChatMessages({
      roomId: params.roomId,
      user: request.user,
      limit: query.limit,
      before: query.before ?? query.cursor,
      after: query.after,
    });

    return ok(reply, {
      message: "Chat messages fetched",
      data,
    });
  });

  app.get("/rooms/:roomId/messages/poll", async (request, reply) => {
    const params = request.params as { roomId: string };
    const query = request.query as { after?: string; limit?: string };
    const data = await loadChatMessages({
      roomId: params.roomId,
      user: request.user,
      limit: query.limit ?? "50",
      after: query.after,
    });

    return ok(reply, {
      message: "Chat poll fetched",
      data: {
        messages: data.messages,
        serverTime: data.serverTime,
        slowmode: data.slowmode,
      },
    });
  });
};

export default chatRoutes;
