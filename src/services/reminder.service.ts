/**
 * Anime Watch Reminder Service
 *
 * Processes three reminder rules against live database state, applies multi-layer
 * anti-spam guards, and dispatches personalised notifications via the existing
 * notification service.
 *
 * Architecture overview
 * ─────────────────────
 *  runReminderCycle()
 *    │
 *    ├─ 1. fetchEligibleUserIds()      — users who opted in (or have no pref yet)
 *    ├─ 2. fetchUserMap()              — batch load usernames
 *    ├─ 3. fetchWatchHistoryBatch()    — single query; all in-progress histories
 *    ├─ 4. fetchRecentReminderMap()    — batch anti-spam snapshot (last 24 h)
 *    ├─ 5. fetchTrendingAnimeIds()     — animes above trendingScore threshold
 *    │
 *    ├─ processRule1()  → continue_watching
 *    ├─ processRule2()  → popular_anime
 *    └─ processRule3()  → inactive_user
 *
 * Every candidate passes through passesAntiSpam() before a notification is sent.
 * Notifications are dispatched sequentially per user to avoid thundering-herd on
 * the push service; errors per notification are isolated and logged without
 * stopping the cycle.
 */

import { prisma } from '../lib/prisma';
import { createUserNotification } from './notification.service';
import {
  generateContinueWatchingMessage,
  generatePopularAnimeMessage,
  generateInactiveUserMessage,
  formatProgress,
  isInProgress,
  MS,
  type ContinueWatchingCtx,
  type PopularAnimeCtx,
  type InactiveUserCtx,
} from '../utils/message-generator';

// ── Configuration ─────────────────────────────────────────────────────────────
// All thresholds live here so ops can tweak them without touching logic.

export const REMINDER_CONFIG = {
  continueWatching: {
    /** progressPct must be strictly above this to qualify */
    minProgressPct: 0,
    /** progressPct must be strictly below this to qualify */
    maxProgressPct: 100,
    /** User must NOT have watched this anime in the last N hours */
    inactivityHours: 6,
    /** Don't send a continue_watching reminder for the same anime within N hours */
    cooldownHours: 24,
  },

  popularAnime: {
    /** User must have ≥ this many WatchHistory rows for a single anime */
    minWatchCount: 3,
    /** Don't send a popular_anime reminder for the same anime within N hours */
    cooldownHours: 24,
    /** Anime.trendingScore must exceed this to count as "trending" */
    trendingScoreThreshold: 50,
  },

  inactiveUser: {
    /** User's last watchedAt must be older than N days */
    inactivityDays: 3,
    /** Don't send an inactive_user reminder within N hours */
    cooldownHours: 24,
  },

  antiSpam: {
    /** Hard cap: max watch_reminder notifications per user per rolling 24 h window */
    maxPerDay: 2,
    /** Min gap in hours between ANY two watch_reminder notifications for a user */
    minGapHours: 6,
    /** Look-back window when querying recent notifications (should match maxCooldown) */
    lookbackHours: 24,
  },

  batch: {
    /** Max users evaluated per cycle (safety valve) */
    maxUsers: 2_000,
    /** Rule priority order when a user qualifies for multiple rules.
     *  Only the first matching rule fires per cycle to cap at maxPerDay. */
    rulePriority: ['continue_watching', 'popular_anime', 'inactive_user'] as const,
  },
} as const;

// ── Internal types ────────────────────────────────────────────────────────────

type NotificationType = 'continue_watching' | 'popular_anime' | 'inactive_user';

/** Condensed view of a WatchHistory row used internally */
interface WatchRow {
  userId: number;
  animeId: number;
  animeTitle: string;
  animeSlug: string;
  animeThumbnail: string;
  progressPct: number;
  watchedAt: Date;
}

/** Per-user map of all their WatchHistory rows grouped by animeId */
type UserAnimeHistory = Map<number /* animeId */, WatchRow[]>;

/** Per-user map: userId → animeId → latest WatchRow */
type UserLatestMap = Map<number, Map<number, WatchRow>>;

/** A snapshot of a recently-sent watch_reminder notification */
interface RecentReminder {
  type: NotificationType;
  animeId: number | null;
  sentAt: Date;
}

/** userId → list of recent reminders (sorted newest-first) */
type RecentReminderMap = Map<number, RecentReminder[]>;

/** Lightweight user shape */
interface UserRow {
  id: number;
  username: string;
}

/** Per-rule counts emitted by processRule* functions */
interface RuleResult {
  sent: number;
  skipped: number;
  errors: number;
}

/** Summary returned from runReminderCycle() */
export interface ReminderCycleStats {
  cycleStartedAt: Date;
  eligibleUsers: number;
  rule1: RuleResult;
  rule2: RuleResult;
  rule3: RuleResult;
  totalSent: number;
  totalErrors: number;
  durationMs: number;
}

// ── Step 1 — Eligible users ───────────────────────────────────────────────────

/**
 * Returns userIds that should receive reminders.
 *
 * Logic: include all users who have watch history UNLESS they have explicitly
 * set watchReminder = false in their NotificationPreference.
 * Users with no preference record are included (system default is true).
 */
async function fetchEligibleUserIds(limit: number): Promise<number[]> {
  // Distinct userIds that have any WatchHistory
  const withHistory = await prisma.watchHistory.findMany({
    select: { userId: true },
    distinct: ['userId'],
    take: limit,
    orderBy: { watchedAt: 'desc' },
  });

  if (withHistory.length === 0) return [];

  const allIds = withHistory.map((r: { userId: number }) => r.userId);

  // Fetch only the ones who explicitly opted out
  const optedOut = await prisma.notificationPreference.findMany({
    where: {
      userId: { in: allIds },
      watchReminder: false,
    },
    select: { userId: true },
  });

  const optedOutSet = new Set(optedOut.map((p: { userId: number }) => p.userId));
  return allIds.filter((id: number) => !optedOutSet.has(id));
}

// ── Step 2 — User details ─────────────────────────────────────────────────────

async function fetchUserMap(userIds: number[]): Promise<Map<number, UserRow>> {
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true },
  });
  return new Map(users.map((u: UserRow) => [u.id, u]));
}

// ── Step 3 — Watch history batch ──────────────────────────────────────────────

/**
 * Fetches all WatchHistory rows for the given users where the episode is
 * still in-progress (progressPct strictly between 0 and 100).
 *
 * Returns two structures built in a single pass:
 *  - byUserAnime: userId → animeId → WatchRow[]  (all rows per user-anime)
 *  - latestByUserAnime: userId → animeId → most-recent WatchRow
 */
async function fetchWatchHistoryBatch(userIds: number[]): Promise<{
  byUserAnime: Map<number, UserAnimeHistory>;
  latestByUserAnime: UserLatestMap;
  allRows: WatchRow[];
}> {
  const raw = await prisma.watchHistory.findMany({
    where: {
      userId: { in: userIds },
      progressPct: {
        gt: REMINDER_CONFIG.continueWatching.minProgressPct,
        lt: REMINDER_CONFIG.continueWatching.maxProgressPct,
      },
    },
    select: {
      userId:         true,
      animeId:        true,
      animeTitle:     true,
      animeSlug:      true,
      animeThumbnail: true,
      progressPct:    true,
      watchedAt:      true,
    },
    orderBy: { watchedAt: 'desc' },
  });

  const allRows: WatchRow[] = raw;

  const byUserAnime   = new Map<number, UserAnimeHistory>();
  const latestByUserAnime = new Map<number, Map<number, WatchRow>>();

  for (const row of allRows) {
    // byUserAnime
    if (!byUserAnime.has(row.userId)) byUserAnime.set(row.userId, new Map());
    const animeMap = byUserAnime.get(row.userId)!;
    if (!animeMap.has(row.animeId)) animeMap.set(row.animeId, []);
    animeMap.get(row.animeId)!.push(row);

    // latestByUserAnime (already sorted desc so first entry is latest)
    if (!latestByUserAnime.has(row.userId)) latestByUserAnime.set(row.userId, new Map());
    const latestMap = latestByUserAnime.get(row.userId)!;
    if (!latestMap.has(row.animeId)) latestMap.set(row.animeId, row);
  }

  return { byUserAnime, latestByUserAnime, allRows };
}

// ── Step 4 — Anti-spam snapshot ───────────────────────────────────────────────

/**
 * Loads all watch_reminder notifications sent to eligible users in the last
 * lookbackHours. Returns a per-user list sorted newest-first.
 *
 * We use the payload JSON field to recover the animeId that was notified about,
 * enabling per-anime cooldown checks without an extra join table.
 */
async function fetchRecentReminderMap(
  userIds: number[],
  since: Date,
): Promise<RecentReminderMap> {
  const records = await prisma.notificationRecipient.findMany({
    where: {
      userId:    { in: userIds },
      createdAt: { gte: since },
      notification: { category: 'watch_reminder' },
    },
    select: {
      userId:    true,
      createdAt: true,
      notification: {
        select: { type: true, payload: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const result: RecentReminderMap = new Map();

  for (const r of records) {
    if (r.userId == null) continue;
    const payload  = r.notification.payload as { animeId?: number } | null;
    const reminder: RecentReminder = {
      type:    r.notification.type as NotificationType,
      animeId: payload?.animeId ?? null,
      sentAt:  r.createdAt,
    };
    const list = result.get(r.userId) ?? [];
    list.push(reminder);
    result.set(r.userId, list);
  }

  return result;
}

// ── Step 5 — Trending anime IDs ───────────────────────────────────────────────

async function fetchTrendingAnimeIds(): Promise<Set<number>> {
  const trending = await prisma.anime.findMany({
    where: { trendingScore: { gte: REMINDER_CONFIG.popularAnime.trendingScoreThreshold } },
    select: { id: true },
  });
  return new Set(trending.map((a: { id: number }) => a.id));
}

// ── Anti-spam guard ───────────────────────────────────────────────────────────

interface AntiSpamResult {
  allowed: boolean;
  /** Human-readable reason for rejection (empty when allowed) */
  reason: string;
}

/**
 * Checks all anti-spam rules for a candidate notification.
 *
 * Guards applied:
 *  1. Max 2 watch_reminder notifications per rolling 24 h window
 *  2. Minimum 6 h gap since the last watch_reminder (any type)
 *  3. Same type not sent in the last 24 h (type-level cooldown)
 *  4. Same anime not sent in the last N h (anime-level cooldown, Rule 1 & 2)
 */
function passesAntiSpam(
  userId: number,
  type: NotificationType,
  animeId: number | null,
  recentMap: RecentReminderMap,
): AntiSpamResult {
  const recents = recentMap.get(userId) ?? [];
  const now     = Date.now();

  // Guard 1 — daily cap
  if (recents.length >= REMINDER_CONFIG.antiSpam.maxPerDay) {
    return { allowed: false, reason: `daily cap reached (${recents.length})` };
  }

  if (recents.length > 0) {
    const lastSentMs = recents[0]!.sentAt.getTime();

    // Guard 2 — minimum gap between any two reminders
    const gapMs = now - lastSentMs;
    if (gapMs < MS.hours(REMINDER_CONFIG.antiSpam.minGapHours)) {
      const gapMin = Math.round(gapMs / 60_000);
      return { allowed: false, reason: `min gap not met (${gapMin} min elapsed)` };
    }

    // Guard 3 — same type cooldown
    const sameTypeSent = recents.some(
      (r) =>
        r.type === type &&
        now - r.sentAt.getTime() < MS.hours(REMINDER_CONFIG.antiSpam.lookbackHours),
    );
    if (sameTypeSent) {
      return { allowed: false, reason: `same type (${type}) already sent in cooldown window` };
    }
  }

  // Guard 4 — per-anime cooldown (only for anime-specific types)
  if (animeId !== null && (type === 'continue_watching' || type === 'popular_anime')) {
    const cooldownHours =
      type === 'continue_watching'
        ? REMINDER_CONFIG.continueWatching.cooldownHours
        : REMINDER_CONFIG.popularAnime.cooldownHours;

    const sameAnimeSent = recents.some(
      (r) =>
        r.animeId === animeId &&
        now - r.sentAt.getTime() < MS.hours(cooldownHours),
    );
    if (sameAnimeSent) {
      return { allowed: false, reason: `anime ${animeId} in per-anime cooldown` };
    }
  }

  return { allowed: true, reason: '' };
}

// ── Notification sender ───────────────────────────────────────────────────────

interface SendReminderInput {
  userId:    number;
  type:      NotificationType;
  title:     string;
  message:   string;
  animeId:   number | null;
  animeSlug: string | null;
  image:     string | null;
}

async function sendReminder(input: SendReminderInput): Promise<void> {
  const link = input.animeSlug ? `/anime/${input.animeSlug}` : null;

  await createUserNotification({
    userId:   input.userId,
    category: 'watch_reminder',
    type:     input.type,
    title:    input.title,
    message:  input.message,
    link,
    image:    input.image,
    payload:  input.animeId !== null ? { animeId: input.animeId } : undefined,
  });
}

// ── Rule 1 — Continue Watching ────────────────────────────────────────────────

/**
 * For each eligible user, find the anime with the highest in-progress episode
 * that hasn't been watched in ≥ inactivityHours and hasn't been reminded
 * recently.  Selects only the single best candidate per user to avoid spam.
 */
async function processRule1(
  userIds: number[],
  userMap: Map<number, UserRow>,
  latestByUserAnime: UserLatestMap,
  recentMap: RecentReminderMap,
): Promise<RuleResult> {
  const result: RuleResult = { sent: 0, skipped: 0, errors: 0 };
  const inactivityCutoff  = new Date(Date.now() - MS.hours(REMINDER_CONFIG.continueWatching.inactivityHours));

  for (const userId of userIds) {
    const user = userMap.get(userId);
    if (!user) { result.skipped++; continue; }

    const animeMap = latestByUserAnime.get(userId);
    if (!animeMap || animeMap.size === 0) { result.skipped++; continue; }

    // Pick the candidate: must be inactive for ≥ inactivityHours
    // Among qualifying animes, prefer the one with most progress (closest to finish)
    let bestRow: WatchRow | null = null;

    for (const row of animeMap.values()) {
      if (!isInProgress(row.progressPct)) continue;
      if (row.watchedAt >= inactivityCutoff) continue;    // watched too recently

      if (!bestRow || row.progressPct > bestRow.progressPct) {
        bestRow = row;
      }
    }

    if (!bestRow) { result.skipped++; continue; }

    const spamCheck = passesAntiSpam(userId, 'continue_watching', bestRow.animeId, recentMap);
    if (!spamCheck.allowed) { result.skipped++; continue; }

    const progress = formatProgress(bestRow.progressPct);
    const ctx: ContinueWatchingCtx = {
      userName:   user.username,
      animeTitle: bestRow.animeTitle,
      progress,
      remaining:  100 - progress,
    };
    const { title, message } = generateContinueWatchingMessage(ctx, userId, bestRow.animeId);

    try {
      await sendReminder({
        userId,
        type:      'continue_watching',
        title,
        message,
        animeId:   bestRow.animeId,
        animeSlug: bestRow.animeSlug,
        image:     bestRow.animeThumbnail,
      });

      // Update in-memory anti-spam map so subsequent rules see this send
      const newEntry: RecentReminder = {
        type: 'continue_watching', animeId: bestRow.animeId, sentAt: new Date(),
      };
      const list = recentMap.get(userId) ?? [];
      list.unshift(newEntry);
      recentMap.set(userId, list);

      result.sent++;
    } catch (err) {
      console.error(`[Reminder] Rule1 send failed userId=${userId}:`, err);
      result.errors++;
    }
  }

  return result;
}

// ── Rule 2 — Popular / Trending Anime ────────────────────────────────────────

/**
 * Fires when a user has watched ≥ minWatchCount distinct episodes of an anime
 * (or the anime is currently trending) but hasn't finished it yet.
 * Picks the anime with the highest episode count for the user.
 */
async function processRule2(
  userIds: number[],
  userMap: Map<number, UserRow>,
  byUserAnime: Map<number, UserAnimeHistory>,
  recentMap: RecentReminderMap,
  trendingAnimeIds: Set<number>,
): Promise<RuleResult> {
  const result: RuleResult = { sent: 0, skipped: 0, errors: 0 };
  const minCount = REMINDER_CONFIG.popularAnime.minWatchCount;

  for (const userId of userIds) {
    const user = userMap.get(userId);
    if (!user) { result.skipped++; continue; }

    // Already sent a reminder this cycle?
    const recentForUser = recentMap.get(userId) ?? [];
    if (recentForUser.length >= REMINDER_CONFIG.antiSpam.maxPerDay) {
      result.skipped++;
      continue;
    }

    const animeMap = byUserAnime.get(userId);
    if (!animeMap || animeMap.size === 0) { result.skipped++; continue; }

    let bestRow:     WatchRow | null = null;
    let bestCount    = 0;
    let bestTrending = false;

    for (const [animeId, rows] of animeMap.entries()) {
      const isTrending = trendingAnimeIds.has(animeId);
      // Must qualify: watched ≥ minCount times OR is trending
      if (rows.length < minCount && !isTrending) continue;
      // Must still be in-progress (at least one episode not at 100%)
      const hasUnfinished = rows.some((r) => isInProgress(r.progressPct));
      if (!hasUnfinished) continue;

      if (rows.length > bestCount || (isTrending && !bestTrending)) {
        bestCount    = rows.length;
        bestRow      = rows[0]!; // sorted desc by watchedAt, so first = latest
        bestTrending = isTrending;
      }
    }

    if (!bestRow) { result.skipped++; continue; }

    const spamCheck = passesAntiSpam(userId, 'popular_anime', bestRow.animeId, recentMap);
    if (!spamCheck.allowed) { result.skipped++; continue; }

    const ctx: PopularAnimeCtx = {
      userName:   user.username,
      animeTitle: bestRow.animeTitle,
      watchCount: bestCount,
      isTrending: bestTrending,
    };
    const { title, message } = generatePopularAnimeMessage(ctx, userId, bestRow.animeId);

    try {
      await sendReminder({
        userId,
        type:      'popular_anime',
        title,
        message,
        animeId:   bestRow.animeId,
        animeSlug: bestRow.animeSlug,
        image:     bestRow.animeThumbnail,
      });

      const newEntry: RecentReminder = {
        type: 'popular_anime', animeId: bestRow.animeId, sentAt: new Date(),
      };
      const list = recentMap.get(userId) ?? [];
      list.unshift(newEntry);
      recentMap.set(userId, list);

      result.sent++;
    } catch (err) {
      console.error(`[Reminder] Rule2 send failed userId=${userId}:`, err);
      result.errors++;
    }
  }

  return result;
}

// ── Rule 3 — Inactive User ────────────────────────────────────────────────────

/**
 * Targets users who haven't watched anything in ≥ inactivityDays but still
 * have at least one in-progress anime.
 *
 * We derive "last active" from the maximum watchedAt across all WatchHistory
 * rows for the user.  This avoids adding a denormalised column to the User
 * model.
 */
async function processRule3(
  userIds: number[],
  userMap: Map<number, UserRow>,
  byUserAnime: Map<number, UserAnimeHistory>,
  allRows: WatchRow[],
  recentMap: RecentReminderMap,
): Promise<RuleResult> {
  const result: RuleResult = { sent: 0, skipped: 0, errors: 0 };
  const inactivityCutoff = new Date(
    Date.now() - MS.days(REMINDER_CONFIG.inactiveUser.inactivityDays),
  );

  // Build per-user last-active from allRows (already fetched, no extra query)
  const lastActiveMap = new Map<number, Date>();
  for (const row of allRows) {
    const current = lastActiveMap.get(row.userId);
    if (!current || row.watchedAt > current) lastActiveMap.set(row.userId, row.watchedAt);
  }

  for (const userId of userIds) {
    const user = userMap.get(userId);
    if (!user) { result.skipped++; continue; }

    // Already capped by earlier rules this cycle?
    const recentForUser = recentMap.get(userId) ?? [];
    if (recentForUser.length >= REMINDER_CONFIG.antiSpam.maxPerDay) {
      result.skipped++;
      continue;
    }

    const lastActive = lastActiveMap.get(userId);
    // No history at all → skip (nothing to remind about)
    if (!lastActive) { result.skipped++; continue; }
    // Not inactive enough → skip
    if (lastActive >= inactivityCutoff) { result.skipped++; continue; }

    const animeMap = byUserAnime.get(userId);
    if (!animeMap || animeMap.size === 0) { result.skipped++; continue; }

    // Count distinct unfinished animes
    let unfinishedCount = 0;
    for (const rows of animeMap.values()) {
      if (rows.some((r) => isInProgress(r.progressPct))) unfinishedCount++;
    }
    if (unfinishedCount === 0) { result.skipped++; continue; }

    const spamCheck = passesAntiSpam(userId, 'inactive_user', null, recentMap);
    if (!spamCheck.allowed) { result.skipped++; continue; }

    const daysSinceActive = Math.floor(
      (Date.now() - lastActive.getTime()) / MS.day,
    );
    const ctx: InactiveUserCtx = {
      userName: user.username,
      daysSinceActive,
      unfinishedCount,
    };
    const { title, message } = generateInactiveUserMessage(ctx, userId);

    // Use the most-recently-watched unfinished anime as the link target
    let linkRow: WatchRow | null = null;
    for (const rows of animeMap.values()) {
      const row = rows[0]; // sorted desc → most recent
      if (!row || !isInProgress(row.progressPct)) continue;
      if (!linkRow || row.watchedAt > linkRow.watchedAt) linkRow = row;
    }

    try {
      await sendReminder({
        userId,
        type:      'inactive_user',
        title,
        message,
        animeId:   linkRow?.animeId ?? null,
        animeSlug: linkRow?.animeSlug ?? null,
        image:     linkRow?.animeThumbnail ?? null,
      });

      const newEntry: RecentReminder = {
        type: 'inactive_user', animeId: null, sentAt: new Date(),
      };
      const list = recentMap.get(userId) ?? [];
      list.unshift(newEntry);
      recentMap.set(userId, list);

      result.sent++;
    } catch (err) {
      console.error(`[Reminder] Rule3 send failed userId=${userId}:`, err);
      result.errors++;
    }
  }

  return result;
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Entry point called by the job scheduler.
 *
 * Returns a stats object so the caller can log or monitor cycle health.
 */
export async function runReminderCycle(): Promise<ReminderCycleStats> {
  const startedAt = new Date();
  console.info('[ReminderService] Cycle started');

  // ── Step 1: eligible users ──────────────────────────────────────────────────
  const eligibleUserIds = await fetchEligibleUserIds(REMINDER_CONFIG.batch.maxUsers);

  if (eligibleUserIds.length === 0) {
    console.info('[ReminderService] No eligible users — cycle complete (0 ms)');
    return {
      cycleStartedAt: startedAt,
      eligibleUsers:  0,
      rule1: { sent: 0, skipped: 0, errors: 0 },
      rule2: { sent: 0, skipped: 0, errors: 0 },
      rule3: { sent: 0, skipped: 0, errors: 0 },
      totalSent:   0,
      totalErrors: 0,
      durationMs:  Date.now() - startedAt.getTime(),
    };
  }

  // ── Step 2–5: parallel data fetch ──────────────────────────────────────────
  const lookbackSince = new Date(
    Date.now() - MS.hours(REMINDER_CONFIG.antiSpam.lookbackHours),
  );

  const [userMap, histResult, recentMap, trendingAnimeIds] = await Promise.all([
    fetchUserMap(eligibleUserIds),
    fetchWatchHistoryBatch(eligibleUserIds),
    fetchRecentReminderMap(eligibleUserIds, lookbackSince),
    fetchTrendingAnimeIds(),
  ]);

  const { byUserAnime, latestByUserAnime, allRows } = histResult;

  console.info(
    `[ReminderService] Data fetched — users=${eligibleUserIds.length} ` +
    `historyRows=${allRows.length} trending=${trendingAnimeIds.size}`,
  );

  // ── Rules — applied in priority order ──────────────────────────────────────
  // Each rule mutates recentMap to prevent over-notification within the cycle.

  const rule1 = await processRule1(
    eligibleUserIds, userMap, latestByUserAnime, recentMap,
  );

  const rule2 = await processRule2(
    eligibleUserIds, userMap, byUserAnime, recentMap, trendingAnimeIds,
  );

  const rule3 = await processRule3(
    eligibleUserIds, userMap, byUserAnime, allRows, recentMap,
  );

  // ── Stats ───────────────────────────────────────────────────────────────────
  const totalSent   = rule1.sent   + rule2.sent   + rule3.sent;
  const totalErrors = rule1.errors + rule2.errors + rule3.errors;
  const durationMs  = Date.now() - startedAt.getTime();

  const stats: ReminderCycleStats = {
    cycleStartedAt: startedAt,
    eligibleUsers:  eligibleUserIds.length,
    rule1,
    rule2,
    rule3,
    totalSent,
    totalErrors,
    durationMs,
  };

  console.info(
    `[ReminderService] Cycle complete — ` +
    `sent=${totalSent} errors=${totalErrors} duration=${durationMs}ms ` +
    `(r1=${rule1.sent} r2=${rule2.sent} r3=${rule3.sent})`,
  );

  return stats;
}
