import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { badRequest } from "../utils/http-error";
import {
  CHAT_MAX_MESSAGE_LENGTH,
  CHAT_MESSAGE_TTL_SECONDS,
  CHAT_GLOBAL_ROOM_ID,
  CHAT_ROOM_SAFETY_TTL_SECONDS,
} from "./chat.config";
import {
  getSlowmodeStatus,
  tryAcquireSlowmodeLock,
} from "./chat-settings.service";
import { hydrateChatContexts } from "./chat-context.service";
import { sanitizeChatContent as sanitizeChatUrls } from "./chat-url.service";
import {
  getChatUserSnapshot,
  invalidateChatUserSnapshot,
} from "./chat-user-cache.service";
import { addExp } from "./exp.service";
import type {
  ChatContextPayload,
  ChatMessagePayload,
  ChatReplyPreview,
  ChatSocketUser,
} from "./chat.types";

export const WEEBIN_AI_USERNAME = "weebinai";

function roomMessagesKey(roomId: string) {
  return `chat:room:${roomId}:messages`;
}

function parseLimit(value: unknown, fallback = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), 100);
}

function parseTimestamp(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function parsePage(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.floor(parsed);
}

export function normalizeChatText(content: unknown) {
  const text =
    typeof content === "string"
      ? content.replace(/[ \t\r\n]+/g, " ").trim()
      : "";
  if (text.length > CHAT_MAX_MESSAGE_LENGTH) {
    throw badRequest(`Pesan maksimal ${CHAT_MAX_MESSAGE_LENGTH} karakter`);
  }
  return text;
}

export async function listChatRoomsForUser(_userId?: number) {
  return [
    {
      id: CHAT_GLOBAL_ROOM_ID,
      slug: "global",
      type: "public",
      title: "Chat",
      description: "Komunitas anime online",
      avatar: null,
      isActive: true,
      lastMessageAt: null,
    },
  ];
}

export function getGlobalChatRoomId() {
  return CHAT_GLOBAL_ROOM_ID;
}

export async function getChatRoomForAccess(
  roomId: string,
  _user?: ChatSocketUser,
) {
  if (roomId !== CHAT_GLOBAL_ROOM_ID)
    throw badRequest("Chat hanya tersedia untuk room global");
  return { id: CHAT_GLOBAL_ROOM_ID };
}

async function cleanupExpiredMessages(roomId: string, now = Date.now()) {
  const minScore = now - CHAT_MESSAGE_TTL_SECONDS * 1000;
  await redis.zremrangebyscore(roomMessagesKey(roomId), "-inf", minScore);
}

function parseMessage(raw: string): ChatMessagePayload | null {
  try {
    const message = JSON.parse(raw) as ChatMessagePayload;
    if (!message || typeof message.id !== "string") return null;
    return {
      ...message,
      contexts: Array.isArray(message.contexts)
        ? message.contexts
        : message.context
          ? [message.context]
          : [],
      links: Array.isArray(message.links) ? message.links : [],
      replyTo: message.replyTo ?? null,
      editedAt: message.editedAt ?? null,
      deletedAt: message.deletedAt ?? null,
      deletedBy: message.deletedBy ?? null,
      deletedByRole: message.deletedByRole ?? null,
    };
  } catch {
    return null;
  }
}

function toPublicMessage(message: ChatMessagePayload): ChatMessagePayload {
  if (!message.deletedAt) return message;
  return {
    ...message,
    content: "",
    context: null,
    contexts: [],
    links: [],
  };
}

function messageSenderId(message: ChatMessagePayload) {
  const senderId = Number(message.senderId);
  return Number.isInteger(senderId) && senderId > 0 ? senderId : null;
}

function applyFreshSenderProfile(
  message: ChatMessagePayload,
  user: {
    id: number;
    username: string;
    fullName: string | null;
    avatar: string | null;
    role: string;
    isVerified: boolean;
    level: number;
  },
): ChatMessagePayload {
  const level = Math.max(1, Number(user.level ?? message.senderLevel ?? 1));
  const displayName = user.fullName?.trim() || user.username;
  const sender = message.sender ?? {
    id: String(user.id),
    name: displayName,
    avatar: user.avatar,
    isVerified: Boolean(user.isVerified),
    verifiedAt: null,
    nageTag: message.senderNageTag,
    frame: message.senderFrame,
    role: user.role,
  };

  return {
    ...message,
    sender: {
      ...sender,
      id: String(user.id),
      name: displayName,
      username: user.username,
      fullName: user.fullName,
      avatar: user.avatar ?? sender.avatar,
      isVerified: Boolean(user.isVerified),
      level,
      role: user.role ?? sender.role ?? null,
    },
    senderName: displayName,
    senderUsername: user.username,
    senderFullName: user.fullName,
    senderLevel: level,
    senderAvatar: user.avatar ?? message.senderAvatar,
  };
}

async function hydrateMessageUserProfiles(messages: ChatMessagePayload[]) {
  const userIds = Array.from(
    new Set(
      messages
        .map(messageSenderId)
        .filter((id): id is number => typeof id === "number"),
    ),
  );
  if (userIds.length === 0) return messages;

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
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
  const userById = new Map(users.map((user) => [user.id, user]));

  return messages.map((message) => {
    const senderId = messageSenderId(message);
    const user = senderId ? userById.get(senderId) : null;
    return user ? applyFreshSenderProfile(message, user) : message;
  });
}

async function findStoredMessage(roomId: string, messageId: string) {
  const key = roomMessagesKey(roomId);
  const rows = await redis.zrange(key, 0, -1);

  for (const row of rows) {
    const message = parseMessage(row);
    if (message?.id === messageId) {
      return {
        key,
        raw: row,
        score: message.createdAt,
        message,
      };
    }
  }

  return null;
}

async function getWeebinAiSnapshot() {
  const user = await prisma.user.findUnique({
    where: { username: WEEBIN_AI_USERNAME },
    select: { id: true },
  });
  if (!user) throw new Error("WEEBIN_AI_USER_NOT_FOUND");
  return getChatUserSnapshot(user.id);
}

async function replaceStoredMessage(input: {
  key: string;
  raw: string;
  score: number;
  message: ChatMessagePayload;
}) {
  await redis
    .multi()
    .zrem(input.key, input.raw)
    .zadd(input.key, input.score, JSON.stringify(input.message))
    .expire(input.key, CHAT_ROOM_SAFETY_TTL_SECONDS)
    .exec();
}

function normalizeReplyToId(value: unknown) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id ? id.slice(0, 120) : null;
}

async function findReplyPreview(
  roomId: string,
  replyToId: unknown,
): Promise<ChatReplyPreview | null> {
  const targetId = normalizeReplyToId(replyToId);
  if (!targetId) return null;

  const rows = await redis.zrange(roomMessagesKey(roomId), 0, -1);
  for (const row of rows) {
    const message = parseMessage(row);
    if (!message || message.id !== targetId) continue;
    return {
      id: message.id,
      senderId: message.senderId,
      senderName: message.senderName,
      senderUsername: message.senderUsername ?? message.sender?.username,
      senderFullName: message.senderFullName ?? message.sender?.fullName ?? null,
      content: message.deletedAt ? "" : message.content.slice(0, 180),
      deletedAt: message.deletedAt,
    };
  }

  return null;
}

export async function loadChatMessages(input: {
  roomId?: string;
  user?: ChatSocketUser;
  limit?: unknown;
  before?: unknown;
  after?: unknown;
}) {
  const roomId = input.roomId ?? CHAT_GLOBAL_ROOM_ID;
  await getChatRoomForAccess(roomId, input.user);

  const now = Date.now();
  await cleanupExpiredMessages(roomId, now);

  const limit = parseLimit(input.limit);
  const minScore = now - CHAT_MESSAGE_TTL_SECONDS * 1000;
  const before = parseTimestamp(input.before);
  const after = parseTimestamp(input.after);
  let rows: string[];

  if (after !== null) {
    rows = await redis.zrangebyscore(
      roomMessagesKey(roomId),
      Math.max(after + 1, minScore),
      "+inf",
      "LIMIT",
      0,
      limit,
    );
  } else {
    rows = await redis.zrevrangebyscore(
      roomMessagesKey(roomId),
      before ?? "+inf",
      minScore,
      "LIMIT",
      0,
      limit,
    );
    rows.reverse();
  }

  const messages = await hydrateMessageUserProfiles(rows
    .map(parseMessage)
    .filter((message): message is ChatMessagePayload => Boolean(message))
    .filter((message) => message.expiresAt > now));
  const publicMessages = messages
    .map(toPublicMessage);

  return {
    roomId,
    messages: publicMessages,
    nextCursor: publicMessages[0]?.createdAt ? String(publicMessages[0].createdAt) : null,
    serverTime: now,
    slowmode: await getSlowmodeStatus({
      roomId,
      userId: input.user?.id,
      role: input.user?.role,
    }),
  };
}

function messageSearchText(message: ChatMessagePayload) {
  return [
    message.senderName,
    message.sender?.name,
    message.content,
    ...message.contexts.flatMap((context) => [
      context.type,
      context.title,
      context.animeTitle,
      context.description,
      context.slug,
      context.animeSlug,
      context.url,
    ]),
    ...message.links.flatMap((link) => [
      link.rawText,
      link.host,
      link.path,
      link.preview?.title,
      link.preview?.animeTitle,
      link.preview?.description,
      link.preview?.url,
    ]),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

export async function listAdminChatMessages(input: {
  roomId?: string;
  page?: unknown;
  limit?: unknown;
  search?: unknown;
}) {
  const roomId = input.roomId ?? CHAT_GLOBAL_ROOM_ID;
  const now = Date.now();
  await cleanupExpiredMessages(roomId, now);

  const page = parsePage(input.page);
  const limit = parseLimit(input.limit, 30);
  const query =
    typeof input.search === "string" ? input.search.trim().toLowerCase() : "";
  const minScore = now - CHAT_MESSAGE_TTL_SECONDS * 1000;
  const rows = await redis.zrevrangebyscore(
    roomMessagesKey(roomId),
    "+inf",
    minScore,
  );

  const allMessages = await hydrateMessageUserProfiles(rows
    .map(parseMessage)
    .filter((message): message is ChatMessagePayload => Boolean(message))
    .filter((message) => message.expiresAt > now));

  const filtered = query
    ? allMessages.filter((message) => messageSearchText(message).includes(query))
    : allMessages;
  const start = (page - 1) * limit;

  return {
    roomId,
    messages: filtered.slice(start, start + limit),
    total: filtered.length,
    page,
    limit,
    search: query,
    serverTime: now,
  };
}

export async function deleteAdminChatMessage(input: {
  roomId?: string;
  messageId: string;
  deletedBy?: number;
}) {
  const roomId = input.roomId ?? CHAT_GLOBAL_ROOM_ID;
  const result = await softDeleteChatMessage({
    roomId,
    messageId: input.messageId,
    user: {
      id: input.deletedBy ?? 0,
      username: "admin",
      role: "admin",
    },
  });
  return { deleted: result.ok, message: result.message };
}

export async function softDeleteChatMessage(input: {
  roomId?: string;
  messageId: string;
  user: ChatSocketUser;
}) {
  const roomId = input.roomId ?? CHAT_GLOBAL_ROOM_ID;
  await getChatRoomForAccess(roomId, input.user);
  const stored = await findStoredMessage(roomId, input.messageId);
  if (!stored) return { ok: false as const, code: "CHAT_NOT_FOUND" };

  const isOwner = stored.message.senderId === String(input.user.id);
  const canModerate =
    input.user.role === "admin" || input.user.role === "moderator";
  if (!isOwner && !canModerate) {
    throw badRequest("Kamu tidak bisa hapus pesan ini");
  }

  if (stored.message.deletedAt) {
    const [message] = await hydrateMessageUserProfiles([stored.message]);
    return { ok: true as const, message: toPublicMessage(message) };
  }

  const message: ChatMessagePayload = {
    ...stored.message,
    deletedAt: Date.now(),
    deletedBy: String(input.user.id),
    deletedByRole: input.user.role ?? null,
  };
  await replaceStoredMessage({
    key: stored.key,
    raw: stored.raw,
    score: stored.score,
    message,
  });

  const [hydrated] = await hydrateMessageUserProfiles([message]);
  return { ok: true as const, message: toPublicMessage(hydrated) };
}

export async function editChatMessage(input: {
  roomId?: string;
  messageId: string;
  user: ChatSocketUser;
  content: unknown;
}) {
  const roomId = input.roomId ?? CHAT_GLOBAL_ROOM_ID;
  await getChatRoomForAccess(roomId, input.user);
  const stored = await findStoredMessage(roomId, input.messageId);
  if (!stored) return { ok: false as const, code: "CHAT_NOT_FOUND" };

  if (stored.message.senderId !== String(input.user.id)) {
    throw badRequest("Kamu tidak bisa edit pesan ini");
  }
  if (stored.message.deletedAt) {
    throw badRequest("Pesan yang sudah dihapus tidak bisa diedit");
  }

  const rawContent = normalizeChatText(input.content);
  const sanitized = await sanitizeChatUrls(rawContent);
  const content = sanitized.sanitizedContent;
  if (!content && stored.message.contexts.length === 0) {
    throw badRequest("Pesan wajib diisi");
  }

  const message: ChatMessagePayload = {
    ...stored.message,
    content,
    links: sanitized.allowedLinks,
    editedAt: Date.now(),
  };
  await replaceStoredMessage({
    key: stored.key,
    raw: stored.raw,
    score: stored.score,
    message,
  });

  const [hydrated] = await hydrateMessageUserProfiles([message]);
  return { ok: true as const, message: toPublicMessage(hydrated) };
}

export async function clearAdminChatMessages(input: { roomId?: string }) {
  const roomId = input.roomId ?? CHAT_GLOBAL_ROOM_ID;
  const deleted = await redis.del(roomMessagesKey(roomId));
  return { roomId, cleared: deleted > 0 };
}

export async function storeChatMessage(input: {
  roomId?: string;
  user: ChatSocketUser;
  content: unknown;
  context?: unknown;
  contexts?: unknown;
  replyToId?: unknown;
  type?: unknown;
}) {
  const roomId = input.roomId ?? CHAT_GLOBAL_ROOM_ID;
  await getChatRoomForAccess(roomId, input.user);

  const rawContent = normalizeChatText(input.content);
  const contexts = await hydrateChatContexts(input.contexts ?? input.context);
  const sanitized = await sanitizeChatUrls(rawContent);
  const content = sanitized.sanitizedContent;
  if (!content && contexts.length === 0)
    throw badRequest("Pesan atau context wajib diisi");
  const replyTo = await findReplyPreview(roomId, input.replyToId);

  const userSnapshot = await getChatUserSnapshot(input.user.id);
  const freshUser = await prisma.user.findUnique({
    where: { id: userSnapshot.id },
    select: { level: true },
  });
  const senderLevel = Math.max(
    1,
    Number(freshUser?.level ?? userSnapshot.level ?? 1),
  );
  const slowmode = await tryAcquireSlowmodeLock({
    roomId,
    userId: input.user.id,
    role: userSnapshot.role,
  });

  if (!slowmode.ok) {
    return {
      ok: false as const,
      error: {
        code: "SLOWMODE_ACTIVE",
        message: "Tunggu beberapa detik sebelum mengirim pesan lagi.",
        remainingSeconds: slowmode.remainingSeconds,
      },
    };
  }

  const createdAt = Date.now();
  const message: ChatMessagePayload = {
    id: randomUUID(),
    roomId,
    senderId: String(userSnapshot.id),
    sender: {
      id: String(userSnapshot.id),
      name: userSnapshot.name,
      username: userSnapshot.username,
      fullName: userSnapshot.fullName,
      avatar: userSnapshot.avatar,
      isVerified: Boolean(userSnapshot.isVerified),
      verifiedAt: userSnapshot.verifiedAt,
      level: senderLevel,
      nageTag: userSnapshot.nageTag,
      frame: userSnapshot.frame,
      role: userSnapshot.role ?? null,
    },
    senderName: userSnapshot.name,
    senderUsername: userSnapshot.username,
    senderFullName: userSnapshot.fullName,
    senderLevel,
    senderAvatar: userSnapshot.avatar,
    senderNageTag: userSnapshot.nageTag,
    senderFrame: userSnapshot.frame,
    content,
    context: contexts[0] ?? null,
    contexts,
    links: sanitized.allowedLinks,
    replyTo,
    type: input.type === "system" ? "system" : "text",
    editedAt: null,
    deletedAt: null,
    deletedBy: null,
    deletedByRole: null,
    createdAt,
    expiresAt: createdAt + CHAT_MESSAGE_TTL_SECONDS * 1000,
  };

  const key = roomMessagesKey(roomId);
  await redis
    .multi()
    .zadd(key, createdAt, JSON.stringify(message))
    .expire(key, CHAT_ROOM_SAFETY_TTL_SECONDS)
    .exec();

  if (message.type !== "system") {
    try {
      const exp = await addExp(input.user.id, "chat_message", 50);
      if (exp.granted) {
        await invalidateChatUserSnapshot(input.user.id).catch(() => null);
        if (exp.level !== undefined) {
          const updatedMessage: ChatMessagePayload = {
            ...message,
            sender: {
              ...message.sender,
              level: exp.level,
            },
            senderLevel: exp.level,
          };
          return { ok: true as const, message: updatedMessage };
        }
      }
    } catch {
      // EXP should never block chat delivery.
    }
  }

  return { ok: true as const, message };
}

export async function storeWeebinAiMessage(input: {
  roomId?: string;
  content?: unknown;
  contexts?: ChatContextPayload[];
  replyToId?: unknown;
}) {
  const roomId = input.roomId ?? CHAT_GLOBAL_ROOM_ID;
  await getChatRoomForAccess(roomId);

  const bot = await getWeebinAiSnapshot();
  const content =
    typeof input.content === "string"
      ? input.content.replace(/\s+/g, " ").trim().slice(0, 1200)
      : "";
  const contexts = (input.contexts ?? []).slice(0, 5);
  const replyTo = await findReplyPreview(roomId, input.replyToId);
  const createdAt = Date.now();
  const message: ChatMessagePayload = {
    id: randomUUID(),
    roomId,
    senderId: String(bot.id),
    sender: {
      id: String(bot.id),
      name: bot.name,
      username: bot.username,
      fullName: bot.fullName,
      avatar: bot.avatar,
      isVerified: Boolean(bot.isVerified),
      verifiedAt: bot.verifiedAt,
      level: bot.level,
      nageTag: bot.nageTag,
      frame: bot.frame,
      role: bot.role ?? null,
    },
    senderName: bot.name,
    senderUsername: bot.username,
    senderFullName: bot.fullName,
    senderLevel: bot.level,
    senderAvatar: bot.avatar,
    senderNageTag: bot.nageTag,
    senderFrame: bot.frame,
    content,
    context: contexts[0] ?? null,
    contexts,
    links: [],
    replyTo,
    type: "text",
    editedAt: null,
    deletedAt: null,
    deletedBy: null,
    deletedByRole: null,
    createdAt,
    expiresAt: createdAt + CHAT_MESSAGE_TTL_SECONDS * 1000,
  };

  const key = roomMessagesKey(roomId);
  await redis
    .multi()
    .zadd(key, createdAt, JSON.stringify(message))
    .expire(key, CHAT_ROOM_SAFETY_TTL_SECONDS)
    .exec();

  return message;
}

export async function updateWeebinAiMessage(input: {
  roomId?: string;
  messageId: string;
  content?: string;
  contexts?: ChatContextPayload[];
}) {
  const roomId = input.roomId ?? CHAT_GLOBAL_ROOM_ID;
  const bot = await getWeebinAiSnapshot();
  const stored = await findStoredMessage(roomId, input.messageId);
  if (!stored || stored.message.senderId !== String(bot.id)) return null;

  const content =
    typeof input.content === "string"
      ? input.content.replace(/\s+/g, " ").trim().slice(0, 1200)
      : stored.message.content;
  const contexts = input.contexts
    ? input.contexts.slice(0, 5)
    : stored.message.contexts;
  const message: ChatMessagePayload = {
    ...stored.message,
    sender: {
      ...stored.message.sender,
      id: String(bot.id),
      name: bot.name,
      username: bot.username,
      fullName: bot.fullName,
      avatar: bot.avatar,
      isVerified: Boolean(bot.isVerified),
      verifiedAt: bot.verifiedAt,
      level: bot.level,
      nageTag: bot.nageTag,
      frame: bot.frame,
      role: bot.role ?? null,
    },
    senderName: bot.name,
    senderUsername: bot.username,
    senderFullName: bot.fullName,
    senderLevel: bot.level,
    senderAvatar: bot.avatar,
    senderNageTag: bot.nageTag,
    senderFrame: bot.frame,
    content,
    context: contexts[0] ?? null,
    contexts,
  };

  await replaceStoredMessage({
    key: stored.key,
    raw: stored.raw,
    score: stored.score,
    message,
  });

  return message;
}

export async function cleanupAllChatRooms() {
  const now = Date.now();
  await cleanupExpiredMessages(CHAT_GLOBAL_ROOM_ID, now);
  return 1;
}
