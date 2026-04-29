import type { FastifyReply } from "fastify";

export function writeChatbotSseEvent(
  reply: FastifyReply,
  event: string,
  data: Record<string, unknown>,
) {
  if (reply.raw.destroyed || reply.raw.writableEnded) return false;

  try {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}
