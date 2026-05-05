import { redis } from "../../lib/redis";
import {
  SUPPORT_ACTIVE_TTL_SECONDS,
  SUPPORT_RESOLVED_TTL_SECONDS,
} from "./support.constants";
import { SUPPORT_ACTIVE_SET_KEY } from "./support.constants";
import type { SupportConversationMeta, SupportMessagePayload } from "./support.types";

export function supportConvMetaKey(conversationId: string) {
  return `support:conv:${conversationId}:meta`;
}

export function supportConvMsgsKey(conversationId: string) {
  return `support:conv:${conversationId}:msgs`;
}

export function supportUserActiveConvKey(userId: number) {
  return `support:user:${userId}:activeConv`;
}

export const SUPPORT_DIRTY_SET_KEY = "support:dirtyConvs";

function toInt(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toNullableInt(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function toStringOrNull(value: unknown) {
  const s = typeof value === "string" ? value : "";
  const t = s.trim();
  return t ? t : null;
}

export async function readSupportMeta(
  conversationId: string,
): Promise<SupportConversationMeta | null> {
  const raw = await redis.hgetall(supportConvMetaKey(conversationId));
  if (!raw || Object.keys(raw).length === 0) return null;

  return {
    id: raw.id ?? conversationId,
    userId: toInt(raw.userId, 0),
    status: (raw.status as SupportConversationMeta["status"]) ?? "ai_active",
    priority:
      (raw.priority as SupportConversationMeta["priority"]) ?? "normal",
    assignedAdminId: toNullableInt(raw.assignedAdminId),
    lastMessageAt: raw.lastMessageAt ? toInt(raw.lastMessageAt, 0) : null,
    lastUserMessageAt: raw.lastUserMessageAt ? toInt(raw.lastUserMessageAt, 0) : null,
    lastAgentMessageAt: raw.lastAgentMessageAt ? toInt(raw.lastAgentMessageAt, 0) : null,
    unreadUser: toInt(raw.unreadUser, 0),
    unreadAdmin: toInt(raw.unreadAdmin, 0),
    telegramChatId: toStringOrNull(raw.telegramChatId),
    telegramThreadId: toStringOrNull(raw.telegramThreadId),
    lastTelegramMessageId: toStringOrNull(raw.lastTelegramMessageId),
    lastFlushedAt: raw.lastFlushedAt ? toInt(raw.lastFlushedAt, 0) : null,
    lastFlushedMessageTs: raw.lastFlushedMessageTs
      ? toInt(raw.lastFlushedMessageTs, 0)
      : null,
    aiFailures: toInt(raw.aiFailures, 0),
    createdAt: toInt(raw.createdAt, Date.now()),
    updatedAt: toInt(raw.updatedAt, Date.now()),
  };
}

export async function writeSupportMeta(meta: SupportConversationMeta) {
  const key = supportConvMetaKey(meta.id);
  await redis
    .multi()
    .hset(key, {
    id: meta.id,
    userId: String(meta.userId),
    status: meta.status,
    priority: meta.priority,
    assignedAdminId: meta.assignedAdminId ? String(meta.assignedAdminId) : "",
    lastMessageAt: meta.lastMessageAt ? String(meta.lastMessageAt) : "",
    lastUserMessageAt: meta.lastUserMessageAt ? String(meta.lastUserMessageAt) : "",
    lastAgentMessageAt: meta.lastAgentMessageAt ? String(meta.lastAgentMessageAt) : "",
    unreadUser: String(meta.unreadUser),
    unreadAdmin: String(meta.unreadAdmin),
    telegramChatId: meta.telegramChatId ?? "",
    telegramThreadId: meta.telegramThreadId ?? "",
    lastTelegramMessageId: meta.lastTelegramMessageId ?? "",
    lastFlushedAt: meta.lastFlushedAt ? String(meta.lastFlushedAt) : "",
    lastFlushedMessageTs: meta.lastFlushedMessageTs
      ? String(meta.lastFlushedMessageTs)
      : "",
    aiFailures: String(meta.aiFailures ?? 0),
    createdAt: String(meta.createdAt),
    updatedAt: String(meta.updatedAt),
    })
    .sadd(SUPPORT_ACTIVE_SET_KEY, meta.id)
    .exec();
  await touchSupportTTL(meta.id, meta.status);
}

export async function touchSupportTTL(
  conversationId: string,
  status: SupportConversationMeta["status"],
) {
  const ttl =
    status === "resolved" ? SUPPORT_RESOLVED_TTL_SECONDS : SUPPORT_ACTIVE_TTL_SECONDS;
  await redis
    .multi()
    .expire(supportConvMetaKey(conversationId), ttl)
    .expire(supportConvMsgsKey(conversationId), ttl)
    .exec();
}

export async function appendSupportMessage(
  conversationId: string,
  message: SupportMessagePayload,
) {
  const key = supportConvMsgsKey(conversationId);
  await redis
    .multi()
    .zadd(key, message.createdAt, JSON.stringify(message))
    .sadd(SUPPORT_DIRTY_SET_KEY, conversationId)
    .exec();
}

export async function clearSupportMessages(conversationId: string) {
  await redis
    .multi()
    .del(supportConvMsgsKey(conversationId))
    .srem(SUPPORT_DIRTY_SET_KEY, conversationId)
    .exec();
}

export async function readSupportMessages(input: {
  conversationId: string;
  after?: number | null;
  limit: number;
}) {
  const after = input.after ?? null;
  const key = supportConvMsgsKey(input.conversationId);
  const limit = Math.max(1, Math.min(input.limit, 200));

  let rows: string[];
  if (after !== null) {
    rows = await redis.zrangebyscore(key, after + 1, "+inf", "LIMIT", 0, limit);
  } else {
    rows = await redis.zrevrangebyscore(key, "+inf", "-inf", "LIMIT", 0, limit);
    rows.reverse();
  }

  const messages = rows
    .map((raw) => {
      try {
        const msg = JSON.parse(raw) as SupportMessagePayload;
        if (msg && !Array.isArray(msg.actions)) msg.actions = [];
        return msg;
      } catch {
        return null;
      }
    })
    .filter((msg): msg is SupportMessagePayload => Boolean(msg && msg.id));

  const nextCursor = messages[0]?.createdAt ? String(messages[0].createdAt) : null;
  return { messages, nextCursor };
}
