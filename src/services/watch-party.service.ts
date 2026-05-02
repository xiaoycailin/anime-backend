import { randomBytes, randomUUID } from "crypto";
import { prisma } from "../lib/prisma";
import { badRequest, notFound } from "../utils/http-error";

const ROOM_CODE_LENGTH = 8;
const ROOM_TTL_HOURS = 8;

type AuthUser = {
  id: number;
  email: string;
  username: string;
  role: string;
};

type CreateRoomInput = {
  user: AuthUser;
  episodeId: unknown;
  title?: unknown;
};

function isWatchPartyEnabled() {
  return process.env.WATCH_PARTY_ENABLED === "true";
}

function assertWatchPartyEnabled() {
  if (!isWatchPartyEnabled()) {
    throw notFound("Nonton bareng belum tersedia");
  }
}

function parseEpisodeId(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequest("Episode tidak valid");
  }
  return parsed;
}

function normalizeTitle(value: unknown) {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 120) : null;
}

function createRoomCode() {
  return randomBytes(5)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, ROOM_CODE_LENGTH);
}

function roomExpiresAt() {
  return new Date(Date.now() + ROOM_TTL_HOURS * 60 * 60 * 1000);
}

function toRoomPayload(room: {
  id: string;
  code: string;
  title: string | null;
  status: string;
  visibility: string;
  lastPlaybackAt: number;
  lastPlaybackStatus: string;
  participantCount: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  host: { id: number; username: string; fullName: string | null; avatar: string | null };
  anime: { id: number; slug: string; title: string; thumbnail: string | null };
  episode: { id: number; slug: string; number: number; title: string };
}) {
  return {
    id: room.id,
    code: room.code,
    title: room.title,
    status: room.status,
    visibility: room.visibility,
    playback: {
      positionSec: room.lastPlaybackAt,
      status: room.lastPlaybackStatus,
    },
    participantCount: room.participantCount,
    expiresAt: room.expiresAt.toISOString(),
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
    host: room.host,
    anime: room.anime,
    episode: room.episode,
  };
}

const roomInclude = {
  host: {
    select: { id: true, username: true, fullName: true, avatar: true },
  },
  anime: {
    select: { id: true, slug: true, title: true, thumbnail: true },
  },
  episode: {
    select: { id: true, slug: true, number: true, title: true },
  },
} as const;

export function getWatchPartyFeatureStatus() {
  return {
    enabled: isWatchPartyEnabled(),
    transport: "polling-prep",
    realtimeReady: false,
  };
}

export async function createWatchPartyRoom(input: CreateRoomInput) {
  assertWatchPartyEnabled();

  const episodeId = parseEpisodeId(input.episodeId);
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    select: {
      id: true,
      animeId: true,
      title: true,
      anime: { select: { title: true } },
    },
  });

  if (!episode) throw notFound("Episode tidak ditemukan");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const room = await prisma.watchPartyRoom.create({
        data: {
          id: randomUUID(),
          code: createRoomCode(),
          hostId: input.user.id,
          animeId: episode.animeId,
          episodeId: episode.id,
          title: normalizeTitle(input.title) ?? episode.anime.title,
          expiresAt: roomExpiresAt(),
          participants: {
            create: {
              userId: input.user.id,
              displayName: input.user.username,
              role: "host",
            },
          },
        },
        include: roomInclude,
      });

      return toRoomPayload(room);
    } catch (error: any) {
      if (error?.code !== "P2002") throw error;
    }
  }

  throw badRequest("Gagal membuat kode room, coba lagi");
}

export async function listMyWatchPartyRooms(userId: number) {
  assertWatchPartyEnabled();

  const rooms = await prisma.watchPartyRoom.findMany({
    where: {
      hostId: userId,
      expiresAt: { gt: new Date() },
      status: { not: "ended" },
    },
    include: roomInclude,
    orderBy: { updatedAt: "desc" },
    take: 20,
  });

  return rooms.map(toRoomPayload);
}

export async function getWatchPartyRoomByCode(code: unknown) {
  assertWatchPartyEnabled();

  if (typeof code !== "string" || !code.trim()) {
    throw badRequest("Kode room tidak valid");
  }

  const room = await prisma.watchPartyRoom.findUnique({
    where: { code: code.trim().toUpperCase() },
    include: roomInclude,
  });

  if (!room || room.expiresAt.getTime() <= Date.now()) {
    throw notFound("Room tidak ditemukan atau sudah berakhir");
  }

  return toRoomPayload(room);
}
