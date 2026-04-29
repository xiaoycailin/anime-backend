export const CHAT_MESSAGE_TTL_SECONDS = toPositiveInt(
  process.env.CHAT_MESSAGE_TTL_SECONDS,
  86_400,
);
export const CHAT_ROOM_SAFETY_TTL_SECONDS = toPositiveInt(
  process.env.CHAT_ROOM_SAFETY_TTL_SECONDS,
  90_000,
);
export const CHAT_POLL_INTERVAL_SECONDS = toPositiveInt(
  process.env.CHAT_POLL_INTERVAL_SECONDS,
  10,
);
export const CHAT_DEFAULT_SLOWMODE_SECONDS = toNonNegativeInt(
  process.env.CHAT_DEFAULT_SLOWMODE_SECONDS,
  0,
);
export const CHAT_MAX_MESSAGE_LENGTH = toPositiveInt(
  process.env.CHAT_MAX_MESSAGE_LENGTH,
  1000,
);
export const CHAT_USER_CACHE_TTL_SECONDS = toPositiveInt(
  process.env.CHAT_USER_CACHE_TTL_SECONDS,
  900,
);
export const CHAT_TYPING_TTL_SECONDS = 5;
export const CHAT_ONLINE_TTL_SECONDS = 90;
export const CHAT_PUBLIC_ROOM_SLUG = "general";
export const CHAT_GLOBAL_ROOM_ID = "global";
export const CHAT_BROADCAST_CHANNEL = "chat:broadcast";

function toPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function toNonNegativeInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}
