import type { ReleaseScheduleStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getAnichinSchedule } from "./anichin-schedule.service";
import { getSokujaSchedule } from "./sokuja-schedule.service";
import { normalizeTitle } from "../utils/season-parser";

export type EpisodeScheduleQuery = {
  days?: string;
  limit?: string;
  range?: string;
  status?: string;
};

type ScheduleItem = {
  id: number;
  animeId: number;
  animeTitle: string;
  animeSlug: string;
  title: string;
  episode: string;
  episodeNumber: number;
  thumbnail: string | null;
  href: string;
  scheduledAt: string;
  releasedAt: string | null;
  releaseTime: string;
  scheduleStatus: string;
  scheduleSource: string;
  notificationSent: boolean;
  animeStatus: string | null;
  animeType: string | null;
};

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function formatScheduleDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatScheduleTime(date: Date) {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function startOfJakartaDay(date = new Date()) {
  const key = formatScheduleDate(date);
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, -7, 0, 0, 0));
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function scheduleStatus(input: {
  status?: string | null;
  releasedAt?: Date | null;
  episodeId?: number | null;
}) {
  if (input.status === "cancelled") return "cancelled";
  if (input.releasedAt || input.episodeId) return "released";
  return "upcoming";
}

function itemPriority(item: ScheduleItem) {
  if (item.scheduleStatus === "released") return 4;
  if (item.scheduleSource === "sokuja.schedule") return 3;
  if (item.scheduleSource === "anichin.schedule") return 2;
  return 1;
}

function dedupeScheduleItems(items: ScheduleItem[]) {
  const byKey = new Map<string, ScheduleItem>();
  for (const item of items) {
    const dateKey = formatScheduleDate(new Date(item.scheduledAt));
    const key = `${item.animeSlug}:${dateKey}`;
    const current = byKey.get(key);
    if (!current || itemPriority(item) > itemPriority(current)) {
      byKey.set(key, item);
    }
  }
  return Array.from(byKey.values());
}

async function getOptionalSokujaSchedule() {
  try {
    return {
      items: await getSokujaSchedule(),
      error: null as string | null,
    };
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getEpisodeSchedule(query: EpisodeScheduleQuery) {
  const days = Math.min(toPositiveInt(query.days, 7), 30);
  const limit = Math.min(toPositiveInt(query.limit, 160), 300);
  const today = startOfJakartaDay();
  const range =
    query.range === "today" || query.range === "week" ? query.range : "rolling";
  const statusFilter = ["upcoming", "released"].includes(query.status ?? "")
    ? query.status
    : "all";
  const includeLegacySchedules = statusFilter !== "upcoming";
  const scheduleDbStatus =
    statusFilter === "all" || statusFilter === "released"
      ? "released"
      : undefined;
  const start =
    range === "today" || range === "week" ? today : addDays(today, -(days - 1));
  const end =
    range === "today"
      ? addDays(today, 1)
      : range === "week"
        ? addDays(today, 7)
        : addDays(today, days);

  const [schedules, fallbackEpisodes, anichinSchedule, sokujaScheduleResult] =
    await Promise.all([
      prisma.animeReleaseSchedule.findMany({
        where: {
          ...(includeLegacySchedules ? {} : { id: -1 }),
          scheduledAt: { gte: start, lt: end },
          ...(scheduleDbStatus
            ? { status: scheduleDbStatus as ReleaseScheduleStatus }
            : {}),
        },
        orderBy: [{ scheduledAt: "asc" }],
        take: limit,
        include: {
          anime: {
            select: {
              slug: true,
              title: true,
              thumbnail: true,
              status: true,
              type: true,
            },
          },
          episode: {
            select: {
              id: true,
              slug: true,
              title: true,
              thumbnail: true,
              createdAt: true,
            },
          },
        },
      }),
      prisma.episode.findMany({
        where: {
          createdAt: { gte: start, lt: end },
          status: "published",
          releaseSchedule: null,
        },
        orderBy: [{ createdAt: "desc" }],
        take: limit,
        select: {
          id: true,
          animeId: true,
          number: true,
          title: true,
          date: true,
          createdAt: true,
          scheduledReleaseAt: true,
          slug: true,
          thumbnail: true,
          anime: {
            select: {
              slug: true,
              title: true,
              thumbnail: true,
              status: true,
              type: true,
            },
          },
        },
      }),
      getAnichinSchedule(),
      getOptionalSokujaSchedule(),
    ]);
  const sokujaSchedule = sokujaScheduleResult.items;

  const upcomingItems = anichinSchedule.filter((item) => {
    const scheduledAt = new Date(item.scheduledAt);
    if (scheduledAt < start || scheduledAt >= end) return false;
    if (statusFilter === "upcoming") return item.scheduleStatus === "upcoming";
    if (statusFilter === "released") return false;
    return true;
  });
  const sokujaItems = sokujaSchedule.filter((item) => {
    const scheduledAt = new Date(item.scheduledAt);
    if (scheduledAt < start || scheduledAt >= end) return false;
    if (statusFilter === "released") return false;
    return true;
  });

  const items = dedupeScheduleItems([
    ...schedules.map((item): ScheduleItem => {
      const computedStatus = scheduleStatus({
        status: item.status,
        releasedAt: item.releasedAt,
        episodeId: item.episodeId,
      });
      return {
        id: item.episode?.id ?? item.id,
        animeId: item.animeId,
        animeTitle: normalizeTitle(item.anime.title),
        animeSlug: item.anime.slug,
        title:
          item.episode?.title ??
          `${normalizeTitle(item.anime.title)} Episode ${item.episodeNumber}`,
        episode: `Ep ${item.episodeNumber}`,
        episodeNumber: item.episodeNumber,
        thumbnail: item.episode?.thumbnail ?? item.anime.thumbnail,
        href: item.episode?.slug
          ? `/anime/${item.anime.slug}/${item.episode.slug}`
          : `/anime/${item.anime.slug}`,
        scheduledAt: item.scheduledAt.toISOString(),
        releasedAt: item.releasedAt?.toISOString() ?? null,
        releaseTime: formatScheduleTime(item.scheduledAt),
        scheduleStatus: computedStatus,
        scheduleSource: item.source,
        notificationSent: Boolean(item.notificationSentAt),
        animeStatus: item.anime.status,
        animeType: item.anime.type,
      };
    }),
    ...fallbackEpisodes.map((item): ScheduleItem => ({
      id: item.id,
      animeId: item.animeId,
      animeTitle: normalizeTitle(item.anime.title),
      animeSlug: item.anime.slug,
      title: item.title,
      episode: `Ep ${item.number}`,
      episodeNumber: item.number,
      thumbnail: item.thumbnail ?? item.anime.thumbnail,
      href: `/anime/${item.anime.slug}/${item.slug}`,
      scheduledAt: (item.scheduledReleaseAt ?? item.createdAt).toISOString(),
      releasedAt: item.createdAt.toISOString(),
      releaseTime: formatScheduleTime(item.scheduledReleaseAt ?? item.createdAt),
      scheduleStatus: "released",
      scheduleSource: item.scheduledReleaseAt ? "episode" : "episode.createdAt",
      notificationSent: false,
      animeStatus: item.anime.status,
      animeType: item.anime.type,
    })),
    ...upcomingItems,
    ...sokujaItems,
  ])
    .filter((item) =>
      statusFilter === "all" ? true : item.scheduleStatus === statusFilter,
    )
    .sort((left, right) => {
      const leftTime = new Date(left.scheduledAt).getTime();
      const rightTime = new Date(right.scheduledAt).getTime();
      if (left.scheduleStatus === "upcoming" || right.scheduleStatus === "upcoming") {
        return leftTime - rightTime;
      }
      return rightTime - leftTime;
    })
    .slice(0, limit);

  const groups = new Map<string, {
    date: string;
    count: number;
    episodes: ScheduleItem[];
  }>();

  for (const item of items) {
    const dateKey = formatScheduleDate(new Date(item.scheduledAt));
    const group = groups.get(dateKey) ?? {
      date: dateKey,
      count: 0,
      episodes: [],
    };

    group.episodes.push(item);
    group.count = group.episodes.length;
    groups.set(dateKey, group);
  }

  return {
    data: Array.from(groups.values()),
    meta: {
      days,
      limit,
      range,
      status: statusFilter,
      timezone: "Asia/Jakarta",
      source: "anichinSchedule+sokujaSchedule+episodeFallback",
      sourceWarnings: sokujaScheduleResult.error
        ? [{ source: "sokuja.schedule", message: sokujaScheduleResult.error }]
        : [],
      start: start.toISOString(),
      end: end.toISOString(),
    },
  };
}
