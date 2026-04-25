/**
 * Anime Watch Reminder — Job Scheduler
 *
 * Runs runReminderCycle() on a fixed interval (default 1 h).
 *
 * Design decisions
 * ────────────────
 * • Uses native setInterval (same pattern as trending.service.ts) — no extra
 *   dependency.  Swap to node-cron / BullMQ when queue infrastructure arrives.
 * • Cycle-overlap guard: if the previous cycle is still running, the next tick
 *   is skipped with a warning.  This prevents thundering-herd on slow DB nodes.
 * • Consecutive-failure backoff: after BACKOFF_THRESHOLD failures the interval
 *   is doubled (up to MAX_INTERVAL_MS) to ease pressure while still retrying.
 * • Clean shutdown: call stopReminderJob() in a SIGTERM handler — the guard
 *   flag ensures an in-flight cycle completes before the process exits.
 * • Health state is exported so a /healthz or /admin route can expose it.
 *
 * Startup behaviour
 * ─────────────────
 * startReminderJob() fires the first cycle immediately (so you don't wait up
 * to 1 h on first deploy) and then at every interval thereafter.  Pass
 * runImmediately = false to disable the eager first run.
 */

import { runReminderCycle, type ReminderCycleStats } from '../services/reminder.service';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Normal cycle interval: every 1 hour */
const BASE_INTERVAL_MS = 60 * 60 * 1_000;

/** Maximum interval when backing off due to repeated failures */
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1_000; // 6 h

/** Stop backing off and reset to BASE_INTERVAL after this many successes */
const RECOVERY_THRESHOLD = 2;

/** Double the interval after this many consecutive failures */
const BACKOFF_THRESHOLD = 3;

/** Abort the entire job after this many consecutive failures */
const FATAL_THRESHOLD = 10;

// ── Job state ─────────────────────────────────────────────────────────────────

let timer:               NodeJS.Timeout | null = null;
let isExecuting          = false;
let consecutiveFailures  = 0;
let consecutiveSuccesses = 0;
let currentIntervalMs    = BASE_INTERVAL_MS;

/** Total cycles executed since startup */
let totalCycles  = 0;
/** Total notifications sent across all cycles */
let totalSent    = 0;
/** Total errors across all cycles */
let totalErrors  = 0;

let lastRunAt:     Date | null            = null;
let lastError:     string | null          = null;
let lastStats:     ReminderCycleStats | null = null;
let jobStartedAt:  Date | null            = null;

// ── Exported health snapshot ──────────────────────────────────────────────────

export interface ReminderJobStatus {
  running:             boolean;
  executing:           boolean;
  intervalMs:          number;
  consecutiveFailures: number;
  totalCycles:         number;
  totalSent:           number;
  totalErrors:         number;
  lastRunAt:           Date | null;
  lastError:           string | null;
  lastStats:           ReminderCycleStats | null;
  jobStartedAt:        Date | null;
}

export function getReminderJobStatus(): ReminderJobStatus {
  return {
    running:             timer !== null,
    executing:           isExecuting,
    intervalMs:          currentIntervalMs,
    consecutiveFailures,
    totalCycles,
    totalSent,
    totalErrors,
    lastRunAt,
    lastError,
    lastStats,
    jobStartedAt,
  };
}

// ── Internal cycle executor ───────────────────────────────────────────────────

async function executeCycle(): Promise<void> {
  if (isExecuting) {
    console.warn('[ReminderJob] Previous cycle still running — tick skipped');
    return;
  }

  isExecuting = true;

  try {
    const stats = await runReminderCycle();

    // ── Success path ──────────────────────────────────────────────────────────
    totalCycles++;
    totalSent         += stats.totalSent;
    totalErrors       += stats.totalErrors;
    lastRunAt          = stats.cycleStartedAt;
    lastStats          = stats;
    lastError          = null;
    consecutiveFailures = 0;
    consecutiveSuccesses++;

    // Reset interval once we've had enough consecutive successes after a backoff
    if (
      currentIntervalMs > BASE_INTERVAL_MS &&
      consecutiveSuccesses >= RECOVERY_THRESHOLD
    ) {
      currentIntervalMs = BASE_INTERVAL_MS;
      console.info(
        `[ReminderJob] Interval reset to base ${BASE_INTERVAL_MS / 1_000}s after recovery`,
      );
      reschedule();
    }
  } catch (err) {
    // ── Failure path ──────────────────────────────────────────────────────────
    totalCycles++;
    totalErrors++;
    consecutiveFailures++;
    consecutiveSuccesses = 0;
    lastError = err instanceof Error ? err.message : String(err);

    console.error(
      `[ReminderJob] Cycle failed (consecutive=${consecutiveFailures}): ${lastError}`,
    );

    // Fatal: too many failures → stop the job entirely
    if (consecutiveFailures >= FATAL_THRESHOLD) {
      console.error(
        `[ReminderJob] ${FATAL_THRESHOLD} consecutive failures — stopping job permanently.` +
        ' Restart the process or call startReminderJob() manually.',
      );
      stopReminderJob();
      return;
    }

    // Exponential backoff up to MAX_INTERVAL_MS
    if (consecutiveFailures >= BACKOFF_THRESHOLD) {
      const next = Math.min(currentIntervalMs * 2, MAX_INTERVAL_MS);
      if (next !== currentIntervalMs) {
        currentIntervalMs = next;
        console.warn(
          `[ReminderJob] Backing off — new interval ${currentIntervalMs / 1_000}s`,
        );
        reschedule();
      }
    }
  } finally {
    isExecuting = false;
  }
}

// ── Interval management ───────────────────────────────────────────────────────

/** Tear down the current timer and start a fresh one with currentIntervalMs. */
function reschedule(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (jobStartedAt === null) return; // job was stopped

  timer = setInterval(() => { void executeCycle(); }, currentIntervalMs);
  // unref() lets the process exit naturally even if the timer is pending
  timer.unref?.();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the reminder job.
 *
 * @param runImmediately  If true (default) fire the first cycle right away
 *                        instead of waiting for the first interval tick.
 */
export function startReminderJob(runImmediately = true): void {
  if (timer !== null) {
    console.warn('[ReminderJob] Already running — startReminderJob() is a no-op');
    return;
  }

  // Reset state in case the job was stopped and restarted
  consecutiveFailures  = 0;
  consecutiveSuccesses = 0;
  currentIntervalMs    = BASE_INTERVAL_MS;
  jobStartedAt         = new Date();

  timer = setInterval(() => { void executeCycle(); }, currentIntervalMs);
  timer.unref?.();

  console.info(
    `[ReminderJob] Started — interval=${currentIntervalMs / 1_000}s ` +
    `immediate=${runImmediately}`,
  );

  if (runImmediately) {
    // Defer by one tick so the server is fully ready before the first DB query
    setImmediate(() => { void executeCycle(); });
  }
}

/**
 * Stop the reminder job.  Any in-flight cycle continues to completion.
 * Safe to call multiple times.
 */
export function stopReminderJob(): void {
  if (timer === null) {
    console.warn('[ReminderJob] Not running — stopReminderJob() is a no-op');
    return;
  }

  clearInterval(timer);
  timer        = null;
  jobStartedAt = null;

  console.info('[ReminderJob] Stopped');
}

/**
 * Force an immediate cycle outside of the normal schedule.
 * Respects the cycle-overlap guard — won't double-fire if already executing.
 *
 * Useful for manual triggers via an admin endpoint:
 *   await triggerReminderCycle();
 */
export async function triggerReminderCycle(): Promise<ReminderCycleStats | null> {
  if (isExecuting) {
    console.warn('[ReminderJob] triggerReminderCycle() called while executing — skipped');
    return null;
  }
  await executeCycle();
  return lastStats;
}
