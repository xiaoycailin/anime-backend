import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../utils/response";
import {
  appendSupportAdminMessage,
  clearSupportConversationAdmin,
  listAdminSupportConversations,
  loadSupportMessagesAdmin,
  resolveSupportConversation,
  setSupportConversationStatus,
} from "../../services/support/support.service";
import { flushSupportConversationToDb } from "../../services/support/support-flush.service";
import { sendTelegramSupportNotification } from "../../services/support/telegram-support.service";
import { readSupportMeta } from "../../services/support/support.redis";

export const adminSupportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.get("/conversations", async (request, reply) => {
    const query = request.query as {
      status?: string;
      search?: string;
      page?: string;
      limit?: string;
    };
    const data = await listAdminSupportConversations(query);
    return ok(reply, { message: "Support conversations fetched", data: data.data, meta: { total: data.total, page: data.page, limit: data.limit, serverTime: data.serverTime } });
  });

  app.get("/conversations/:id/messages", async (request, reply) => {
    const params = request.params as { id: string };
    const query = request.query as { limit?: string; after?: string };
    const data = await loadSupportMessagesAdmin({
      conversationId: params.id,
      limit: query.limit,
      after: query.after,
    });
    return ok(reply, { message: "Support messages fetched", data });
  });

  app.post("/conversations/:id/messages", async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { content?: unknown };
    const result = await appendSupportAdminMessage({
      admin: request.user,
      conversationId: params.id,
      content: body.content,
      source: "app",
    });
    await flushSupportConversationToDb({ conversationId: params.id, force: true }).catch(() => null);
    return ok(reply, { message: "Admin reply sent", data: result });
  });

  app.patch("/conversations/:id/status", async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { status?: string; priority?: string; assignedAdminId?: number | null };
    const meta = await setSupportConversationStatus({
      conversationId: params.id,
      status: (body.status as any) ?? "human_active",
      priority: body.priority as any,
      assignedAdminId: body.assignedAdminId ?? undefined,
    });
    await flushSupportConversationToDb({ conversationId: params.id, force: true }).catch(() => null);
    return ok(reply, { message: "Status updated", data: meta });
  });

  app.patch("/conversations/:id/resolve", async (request, reply) => {
    const params = request.params as { id: string };
    const meta = await resolveSupportConversation({
      user: request.user,
      conversationId: params.id,
    });
    await flushSupportConversationToDb({ conversationId: params.id, force: true }).catch(() => null);
    return ok(reply, { message: "Resolved", data: meta });
  });

  app.patch("/conversations/:id/clear", async (request, reply) => {
    const params = request.params as { id: string };
    const meta = await clearSupportConversationAdmin({
      admin: request.user,
      conversationId: params.id,
    });
    await flushSupportConversationToDb({ conversationId: params.id, force: true }).catch(() => null);
    return ok(reply, { message: "Cleared", data: meta });
  });

  app.post("/telegram/test", async (_request, reply) => {
    const meta = await readSupportMeta("test").catch(() => null);
    await sendTelegramSupportNotification({
      meta: meta ?? {
        id: "test",
        userId: 0,
        status: "needs_human",
        priority: "normal",
        assignedAdminId: null,
        lastMessageAt: null,
        lastUserMessageAt: null,
        lastAgentMessageAt: null,
        unreadUser: 0,
        unreadAdmin: 0,
        telegramChatId: null,
        telegramThreadId: null,
        lastTelegramMessageId: null,
        lastFlushedAt: null,
        lastFlushedMessageTs: null,
        aiFailures: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      userLabel: "@test",
      userText: "Test notif",
    }).catch(() => null);
    return ok(reply, { message: "Telegram test attempted", data: { ok: true } });
  });
};

export default adminSupportRoutes;
