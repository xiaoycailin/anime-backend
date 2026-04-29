import type { FastifyPluginAsync } from "fastify";
import { runWeebinAiChatbot } from "../../services/openai-services/chatbot/core";
import { writeChatbotSseEvent } from "../../services/openai-services/chatbot/stream";

export const aiChatRoutes: FastifyPluginAsync = async (app) => {
  app.post("/", { preHandler: app.authenticate }, async (request, reply) => {
    const body = (request.body ?? {}) as {
      messageId?: string;
      roomId?: string;
      content?: unknown;
      currentContext?: unknown;
      messages?: unknown;
      mentionedBot?: unknown;
    };
    const controller = new AbortController();
    const abortStream = () => controller.abort();
    request.raw.on("aborted", abortStream);
    request.raw.on("close", abortStream);

    const origin = request.headers.origin || "*";
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    try {
      const result = await runWeebinAiChatbot(
        {
          content: body.content,
          mentionedBot: body.mentionedBot,
          currentContext: body.currentContext,
          messages: body.messages,
        },
        {
          signal: controller.signal,
          onStatus: async (status) => {
            writeChatbotSseEvent(reply, "status", { status });
          },
          onDelta: async (delta, text) => {
            writeChatbotSseEvent(reply, "delta", { delta, text });
          },
          onCards: async (cards) => {
            writeChatbotSseEvent(reply, "cards", { cards });
          },
        },
      );

      writeChatbotSseEvent(reply, "done", {
        messageId: body.messageId ?? null,
        roomId: body.roomId ?? null,
        text: result.text,
        cards: result.cards,
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        writeChatbotSseEvent(reply, "error", {
          message:
            error instanceof Error
              ? error.message
              : "WeebinAI belum bisa dipakai sekarang",
        });
      }
    } finally {
      reply.raw.end();
    }
  });
};

export default aiChatRoutes;
