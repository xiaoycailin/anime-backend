import { cleanupAllChatRooms } from "../services/chat.service";

const CLEANUP_INTERVAL_MS = 60_000;

export function startChatCleanupJob(logger: {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}) {
  const run = async () => {
    try {
      const count = await cleanupAllChatRooms();
      logger.info(`[chat-cleanup] cleaned ${count} active room(s)`);
    } catch (error) {
      logger.error("[chat-cleanup] failed", error);
    }
  };

  const timer = setInterval(run, CLEANUP_INTERVAL_MS);
  timer.unref?.();
  void run();
  return timer;
}
