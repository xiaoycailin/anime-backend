import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { normalizeTitle } from "../utils/season-parser";

const ACCENT_PRESETS = [
  "from-violet-600 to-purple-700",
  "from-rose-600 to-orange-500",
  "from-cyan-600 to-blue-700",
  "from-emerald-600 to-teal-700",
  "from-fuchsia-600 to-pink-700",
];

type AnimeWithGenres = {
  id: number;
  slug: string;
  title: string;
  thumbnail: string | null;
  bigCover?: string | null;
  status: string | null;
  type?: string | null;
  studio?: string | null;
  rating?: Prisma.Decimal | number | null;
  followed?: number | null;
  views?: number;
  likes?: number;
  trendingScore?: number;
  totalEpisodes?: number | null;
  genres: { genre: { name: string } }[];
  _count?: { episodes: number };
};

function toAnimeStatus(value: string | null): "Ongoing" | "Completed" {
  return (value ?? "").toLowerCase().includes("complete")
    ? "Completed"
    : "Ongoing";
}

function formatAnimeCard(
  anime: AnimeWithGenres,
  options: { includeBigCover?: boolean; includeStats?: boolean } = {},
) {
  return {
    id: anime.id,
    slug: anime.slug,
    title: normalizeTitle(anime.title),
    genre: anime.genres.map((item) => item.genre.name),
    thumbnail: anime.thumbnail ?? "",
    ...(options.includeBigCover ? { bigCover: anime.bigCover ?? "" } : {}),
    status: toAnimeStatus(anime.status),
    type: anime.type ?? null,
    studio: anime.studio ?? null,
    ...(options.includeStats
      ? {
          rating: anime.rating ? Number(anime.rating) : null,
          followed: anime.followed ?? null,
          views: anime.views ?? 0,
          likes: anime.likes ?? 0,
          trendingScore: anime.trendingScore ?? 0,
          totalEpisodes: anime.totalEpisodes ?? null,
          episodeCount: anime._count?.episodes ?? 0,
        }
      : {}),
  };
}

function formatEpisodeLabel(
  totalEpisodes: number | null,
  episodesCount: number,
) {
  const finalCount =
    totalEpisodes && totalEpisodes > 0 ? totalEpisodes : episodesCount;
  if (!finalCount || finalCount <= 0) return "Episode -";
  return `Episode 1-${finalCount}`;
}

export type HomeSections = {
  trending: { weekly: ReturnType<typeof formatAnimeCard>[] };
  banners: {
    id: number;
    slug: string;
    title: string;
    description: string;
    genre: string[];
    episode: string;
    rating: string | null;
    status: "Completed" | "Ongoing";
    thumbnail: string;
    banner: string;
    href: string;
    accent: string;
  }[];
  newEpisodes: {
    id: number;
    title: string;
    episode: string;
    time: string;
    thumbnail: string | null;
    href: string;
    animeType: string | null;
    totalEpisodes: number | null;
    episodeCount: number;
  }[];
  newRelease: {
    id: number;
    slug: string;
    title: string;
    genre: string[];
    thumbnail: string;
    status: "Ongoing" | "Completed";
    type: string | null;
    totalEpisodes: number | null;
    episodeCount: number;
  }[];
  popular: ReturnType<typeof formatAnimeCard>[];
  genres: { id: number; name: string; animeCount: number }[];
};

function formatRelativeTime(date: Date) {
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMinutes < 1) return "baru saja";
  if (diffMinutes < 60) return `${diffMinutes}m lalu`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}j lalu`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}h lalu`;
}

export async function getHomeSections(): Promise<HomeSections> {
  const [trending, banners, latestEpisodes, newRelease, popular, genres] =
    await Promise.all([
      getTrendingAnime(),
      getBanners(),
      getLatestEpisodes(),
      getNewReleaseAnime(),
      getPopularAnime(),
      getGenres(),
    ]);

  return {
    trending: { weekly: trending },
    banners,
    newEpisodes: latestEpisodes,
    newRelease,
    popular,
    genres,
  };
}

async function getTrendingAnime() {
  const animes = await prisma.anime.findMany({
    orderBy: [
      { trendingScore: "desc" },
      { views: "desc" },
      { likes: "desc" },
      { updatedAt: "desc" },
    ],
    take: 9,
    select: {
      id: true,
      slug: true,
      title: true,
      thumbnail: true,
      bigCover: true,
      status: true,
      type: true,
      studio: true,
      rating: true,
      followed: true,
      views: true,
      likes: true,
      trendingScore: true,
      totalEpisodes: true,
      genres: { select: { genre: { select: { name: true } } } },
      _count: { select: { episodes: true } },
    },
  });

  return animes.map((anime) =>
    formatAnimeCard(anime, { includeBigCover: true, includeStats: true }),
  );
}

async function getBanners() {
  const animes = await prisma.anime.findMany({
    orderBy: [{ followed: "desc" }, { rating: "desc" }, { updatedAt: "desc" }],
    take: 5,
    select: {
      id: true,
      slug: true,
      title: true,
      synopsis: true,
      status: true,
      totalEpisodes: true,
      rating: true,
      bigCover: true,
      thumbnail: true,
      episodes: { select: { slug: true }, orderBy: { number: "desc" }, take: 1 },
      genres: { select: { genre: { select: { name: true } } } },
      _count: { select: { episodes: true } },
    },
  });

  return animes.map((anime, index) => ({
    id: anime.id,
    slug: anime.slug,
    title: normalizeTitle(anime.title),
    description: anime.synopsis ?? "",
    genre: anime.genres.map((item) => item.genre.name),
    episode: formatEpisodeLabel(anime.totalEpisodes, anime._count.episodes),
    rating: anime.rating ? Number(anime.rating).toFixed(1) : null,
    status: toAnimeStatus(anime.status),
    thumbnail: anime.thumbnail ?? "",
    banner: anime.bigCover ?? anime.thumbnail ?? "",
    href: `/anime/${anime.slug}/${anime.episodes[0]?.slug ?? ""}`,
    accent: ACCENT_PRESETS[index % ACCENT_PRESETS.length],
  }));
}

async function getLatestEpisodes() {
  const episodes = await prisma.episode.findMany({
    orderBy: [{ createdAt: "desc" }],
    distinct: ["animeId"],
    take: 10,
    select: {
      id: true,
      number: true,
      createdAt: true,
      slug: true,
      thumbnail: true,
      anime: {
        select: {
          slug: true,
          title: true,
          thumbnail: true,
          updatedAt: true,
          type: true,
          totalEpisodes: true,
          _count: { select: { episodes: true } },
        },
      },
    },
  });

  return episodes.map((item) => ({
    id: item.id,
    title: normalizeTitle(item.anime.title),
    episode: `Ep ${item.number}`,
    time: formatRelativeTime(item.createdAt) || formatRelativeTime(item.anime.updatedAt),
    thumbnail: item.thumbnail ?? item.anime.thumbnail,
    href: `/anime/${item.anime.slug}/${item.slug}`,
    animeType: item.anime.type,
    totalEpisodes: item.anime.totalEpisodes,
    episodeCount: item.anime._count.episodes,
  }));
}

async function getNewReleaseAnime() {
  const ranked = await prisma.$queryRaw<{ id: number }[]>`
    SELECT a.id
    FROM animes a
    LEFT JOIN episodes e ON e.animeId = a.id
    GROUP BY a.id
    ORDER BY GREATEST(a.createdAt, COALESCE(MAX(e.createdAt), a.createdAt)) DESC
    LIMIT 12
  `;
  const ids = ranked.map((row) => Number(row.id));

  if (ids.length === 0) return [];

  const animes = await prisma.anime.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      slug: true,
      title: true,
      thumbnail: true,
      status: true,
      type: true,
      totalEpisodes: true,
      genres: { select: { genre: { select: { name: true } } } },
      _count: { select: { episodes: true } },
    },
  });

  const animeMap = new Map(animes.map((anime) => [anime.id, anime]));
  return ids
    .map((id) => animeMap.get(id))
    .filter((anime): anime is NonNullable<typeof anime> => Boolean(anime))
    .map((anime) => ({
      id: anime.id,
      slug: anime.slug,
      title: normalizeTitle(anime.title),
      genre: anime.genres.map((item) => item.genre.name),
      thumbnail: anime.thumbnail ?? "",
      status: toAnimeStatus(anime.status),
      type: anime.type,
      totalEpisodes: anime.totalEpisodes,
      episodeCount: anime._count.episodes,
    }));
}

async function getPopularAnime() {
  const animes = await prisma.anime.findMany({
    orderBy: [{ followed: "desc" }, { rating: "desc" }, { updatedAt: "desc" }],
    take: 12,
    select: {
      id: true,
      slug: true,
      title: true,
      thumbnail: true,
      bigCover: true,
      status: true,
      type: true,
      studio: true,
      rating: true,
      followed: true,
      totalEpisodes: true,
      genres: { select: { genre: { select: { name: true } } } },
      _count: { select: { episodes: true } },
    },
  });

  return animes.map((anime) =>
    formatAnimeCard(anime, { includeBigCover: true, includeStats: true }),
  );
}

async function getGenres() {
  const genres = await prisma.genre.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      _count: { select: { animes: true } },
    },
  });

  return genres.map((genre) => ({
    id: genre.id,
    name: genre.name,
    animeCount: genre._count.animes,
  }));
}
