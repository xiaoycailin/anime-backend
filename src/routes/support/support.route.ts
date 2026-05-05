import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../utils/response";
import { badRequest } from "../../utils/http-error";
import {
  appendSupportAiMessage,
  appendSupportUserMessage,
  ensureSupportConversationForUser,
  getSupportConversationMetaForUser,
  loadSupportConversationForUser,
  requestSupportHandoff,
  resolveSupportConversation,
} from "../../services/support/support.service";
import { runSupportAiTriage } from "../../services/support/support-ai.service";
import { sendTelegramSupportNotification } from "../../services/support/telegram-support.service";
import { flushSupportConversationToDb } from "../../services/support/support-flush.service";
import { readSupportMessages, readSupportMeta } from "../../services/support/support.redis";
import { createRoleNotification } from "../../services/notification.service";

export const supportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.post("/conversations", async (request, reply) => {
    const user = request.user;
    const conversationId = await ensureSupportConversationForUser(user.id);
    const meta = await getSupportConversationMetaForUser({ user });
    return ok(reply, { message: "Support conversation ready", data: { conversationId, meta } });
  });

  app.get("/conversations/me", async (request, reply) => {
    const query = request.query as { limit?: string; after?: string };
    const data = await loadSupportConversationForUser({
      user: request.user,
      limit: query.limit,
      after: query.after,
    });
    return ok(reply, { message: "Support conversation fetched", data });
  });

  app.get("/conversations/:id/messages", async (request, reply) => {
    const params = request.params as { id: string };
    const query = request.query as { limit?: string; after?: string };
    const meta = await getSupportConversationMetaForUser({ user: request.user });
    if (meta.id !== params.id) throw badRequest("Ticket tidak valid");
    const data = await loadSupportConversationForUser({
      user: request.user,
      limit: query.limit,
      after: query.after,
    });
    return ok(reply, { message: "Support messages fetched", data });
  });

  app.post("/conversations/:id/messages", async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { content?: unknown };

    const meta = await getSupportConversationMetaForUser({ user: request.user });
    if (meta.id !== params.id) throw badRequest("Ticket tidak valid");

    const userResult = await appendSupportUserMessage({
      user: request.user,
      conversationId: params.id,
      content: body.content,
    });

    const aiReplies: Array<{ messageId: string; content: string; handoff: boolean }> = [];

    // AI triage only when AI is active.
    const latestMeta = await readSupportMeta(params.id);
    if (latestMeta && latestMeta.status === "ai_active") {
      const recent = await readSupportMessages({
        conversationId: params.id,
        after: null,
        limit: 40,
      });

      const triage = await runSupportAiTriage({
        userText: userResult.message.content,
        recentMessages: recent.messages,
        aiFailures: latestMeta.aiFailures ?? 0,
      });

      if (triage.reply) {
        const aiMsg = await appendSupportAiMessage({
          conversationId: params.id,
          content: triage.reply,
          source: "ai",
          actions: triage.handoffRequired
            ? [{ type: "handoff", label: "Chat dengan admin" }]
            : [],
        });
        aiReplies.push({
          messageId: aiMsg.message.id,
          content: aiMsg.message.content,
          handoff: triage.handoffRequired,
        });
      }

      if (triage.handoffRequired) {
        const nextMeta = await requestSupportHandoff({
          user: request.user,
          conversationId: params.id,
        });
        await createRoleNotification({
          role: "admin",
          category: "admin_operational",
          type: "support_handoff",
          title: "Support butuh admin",
          message: `Ticket SUP-${nextMeta.id.slice(0, 8)} dari @${request.user.username}`,
          link: "/admin/support",
          payload: { conversationId: nextMeta.id },
          createdById: request.user.id,
        }).catch(() => null);
        await sendTelegramSupportNotification({
          meta: nextMeta,
          userLabel: `@${request.user.username}`,
          userText: userResult.message.content,
          aiSummary: triage.summaryForAdmin,
        }).catch(() => null);
        await flushSupportConversationToDb({ conversationId: params.id, force: true }).catch(() => null);
      }
    }

    return ok(reply, {
      message: "Support message sent",
      data: {
        meta: userResult.meta,
        message: userResult.message,
        aiReplies,
      },
    });
  });

  app.patch("/conversations/:id/handoff", async (request, reply) => {
    const params = request.params as { id: string };
    const meta = await requestSupportHandoff({
      user: request.user,
      conversationId: params.id,
    });
    await createRoleNotification({
      role: "admin",
      category: "admin_operational",
      type: "support_handoff",
      title: "Support butuh admin",
      message: `Ticket SUP-${meta.id.slice(0, 8)} dari @${request.user.username}`,
      link: "/admin/support",
      payload: { conversationId: meta.id },
      createdById: request.user.id,
    }).catch(() => null);
    await sendTelegramSupportNotification({
      meta,
      userLabel: `@${request.user.username}`,
      userText: "User minta CS human.",
      aiSummary: "",
    }).catch(() => null);
    await flushSupportConversationToDb({ conversationId: params.id, force: true }).catch(() => null);
    return ok(reply, { message: "Handoff requested", data: meta });
  });

  app.patch("/conversations/:id/resolve", async (request, reply) => {
    const params = request.params as { id: string };
    const meta = await resolveSupportConversation({
      user: request.user,
      conversationId: params.id,
    });
    await flushSupportConversationToDb({ conversationId: params.id, force: true }).catch(() => null);
    return ok(reply, { message: "Conversation resolved", data: meta });
  });
};

export default supportRoutes;
