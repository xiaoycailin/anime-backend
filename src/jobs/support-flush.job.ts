import { flushDirtySupportConversations } from "../services/support/support-flush.service";

export function startSupportFlushJob(logger: {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}) {
  const intervalSeconds = Math.max(
    30,
    Math.min(3600, Number(process.env.SUPPORT_FLUSH_INTERVAL_SECONDS) || 300),
  );
  const intervalMs = intervalSeconds * 1000;

  const run = async () => {
    try {
      const result = await flushDirtySupportConversations({ max: 15 });
      logger.info(
        `[support-flush] checked=${result.checked} flushed=${result.flushed} locked=${result.locked}`,
      );
    } catch (error) {
      logger.error("[support-flush] failed", error);
    }
  };

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
  return timer;
}

