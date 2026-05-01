import Redis, { type RedisOptions } from "ioredis";

const REDIS_DB_INDEX = 5;
const REDIS_KEY_PREFIX = "app:";

const globalForRedis = global as unknown as {
  redis?: Redis;
};

function buildRedisOptions(): RedisOptions {
  const port = Number(process.env.REDIS_PORT) || 6379;
  const host = process.env.REDIS_HOST || "127.0.0.1";
  const password = process.env.REDIS_PASSWORD || undefined;

  return {
    host,
    port,
    password,
    db: REDIS_DB_INDEX,
    keyPrefix: REDIS_KEY_PREFIX,
    lazyConnect: false,
    enableAutoPipelining: true,
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 3000);
      return delay;
    },
    reconnectOnError(error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ECONNRESET" || code === "ETIMEDOUT") return 2;
      return false;
    },
  };
}

function createRedisClient(): Redis {
  const client = new Redis(buildRedisOptions());

  client.on("connect", () => {
    console.log(`[redis] connecting (db=${REDIS_DB_INDEX})`);
  });

  client.on("ready", () => {
    console.log(`[redis] ready (db=${REDIS_DB_INDEX})`);
  });

  client.on("error", (error) => {
    console.error("[redis] error:", error.message);
  });

  client.on("end", () => {
    console.warn("[redis] connection closed");
  });

  return client;
}

export const redis: Redis = globalForRedis.redis ?? createRedisClient();

export function createRedisSubscriber(): Redis {
  // Subscribe connections cannot share state with the main client.
  // Use the same options so keyPrefix ("app:") is applied to channels too.
  const client = new Redis(buildRedisOptions());
  client.on("error", (error) => {
    console.error("[redis-sub] error:", error.message);
  });
  return client;
}

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}

export const REDIS_PREFIX = REDIS_KEY_PREFIX;
export const REDIS_DB = REDIS_DB_INDEX;

export function isRedisReady(): boolean {
  return redis.status === "ready";
}

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
