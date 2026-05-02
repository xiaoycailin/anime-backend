import { randomUUID } from "crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../lib/prisma";

export const GUEST_WATCH_ID_COOKIE = "weebin_guest_watch_id";
export const GUEST_WATCH_ID_HEADER = "x-guest-watch-id";

const LATEST_EPISODE_WINDOW = Number(
  process.env.GUEST_WATCH_LATEST_EPISODE_WINDOW ?? 5,
);
const MAX_GUEST_LATEST_EPISODES = Number(
  process.env.GUEST_WATCH_MAX_LATEST_EPISODES ?? 5,
);

type GuestWatchEpisode = {
  id: number;
  animeId: number;
  number: number;
};

type GuestWatchQuotaEpisode = {
  id: number;
  number: number;
  title: string | null;
  slug: string;
  locked: boolean;
  watched: boolean;
  watchedAt: Date | null;
};

type GuestWatchDecision =
  | {
      allowed: true;
      guestId: string | null;
      tracked: boolean;
      current: number;
      limit: number;
      window: number;
      latestOnly: boolean;
      rule: "latest_episodes_require_login";
    }
  | {
      allowed: false;
      guestId: string;
      current: number;
      limit: number;
      window: number;
      latestOnly: true;
      rule: "latest_episodes_require_login";
    };

function cleanGuestId(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(trimmed)) return null;
  return trimmed;
}

function createGuestId() {
  return randomUUID().replace(/-/g, "");
}

function getHeaderValue(request: FastifyRequest) {
  const value = request.headers[GUEST_WATCH_ID_HEADER];
  return Array.isArray(value) ? value[0] : value;
}

export function getOrSetGuestWatchId(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const guestId =
    cleanGuestId(getHeaderValue(request)) ??
    cleanGuestId(request.cookies?.[GUEST_WATCH_ID_COOKIE]) ??
    createGuestId();

  reply.setCookie(GUEST_WATCH_ID_COOKIE, guestId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 180,
  });

  return guestId;
}

export async function checkGuestWatchLimit(input: {
  guestId: string;
  episode: GuestWatchEpisode;
}): Promise<GuestWatchDecision> {
  const [latestEpisodes, existing] = await Promise.all([
    prisma.episode.findMany({
      where: { animeId: input.episode.animeId, status: "published" },
      orderBy: [{ number: "desc" }, { id: "desc" }],
      take: LATEST_EPISODE_WINDOW,
      select: { id: true, number: true },
    }),
    prisma.guestWatchAccess.findUnique({
      where: {
        guestId_episodeId: {
          guestId: input.guestId,
          episodeId: input.episode.id,
        },
      },
      select: { id: true },
    }),
  ]);

  const latestEpisodeIds = latestEpisodes.map((episode) => episode.id);
  const isLatestEpisode = latestEpisodeIds.includes(input.episode.id);

  if (!isLatestEpisode) {
    return {
      allowed: true,
      guestId: input.guestId,
      tracked: false,
      current: 0,
      limit: MAX_GUEST_LATEST_EPISODES,
      window: LATEST_EPISODE_WINDOW,
      latestOnly: true,
      rule: "latest_episodes_require_login",
    };
  }

  const watchedCount = await prisma.guestWatchAccess.count({
    where: {
      guestId: input.guestId,
      animeId: input.episode.animeId,
      episodeId: { in: latestEpisodeIds },
    },
  });

  return {
    allowed: false,
    guestId: input.guestId,
    current: existing ? watchedCount : watchedCount,
    limit: MAX_GUEST_LATEST_EPISODES,
    window: LATEST_EPISODE_WINDOW,
    latestOnly: true,
    rule: "latest_episodes_require_login",
  };
}

export async function getGuestWatchQuota(input: {
  guestId: string;
  animeSlug: string;
}) {
  const anime = await prisma.anime.findUnique({
    where: { slug: input.animeSlug },
    select: { id: true, slug: true, title: true },
  });

  if (!anime) return null;

  const latestEpisodes = await prisma.episode.findMany({
    where: { animeId: anime.id, status: "published" },
    orderBy: [{ number: "desc" }, { id: "desc" }],
    take: LATEST_EPISODE_WINDOW,
    select: { id: true, number: true, title: true, slug: true },
  });

  const latestEpisodeIds = latestEpisodes.map((episode) => episode.id);
  const watchedRows = latestEpisodeIds.length
    ? await prisma.guestWatchAccess.findMany({
        where: {
          guestId: input.guestId,
          animeId: anime.id,
          episodeId: { in: latestEpisodeIds },
        },
        select: { episodeId: true, watchedAt: true },
      })
    : [];
  const watchedByEpisodeId = new Map(
    watchedRows.map((row) => [row.episodeId, row.watchedAt]),
  );
  const episodes: GuestWatchQuotaEpisode[] = latestEpisodes.map((episode) => {
    const watchedAt = watchedByEpisodeId.get(episode.id) ?? null;

    return {
      ...episode,
      locked: true,
      watched: !!watchedAt,
      watchedAt,
    };
  });
  const used = episodes.filter((episode) => episode.watched).length;

  return {
    guestId: input.guestId,
    anime,
    used,
    remaining: 0,
    limit: MAX_GUEST_LATEST_EPISODES,
    window: LATEST_EPISODE_WINDOW,
    lockedCount: episodes.length,
    guestCanWatchLatest: false,
    rule: "latest_episodes_require_login",
    latestOnly: true,
    episodes,
  };
}

export async function optionalAuthUserId(
  app: FastifyInstance,
  request: FastifyRequest,
) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;

  try {
    const payload = app.jwt.verify<{ id: number }>(auth.slice("Bearer ".length));
    return Number.isFinite(payload.id) ? payload.id : null;
  } catch {
    return null;
  }
}
