import { PrismaClient } from "@prisma/client";
import { AnimeDetail } from "./scraper-service/types";

const prisma = new PrismaClient();

const KNOWN_METADATA_KEYS = [
  "status",
  "network",
  "studio",
  "released",
  "duration",
  "season",
  "country",
  "type",
  "episodes",
  "fansub",
];

function extractSlug(href: string): string {
  try {
    return (
      new URL(href).pathname
        .replace(/^\/+|\/+$/g, "")
        .split("/")
        .pop() ?? ""
    );
  } catch {
    return href;
  }
}

function toAnimeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export async function insertAnime(anime: AnimeDetail): Promise<void> {
  const slug = toAnimeSlug(anime.title);
  const { metadata } = anime;

  const extraMetadata = Object.entries(metadata).filter(
    ([key]) => !KNOWN_METADATA_KEYS.includes(key),
  );

  // ─── TRANSACTION: semua atau tidak sama sekali ────────────────────────────
  await prisma.$transaction(async (tx) => {
    // ─── UPSERT ANIME ────────────────────────────────────────────────────────
    const saved = await tx.anime.upsert({
      where: { slug },
      update: {
        title: anime.title,
        thumbnail: anime.thumbnail,
        bigCover: anime.bigCover,
        rating: anime.rating ? parseFloat(anime.rating) : null,
        alternativeTitles: anime.alternativeTitles,
        synopsis: anime.synopsis,
        followed: anime.followed ? parseInt(anime.followed) : null,
        status: metadata.status,
        network: metadata.network,
        studio: metadata.studio,
        released: metadata.released,
        duration: metadata.duration,
        season: metadata.season,
        country: metadata.country,
        type: metadata.type,
        totalEpisodes: metadata.episodes ? parseInt(metadata.episodes) : null,
        fansub: metadata.fansub,
      },
      create: {
        slug,
        title: anime.title,
        thumbnail: anime.thumbnail,
        bigCover: anime.bigCover,
        rating: anime.rating ? parseFloat(anime.rating) : null,
        alternativeTitles: anime.alternativeTitles,
        synopsis: anime.synopsis,
        followed: anime.followed ? parseInt(anime.followed) : null,
        status: metadata.status,
        network: metadata.network,
        studio: metadata.studio,
        released: metadata.released,
        duration: metadata.duration,
        season: metadata.season,
        country: metadata.country,
        type: metadata.type,
        totalEpisodes: metadata.episodes ? parseInt(metadata.episodes) : null,
        fansub: metadata.fansub,
      },
    });

    // ─── GENRES ──────────────────────────────────────────────────────────────
    const genres = await Promise.all(
      anime.genres.map((name) =>
        tx.genre.upsert({
          where: { name },
          update: {},
          create: { name },
        }),
      ),
    );

    await tx.animeGenre.deleteMany({ where: { animeId: saved.id } });
    await tx.animeGenre.createMany({
      data: genres.map((g) => ({ animeId: saved.id, genreId: g.id })),
      skipDuplicates: true,
    });

    // ─── TAGS ─────────────────────────────────────────────────────────────────
    const tags = await Promise.all(
      anime.tags.map((tag) => {
        const tagSlug = tag.href
          ? extractSlug(tag.href)
          : toAnimeSlug(tag.label);
        return tx.tag.upsert({
          where: { slug: tagSlug },
          update: { label: tag.label },
          create: { slug: tagSlug, label: tag.label },
        });
      }),
    );

    await tx.animeTag.deleteMany({ where: { animeId: saved.id } });
    await tx.animeTag.createMany({
      data: tags.map((t) => ({ animeId: saved.id, tagId: t.id })),
      skipDuplicates: true,
    });

    // ─── EXTRA METADATA ───────────────────────────────────────────────────────
    await Promise.all(
      extraMetadata.map(([key, value]) =>
        tx.animeMetaExtra.upsert({
          where: { animeId_key: { animeId: saved.id, key } },
          update: { value: value ?? "" },
          create: { animeId: saved.id, key, value: value ?? "" },
        }),
      ),
    );

    // ─── EPISODES ─────────────────────────────────────────────────────────────
    await Promise.all(
      anime.episodes.map(async (ep) => {
        const epSlug = ep.href
          ? extractSlug(ep.href)
          : `${slug}-ep-${ep.number}`;
        const epNumber = parseInt(ep.number) || 0;

        const savedEp = await tx.episode.upsert({
          where: { slug: epSlug },
          update: {
            title: ep.title,
            sub: ep.sub,
            date: ep.date,
            number: epNumber,
          },
          create: {
            animeId: saved.id,
            slug: epSlug,
            number: epNumber,
            title: ep.title,
            sub: ep.sub,
            date: ep.date,
          },
        });

        // ─── SERVERS ──────────────────────────────────────────────────────────
        if (ep.servers?.length) {
          await tx.server.deleteMany({ where: { episodeId: savedEp.id } });
          await tx.server.createMany({
            data: ep.servers.map((s) => ({
              episodeId: savedEp.id,
              label: s.label,
              value: s.value ?? "",
            })),
          });
        }
      }),
    );
  });
}

export async function insertAnimeList(list: AnimeDetail[]): Promise<void> {
  for (const anime of list) {
    try {
      await insertAnime(anime);
      console.log(`✓ ${anime.title}`);
    } catch (err) {
      // satu anime gagal tidak menggagalkan yang lain
      console.error(`✗ ${anime.title}:`, err);
    }
  }
}
