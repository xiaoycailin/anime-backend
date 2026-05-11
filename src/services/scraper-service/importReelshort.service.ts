import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { CacheInvalidator } from "../../lib/cache";
import { toAnimeSlug } from "../../utils/slug";
import {
  scrapeReelshortDetail,
  scrapeReelshortEpisodeDetail,
  type ReelshortDetail,
  type ReelshortEpisode,
  type ReelshortEpisodeDetail,
  type ReelshortPlaylist,
} from "./scrapeReelshort.service";

type Tx = Prisma.TransactionClient;

export type ReelshortImportResult = {
  sourceUrl: string;
  animeId: number;
  slug: string;
  title: string;
  isNewAnime: boolean;
  episodeCount: number;
  serverCount: number;
  episodes: Array<{
    id: number;
    number: number;
    slug: string;
    serverCount: number;
  }>;
};

export type ReelshortImportLogType = "info" | "success" | "error";

export type ReelshortImportCallbacks = {
  onTotal?: (total: number) => void;
  onLog?: (type: ReelshortImportLogType, message: string) => void;
  onEpisode?: (episode: { number: number; title: string; ok: boolean }) => void;
};

type EpisodeImportDetail = {
  episode: ReelshortEpisode;
  detail: ReelshortEpisodeDetail | null;
  error: string | null;
};

function uniqueNames(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function episodeSlug(animeSlug: string, episode: ReelshortEpisode) {
  try {
    return (
      new URL(episode.url).pathname.replace(/^\/+|\/+$/g, "").split("/").pop() ??
      `${animeSlug}-episode-${episode.number}`
    );
  } catch {
    return `${animeSlug}-episode-${episode.number}`;
  }
}

function playlistLabelFromUrl(url: string | null) {
  if (!url) return "AUTO";
  if (/-hd\.m3u8(?:$|[?#])/i.test(url)) return "1080P";
  if (/-sd\.m3u8(?:$|[?#])/i.test(url)) return "720P";
  if (/-ld\.m3u8(?:$|[?#])/i.test(url)) return "540P";
  return "AUTO";
}

function qualityRank(quality: string) {
  const numeric = Number(quality.match(/\d+/)?.[0] ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function buildServerValue(detail: ReelshortEpisodeDetail | null) {
  if (!detail) return "";

  const byUrl = new Map<string, ReelshortPlaylist>();
  for (const playlist of detail.playlists) {
    if (!playlist.url) continue;
    byUrl.set(playlist.url, playlist);
  }

  const rows = [...byUrl.values()]
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))
    .map((playlist) => `${playlist.definition ?? playlist.quality}:${playlist.url}`);

  if (rows.length > 0) return rows.join("\n");

  return "";
}

function buildFallbackServerValue(detail: ReelshortEpisodeDetail | null, sourceUrl: string) {
  const fallbackUrl = detail?.playlistUrl ?? sourceUrl;
  const label = detail?.playlistUrl ? playlistLabelFromUrl(detail.playlistUrl) : "RLS";
  return `${label}:${fallbackUrl}`;
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

async function upsertTags(tx: Tx, animeId: number, detail: ReelshortDetail) {
  const tags = await Promise.all(
    detail.tagItems.map((item) => {
      const slug = item.id || toAnimeSlug(item.text);
      return tx.tag.upsert({
        where: { slug },
        update: { label: item.text },
        create: { slug, label: item.text },
      });
    }),
  );

  if (!tags.length) return;
  await tx.animeTag.createMany({
    data: tags.map((tag) => ({ animeId, tagId: tag.id })),
    skipDuplicates: true,
  });
}

async function upsertEpisodeWithServer(
  tx: Tx,
  animeId: number,
  animeSlug: string,
  episode: ReelshortEpisode,
  detail: ReelshortEpisodeDetail | null,
) {
  const slug = episodeSlug(animeSlug, episode);
  const serverValue = buildServerValue(detail);
  const fallbackValue = buildFallbackServerValue(detail, episode.url);
  const title = `Episode ${episode.number}`;
  const saved = await tx.episode.upsert({
    where: { slug },
    update: {
      animeId,
      number: episode.number,
      title,
      thumbnail: detail?.thumbnail ?? null,
      sub: "Sub",
      status: "published",
      sourceProvider: "rls",
      sourceVideoId: episode.chapterId,
    },
    create: {
      animeId,
      slug,
      number: episode.number,
      title,
      thumbnail: detail?.thumbnail ?? null,
      sub: "Sub",
      status: "published",
      sourceProvider: "rls",
      sourceVideoId: episode.chapterId,
    },
  });

  await tx.server.deleteMany({ where: { episodeId: saved.id, label: { in: ["ReelShort", "RLS FB"] } } });
  let serverCount = 0;
  if (serverValue) {
    await tx.server.create({
      data: {
        episodeId: saved.id,
        label: "ReelShort",
        value: serverValue,
        isPrimary: true,
      },
    });
    serverCount += 1;
  }

  await tx.server.create({
    data: {
      episodeId: saved.id,
      label: "RLS FB",
      value: fallbackValue,
      isPrimary: !serverValue,
    },
  });
  serverCount += 1;

  return { id: saved.id, number: episode.number, slug, serverCount };
}

export async function importReelshortMovie(sourceUrl: string): Promise<ReelshortImportResult> {
  return importReelshortMovieWithProgress(sourceUrl);
}

export async function importReelshortMovieWithProgress(
  sourceUrl: string,
  callbacks: ReelshortImportCallbacks = {},
): Promise<ReelshortImportResult> {
  callbacks.onLog?.("info", `Scrape movie: ${sourceUrl}`);
  const movie = await scrapeReelshortDetail(sourceUrl);
  const slug = movie.slug || toAnimeSlug(movie.title);
  const details: EpisodeImportDetail[] = [];
  callbacks.onTotal?.(movie.episodes.length);
  callbacks.onLog?.("success", `Movie ditemukan: ${movie.title} (${movie.episodes.length} eps)`);

  for (const episode of movie.episodes) {
    try {
      const detail = await scrapeReelshortEpisodeDetail(episode.url);
      details.push({ episode, detail, error: null });
      callbacks.onEpisode?.({ number: episode.number, title: episode.label, ok: true });
      callbacks.onLog?.(
        "success",
        `EP ${episode.number}: ${detail.playlists.length || 1} server quality tersimpan`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      details.push({ episode, detail: null, error: message });
      callbacks.onEpisode?.({ number: episode.number, title: episode.label, ok: false });
      callbacks.onLog?.(
        "error",
        `EP ${episode.number}: gagal ambil server, fallback ke source URL (${message})`,
      );
    }
  }

  const result = await prisma.$transaction(
    async (tx) => {
      const existing = await tx.anime.findUnique({
        where: { slug },
        select: { id: true },
      });

      const anime = await tx.anime.upsert({
        where: { slug },
        update: {
          title: movie.title,
          thumbnail: movie.imageUrl,
          bigCover: movie.imageUrl,
          synopsis: details.find((item) => item.detail)?.detail?.plot ?? null,
          status: "Completed",
          network: "ReelShort",
          type: "Short",
          totalEpisodes: movie.totalEpisodes,
        },
        create: {
          slug,
          title: movie.title,
          thumbnail: movie.imageUrl,
          bigCover: movie.imageUrl,
          synopsis: details.find((item) => item.detail)?.detail?.plot ?? null,
          status: "Completed",
          network: "ReelShort",
          type: "Short",
          totalEpisodes: movie.totalEpisodes,
        },
      });

      await upsertGenres(tx, anime.id, movie.tags);
      await upsertTags(tx, anime.id, movie);

      const episodes = [];
      for (const item of details) {
        episodes.push(await upsertEpisodeWithServer(tx, anime.id, anime.slug, item.episode, item.detail));
      }

      return {
        sourceUrl,
        animeId: anime.id,
        slug: anime.slug,
        title: anime.title,
        isNewAnime: !existing,
        episodeCount: episodes.length,
        serverCount: episodes.reduce((sum, episode) => sum + episode.serverCount, 0),
        episodes,
      };
    },
    { maxWait: 10_000, timeout: 120_000 },
  );

  await CacheInvalidator.onAnimeChange(result.slug).catch(() => null);
  return result;
}

export async function importReelshortMovies(urls: string[]) {
  const results = [];
  for (const sourceUrl of uniqueNames(urls)) {
    results.push(await importReelshortMovie(sourceUrl));
  }

  return {
    requestedCount: urls.length,
    importedCount: results.length,
    results,
  };
}
