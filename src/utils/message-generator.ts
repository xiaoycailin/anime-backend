/**
 * Anime Watch Reminder — Message Generator
 *
 * All notification copy lives here.  Each rule has multiple title + body
 * variants to prevent the same user from seeing identical messages back-to-back.
 *
 * Randomisation strategy
 * ─────────────────────
 * We use a *deterministic* seed built from:
 *   userId ⊕ animeId ⊕ current-hour-slot
 * This gives a stable choice within one cycle, rotates every hour, and is
 * different per user-anime pair — no Math.random(), no state required.
 */

// ── Public types ──────────────────────────────────────────────────────────────

export type ReminderType = 'continue_watching' | 'popular_anime' | 'inactive_user';

/** Shape passed to continue-watching template functions */
export interface ContinueWatchingCtx {
  /** User's display name (username) */
  userName: string;
  /** Full anime title as stored in WatchHistory.animeTitle */
  animeTitle: string;
  /** Integer progress percentage, guaranteed 1–99 */
  progress: number;
  /** Episodes remaining if known — optional, used by some variants */
  remaining?: number;
}

/** Shape passed to popular-anime template functions */
export interface PopularAnimeCtx {
  userName: string;
  animeTitle: string;
  /** How many WatchHistory rows this user has for this anime */
  watchCount: number;
  /** True when this anime is considered trending by trendingScore */
  isTrending: boolean;
}

/** Shape passed to inactive-user template functions */
export interface InactiveUserCtx {
  userName: string;
  /** Whole number of days since last watchedAt */
  daysSinceActive: number;
  /** Number of distinct animes with progressPct 0 < p < 100 */
  unfinishedCount: number;
}

/** Return type from every generate* helper */
export interface GeneratedMessage {
  title: string;
  message: string;
}

// ── Template function type ────────────────────────────────────────────────────

type MsgFn<T> = (ctx: T) => string;

// ── Continue Watching templates ───────────────────────────────────────────────

const CW_TITLES: MsgFn<ContinueWatchingCtx>[] = [
  (c) => `Lanjut nonton ${c.animeTitle} yuk!`,
  (c) => `${c.animeTitle} masih ${c.progress}%`,
  (c) => `${c.animeTitle} nunggu kamu 👀`,
  (c) => `Jangan lupa ${c.animeTitle}!`,
  (c) => `${c.animeTitle} — belum selesai nih`,
  (c) => `${c.progress}% doang? Lanjut dong!`,
  (c) => `Sisa ${100 - c.progress}% lagi — ${c.animeTitle}`,
];

const CW_MESSAGES: MsgFn<ContinueWatchingCtx>[] = [
  (c) =>
    `${c.userName}, ${c.animeTitle} baru ${c.progress}% nih, lanjut yuk!`,
  (c) =>
    `${c.animeTitle} masih nunggu kamu 👀 lanjut dari ${c.progress}% sekarang?`,
  (c) =>
    `Sedikit lagi seru 🔥 ${c.animeTitle} masih di ${c.progress}%`,
  (c) =>
    `${c.userName}, ${c.animeTitle} sudah ditonton ${c.progress}% — mau lanjut sekarang?`,
  (c) =>
    `Ayo lanjut! ${c.animeTitle} masih ${100 - c.progress}% lagi buat ditamatin 🎬`,
  (c) =>
    `Jangan setengah-setengah dong 😄 ${c.animeTitle} masih ${c.progress}%!`,
  (c) =>
    `${c.userName}, lanjut ${c.animeTitle} yuk! Udah ${c.progress}% nih, sayang kalau berhenti.`,
  (c) =>
    `Sayang banget kalau berhenti di ${c.progress}% 😅 ${c.animeTitle} lagi seru tuh!`,
  (c) =>
    `Plot twist belum kamu tau! 🎯 Lanjut ${c.animeTitle} dari ${c.progress}%.`,
];

// ── Popular Anime templates ───────────────────────────────────────────────────

const PA_TITLES: MsgFn<PopularAnimeCtx>[] = [
  (c) => `Kamu sering nonton ${c.animeTitle}!`,
  (c) => `${c.animeTitle} favoritmu 🔥`,
  (c) => `Tamatin ${c.animeTitle} yuk!`,
  (c) => `${c.animeTitle} — worth ditamatin!`,
  (c) => c.isTrending ? `${c.animeTitle} lagi trending 🔥` : `${c.animeTitle} nunggu kamu!`,
];

const PA_MESSAGES: MsgFn<PopularAnimeCtx>[] = [
  (c) =>
    `${c.animeTitle} lagi sering kamu tonton 🔥 lanjutkan!`,
  (c) =>
    `Kayaknya kamu suka ${c.animeTitle} 👀 lanjut lagi yuk`,
  (c) =>
    `${c.animeTitle} worth banget buat ditamatin!`,
  (c) =>
    `${c.animeTitle} sudah kamu tonton berkali-kali 🔥 wajib lanjut sampai tamat!`,
  (c) =>
    `Penggemar setia ${c.animeTitle}? 👀 Yuk tamatin!`,
  (c) =>
    `${c.userName}, kamu nonton ${c.animeTitle} ${c.watchCount} episode loh 🎉 lanjut yuk!`,
  (c) =>
    `${c.animeTitle} jelas hits buat kamu 🎯 saatnya tamatin!`,
  (c) =>
    c.isTrending
      ? `${c.animeTitle} lagi trending dan kamu belum tamatin — gas lanjut! 🔥`
      : `${c.animeTitle} udah ${c.watchCount} episode, dikit lagi beres nih!`,
];

// ── Inactive User templates ───────────────────────────────────────────────────

const IU_TITLES: MsgFn<InactiveUserCtx>[] = [
  (c) => `Ayo balik, ${c.userName}!`,
  ()  => `Anime kamu kangen nih 👀`,
  ()  => `Waktunya nonton lagi 🎬`,
  (c) => `${c.daysSinceActive} hari nggak nonton, kangen nggak?`,
  (c) => `${c.unfinishedCount} anime nunggu kamu tamatin!`,
];

const IU_MESSAGES: MsgFn<InactiveUserCtx>[] = [
  (c) =>
    `${c.userName}, udah lama nggak nonton 😢 balik yuk!`,
  ()  =>
    `Anime kamu kangen nih 👀`,
  ()  =>
    `Waktunya lanjut anime lagi 🎬`,
  (c) =>
    `${c.userName}, kamu punya ${c.unfinishedCount} anime yang belum selesai loh 👀`,
  (c) =>
    `Jangan sampai lupa ceritanya! 😅 Lanjut nonton yuk ${c.userName}`,
  (c) =>
    `${c.daysSinceActive} hari nggak nonton nih 😢 ayo balik!`,
  ()  =>
    `Udah kangen belum sama anime kamu? 🎬`,
  (c) =>
    `Masih ada ${c.unfinishedCount} anime yang nunggu kamu tamatin loh! 😄`,
  (c) =>
    `${c.userName}, ceritanya masih nanggung — lanjut sekarang biar nggak penasaran!`,
];

// ── Seed & picker helpers ─────────────────────────────────────────────────────

/**
 * Builds a deterministic integer seed.
 *
 * Changes every hour (hourSlot) so the same user gets a different variant
 * each cycle without storing any state.  The XOR mixing ensures that two
 * users watching the same anime at the same hour get different picks.
 */
function makeSeed(userId: number, animeId = 0): number {
  const hourSlot = Math.floor(Date.now() / 3_600_000);
  // Simple but effective integer mixing — stays positive via Math.abs
  return Math.abs(
    ((userId * 2_654_435_761) ^ (animeId * 40_503) ^ (hourSlot * 6_364_136_223)) % 997,
  );
}

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length]!;
}

// ── Public generate helpers ───────────────────────────────────────────────────

/**
 * Generate a title + message for the "continue watching" rule.
 *
 * @param ctx   Template context (userName, animeTitle, progress)
 * @param userId  Used to personalise the seed
 * @param animeId Used to personalise the seed
 */
export function generateContinueWatchingMessage(
  ctx: ContinueWatchingCtx,
  userId: number,
  animeId: number,
): GeneratedMessage {
  const seed = makeSeed(userId, animeId);
  return {
    title:   pick(CW_TITLES,   seed)(ctx),
    message: pick(CW_MESSAGES, seed + CW_TITLES.length)(ctx),
  };
}

/**
 * Generate a title + message for the "popular anime" rule.
 */
export function generatePopularAnimeMessage(
  ctx: PopularAnimeCtx,
  userId: number,
  animeId: number,
): GeneratedMessage {
  const seed = makeSeed(userId, animeId);
  return {
    title:   pick(PA_TITLES,   seed)(ctx),
    message: pick(PA_MESSAGES, seed + PA_TITLES.length)(ctx),
  };
}

/**
 * Generate a title + message for the "inactive user" rule.
 */
export function generateInactiveUserMessage(
  ctx: InactiveUserCtx,
  userId: number,
): GeneratedMessage {
  const seed = makeSeed(userId);
  return {
    title:   pick(IU_TITLES,   seed)(ctx),
    message: pick(IU_MESSAGES, seed + IU_TITLES.length)(ctx),
  };
}

// ── Utility: format progress as integer ──────────────────────────────────────

/** Clamps a raw progressPct float to a display-safe integer 1–99. */
export function formatProgress(raw: number): number {
  return Math.min(99, Math.max(1, Math.round(raw)));
}

/** Returns true if progress is considered "in-progress" (not started, not done). */
export function isInProgress(progressPct: number): boolean {
  return progressPct > 0 && progressPct < 100;
}

/** Milliseconds helpers used by the service layer */
export const MS = {
  hour:  3_600_000,
  day:   86_400_000,
  hours: (n: number) => n * 3_600_000,
  days:  (n: number) => n * 86_400_000,
} as const;
