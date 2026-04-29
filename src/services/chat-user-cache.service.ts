import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { getEquippedDecorations } from "./decoration.service";
import { CHAT_USER_CACHE_TTL_SECONDS } from "./chat.config";
import type { ChatUserSnapshot } from "./chat.types";

function userCacheKey(userId: number) {
  return `chat:user:${userId}:profile`;
}

export async function getChatUserSnapshot(
  userId: number,
): Promise<ChatUserSnapshot> {
  const cached = await redis.get(userCacheKey(userId));
  if (cached) {
    try {
      const snapshot = JSON.parse(cached) as Partial<ChatUserSnapshot>;
      if (
        typeof snapshot.isVerified === "boolean" &&
        typeof snapshot.level === "number"
      ) {
        return snapshot as ChatUserSnapshot;
      }
      await redis.del(userCacheKey(userId));
    } catch {
      await redis.del(userCacheKey(userId));
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      fullName: true,
      avatar: true,
      role: true,
      isVerified: true,
      level: true,
    },
  });

  if (!user) {
    throw new Error("CHAT_USER_NOT_FOUND");
  }

  const decorations = await getEquippedDecorations(user.id);
  const snapshot: ChatUserSnapshot = {
    id: user.id,
    name: user.fullName?.trim() || user.username,
    username: user.username,
    fullName: user.fullName,
    avatar: user.avatar,
    isVerified: Boolean(user.isVerified),
    verifiedAt: null,
    level: Math.max(1, Number(user.level ?? 1)),
    nageTag: decorations.nametag,
    frame: decorations.frame,
    role: user.role,
  };

  await redis.set(
    userCacheKey(user.id),
    JSON.stringify(snapshot),
    "EX",
    CHAT_USER_CACHE_TTL_SECONDS,
  );

  return snapshot;
}

export async function invalidateChatUserSnapshot(userId: number) {
  await redis.del(userCacheKey(userId));
}
