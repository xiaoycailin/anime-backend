import { randomUUID } from "crypto";
import { prisma } from "../../lib/prisma";
import { badRequest, forbidden, notFound } from "../../utils/http-error";
import {
  CS_BOT_DISPLAY_NAME,
  CS_BOT_USERNAME,
  SUPPORT_MESSAGES_MAX_PAGE,
} from "./support.constants";
import {
  appendSupportMessage,
  clearSupportMessages,
  readSupportMessages,
  readSupportMeta,
  supportUserActiveConvKey,
  touchSupportTTL,
  writeSupportMeta,
} from "./support.redis";
import type {
  SupportConversationEnvelope,
  SupportConversationMeta,
  SupportConversationPriority,
  SupportConversationStatus,
  SupportListConversationsRow,
  SupportMessagePayload,
  SupportMessageSenderType,
  SupportMessageSource,
} from "./support.types";
import { publishSupportConversationCleared, publishSupportMessageNew } from "./support-ws.service";

function nowMs() {
  return Date.now();
}

function parseLimit(value: unknown, fallback = 60) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), SUPPORT_MESSAGES_MAX_PAGE);
}

function parseAfter(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function requireAuthUser<T extends { id: number }>(user: T | undefined): T {
  if (!user?.id) throw forbidden("Kamu harus login untuk chat CS");
  return user;
}

function toMessagePayload(input: {
  conversationId: string;
  senderType: SupportMessageSenderType;
  senderUserId: number | null;
  senderDisplay: SupportMessagePayload["senderDisplay"];
  content: string;
  source: SupportMessageSource;
  actions?: SupportMessagePayload["actions"];
  createdAt: number;
}): SupportMessagePayload {
  return {
    id: randomUUID(),
    conversationId: input.conversationId,
    senderType: input.senderType,
    senderUserId: input.senderUserId,
    senderDisplay: input.senderDisplay,
    content: input.content.trim(),
    source: input.source,
    actions: input.actions ?? [],
    createdAt: input.createdAt,
  };
}

async function ensureSupportMeta(conversationId: string) {
  const cached = await readSupportMeta(conversationId);
  if (cached) return cached;

  const row = await prisma.supportConversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      userId: true,
      status: true,
      priority: true,
      assignedAdminId: true,
      lastMessageAt: true,
      unreadUser: true,
      unreadAdmin: true,
      telegramChatId: true,
      telegramThreadId: true,
      lastTelegramMessageId: true,
      lastFlushedAt: true,
      lastFlushedMessageAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) throw notFound("Ticket tidak ditemukan");

  const now = nowMs();
  const meta: SupportConversationMeta = {
    id: row.id,
    userId: row.userId,
    status: row.status,
    priority: row.priority,
    assignedAdminId: row.assignedAdminId ?? null,
    lastMessageAt: row.lastMessageAt ?? null,
    lastUserMessageAt: null,
    lastAgentMessageAt: null,
    unreadUser: row.unreadUser ?? 0,
    unreadAdmin: row.unreadAdmin ?? 0,
    telegramChatId: row.telegramChatId ?? null,
    telegramThreadId: row.telegramThreadId ?? null,
    lastTelegramMessageId: row.lastTelegramMessageId ?? null,
    lastFlushedAt: row.lastFlushedAt ? row.lastFlushedAt.getTime() : null,
    lastFlushedMessageTs: row.lastFlushedMessageAt
      ? Number(row.lastFlushedMessageAt)
      : null,
    aiFailures: 0,
    createdAt: row.createdAt?.getTime?.() ?? now,
    updatedAt: row.updatedAt?.getTime?.() ?? now,
  };
  await writeSupportMeta(meta).catch(() => null);
  return meta;
}

export async function ensureSupportConversationForUser(userId: number) {
  const activeKey = supportUserActiveConvKey(userId);
  const existingId = await prisma.supportConversation.findFirst({
    where: { userId, status: { not: "resolved" } },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
  });

  const convId = existingId?.id ?? randomUUID();
  if (!existingId) {
    await prisma.supportConversation.create({
      data: {
        id: convId,
        userId,
        status: "ai_active",
        priority: "normal",
      },
    });
  }
  await prisma.supportConversation
    .update({
      where: { id: convId },
      data: { updatedAt: new Date() },
    })
    .catch(() => null);

  const now = nowMs();
  const meta: SupportConversationMeta = {
    id: convId,
    userId,
    status: "ai_active",
    priority: "normal",
    assignedAdminId: null,
    lastMessageAt: null,
    lastUserMessageAt: null,
    lastAgentMessageAt: null,
    unreadUser: 0,
    unreadAdmin: 0,
    telegramChatId: null,
    telegramThreadId: null,
    lastTelegramMessageId: null,
    lastFlushedAt: null,
    lastFlushedMessageTs: null,
    aiFailures: 0,
    createdAt: now,
    updatedAt: now,
  };

  const cached = await readSupportMeta(convId);
  if (!cached) {
    await writeSupportMeta(meta);
  } else {
    await touchSupportTTL(convId, cached.status);
  }

  // Track active conversation in Redis to reduce DB lookups.
  // Not fatal if it fails (Redis down).
  const { redis } = await import("../../lib/redis");
  await redis.set(activeKey, convId).catch(() => null);

  return convId;
}

export async function getSupportConversationMetaForUser(input: {
  user: { id: number; role?: string; username?: string } | undefined;
}) {
  const user = requireAuthUser(input.user);
  const convId = await ensureSupportConversationForUser(user.id);
  const meta = await readSupportMeta(convId);
  if (meta) return meta;

  const row = await prisma.supportConversation.findUnique({
    where: { id: convId },
    select: {
      id: true,
      userId: true,
      status: true,
      priority: true,
      assignedAdminId: true,
      lastMessageAt: true,
      unreadUser: true,
      unreadAdmin: true,
      telegramChatId: true,
      telegramThreadId: true,
      lastTelegramMessageId: true,
      lastFlushedAt: true,
      lastFlushedMessageAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) throw notFound("Conversation CS tidak ditemukan");

  const now = nowMs();
  const hydrated: SupportConversationMeta = {
    id: row.id,
    userId: row.userId,
    status: row.status,
    priority: row.priority,
    assignedAdminId: row.assignedAdminId ?? null,
    lastMessageAt: row.lastMessageAt ?? null,
    lastUserMessageAt: null,
    lastAgentMessageAt: null,
    unreadUser: row.unreadUser ?? 0,
    unreadAdmin: row.unreadAdmin ?? 0,
    telegramChatId: row.telegramChatId ?? null,
    telegramThreadId: row.telegramThreadId ?? null,
    lastTelegramMessageId: row.lastTelegramMessageId ?? null,
    lastFlushedAt: row.lastFlushedAt ? row.lastFlushedAt.getTime() : null,
    lastFlushedMessageTs: row.lastFlushedMessageAt
      ? Number(row.lastFlushedMessageAt)
      : null,
    aiFailures: 0,
    createdAt: row.createdAt?.getTime?.() ?? now,
    updatedAt: row.updatedAt?.getTime?.() ?? now,
  };

  await writeSupportMeta(hydrated).catch(() => null);
  return hydrated;
}

export async function loadSupportConversationForUser(input: {
  user: { id: number; role?: string; username?: string } | undefined;
  limit?: unknown;
  after?: unknown;
}) {
  const meta = await getSupportConversationMetaForUser({ user: input.user });
  const limit = parseLimit(input.limit, 60);
  const after = parseAfter(input.after);
  const { messages, nextCursor } = await readSupportMessages({
    conversationId: meta.id,
    after,
    limit,
  });

  const serverTime = nowMs();
  const envelope: SupportConversationEnvelope = {
    meta,
    messages,
    serverTime,
    nextCursor,
  };
  return envelope;
}

export async function loadSupportMessagesAdmin(input: {
  conversationId: string;
  limit?: unknown;
  after?: unknown;
}) {
  const limit = parseLimit(input.limit, 80);
  const after = parseAfter(input.after);
  const meta = await readSupportMeta(input.conversationId);
  const { messages, nextCursor } = await readSupportMessages({
    conversationId: input.conversationId,
    after,
    limit,
  });
  return {
    meta,
    messages,
    serverTime: nowMs(),
    nextCursor,
  };
}

export async function appendSupportUserMessage(input: {
  user: { id: number; username: string; role: string } | undefined;
  conversationId: string;
  content: unknown;
}) {
  const user = requireAuthUser(input.user);
  const meta = await ensureSupportMeta(input.conversationId);
  if (!meta || meta.userId !== user.id)
    throw forbidden("Kamu tidak punya akses ke ticket ini");

  const content =
    typeof input.content === "string" ? input.content.trim() : "";
  if (!content) throw badRequest("Pesan wajib diisi");
  if (content.length > 2000) throw badRequest("Pesan terlalu panjang");

  const createdAt = nowMs();
  const message = toMessagePayload({
    conversationId: input.conversationId,
    senderType: "user",
    senderUserId: user.id,
    senderDisplay: {
      username: user.username,
      name: user.username,
      role: "user",
    },
    content,
    source: "app",
    createdAt,
  });

  if (meta.status === "resolved") {
    meta.status = "ai_active";
    meta.aiFailures = 0;
  }
  meta.lastMessageAt = createdAt;
  meta.lastUserMessageAt = createdAt;
  meta.unreadAdmin = Math.max(0, (meta.unreadAdmin ?? 0) + 1);
  meta.updatedAt = createdAt;
  await writeSupportMeta(meta);
  await appendSupportMessage(input.conversationId, message);
  await publishSupportMessageNew(input.conversationId, message).catch(() => null);
  return { meta, message };
}

export async function appendSupportAdminMessage(input: {
  admin: { id: number; username: string; role: string } | undefined;
  conversationId: string;
  content: unknown;
  source: SupportMessageSource;
}) {
  const admin = requireAuthUser(input.admin);
  if (admin.role !== "admin" && admin.role !== "moderator") {
    throw forbidden("Hanya admin yang bisa balas ticket");
  }

  const meta = await ensureSupportMeta(input.conversationId);
  if (!meta) throw notFound("Ticket tidak ditemukan");

  const content =
    typeof input.content === "string" ? input.content.trim() : "";
  if (!content) throw badRequest("Pesan wajib diisi");
  if (content.length > 4000) throw badRequest("Pesan terlalu panjang");

  const createdAt = nowMs();
  const message = toMessagePayload({
    conversationId: input.conversationId,
    senderType: "admin",
    senderUserId: admin.id,
    senderDisplay: {
      username: CS_BOT_USERNAME,
      name: CS_BOT_DISPLAY_NAME,
      role: "admin",
    },
    content,
    source: input.source,
    createdAt,
  });

  meta.status = "human_active";
  meta.assignedAdminId = meta.assignedAdminId ?? admin.id;
  meta.lastMessageAt = createdAt;
  meta.lastAgentMessageAt = createdAt;
  meta.unreadUser = Math.max(0, (meta.unreadUser ?? 0) + 1);
  meta.updatedAt = createdAt;
  await writeSupportMeta(meta);
  await appendSupportMessage(input.conversationId, message);
  await publishSupportMessageNew(input.conversationId, message).catch(() => null);
  return { meta, message };
}

export async function appendSupportAdminMessageExternal(input: {
  conversationId: string;
  content: string;
  source: SupportMessageSource;
  externalLabel: { username: string; name: string };
}) {
  const meta = await ensureSupportMeta(input.conversationId);
  if (!meta) throw notFound("Ticket tidak ditemukan");

  const content = input.content.trim();
  if (!content) throw badRequest("Pesan wajib diisi");
  if (content.length > 4000) throw badRequest("Pesan terlalu panjang");

  const createdAt = nowMs();
  const message = toMessagePayload({
    conversationId: input.conversationId,
    senderType: "admin",
    senderUserId: null,
    senderDisplay: {
      username: CS_BOT_USERNAME,
      name: CS_BOT_DISPLAY_NAME,
      role: "admin",
    },
    content,
    source: input.source,
    createdAt,
  });

  meta.status = "human_active";
  meta.lastMessageAt = createdAt;
  meta.lastAgentMessageAt = createdAt;
  meta.unreadUser = Math.max(0, (meta.unreadUser ?? 0) + 1);
  meta.updatedAt = createdAt;
  await writeSupportMeta(meta);
  await appendSupportMessage(input.conversationId, message);
  await publishSupportMessageNew(input.conversationId, message).catch(() => null);
  return { meta, message };
}

export async function appendSupportAiMessage(input: {
  conversationId: string;
  content: string;
  source: SupportMessageSource;
  actions?: SupportMessagePayload["actions"];
}) {
  const meta = await ensureSupportMeta(input.conversationId);
  if (!meta) throw notFound("Ticket tidak ditemukan");

  const createdAt = nowMs();
  const message = toMessagePayload({
    conversationId: input.conversationId,
    senderType: "ai",
    senderUserId: null,
    senderDisplay: {
      username: CS_BOT_USERNAME,
      name: CS_BOT_DISPLAY_NAME,
      role: "ai",
    },
    content: input.content,
    source: input.source,
    actions: input.actions,
    createdAt,
  });

  meta.lastMessageAt = createdAt;
  meta.lastAgentMessageAt = createdAt;
  meta.unreadUser = Math.max(0, (meta.unreadUser ?? 0) + 1);
  meta.updatedAt = createdAt;
  await writeSupportMeta(meta);
  await appendSupportMessage(input.conversationId, message);
  await publishSupportMessageNew(input.conversationId, message).catch(() => null);
  return { meta, message };
}

export async function appendSupportSystemMessage(input: {
  conversationId: string;
  content: string;
}) {
  const meta = await ensureSupportMeta(input.conversationId);
  if (!meta) throw notFound("Ticket tidak ditemukan");

  const createdAt = nowMs();
  const message = toMessagePayload({
    conversationId: input.conversationId,
    senderType: "system",
    senderUserId: null,
    senderDisplay: {
      username: CS_BOT_USERNAME,
      name: CS_BOT_DISPLAY_NAME,
      role: "system",
    },
    content: input.content,
    source: "app",
    createdAt,
  });

  meta.lastMessageAt = createdAt;
  meta.lastAgentMessageAt = createdAt;
  meta.updatedAt = createdAt;
  await writeSupportMeta(meta);
  await appendSupportMessage(input.conversationId, message);
  await publishSupportMessageNew(input.conversationId, message).catch(() => null);
  return { meta, message };
}

export async function setSupportConversationStatus(input: {
  conversationId: string;
  status: SupportConversationStatus;
  priority?: SupportConversationPriority;
  assignedAdminId?: number | null;
}) {
  const meta = await ensureSupportMeta(input.conversationId);
  if (!meta) throw notFound("Ticket tidak ditemukan");
  const updatedAt = nowMs();
  meta.status = input.status;
  if (input.priority) meta.priority = input.priority;
  if (input.assignedAdminId !== undefined)
    meta.assignedAdminId = input.assignedAdminId;
  meta.updatedAt = updatedAt;
  await writeSupportMeta(meta);
  return meta;
}

export async function requestSupportHandoff(input: {
  user: { id: number } | undefined;
  conversationId: string;
}) {
  const user = requireAuthUser(input.user);
  const meta = await ensureSupportMeta(input.conversationId);
  if (!meta || meta.userId !== user.id)
    throw forbidden("Kamu tidak punya akses ke ticket ini");
  if (meta.status !== "resolved") {
    meta.status = "needs_human";
    meta.updatedAt = nowMs();
    await writeSupportMeta(meta);
  }
  return meta;
}

export async function resolveSupportConversation(input: {
  user: { id: number; role?: string } | undefined;
  conversationId: string;
}) {
  const user = requireAuthUser(input.user);
  const meta = await ensureSupportMeta(input.conversationId);
  if (!meta) throw notFound("Ticket tidak ditemukan");

  const isOwner = meta.userId === user.id;
  const isAdmin = user.role === "admin" || user.role === "moderator";
  if (!isOwner && !isAdmin) throw forbidden("Tidak punya akses");

  meta.status = "resolved";
  meta.updatedAt = nowMs();
  await writeSupportMeta(meta);
  await touchSupportTTL(meta.id, "resolved");
  return meta;
}

export async function listAdminSupportConversations(input: {
  status?: unknown;
  search?: unknown;
  page?: unknown;
  limit?: unknown;
}) {
  const page = Math.max(1, Math.floor(Number(input.page) || 1));
  const limit = Math.max(10, Math.min(50, Math.floor(Number(input.limit) || 20)));
  const status =
    typeof input.status === "string" && input.status.trim()
      ? (input.status.trim() as SupportConversationStatus)
      : null;
  const search =
    typeof input.search === "string" ? input.search.trim() : "";

  const where: any = {};
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { id: { contains: search } },
      { user: { username: { contains: search } } },
      { user: { fullName: { contains: search } } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.supportConversation.count({ where }),
    prisma.supportConversation.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        userId: true,
        status: true,
        priority: true,
        assignedAdminId: true,
        lastMessageAt: true,
        unreadUser: true,
        unreadAdmin: true,
        updatedAt: true,
        user: {
          select: {
            username: true,
            fullName: true,
            avatar: true,
          },
        },
      },
    }),
  ]);

  const data: SupportListConversationsRow[] = rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    username: row.user.username,
    fullName: row.user.fullName,
    avatar: row.user.avatar,
    status: row.status,
    priority: row.priority,
    assignedAdminId: row.assignedAdminId ?? null,
    lastMessageAt: row.lastMessageAt ?? null,
    unreadUser: row.unreadUser ?? 0,
    unreadAdmin: row.unreadAdmin ?? 0,
    updatedAt: row.updatedAt.getTime(),
  }));

  return { total, page, limit, data, serverTime: nowMs() };
}

export async function resolveSupportConversationIdFromTicket(ticket: string) {
  const raw = ticket.trim();
  const upper = raw.toUpperCase();
  if (upper.startsWith("SUP-")) {
    const prefix = raw.slice(4).trim();
    if (prefix.length < 6) throw badRequest("Ticket SUP- tidak valid");
    const row = await prisma.supportConversation.findFirst({
      where: { id: { startsWith: prefix } },
      select: { id: true },
    });
    if (!row) throw notFound("Ticket tidak ditemukan");
    return row.id;
  }

  // Accept direct UUID conversation id.
  if (!/^[0-9a-fA-F-]{16,36}$/.test(raw))
    throw badRequest("Ticket tidak valid");
  return raw;
}

export async function clearSupportConversationAdmin(input: {
  admin: { id: number; username: string; role: string } | undefined;
  conversationId: string;
}) {
  const admin = requireAuthUser(input.admin);
  if (admin.role !== "admin" && admin.role !== "moderator") {
    throw forbidden("Hanya admin yang bisa clear chat");
  }

  const meta = await ensureSupportMeta(input.conversationId);
  if (!meta) throw notFound("Ticket tidak ditemukan");

  const now = nowMs();

  // Durable delete
  await prisma.supportMessage
    .deleteMany({ where: { conversationId: input.conversationId } })
    .catch(() => null);
  await prisma.supportConversation
    .update({
      where: { id: input.conversationId },
      data: {
        status: "ai_active",
        assignedAdminId: null,
        lastMessageAt: null,
        unreadUser: 0,
        unreadAdmin: 0,
        lastFlushedAt: new Date(now),
        lastFlushedMessageAt: null,
        updatedAt: new Date(now),
      },
    })
    .catch(() => null);

  // Hot-store delete + reset meta
  await clearSupportMessages(input.conversationId).catch(() => null);
  meta.status = "ai_active";
  meta.assignedAdminId = null;
  meta.lastMessageAt = null;
  meta.lastUserMessageAt = null;
  meta.lastAgentMessageAt = null;
  meta.unreadUser = 0;
  meta.unreadAdmin = 0;
  meta.aiFailures = 0;
  meta.lastFlushedAt = now;
  meta.lastFlushedMessageTs = null;
  meta.updatedAt = now;
  await writeSupportMeta(meta).catch(() => null);
  await touchSupportTTL(meta.id, meta.status).catch(() => null);

  await publishSupportConversationCleared(meta.id).catch(() => null);
  return meta;
}
