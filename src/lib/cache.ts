import { redis, REDIS_PREFIX, isRedisReady } from "./redis";

export const CACHE_TTL = {
  HOME: 90,
  POPULAR: 90,
  TRENDING: 90,
  TRENDING_WEEKLY: 90,
  BANNERS: 90,
  NEW_RELEASE: 60,
  LATEST_EPISODES: 60,
  BROWSE: 60,
  SEARCH: 45,
  ANIME_DETAIL: 600,
  EPISODE_DETAIL: 1200,
  PUBLIC_USER: 600,
  PUBLIC_USER_ACTIVITY: 600,
  GENRES: 3600,
  TAGS: 3600,
  STUDIOS: 3600,
  SUBTITLES: 36000,
} as const;

export const CACHE_KEYS = {
  home: () => "anime:list:home",
  popular: (limit: number) => `anime:list:popular:${limit}`,
  trending: (limit: number) => `anime:list:trending:${limit}`,
  trendingWeekly: (limit: number) => `anime:list:trending-weekly:${limit}`,
  banners: (queryKey: string) => `anime:list:banners:${queryKey}`,
  newRelease: (limit: number) => `anime:list:new-release:${limit}`,
  latestEpisodes: (limit: number) => `episode:list:latest:${limit}`,
  random: (limit: number) => `anime:list:random:${limit}`,
  browse: (queryKey: string) => `anime:list:browse:${queryKey}`,
  search: (queryKey: string) => `anime:list:search:${queryKey}`,
  animeDetail: (slug: string) => `anime:detail:${slug}`,
  episodeDetail: (animeSlug: string, episodeSlug: string) =>
    `anime:episode:${animeSlug}:v2:${episodeSlug}`,
  publicUser: (userId: number) => `user:public:${userId}`,
  publicUserHistory: (userId: number, page: number, limit: number) =>
    `user:public:${userId}:history:${page}:${limit}`,
  publicUserSaved: (userId: number, page: number, limit: number) =>
    `user:public:${userId}:saved:${page}:${limit}`,
  publicUserComments: (userId: number, page: number, limit: number) =>
    `user:public:${userId}:comments:${page}:${limit}`,
  genres: () => "anime:meta:genres",
  tags: (limit: number) => `anime:meta:tags:${limit}`,
  studios: (limit: number) => `anime:meta:studios:${limit}`,
  subtitleVtt: (episodeId: number, serverId: number, language: string) =>
    `subtitle:vtt:${episodeId}:${serverId}:${language}`,
} as const;

const CACHE_PATTERNS = {
  allAnimeLists: "anime:list:*",
  allSearch: "anime:list:search:*",
  allBrowse: "anime:list:browse:*",
  allMeta: "anime:meta:*",
  allEpisodeLists: "episode:list:*",
  episodesOfAnime: (animeSlug: string) => `anime:episode:${animeSlug}:*`,
} as const;

export const CACHE_INVALIDATION_PATTERNS = CACHE_PATTERNS;

type Logger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string, err?: unknown) => void;
};

const defaultLogger: Logger = {
  info: (msg) => console.log(`[cache] ${msg}`),
  warn: (msg) => console.warn(`[cache] ${msg}`),
  error: (msg, err) => console.error(`[cache] ${msg}`, err ?? ""),
};

let logger: Logger = defaultLogger;

export function setCacheLogger(custom: Logger) {
  logger = { ...defaultLogger, ...custom };
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      return val;
    });
  } catch (error) {
    logger.error?.("failed to serialize cache value", error);
    return null;
  }
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logger.error?.("failed to parse cached value", error);
    return null;
  }
}

export async function getCache<T>(key: string): Promise<T | null> {
  if (!isRedisReady()) return null;

  try {
    const raw = await redis.get(key);
    if (raw === null) {
      logger.info?.(`MISS ${key}`);
      return null;
    }
    logger.info?.(`HIT ${key}`);
    return safeParse<T>(raw);
  } catch (error) {
    logger.error?.(`getCache failed for ${key}`, error);
    return null;
  }
}

export async function setCache<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<boolean> {
  if (!isRedisReady()) return false;
  if (value === undefined || value === null) return false;

  const payload = safeStringify(value);
  if (payload === null) return false;

  const ttl = Math.max(1, Math.floor(ttlSeconds));

  try {
    await redis.set(key, payload, "EX", ttl);
    logger.info?.(`SET ${key} ttl=${ttl}s`);
    return true;
  } catch (error) {
    logger.error?.(`setCache failed for ${key}`, error);
    return false;
  }
}

export async function deleteCache(...keys: string[]): Promise<number> {
  if (!isRedisReady() || keys.length === 0) return 0;

  try {
    const removed = await redis.del(...keys);
    if (removed > 0) {
      logger.info?.(`DEL ${keys.join(", ")} (removed=${removed})`);
    }
    return removed;
  } catch (error) {
    logger.error?.(`deleteCache failed for ${keys.join(", ")}`, error);
    return 0;
  }
}

export async function deleteByPattern(pattern: string): Promise<number> {
  if (!isRedisReady() || !pattern) return 0;

  const matchPattern = `${REDIS_PREFIX}${pattern}`;
  let totalRemoved = 0;

  try {
    const stream = redis.scanStream({
      match: matchPattern,
      count: 200,
    });

    const pendingDeletes: Promise<unknown>[] = [];

    await new Promise<void>((resolve, reject) => {
      stream.on("data", (rawKeys: string[]) => {
        if (!rawKeys || rawKeys.length === 0) return;

        const stripped = rawKeys.map((key) =>
          key.startsWith(REDIS_PREFIX) ? key.slice(REDIS_PREFIX.length) : key,
        );

        pendingDeletes.push(
          redis
            .del(...stripped)
            .then((count) => {
              totalRemoved += count;
            })
            .catch((error) => {
              logger.error?.(`SCAN del batch failed`, error);
            }),
        );
      });

      stream.on("end", resolve);
      stream.on("error", reject);
    });

    await Promise.all(pendingDeletes);

    if (totalRemoved > 0) {
      logger.info?.(`DEL pattern=${pattern} (removed=${totalRemoved})`);
    }
    return totalRemoved;
  } catch (error) {
    logger.error?.(`deleteByPattern failed for ${pattern}`, error);
    return 0;
  }
}

export async function getOrSetCache<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = await getCache<T>(key);
  if (cached !== null) return cached;

  const fresh = await loader();
  await setCache(key, fresh, ttlSeconds);
  return fresh;
}

export async function incrementCache(
  key: string,
  by = 1,
): Promise<number | null> {
  if (!isRedisReady()) return null;
  try {
    return await redis.incrby(key, by);
  } catch (error) {
    logger.error?.(`incrementCache failed for ${key}`, error);
    return null;
  }
}

export async function setCacheField<T>(
  key: string,
  patch: Partial<T>,
  ttlSeconds: number,
): Promise<boolean> {
  if (!isRedisReady()) return false;

  const existing = await getCache<T>(key);
  if (existing === null || typeof existing !== "object") return false;

  const merged = { ...(existing as object), ...patch } as T;
  return setCache(key, merged, ttlSeconds);
}

export function buildQueryKey(params: Record<string, unknown>): string {
  const entries = Object.entries(params)
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    )
    .map(([key, value]) => {
      if (Array.isArray(value)) return [key, value.join(",")];
      return [key, String(value)];
    })
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) return "default";

  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

export const CacheInvalidator = {
  async onAnimeChange(slug?: string | null) {
    const tasks: Promise<unknown>[] = [
      deleteByPattern(CACHE_PATTERNS.allAnimeLists),
      deleteByPattern(CACHE_PATTERNS.allEpisodeLists),
      deleteByPattern(CACHE_PATTERNS.allMeta),
    ];
    if (slug) {
      tasks.push(deleteCache(CACHE_KEYS.animeDetail(slug)));
      tasks.push(deleteByPattern(CACHE_PATTERNS.episodesOfAnime(slug)));
    }
    await Promise.all(tasks);
  },

  async onEpisodeChange(
    animeSlug?: string | null,
    episodeSlug?: string | null,
  ) {
    const tasks: Promise<unknown>[] = [
      deleteByPattern(CACHE_PATTERNS.allEpisodeLists),
      deleteByPattern(CACHE_PATTERNS.allAnimeLists),
    ];
    if (animeSlug) {
      tasks.push(deleteCache(CACHE_KEYS.animeDetail(animeSlug)));
      if (episodeSlug) {
        tasks.push(
          deleteCache(CACHE_KEYS.episodeDetail(animeSlug, episodeSlug)),
        );
      } else {
        tasks.push(deleteByPattern(CACHE_PATTERNS.episodesOfAnime(animeSlug)));
      }
    }
    await Promise.all(tasks);
  },

  async onBulkAnimeChange() {
    await Promise.all([
      deleteByPattern(CACHE_PATTERNS.allAnimeLists),
      deleteByPattern(CACHE_PATTERNS.allEpisodeLists),
      deleteByPattern(CACHE_PATTERNS.allMeta),
      deleteByPattern("anime:detail:*"),
      deleteByPattern("anime:episode:*"),
    ]);
  },

  async onPublicUserChange(userId?: number | null) {
    if (!userId) return;
    await Promise.all([
      deleteCache(CACHE_KEYS.publicUser(userId)),
      deleteByPattern(`user:public:${userId}:*`),
    ]);
  },

  async onPublicUsersChange(userIds: Array<number | null | undefined>) {
    const uniqueIds = Array.from(
      new Set(
        userIds.filter(
          (userId): userId is number =>
            typeof userId === "number" && Number.isFinite(userId) && userId > 0,
        ),
      ),
    );
    await Promise.all(
      uniqueIds.map((userId) => this.onPublicUserChange(userId)),
    );
  },
};
