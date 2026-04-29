import { randomUUID } from "crypto";
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
import { getChatUserSnapshot } from "./chat-user-cache.service";
import type {
  ChatMessagePayload,
  ChatReplyPreview,
  ChatSocketUser,
} from "./chat.types";

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

  const messages = rows
    .map(parseMessage)
    .filter((message): message is ChatMessagePayload => Boolean(message))
    .filter((message) => message.expiresAt > now)
    .map(toPublicMessage);

  return {
    roomId,
    messages,
    nextCursor: messages[0]?.createdAt ? String(messages[0].createdAt) : null,
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

  const allMessages = rows
    .map(parseMessage)
    .filter((message): message is ChatMessagePayload => Boolean(message))
    .filter((message) => message.expiresAt > now);

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
    return { ok: true as const, message: toPublicMessage(stored.message) };
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

  return { ok: true as const, message: toPublicMessage(message) };
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

  return { ok: true as const, message: toPublicMessage(message) };
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
      avatar: userSnapshot.avatar,
      isVerified: Boolean(userSnapshot.isVerified),
      verifiedAt: userSnapshot.verifiedAt,
      nageTag: userSnapshot.nageTag,
      frame: userSnapshot.frame,
      role: userSnapshot.role ?? null,
    },
    senderName: userSnapshot.name,
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

  return { ok: true as const, message };
}

export async function cleanupAllChatRooms() {
  const now = Date.now();
  await cleanupExpiredMessages(CHAT_GLOBAL_ROOM_ID, now);
  return 1;
}
