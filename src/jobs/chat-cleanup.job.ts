import { cleanupAllChatRooms } from "../services/chat.service";

const CLEANUP_INTERVAL_MS = 60_000;

export async function runChatCleanupJobCycle(logger: {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}) {
  try {
    const count = await cleanupAllChatRooms();
    logger.info(`[chat-cleanup] cleaned ${count} active room(s)`);
    return { cleaned: count };
  } catch (error) {
    logger.error("[chat-cleanup] failed", error);
    throw error;
  }
}

export function startChatCleanupJob(logger: {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}) {
  const timer = setInterval(() => {
    void runChatCleanupJobCycle(logger).catch(() => null);
  }, CLEANUP_INTERVAL_MS);
  timer.unref?.();
  void runChatCleanupJobCycle(logger).catch(() => null);
  return timer;
}
