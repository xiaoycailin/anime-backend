import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../utils/response";
import { forbidden, badRequest } from "../../utils/http-error";
import {
  appendSupportAdminMessageExternal,
  resolveSupportConversation,
  resolveSupportConversationIdFromTicket,
} from "../../services/support/support.service";
import {
  isTelegramAdminUserId,
  isTelegramAdminUsername,
  parseTelegramCommand,
  verifyTelegramWebhookSecret,
} from "../../services/support/telegram-support.service";
import { flushSupportConversationToDb } from "../../services/support/support-flush.service";

type TelegramUpdate = {
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number | string };
    from?: { id?: number; username?: string; first_name?: string; last_name?: string };
  };
};

export const supportTelegramRoutes: FastifyPluginAsync = async (app) => {
  app.post("/webhook", async (request, reply) => {
    const query = request.query as { secret?: string };
    if (!verifyTelegramWebhookSecret(query.secret)) throw forbidden("Invalid secret");

    const update = request.body as TelegramUpdate;
    const message = update?.message;
    const text = message?.text ?? "";
    const fromId = message?.from?.id;
    const fromUsername = message?.from?.username;

    if (!isTelegramAdminUserId(fromId) && !isTelegramAdminUsername(fromUsername))
      throw forbidden("Not allowed");

    const cmd = parseTelegramCommand(text);
    if (!cmd) return ok(reply, { message: "Ignored", data: { ok: true } });

    const conversationId = await resolveSupportConversationIdFromTicket(cmd.ticket);

    if (cmd.type === "reply") {
      const result = await appendSupportAdminMessageExternal({
        conversationId,
        content: cmd.message,
        source: "telegram",
        externalLabel: {
          username: message?.from?.username ?? "telegram",
          name: [message?.from?.first_name, message?.from?.last_name].filter(Boolean).join(" ") || "Telegram Admin",
        },
      });
      await flushSupportConversationToDb({ conversationId, force: true }).catch(() => null);
      return ok(reply, { message: "Forwarded", data: result });
    }

    if (cmd.type === "resolve") {
      // Resolve as system/admin. We don't have app user mapping for telegram, so allow via service call.
      const meta = await resolveSupportConversation({
        user: { id: 1, role: "admin" } as any,
        conversationId,
      }).catch(() => null);
      await flushSupportConversationToDb({ conversationId, force: true }).catch(() => null);
      return ok(reply, { message: "Resolved", data: meta ?? { ok: true } });
    }

    throw badRequest("Command tidak didukung");
  });
};

export default supportTelegramRoutes;
