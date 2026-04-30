import { prisma } from "../lib/prisma";
import { createSegmentNotification } from "./notification.service";

type EpisodePublishedInput = {
  episode: {
    id: number;
    animeId: number;
    slug: string;
    number: number;
    title: string;
    createdAt: Date;
    scheduledReleaseAt?: Date | null;
    anime: {
      id: number;
      slug: string;
      title: string;
      thumbnail?: string | null;
    };
  };
  createdById?: number | null;
};

export async function markEpisodeReleasedAndNotifyOnce(input: EpisodePublishedInput) {
  const releasedAt = input.episode.createdAt ?? new Date();
  const schedule = await prisma.animeReleaseSchedule.upsert({
    where: {
      animeId_episodeNumber: {
        animeId: input.episode.animeId,
        episodeNumber: input.episode.number,
      },
    },
    create: {
      animeId: input.episode.animeId,
      episodeId: input.episode.id,
      episodeNumber: input.episode.number,
      scheduledAt: input.episode.scheduledReleaseAt ?? releasedAt,
      releasedAt,
      status: "released",
      source: input.episode.scheduledReleaseAt ? "episode" : "published",
    },
    update: {
      episodeId: input.episode.id,
      scheduledAt: input.episode.scheduledReleaseAt ?? undefined,
      releasedAt,
      status: "released",
    },
  });

  const claimed = await prisma.animeReleaseSchedule.updateMany({
    where: {
      id: schedule.id,
      notificationSentAt: null,
    },
    data: {
      notificationSentAt: new Date(),
    },
  });

  if (claimed.count === 0) return schedule;

  await createSegmentNotification({
    segment: { type: "saved-anime", animeId: input.episode.animeId },
    category: "content_update",
    type: "episode_published",
    title: `Episode baru: ${input.episode.anime.title}`,
    message: `Episode ${input.episode.number} sudah tayang dan siap ditonton.`,
    link: `/anime/${input.episode.anime.slug}/${input.episode.slug}`,
    image: input.episode.anime.thumbnail ?? null,
    topic: "episode",
    payload: {
      animeId: input.episode.anime.id,
      animeSlug: input.episode.anime.slug,
      animeTitle: input.episode.anime.title,
      episodeId: input.episode.id,
      episodeSlug: input.episode.slug,
      episodeNumber: input.episode.number,
      scheduleId: schedule.id,
    },
    createdById: input.createdById ?? null,
  });

  return schedule;
}
