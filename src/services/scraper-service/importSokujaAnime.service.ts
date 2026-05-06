import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { scrapeSokujaAnimePages } from "./scrapeSokujaAnimeList.service";
import type { AnimeDetail, AnimeEpisode, AnimeMetadata } from "./types";

const KNOWN_METADATA_KEYS = new Set([
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
]);
const IMPORT_TRANSACTION_TIMEOUT_MS = 60_000;

type SokujaImportOptions = {
  fromPage: number;
  toPage: number;
  dryRun?: boolean;
  episodeMode?: "full" | "recent";
  episodeLimit?: number;
};

export type SokujaListItem = {
  slug: string;
  title: string;
  thumbnail: string | null;
  bigCover: string | null;
  rating: number | null;
  status: string | null;
  released: string | null;
  type: string | null;
};

type Tx = Prisma.TransactionClient;

function parseNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIntOrNull(value: string | number | null | undefined) {
  const parsed = parseNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function extractPathSlug(href: string | null | undefined) {
  if (!href) return "";
  try {
    return new URL(href).pathname.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
  } catch {
    return href.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
  }
}

function normalizeLabel(label: string) {
  const quality = label.match(/(\d{3,4})\s*p/i)?.[1];
  return quality ? `${quality}P` : label.replace(/^sokuja\s*/i, "").trim() || "Server";
}

function episodeSourceData(episode: AnimeEpisode) {
  return episode.sourceEpisodeId
    ? {
        sourceProvider: "sokuja",
        sourceVideoId: String(episode.sourceEpisodeId),
      }
    : {};
}

function uniqueNames(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function metadataCreateInput(metadata: AnimeMetadata, item: SokujaListItem) {
  return {
    status: metadata.status ?? item.status ?? null,
    network: metadata.network ?? null,
    studio: metadata.studio ?? null,
    released: metadata.released ?? item.released ?? null,
    duration: metadata.duration ?? null,
    season: metadata.season ?? null,
    country: metadata.country ?? null,
    type: "Anime",
    totalEpisodes: parseIntOrNull(metadata.episodes),
    fansub: metadata.fansub ?? null,
  };
}

async function upsertGenres(tx: Tx, animeId: number, names: string[]) {
  const genres = await Promise.all(
    uniqueNames(names).map((name) =>
      tx.genre.upsert({
        where: { name },
        update: {},
        create: { name },
      }),
    ),
  );

  if (!genres.length) return;
  await tx.animeGenre.createMany({
    data: genres.map((genre) => ({ animeId, genreId: genre.id })),
    skipDuplicates: true,
  });
}

async function upsertTags(tx: Tx, animeId: number, detail: AnimeDetail) {
  const tags = await Promise.all(
    detail.tags
      .filter((tag) => tag.label.trim())
      .map((tag) => {
        const slug = extractPathSlug(tag.href) || tag.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        return tx.tag.upsert({
          where: { slug },
          update: { label: tag.label },
          create: { slug, label: tag.label },
        });
      }),
  );

  if (!tags.length) return;
  await tx.animeTag.createMany({
    data: tags.map((tag) => ({ animeId, tagId: tag.id })),
    skipDuplicates: true,
  });
}

async function upsertExtraMetadata(
  tx: Tx,
  animeId: number,
  metadata: AnimeMetadata,
) {
  const extras = Object.entries(metadata).filter(([key]) => !KNOWN_METADATA_KEYS.has(key));
  await Promise.all(
    extras.map(([key, value]) =>
      tx.animeMetaExtra.upsert({
        where: { animeId_key: { animeId, key } },
        update: { value: value ?? "" },
        create: { animeId, key, value: value ?? "" },
      }),
    ),
  );
}

async function upsertEpisodeServers(
  tx: Tx,
  episodeId: number,
  episode: AnimeEpisode,
) {
  const servers = (episode.servers ?? []).filter((server) => server.value);
  if (!servers.length) return 0;

  await tx.server.deleteMany({
    where: {
      episodeId,
      OR: [{ value: { contains: "sokuja" } }, { value: { contains: "storages.sokuja.id" } }],
    },
  });

  await tx.server.createMany({
    data: servers.map((server, index) => ({
      episodeId,
      label: normalizeLabel(server.label),
      value: server.value ?? "",
      isPrimary: server.isPrimary ?? index === 0,
    })),
  });

  return servers.length;
}

async function upsertEpisode(
  tx: Tx,
  animeId: number,
  animeSlug: string,
  episode: AnimeEpisode,
) {
  const slug = extractPathSlug(episode.href) || `${animeSlug}-episode-${episode.number}`;
  const number = parseIntOrNull(episode.number) ?? 0;
  const saved = await tx.episode.upsert({
    where: { slug },
    update: {
      animeId,
      number,
      title: episode.title,
      thumbnail: episode.thumbnail ?? null,
      sub: episode.sub || null,
      date: episode.date || null,
      status: episode.status ?? "published",
      ...episodeSourceData(episode),
    },
    create: {
      animeId,
      slug,
      number,
      title: episode.title,
      thumbnail: episode.thumbnail ?? null,
      sub: episode.sub || null,
      date: episode.date || null,
      status: episode.status ?? "published",
      ...episodeSourceData(episode),
    },
  });

  const serverCount = await upsertEpisodeServers(tx, saved.id, episode);
  return { id: saved.id, number, slug, serverCount };
}

export async function importOneSokujaAnime(item: SokujaListItem, detail: AnimeDetail) {
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.anime.findUnique({
        where: { slug: item.slug },
        select: { id: true },
      });
      const metadata = metadataCreateInput(detail.metadata, item);
      const rating = parseNumber(detail.rating ?? item.rating);

      const anime = await tx.anime.upsert({
        where: { slug: item.slug },
        update: {
          title: detail.title || item.title,
          thumbnail: detail.thumbnail ?? item.thumbnail,
          bigCover: detail.bigCover ?? item.bigCover,
          rating,
          alternativeTitles: detail.alternativeTitles,
          synopsis: detail.synopsis,
          followed: parseIntOrNull(detail.followed),
          ...metadata,
        },
        create: {
          slug: item.slug,
          title: detail.title || item.title,
          thumbnail: detail.thumbnail ?? item.thumbnail,
          bigCover: detail.bigCover ?? item.bigCover,
          rating,
          alternativeTitles: detail.alternativeTitles,
          synopsis: detail.synopsis,
          followed: parseIntOrNull(detail.followed),
          ...metadata,
        },
      });

      await upsertGenres(tx, anime.id, detail.genres);
      await upsertTags(tx, anime.id, detail);
      await upsertExtraMetadata(tx, anime.id, detail.metadata);

      const episodes = [];
      for (const episode of detail.episodes) {
        episodes.push(await upsertEpisode(tx, anime.id, anime.slug, episode));
      }

      return {
        animeId: anime.id,
        slug: anime.slug,
        title: anime.title,
        isNewAnime: !existing,
        episodeCount: episodes.length,
        serverCount: episodes.reduce((sum, episode) => sum + episode.serverCount, 0),
        episodes,
      };
    },
    {
      maxWait: 10_000,
      timeout: IMPORT_TRANSACTION_TIMEOUT_MS,
    },
  );
}

export async function importSokujaAnimePages(options: SokujaImportOptions) {
  const scraped = await scrapeSokujaAnimePages(options.fromPage, options.toPage, {
    includeDetails: true,
    includeEpisodeServers: true,
    episodeMode: options.episodeMode,
    episodeLimit: options.episodeLimit,
  });

  const details = scraped.animeDetails ?? [];
  const pairs = scraped.items.flatMap((item, index) => {
    const detail = details[index];
    return detail ? [{ item: item as SokujaListItem, detail }] : [];
  });

  if (options.dryRun) {
    return {
      ...scraped,
      dryRun: true,
      importCount: pairs.length,
      importPreview: pairs.map(({ item, detail }) => ({
        slug: item.slug,
        title: detail.title || item.title,
        episodes: detail.episodes.length,
        servers: detail.episodes.reduce((sum, episode) => sum + (episode.servers?.length ?? 0), 0),
      })),
    };
  }

  const imported = [];
  for (const pair of pairs) {
    imported.push(await importOneSokujaAnime(pair.item, pair.detail));
  }

  return {
    fromPage: scraped.fromPage,
    toPage: scraped.toPage,
    totalFound: scraped.totalFound,
    estimatedTotalPages: scraped.estimatedTotalPages,
    scrapedCount: scraped.count,
    importedCount: imported.length,
    imported,
  };
}
