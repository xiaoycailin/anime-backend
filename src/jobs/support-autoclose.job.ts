import { redis } from "../lib/redis";
import { SUPPORT_ACTIVE_SET_KEY } from "../services/support/support.constants";
import { readSupportMeta, writeSupportMeta } from "../services/support/support.redis";
import { appendSupportSystemMessage } from "../services/support/support.service";
import { flushSupportConversationToDb } from "../services/support/support-flush.service";

function nowMs() {
  return Date.now();
}

function idleSeconds() {
  const value = Number(process.env.SUPPORT_AUTO_CLOSE_IDLE_SECONDS) || 180;
  return Math.max(60, Math.min(30 * 60, Math.floor(value)));
}

function shouldAutoClose(meta: {
  status: string;
  lastUserMessageAt: number | null;
  lastAgentMessageAt: number | null;
}) {
  if (meta.status === "resolved") return false;
  if (!meta.lastAgentMessageAt) return false;
  const lastUser = meta.lastUserMessageAt ?? 0;
  if (lastUser >= meta.lastAgentMessageAt) return false;
  const idleMs = idleSeconds() * 1000;
  return nowMs() - meta.lastAgentMessageAt >= idleMs;
}

export async function runSupportAutoCloseJobCycle(logger: {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}) {
  try {
    const candidates = await redis.srandmember(SUPPORT_ACTIVE_SET_KEY, 30);
    let checked = 0;
    let closed = 0;

    for (const conversationId of candidates) {
      const meta = await readSupportMeta(conversationId);
      if (!meta) {
        await redis.srem(SUPPORT_ACTIVE_SET_KEY, conversationId).catch(() => null);
        continue;
      }
      checked += 1;
      if (!shouldAutoClose(meta)) continue;

      await appendSupportSystemMessage({
        conversationId,
        content:
          "Ticket ditutup otomatis karena tidak ada balasan selama beberapa menit. Kalau masih butuh bantuan, kamu bisa chat lagi di sini.",
      }).catch(() => null);

      meta.status = "resolved";
      meta.updatedAt = nowMs();
      await writeSupportMeta(meta).catch(() => null);
      await flushSupportConversationToDb({ conversationId, force: true }).catch(
        () => null,
      );
      closed += 1;
    }

    logger.info(`[support-autoclose] checked=${checked} closed=${closed}`);
    return { checked, closed };
  } catch (error) {
    logger.error("[support-autoclose] failed", error);
    throw error;
  }
}

export function startSupportAutoCloseJob(logger: {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}) {
  const intervalMs = 30_000;

  const timer = setInterval(() => {
    void runSupportAutoCloseJobCycle(logger).catch(() => null);
  }, intervalMs);
  timer.unref?.();
  void runSupportAutoCloseJobCycle(logger).catch(() => null);
  return timer;
}
