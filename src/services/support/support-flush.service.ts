import { prisma } from "../../lib/prisma";
import { redis } from "../../lib/redis";
import { SUPPORT_FLUSH_LOCK_TTL_SECONDS } from "./support.constants";
import {
  readSupportMeta,
  supportConvMsgsKey,
  SUPPORT_DIRTY_SET_KEY,
  writeSupportMeta,
} from "./support.redis";
import type { SupportMessagePayload } from "./support.types";

function nowMs() {
  return Date.now();
}

function lockKey(conversationId: string) {
  return `support:flush:lock:${conversationId}`;
}

export async function flushSupportConversationToDb(input: {
  conversationId: string;
  force?: boolean;
}) {
  const meta = await readSupportMeta(input.conversationId);
  if (!meta) {
    await redis.srem(SUPPORT_DIRTY_SET_KEY, input.conversationId).catch(() => null);
    return { ok: false as const, reason: "META_MISSING" };
  }

  const lockOk = await redis.set(
    lockKey(input.conversationId),
    "1",
    "EX",
    SUPPORT_FLUSH_LOCK_TTL_SECONDS,
    "NX",
  );
  if (!lockOk) return { ok: false as const, reason: "LOCKED" };

  try {
    const lastFlushed = meta.lastFlushedMessageTs ?? 0;
    const rows = await redis.zrangebyscore(
      supportConvMsgsKey(input.conversationId),
      lastFlushed + 1,
      "+inf",
    );

    const messages = rows
      .map((raw) => {
        try {
          return JSON.parse(raw) as SupportMessagePayload;
        } catch {
          return null;
        }
      })
      .filter((msg): msg is SupportMessagePayload => Boolean(msg && msg.id));

    if (messages.length === 0) {
      // Even without new messages, persist conversation state (status/priority/unread)
      // so creating a new ticket after "resolved" works reliably.
      await prisma.supportConversation.upsert({
        where: { id: meta.id },
        create: {
          id: meta.id,
          userId: meta.userId,
          status: meta.status,
          priority: meta.priority,
          assignedAdminId: meta.assignedAdminId ?? undefined,
          lastMessageAt: meta.lastMessageAt ?? undefined,
          unreadUser: meta.unreadUser ?? 0,
          unreadAdmin: meta.unreadAdmin ?? 0,
          telegramChatId: meta.telegramChatId ?? undefined,
          telegramThreadId: meta.telegramThreadId ?? undefined,
          lastTelegramMessageId: meta.lastTelegramMessageId ?? undefined,
          lastFlushedAt: new Date(),
          lastFlushedMessageAt:
            meta.lastFlushedMessageTs !== null
              ? BigInt(meta.lastFlushedMessageTs)
              : undefined,
        },
        update: {
          status: meta.status,
          priority: meta.priority,
          assignedAdminId: meta.assignedAdminId ?? undefined,
          lastMessageAt: meta.lastMessageAt ?? undefined,
          unreadUser: meta.unreadUser ?? 0,
          unreadAdmin: meta.unreadAdmin ?? 0,
          telegramChatId: meta.telegramChatId ?? undefined,
          telegramThreadId: meta.telegramThreadId ?? undefined,
          lastTelegramMessageId: meta.lastTelegramMessageId ?? undefined,
          lastFlushedAt: new Date(),
          lastFlushedMessageAt:
            meta.lastFlushedMessageTs !== null
              ? BigInt(meta.lastFlushedMessageTs)
              : undefined,
        },
      });

      await redis
        .srem(SUPPORT_DIRTY_SET_KEY, input.conversationId)
        .catch(() => null);
      meta.lastFlushedAt = nowMs();
      await writeSupportMeta(meta).catch(() => null);
      return { ok: true as const, flushed: 0 };
    }

    await prisma.supportConversation.upsert({
      where: { id: meta.id },
      create: {
        id: meta.id,
        userId: meta.userId,
        status: meta.status,
        priority: meta.priority,
        assignedAdminId: meta.assignedAdminId ?? undefined,
        lastMessageAt: meta.lastMessageAt ?? undefined,
        unreadUser: meta.unreadUser ?? 0,
        unreadAdmin: meta.unreadAdmin ?? 0,
        telegramChatId: meta.telegramChatId ?? undefined,
        telegramThreadId: meta.telegramThreadId ?? undefined,
        lastTelegramMessageId: meta.lastTelegramMessageId ?? undefined,
        lastFlushedAt: new Date(),
        lastFlushedMessageAt: BigInt(messages[messages.length - 1].createdAt),
      },
      update: {
        status: meta.status,
        priority: meta.priority,
        assignedAdminId: meta.assignedAdminId ?? undefined,
        lastMessageAt: meta.lastMessageAt ?? undefined,
        unreadUser: meta.unreadUser ?? 0,
        unreadAdmin: meta.unreadAdmin ?? 0,
        telegramChatId: meta.telegramChatId ?? undefined,
        telegramThreadId: meta.telegramThreadId ?? undefined,
        lastTelegramMessageId: meta.lastTelegramMessageId ?? undefined,
        lastFlushedAt: new Date(),
        lastFlushedMessageAt: BigInt(messages[messages.length - 1].createdAt),
      },
    });

    await prisma.supportMessage.createMany({
      data: messages.map((msg) => ({
        id: msg.id,
        conversationId: msg.conversationId,
        senderType: msg.senderType,
        senderUserId: msg.senderUserId ?? undefined,
        content: msg.content,
        source: msg.source,
        createdAt: new Date(msg.createdAt),
      })),
      skipDuplicates: true,
    });

    const lastTs = messages[messages.length - 1].createdAt;
    meta.lastFlushedAt = nowMs();
    meta.lastFlushedMessageTs = lastTs;
    await writeSupportMeta(meta).catch(() => null);

    await redis.srem(SUPPORT_DIRTY_SET_KEY, input.conversationId).catch(() => null);
    return { ok: true as const, flushed: messages.length };
  } finally {
    await redis.del(lockKey(input.conversationId)).catch(() => null);
  }
}

export async function flushDirtySupportConversations(input?: {
  max?: number;
}) {
  const max = Math.max(1, Math.min(50, Number(input?.max ?? 15)));
  const conversationIds = await redis.smembers(SUPPORT_DIRTY_SET_KEY);
  const slice = conversationIds.slice(0, max);
  let flushed = 0;
  let locked = 0;

  for (const conversationId of slice) {
    const result = await flushSupportConversationToDb({ conversationId });
    if (result.ok) flushed += result.flushed ?? 0;
    else if (result.reason === "LOCKED") locked += 1;
  }

  return { checked: slice.length, flushed, locked };
}
