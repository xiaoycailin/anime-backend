import { redis } from "../lib/redis";
import { badRequest } from "../utils/http-error";
import { CHAT_DEFAULT_SLOWMODE_SECONDS } from "./chat.config";
import type { ChatSlowmodeSetting } from "./chat.types";

const GLOBAL_SLOWMODE_KEY = "chat:settings:slowmode:global";

function roomSlowmodeKey(roomId: string) {
  return `chat:settings:slowmode:room:${roomId}`;
}

function normalizeSetting(
  value: unknown,
  fallbackSeconds = CHAT_DEFAULT_SLOWMODE_SECONDS,
): ChatSlowmodeSetting {
  if (!value || typeof value !== "object") {
    return {
      enabled: fallbackSeconds > 0,
      seconds: fallbackSeconds,
      updatedBy: null,
      updatedAt: 0,
    };
  }
  const raw = value as Partial<ChatSlowmodeSetting>;
  const seconds = Math.max(0, Math.min(3600, Math.floor(Number(raw.seconds) || 0)));
  return {
    enabled: Boolean(raw.enabled) && seconds > 0,
    seconds,
    updatedBy: raw.updatedBy ?? null,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

async function readSetting(
  key: string,
  fallbackSeconds = 0,
): Promise<ChatSlowmodeSetting> {
  const value = await redis.get(key);
  if (!value) return normalizeSetting(null, fallbackSeconds);
  try {
    return normalizeSetting(JSON.parse(value), fallbackSeconds);
  } catch {
    await redis.del(key);
    return normalizeSetting(null, fallbackSeconds);
  }
}

function validateSeconds(seconds: unknown) {
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 3600) {
    throw badRequest("Slowmode seconds harus 0 sampai 3600");
  }
  return Math.floor(parsed);
}

export async function getGlobalSlowmodeSetting() {
  return readSetting(GLOBAL_SLOWMODE_KEY, CHAT_DEFAULT_SLOWMODE_SECONDS);
}

export async function getRoomSlowmodeSetting(roomId: string) {
  return readSetting(roomSlowmodeKey(roomId), 0);
}

export async function listChatSettings(roomIds: string[] = []) {
  const global = await getGlobalSlowmodeSetting();
  const roomEntries = await Promise.all(
    roomIds.map(async (roomId) => [roomId, await getRoomSlowmodeSetting(roomId)] as const),
  );
  return {
    slowmode: {
      global,
      rooms: Object.fromEntries(roomEntries),
    },
  };
}

export async function updateGlobalSlowmodeSetting(input: {
  enabled?: boolean;
  seconds?: unknown;
  updatedBy: number;
}) {
  const seconds = validateSeconds(input.seconds);
  const setting: ChatSlowmodeSetting = {
    enabled: Boolean(input.enabled) && seconds > 0,
    seconds,
    updatedBy: String(input.updatedBy),
    updatedAt: Date.now(),
  };
  await redis.set(GLOBAL_SLOWMODE_KEY, JSON.stringify(setting));
  return setting;
}

export async function updateRoomSlowmodeSetting(
  roomId: string,
  input: { enabled?: boolean; seconds?: unknown; updatedBy: number },
) {
  const seconds = validateSeconds(input.seconds);
  const setting: ChatSlowmodeSetting = {
    enabled: Boolean(input.enabled) && seconds > 0,
    seconds,
    updatedBy: String(input.updatedBy),
    updatedAt: Date.now(),
  };
  await redis.set(roomSlowmodeKey(roomId), JSON.stringify(setting));
  return setting;
}

export async function resolveSlowmodeSeconds(roomId: string) {
  const room = await getRoomSlowmodeSetting(roomId);
  if (room.enabled && room.seconds > 0) return room.seconds;

  const global = await getGlobalSlowmodeSetting();
  if (global.enabled && global.seconds > 0) return global.seconds;

  return 0;
}

export async function tryAcquireSlowmodeLock(input: {
  roomId: string;
  userId: number;
  role: string;
}) {
  if (input.role === "admin" || input.role === "moderator") {
    return { ok: true as const, remainingSeconds: 0 };
  }

  const seconds = await resolveSlowmodeSeconds(input.roomId);
  if (seconds <= 0) return { ok: true as const, remainingSeconds: 0 };

  const key = `chat:slowmode:lock:${input.roomId}:${input.userId}`;
  const acquired = await redis.set(key, "1", "EX", seconds, "NX");
  if (acquired === "OK") return { ok: true as const, remainingSeconds: 0 };

  const ttl = await redis.ttl(key);
  return {
    ok: false as const,
    remainingSeconds: Math.max(1, ttl),
  };
}

export async function getSlowmodeStatus(input: {
  roomId: string;
  userId?: number;
  role?: string;
}) {
  const seconds = await resolveSlowmodeSeconds(input.roomId);
  const bypassed = input.role === "admin" || input.role === "moderator";
  if (seconds <= 0 || !input.userId || bypassed) {
    return {
      enabled: false,
      seconds,
      remainingSeconds: 0,
    };
  }

  const key = `chat:slowmode:lock:${input.roomId}:${input.userId}`;
  const ttl = await redis.ttl(key);
  return {
    enabled: true,
    seconds,
    remainingSeconds: ttl > 0 ? ttl : 0,
  };
}
