import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { prisma } from "../../lib/prisma";
import { createRedisSubscriber, redis } from "../../lib/redis";
import { forbidden } from "../../utils/http-error";
import type { SupportMessagePayload } from "./support.types";

type SupportClientEvent =
  | { event: "support:join"; conversationId: string }
  | { event: "support:leave"; conversationId: string }
  | {
      event: "support:typing";
      conversationId: string;
      typing: boolean;
      text?: string;
    };

type SupportServerEvent =
  | {
      event: "support:message:new";
      conversationId: string;
      message: SupportMessagePayload;
    }
  | {
      event: "support:conversation:cleared";
      conversationId: string;
      clearedAt: number;
    }
  | {
      event: "support:typing:update";
      conversationId: string;
      userId: string;
      username: string;
      typing: boolean;
      text: string;
    };

type SupportSocketUser = { id: number; username: string; role: string };

type SupportSocketClient = {
  id: string;
  socket: Duplex;
  user: SupportSocketUser;
  rooms: Set<string>;
  buffer: Buffer;
};

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SUPPORT_BROADCAST_CHANNEL = "support:broadcast:v1";
const SUPPORT_TYPING_TTL_SECONDS = 8;

const clients = new Map<string, SupportSocketClient>();
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

function parseFrames(client: SupportSocketClient) {
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

function send(client: SupportSocketClient, event: SupportServerEvent) {
  if (client.socket.destroyed) return;
  client.socket.write(encodeFrame(JSON.stringify(event)));
}

function broadcastLocal(conversationId: string, event: SupportServerEvent) {
  const socketIds = rooms.get(conversationId);
  if (!socketIds) return;
  for (const socketId of socketIds) {
    const client = clients.get(socketId);
    if (client) send(client, event);
  }
}

async function publishRoomEvent(conversationId: string, event: SupportServerEvent) {
  broadcastLocal(conversationId, event);
  await redis.publish(
    SUPPORT_BROADCAST_CHANNEL,
    JSON.stringify({ conversationId, event }),
  );
}

function joinRoom(client: SupportSocketClient, conversationId: string) {
  client.rooms.add(conversationId);
  const socketIds = rooms.get(conversationId) ?? new Set<string>();
  socketIds.add(client.id);
  rooms.set(conversationId, socketIds);
}

function leaveRoom(client: SupportSocketClient, conversationId: string) {
  client.rooms.delete(conversationId);
  const socketIds = rooms.get(conversationId);
  if (!socketIds) return;
  socketIds.delete(client.id);
  if (socketIds.size === 0) rooms.delete(conversationId);
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

async function requireSupportAccess(conversationId: string, user: SupportSocketUser) {
  const conv = await prisma.supportConversation.findUnique({
    where: { id: conversationId },
    select: { userId: true },
  });
  if (!conv) throw forbidden("Ticket tidak ditemukan");
  if (user.role === "admin" || user.role === "moderator") return;
  if (conv.userId !== user.id) throw forbidden("Tidak punya akses ticket");
}

async function handleClientEvent(client: SupportSocketClient, input: string) {
  let payload: SupportClientEvent;
  try {
    payload = JSON.parse(input) as SupportClientEvent;
  } catch {
    return;
  }

  const conversationId =
    "conversationId" in payload ? String(payload.conversationId ?? "") : "";
  if (!conversationId) return;

  if (payload.event === "support:join") {
    await requireSupportAccess(conversationId, client.user);
    joinRoom(client, conversationId);
    return;
  }

  if (payload.event === "support:leave") {
    leaveRoom(client, conversationId);
    return;
  }

  if (payload.event === "support:typing") {
    if (!client.rooms.has(conversationId)) return;
    const typing = Boolean(payload.typing);
    const text =
      typeof payload.text === "string"
        ? payload.text.slice(0, 220)
        : "";
    const key = `support:typing:${conversationId}:${client.user.id}`;
    if (typing && text.trim()) {
      await redis.set(
        key,
        JSON.stringify({
          userId: String(client.user.id),
          username: client.user.username,
          text,
          updatedAt: Date.now(),
        }),
        "EX",
        SUPPORT_TYPING_TTL_SECONDS,
      );
    } else {
      await redis.del(key);
    }

    await publishRoomEvent(conversationId, {
      event: "support:typing:update",
      conversationId,
      userId: String(client.user.id),
      username: client.user.username,
      typing: typing && Boolean(text.trim()),
      text,
    });
  }
}

function cleanupClient(client: SupportSocketClient) {
  clients.delete(client.id);
  for (const conversationId of Array.from(client.rooms)) {
    leaveRoom(client, conversationId);
  }
}

function startSubscriber() {
  if (subscriberStarted) return;
  subscriberStarted = true;

  const subscriber = createRedisSubscriber();
  void subscriber.subscribe(SUPPORT_BROADCAST_CHANNEL).catch((error) => {
    subscriberStarted = false;
    console.error("[support-ws] redis subscribe failed:", error?.message ?? error);
    subscriber.disconnect();
    setTimeout(startSubscriber, 5000).unref?.();
  });

  subscriber.on("message", (_channel, raw) => {
    try {
      const payload = JSON.parse(raw) as {
        conversationId: string;
        event: SupportServerEvent;
      };
      broadcastLocal(payload.conversationId, payload.event);
    } catch {
      // ignore
    }
  });
}

export async function publishSupportMessageNew(
  conversationId: string,
  message: SupportMessagePayload,
) {
  await publishRoomEvent(conversationId, {
    event: "support:message:new",
    conversationId,
    message,
  });
}

export async function publishSupportConversationCleared(conversationId: string) {
  await publishRoomEvent(conversationId, {
    event: "support:conversation:cleared",
    conversationId,
    clearedAt: Date.now(),
  });
}

export function registerSupportWebSocket(app: FastifyInstance) {
  startSubscriber();

  app.server.on("upgrade", async (request, socket) => {
    const url = new URL(request.url ?? "", "http://localhost");
    if (url.pathname !== "/api/support/ws") return;

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

    let user: SupportSocketUser;
    try {
      user = app.jwt.verify<SupportSocketUser>(token);
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

    const client: SupportSocketClient = {
      id: crypto.randomUUID(),
      socket,
      user,
      rooms: new Set(),
      buffer: Buffer.alloc(0),
    };
    clients.set(client.id, client);

    socket.on("data", (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      const messages = parseFrames(client);
      for (const message of messages) {
        void handleClientEvent(client, message).catch(() => null);
      }
    });

    socket.on("close", () => cleanupClient(client));
    socket.on("error", () => cleanupClient(client));
  });
}
