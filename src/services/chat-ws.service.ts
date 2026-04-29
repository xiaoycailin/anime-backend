import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { createRedisSubscriber, redis } from "../lib/redis";
import {
  CHAT_BROADCAST_CHANNEL,
  CHAT_GLOBAL_ROOM_ID,
  CHAT_ONLINE_TTL_SECONDS,
  CHAT_TYPING_TTL_SECONDS,
} from "./chat.config";
import {
  editChatMessage,
  getChatRoomForAccess,
  loadChatMessages,
  softDeleteChatMessage,
  storeWeebinAiMessage,
  storeChatMessage,
  updateWeebinAiMessage,
  WEEBIN_AI_USERNAME,
} from "./chat.service";
import { runWeebinAiChatbot } from "./openai-services/chatbot/core";
import { hasWeebinAiMention } from "./openai-services/chatbot/skills";
import type { ChatbotStatus } from "./openai-services/chatbot/types";
import type { ChatContextPayload, ChatMessagePayload, ChatSocketUser } from "./chat.types";

type ChatClientEvent =
  | { event: "chat:join"; roomId?: string }
  | { event: "chat:leave"; roomId?: string }
  | {
      event: "chat:message:send";
      roomId?: string;
      content?: string;
      context?: unknown;
      contexts?: unknown;
      replyToId?: unknown;
      type?: string;
    }
  | { event: "chat:message:delete"; roomId?: string; messageId?: string }
  | {
      event: "chat:message:edit";
      roomId?: string;
      messageId?: string;
      content?: string;
    }
  | { event: "chat:typing:start"; roomId?: string }
  | { event: "chat:typing:stop"; roomId?: string }
  | { event: "chat:read"; roomId?: string; lastReadAt?: number };

type ChatServerEvent =
  | { event: "chat:message:new"; roomId: string; message: ChatMessagePayload }
  | {
      event: "chat:message:update";
      roomId: string;
      message: ChatMessagePayload;
    }
  | { event: "chat:message:error"; code: string; message: string }
  | {
      event: "chat:typing:update";
      roomId: string;
      userId: string;
      username: string;
      typing: boolean;
      status?: string | null;
    }
  | {
      event: "chat:ai:status";
      roomId: string;
      messageId: string;
      status: string;
    }
  | {
      event: "chat:ai:delta";
      roomId: string;
      messageId: string;
      delta: string;
      text: string;
    }
  | {
      event: "chat:ai:cards";
      roomId: string;
      messageId: string;
      cards: ChatContextPayload[];
    }
  | { event: "chat:user:online"; userId: string }
  | { event: "chat:user:offline"; userId: string }
  | {
      event: "chat:slowmode:error";
      code: string;
      message: string;
      remainingSeconds: number;
    }
  | {
      event: "chat:room:update";
      roomId: string;
      payload: Record<string, unknown>;
    };

type ChatSocketClient = {
  id: string;
  socket: Duplex;
  user: ChatSocketUser;
  rooms: Set<string>;
  buffer: Buffer;
  heartbeat: NodeJS.Timeout;
};

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const clients = new Map<string, ChatSocketClient>();
const rooms = new Map<string, Set<string>>();
let subscriberStarted = false;

function encodeFrame(payload: string) {
  const body = Buffer.from(payload);
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  }
  if (body.length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function send(client: ChatSocketClient, event: ChatServerEvent) {
  if (client.socket.destroyed) return;
  client.socket.write(encodeFrame(JSON.stringify(event)));
}

function sendError(client: ChatSocketClient, code: string, message: string) {
  send(client, { event: "chat:message:error", code, message });
}

function broadcastLocal(roomId: string, event: ChatServerEvent) {
  const socketIds = rooms.get(roomId);
  if (!socketIds) return;
  for (const socketId of socketIds) {
    const client = clients.get(socketId);
    if (client) send(client, event);
  }
}

async function publishRoomEvent(roomId: string, event: ChatServerEvent) {
  broadcastLocal(roomId, event);
  await redis.publish(
    CHAT_BROADCAST_CHANNEL,
    JSON.stringify({ roomId, event }),
  );
}

export async function publishChatMessageUpdate(
  roomId: string,
  message: ChatMessagePayload,
) {
  await publishRoomEvent(roomId, {
    event: "chat:message:update",
    roomId,
    message,
  });
}

async function publishWeebinAiTyping(
  roomId: string,
  messageId: string,
  typing: boolean,
  status?: ChatbotStatus,
) {
  await publishRoomEvent(roomId, {
    event: "chat:typing:update",
    roomId,
    userId: "21",
    username: "WeebinAI",
    typing,
    status: status ?? null,
  });

  if (typing && status) {
    await publishRoomEvent(roomId, {
      event: "chat:ai:status",
      roomId,
      messageId,
      status,
    });
  }
}

async function updateAndPublishWeebinAiMessage(input: {
  roomId: string;
  messageId: string;
  content: string;
  contexts?: ChatContextPayload[];
}) {
  const message = await updateWeebinAiMessage(input);
  if (!message) return null;
  await publishRoomEvent(input.roomId, {
    event: "chat:message:update",
    roomId: input.roomId,
    message,
  });
  return message;
}

async function getRecentWeebinAiContextMessages(
  roomId: string,
  userMessage: ChatMessagePayload,
) {
  const response = await loadChatMessages({ roomId, limit: 14 });
  return response.messages
    .filter((message) => message.id !== userMessage.id && !message.deletedAt)
    .filter((message) => typeof message.content === "string" && message.content.trim())
    .slice(-8)
    .map((message) => ({
      role:
        message.senderUsername?.toLowerCase() === WEEBIN_AI_USERNAME
          ? ("assistant" as const)
          : ("user" as const),
      content: message.content,
    }));
}

async function answerWeebinAiMention(
  roomId: string,
  userMessage: ChatMessagePayload,
) {
  let botMessage: ChatMessagePayload | null = null;
  let fullText = "";
  let cards: ChatContextPayload[] = [];

  try {
    const recentMessages = await getRecentWeebinAiContextMessages(
      roomId,
      userMessage,
    );

    botMessage = await storeWeebinAiMessage({
      roomId,
      content: "",
      replyToId: userMessage.id,
    });

    await publishRoomEvent(roomId, {
      event: "chat:message:new",
      roomId,
      message: botMessage,
    });

    await publishWeebinAiTyping(
      roomId,
      botMessage.id,
      true,
      "WeebinAI sedang berfikir...",
    );

    const result = await runWeebinAiChatbot(
      {
        content: userMessage.content,
        mentionedBot: true,
        messages: recentMessages,
      },
      {
        onStatus: async (status) => {
          if (!botMessage) return;
          await publishWeebinAiTyping(roomId, botMessage.id, true, status);
        },
        onDelta: async (delta, text) => {
          if (!botMessage) return;
          fullText = text;
          await publishRoomEvent(roomId, {
            event: "chat:ai:delta",
            roomId,
            messageId: botMessage.id,
            delta,
            text,
          });
          await updateAndPublishWeebinAiMessage({
            roomId,
            messageId: botMessage.id,
            content: fullText,
            contexts: cards,
          });
        },
        onCards: async (nextCards) => {
          if (!botMessage) return;
          cards = nextCards;
          await publishRoomEvent(roomId, {
            event: "chat:ai:cards",
            roomId,
            messageId: botMessage.id,
            cards,
          });
          await updateAndPublishWeebinAiMessage({
            roomId,
            messageId: botMessage.id,
            content: fullText,
            contexts: cards,
          });
        },
      },
    );

    fullText = result.text;
    cards = result.cards;
    await updateAndPublishWeebinAiMessage({
      roomId,
      messageId: botMessage.id,
      content: fullText,
      contexts: cards,
    });
    await publishWeebinAiTyping(roomId, botMessage.id, false);
  } catch {
    if (botMessage) {
      await updateAndPublishWeebinAiMessage({
        roomId,
        messageId: botMessage.id,
        content:
          "Maaf Animers, WeebinAI lagi belum bisa jawab sekarang. Coba lagi sebentar ya.",
        contexts: cards,
      });
      await publishWeebinAiTyping(roomId, botMessage.id, false);
    }
  }
}

function joinRoom(client: ChatSocketClient, roomId: string) {
  client.rooms.add(roomId);
  const socketIds = rooms.get(roomId) ?? new Set<string>();
  socketIds.add(client.id);
  rooms.set(roomId, socketIds);
}

function leaveRoom(client: ChatSocketClient, roomId: string) {
  client.rooms.delete(roomId);
  const socketIds = rooms.get(roomId);
  if (!socketIds) return;
  socketIds.delete(client.id);
  if (socketIds.size === 0) rooms.delete(roomId);
}

function parseFrames(client: ChatSocketClient) {
  const messages: string[] = [];
  let buffer = client.buffer;

  while (buffer.length >= 2) {
    const opcode = buffer[0] & 0x0f;
    let offset = 2;
    let length = buffer[1] & 0x7f;
    const masked = Boolean(buffer[1] & 0x80);

    if (length === 126) {
      if (buffer.length < offset + 2) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) break;
      const bigLength = buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(64 * 1024)) {
        client.socket.destroy();
        break;
      }
      length = Number(bigLength);
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (buffer.length < offset + maskLength + length) break;

    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    buffer = buffer.subarray(offset + length);

    if (mask) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4];
      }
    }

    if (opcode === 0x8) {
      client.socket.end();
      break;
    }
    if (opcode === 0x9) {
      client.socket.write(Buffer.from([0x8a, 0x00]));
      continue;
    }
    if (opcode === 0x1) {
      messages.push(payload.toString("utf8"));
    }
  }

  client.buffer = buffer;
  return messages;
}

function getTokenFromRequest(request: IncomingMessage) {
  const url = new URL(request.url ?? "", "http://localhost");
  const queryToken =
    url.searchParams.get("token") ?? url.searchParams.get("access_token");
  if (queryToken) return queryToken;

  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);

  return null;
}

async function setOnline(client: ChatSocketClient) {
  const key = `chat:online:${client.user.id}`;
  await redis.set(
    key,
    JSON.stringify({
      userId: String(client.user.id),
      socketId: client.id,
      lastSeen: Date.now(),
    }),
    "EX",
    CHAT_ONLINE_TTL_SECONDS,
  );
}

async function markOfflineIfNeeded(client: ChatSocketClient) {
  const stillOnline = Array.from(clients.values()).some(
    (item) => item.user.id === client.user.id && item.id !== client.id,
  );
  if (stillOnline) return;
  await redis.del(`chat:online:${client.user.id}`);
  for (const roomId of client.rooms) {
    await publishRoomEvent(roomId, {
      event: "chat:user:offline",
      userId: String(client.user.id),
    });
  }
}

async function handleClientEvent(client: ChatSocketClient, input: string) {
  let payload: ChatClientEvent;
  try {
    payload = JSON.parse(input) as ChatClientEvent;
  } catch {
    sendError(client, "INVALID_JSON", "Payload chat tidak valid");
    return;
  }

  const roomId = payload.roomId ? String(payload.roomId) : "";
  const targetRoomId = roomId || CHAT_GLOBAL_ROOM_ID;

  try {
    if (payload.event === "chat:join") {
      await getChatRoomForAccess(targetRoomId, client.user);
      joinRoom(client, targetRoomId);
      await setOnline(client);
      await publishRoomEvent(targetRoomId, {
        event: "chat:user:online",
        userId: String(client.user.id),
      });
      return;
    }

    if (payload.event === "chat:leave") {
      leaveRoom(client, targetRoomId);
      return;
    }

    if (payload.event === "chat:message:send") {
      if (!client.rooms.has(targetRoomId)) {
        await getChatRoomForAccess(targetRoomId, client.user);
        joinRoom(client, targetRoomId);
      }
      const result = await storeChatMessage({
        roomId: targetRoomId,
        user: client.user,
        content: payload.content,
        context: payload.context,
        contexts: payload.contexts,
        replyToId: payload.replyToId,
        type: payload.type,
      });

      if (!result.ok) {
        send(client, { event: "chat:slowmode:error", ...result.error });
        return;
      }

      await publishRoomEvent(targetRoomId, {
        event: "chat:message:new",
        roomId: targetRoomId,
        message: result.message,
      });

      if (
        result.message.senderUsername !== WEEBIN_AI_USERNAME &&
        hasWeebinAiMention(result.message.content)
      ) {
        void answerWeebinAiMention(targetRoomId, result.message);
      }
      return;
    }

    if (payload.event === "chat:message:delete") {
      if (!payload.messageId) {
        sendError(client, "INVALID_MESSAGE", "ID pesan tidak valid");
        return;
      }
      const result = await softDeleteChatMessage({
        roomId: targetRoomId,
        user: client.user,
        messageId: payload.messageId,
      });
      if (!result.ok) {
        sendError(client, result.code, "Chat tidak ditemukan");
        return;
      }
      await publishRoomEvent(targetRoomId, {
        event: "chat:message:update",
        roomId: targetRoomId,
        message: result.message,
      });
      return;
    }

    if (payload.event === "chat:message:edit") {
      if (!payload.messageId) {
        sendError(client, "INVALID_MESSAGE", "ID pesan tidak valid");
        return;
      }
      const result = await editChatMessage({
        roomId: targetRoomId,
        user: client.user,
        messageId: payload.messageId,
        content: payload.content,
      });
      if (!result.ok) {
        sendError(client, result.code, "Chat tidak ditemukan");
        return;
      }
      await publishRoomEvent(targetRoomId, {
        event: "chat:message:update",
        roomId: targetRoomId,
        message: result.message,
      });
      return;
    }

    if (
      payload.event === "chat:typing:start" ||
      payload.event === "chat:typing:stop"
    ) {
      if (!client.rooms.has(targetRoomId)) return;
      const typing = payload.event === "chat:typing:start";
      const key = `chat:typing:${targetRoomId}:${client.user.id}`;
      if (typing) {
        await redis.set(key, "1", "EX", CHAT_TYPING_TTL_SECONDS);
      } else {
        await redis.del(key);
      }
      await publishRoomEvent(targetRoomId, {
        event: "chat:typing:update",
        roomId: targetRoomId,
        userId: String(client.user.id),
        username: client.user.username,
        typing,
        status: null,
      });
      return;
    }

    if (payload.event === "chat:read") {
      await publishRoomEvent(targetRoomId, {
        event: "chat:room:update",
        roomId: targetRoomId,
        payload: {
          userId: String(client.user.id),
          lastReadAt: payload.lastReadAt ?? Date.now(),
        },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat error";
    sendError(client, "CHAT_ERROR", message);
  }
}

function cleanupClient(client: ChatSocketClient) {
  clearInterval(client.heartbeat);
  clients.delete(client.id);
  for (const roomId of Array.from(client.rooms)) {
    leaveRoom(client, roomId);
  }
  void markOfflineIfNeeded(client);
}

function startSubscriber() {
  if (subscriberStarted) return;
  subscriberStarted = true;
  const subscriber = createRedisSubscriber();
  void subscriber.subscribe(CHAT_BROADCAST_CHANNEL);
  subscriber.on("message", (_channel, raw) => {
    try {
      const payload = JSON.parse(raw) as {
        roomId: string;
        event: ChatServerEvent;
      };
      broadcastLocal(payload.roomId, payload.event);
    } catch {
      // ignore malformed cross-instance messages
    }
  });
}

export function registerChatWebSocket(app: FastifyInstance) {
  startSubscriber();

  app.server.on("upgrade", async (request, socket) => {
    const url = new URL(request.url ?? "", "http://localhost");
    if (url.pathname !== "/api/chat/ws") return;

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const token = getTokenFromRequest(request);
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    let user: ChatSocketUser;
    try {
      user = app.jwt.verify<ChatSocketUser>(token);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(key + WS_MAGIC)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );

    const client: ChatSocketClient = {
      id: crypto.randomUUID(),
      socket,
      user,
      rooms: new Set(),
      buffer: Buffer.alloc(0),
      heartbeat: setInterval(() => {
        void setOnline(client);
      }, 30_000),
    };
    client.heartbeat.unref?.();
    clients.set(client.id, client);
    await setOnline(client);
    await getChatRoomForAccess(CHAT_GLOBAL_ROOM_ID, client.user);
    joinRoom(client, CHAT_GLOBAL_ROOM_ID);
    await publishRoomEvent(CHAT_GLOBAL_ROOM_ID, {
      event: "chat:user:online",
      userId: String(client.user.id),
    });

    socket.on("data", (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      const messages = parseFrames(client);
      for (const message of messages) {
        void handleClientEvent(client, message);
      }
    });

    socket.on("close", () => cleanupClient(client));
    socket.on("error", () => cleanupClient(client));
  });
}
