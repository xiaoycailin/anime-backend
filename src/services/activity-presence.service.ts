type ActivityUser = {
  id: number;
  email: string;
  username: string;
  role: string;
};

export type ActivityPingInput = {
  path?: string;
  title?: string;
  watchingAnimeId?: number | null;
  watchingEpisodeId?: number | null;
  watchingAnimeTitle?: string | null;
  watchingEpisodeTitle?: string | null;
  watchingEpisodeNumber?: number | null;
};

export type ActivityPresence = {
  userId: number;
  email: string;
  username: string;
  role: string;
  path: string | null;
  title: string | null;
  lastSeenAt: Date;
  watching: {
    animeId: number | null;
    episodeId: number | null;
    animeTitle: string | null;
    episodeTitle: string | null;
    episodeNumber: number | null;
  } | null;
};

const records = new Map<number, ActivityPresence>();
const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const KEEP_WINDOW_MS = 30 * 60 * 1000;

function cleanString(value: unknown, max = 180) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function cleanNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function prune(now = Date.now()) {
  for (const [userId, record] of records) {
    if (now - record.lastSeenAt.getTime() > KEEP_WINDOW_MS) {
      records.delete(userId);
    }
  }
}

export function upsertActivityPresence(
  user: ActivityUser,
  input: ActivityPingInput = {},
) {
  prune();

  const animeId = cleanNumber(input.watchingAnimeId);
  const episodeId = cleanNumber(input.watchingEpisodeId);
  const animeTitle = cleanString(input.watchingAnimeTitle);
  const episodeTitle = cleanString(input.watchingEpisodeTitle);
  const episodeNumber = cleanNumber(input.watchingEpisodeNumber);
  const hasWatching = Boolean(animeId || episodeId || animeTitle || episodeTitle);

  const record: ActivityPresence = {
    userId: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    path: cleanString(input.path, 260),
    title: cleanString(input.title, 180),
    lastSeenAt: new Date(),
    watching: hasWatching
      ? { animeId, episodeId, animeTitle, episodeTitle, episodeNumber }
      : null,
  };

  records.set(user.id, record);
  return record;
}

export function getActivityPresenceSnapshot() {
  prune();
  return [...records.values()].sort(
    (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
  );
}

export function isActivityOnline(lastSeenAt?: Date | string | null) {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() <= ONLINE_WINDOW_MS;
}

export function activityPresenceConfig() {
  return {
    onlineWindowSeconds: Math.round(ONLINE_WINDOW_MS / 1000),
    keepWindowSeconds: Math.round(KEEP_WINDOW_MS / 1000),
  };
}
