import { flushDirtySupportConversations } from "../services/support/support-flush.service";

export async function runSupportFlushJobCycle(logger: {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}) {
  try {
    const result = await flushDirtySupportConversations({ max: 15 });
    logger.info(
      `[support-flush] checked=${result.checked} flushed=${result.flushed} locked=${result.locked}`,
    );
    return result;
  } catch (error) {
    logger.error("[support-flush] failed", error);
    throw error;
  }
}

export function startSupportFlushJob(logger: {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}) {
  const intervalSeconds = Math.max(
    30,
    Math.min(3600, Number(process.env.SUPPORT_FLUSH_INTERVAL_SECONDS) || 300),
  );
  const intervalMs = intervalSeconds * 1000;

  const timer = setInterval(() => {
    void runSupportFlushJobCycle(logger).catch(() => null);
  }, intervalMs);
  timer.unref?.();
  void runSupportFlushJobCycle(logger).catch(() => null);
  return timer;
}
