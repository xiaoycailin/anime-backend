import { prisma } from "../lib/prisma";
import { badRequest } from "../utils/http-error";
import type { ChatContextPayload, ChatContextType } from "./chat.types";

type ContextInput = {
  type?: unknown;
  id?: unknown;
};

function cleanText(value: string | null | undefined, max = 180) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text;
}

function toContextType(value: unknown): ChatContextType | null {
  if (value === "anime" || value === "episode") return value;
  return null;
}

function toId(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export async function hydrateChatContext(
  input: ContextInput,
): Promise<ChatContextPayload> {
  const type = toContextType(input.type);
  const id = toId(input.id);

  if (!type || !id) throw badRequest("Context chat tidak valid");

  if (type === "anime") {
    const anime = await prisma.anime.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        slug: true,
        thumbnail: true,
        bigCover: true,
        synopsis: true,
      },
    });

    if (!anime) throw badRequest("Anime context tidak ditemukan");

    return {
      type: "anime",
      id: String(anime.id),
      title: anime.title,
      animeTitle: null,
      thumbnail: anime.thumbnail ?? anime.bigCover ?? null,
      description: cleanText(anime.synopsis),
      slug: anime.slug,
      animeSlug: null,
      url: `/anime/${anime.slug}`,
    };
  }

  const episode = await prisma.episode.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      slug: true,
      thumbnail: true,
      anime: {
        select: {
          title: true,
          slug: true,
          thumbnail: true,
          bigCover: true,
          synopsis: true,
        },
      },
    },
  });

  if (!episode) throw badRequest("Episode context tidak ditemukan");

  return {
    type: "episode",
    id: String(episode.id),
    title: episode.title,
    animeTitle: episode.anime.title,
    thumbnail:
      episode.thumbnail ??
      episode.anime.thumbnail ??
      episode.anime.bigCover ??
      null,
    description: cleanText(episode.anime.synopsis),
    slug: episode.slug,
    animeSlug: episode.anime.slug,
    url: `/anime/${episode.anime.slug}/${episode.slug}`,
  };
}

export async function hydrateChatContexts(input: unknown) {
  const rawItems = Array.isArray(input)
    ? input
    : input && typeof input === "object"
      ? [input]
      : [];

  const limited = rawItems.slice(0, 5);
  const contexts: ChatContextPayload[] = [];
  const seen = new Set<string>();

  for (const item of limited) {
    const context = await hydrateChatContext(item as ContextInput);
    const key = `${context.type}:${context.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    contexts.push(context);
  }

  return contexts;
}

export async function resolveChatPreviewByPath(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "anime" || !parts[1]) return null;

  const animeSlug = parts[1];
  const episodeSlug = parts[2];

  if (episodeSlug) {
    const episode = await prisma.episode.findFirst({
      where: {
        slug: episodeSlug,
        anime: { slug: animeSlug },
      },
      select: { id: true },
    });
    if (!episode) return null;
    return hydrateChatContext({ type: "episode", id: episode.id });
  }

  const anime = await prisma.anime.findUnique({
    where: { slug: animeSlug },
    select: { id: true },
  });
  if (!anime) return null;
  return hydrateChatContext({ type: "anime", id: anime.id });
}

export async function searchChatContexts(input: {
  q?: unknown;
  type?: unknown;
  limit?: unknown;
}) {
  const q = typeof input.q === "string" ? input.q.trim() : "";
  const filterType =
    input.type === "anime" || input.type === "episode" ? input.type : "all";
  const limit = Math.min(Math.max(Number(input.limit) || 12, 1), 20);

  if (!q) return [];

  const perTypeLimit = filterType === "all" ? Math.ceil(limit / 2) : limit;
  const results: ChatContextPayload[] = [];

  if (filterType === "all" || filterType === "anime") {
    const animes = await prisma.anime.findMany({
      where: {
        OR: [
          { title: { contains: q } },
          { slug: { contains: q } },
          { synopsis: { contains: q } },
        ],
      },
      select: {
        id: true,
        title: true,
        slug: true,
        thumbnail: true,
        bigCover: true,
        synopsis: true,
      },
      orderBy: { updatedAt: "desc" },
      take: perTypeLimit,
    });

    results.push(
      ...animes.map((anime) => ({
        type: "anime" as const,
        id: String(anime.id),
        title: anime.title,
        animeTitle: null,
        thumbnail: anime.thumbnail ?? anime.bigCover ?? null,
        description: cleanText(anime.synopsis),
        slug: anime.slug,
        animeSlug: null,
        url: `/anime/${anime.slug}`,
      })),
    );
  }

  if (filterType === "all" || filterType === "episode") {
    const episodes = await prisma.episode.findMany({
      where: {
        OR: [
          { title: { contains: q } },
          { slug: { contains: q } },
          { anime: { title: { contains: q } } },
          { anime: { slug: { contains: q } } },
        ],
      },
      select: {
        id: true,
        title: true,
        slug: true,
        thumbnail: true,
        anime: {
          select: {
            title: true,
            slug: true,
            thumbnail: true,
            bigCover: true,
            synopsis: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: perTypeLimit,
    });

    results.push(
      ...episodes.map((episode) => ({
        type: "episode" as const,
        id: String(episode.id),
        title: episode.title,
        animeTitle: episode.anime.title,
        thumbnail:
          episode.thumbnail ??
          episode.anime.thumbnail ??
          episode.anime.bigCover ??
          null,
        description: cleanText(episode.anime.synopsis),
        slug: episode.slug,
        animeSlug: episode.anime.slug,
        url: `/anime/${episode.anime.slug}/${episode.slug}`,
      })),
    );
  }

  return results.slice(0, limit);
}
