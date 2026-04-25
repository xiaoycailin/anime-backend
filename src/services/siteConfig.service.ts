import { prisma } from "../lib/prisma";

type ConfigMap = Record<string, string>;
type CacheEntry = {
  expiresAt: number;
  data: ConfigMap;
};

const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
const configCache = new Map<string, CacheEntry>();

function normalizeGroup(group?: string) {
  return group
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

function toFlatConfig(
  configs: Array<{
    key: string;
    value: string;
  }>,
) {
  return configs.reduce<ConfigMap>((acc, config) => {
    acc[config.key] = config.value;
    return acc;
  }, {});
}

export function invalidateConfigCache() {
  configCache.clear();
}

export async function getCachedConfigs(group?: string) {
  const normalizedGroup = normalizeGroup(group);
  const cacheKey = normalizedGroup || "all";
  const cached = configCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const groups = normalizedGroup?.split(",").filter(Boolean);
  const configs = await prisma.siteConfig.findMany({
    where: groups?.length ? { group: { in: groups } } : undefined,
    orderBy: [{ group: "asc" }, { key: "asc" }],
    select: {
      key: true,
      value: true,
    },
  });

  const data = toFlatConfig(configs);
  configCache.set(cacheKey, {
    data,
    expiresAt: now + CONFIG_CACHE_TTL_MS,
  });

  return data;
}

export async function getConfig(key: string) {
  const configs = await getCachedConfigs();
  return configs[key] ?? null;
}

export async function getConfigJson<T>(key: string) {
  const value = await getConfig(key);

  if (!value) return null;

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function getConfigBool(key: string) {
  const value = await getConfig(key);
  return value === "true";
}

export async function getConfigNumber(key: string) {
  const value = await getConfig(key);
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}
