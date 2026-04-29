import { prisma } from "../../../lib/prisma";
import type { ChatContextPayload } from "../../chat.types";
import type {
  ChatbotAnimeCandidate,
  ChatbotEpisodeCandidate,
  ChatbotRetrievalContext,
} from "./types";

function compactText(value: string | null | undefined, max = 220) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text;
}

function slugifyQuery(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function queryTokens(query: string) {
  const stopWords = new Set([
    "ada",
    "gak",
    "ga",
    "nggak",
    "tidak",
    "anime",
    "episode",
    "eps",
    "season",
    "yang",
    "di",
    "weebin",
    "dong",
    "bos",
    "bro",
    "bang",
    "kak",
    "min",
    "kamu",
    "aku",
    "gw",
    "gua",
    "gue",
    "anjay",
    "gg",
    "job",
    "baby",
    "thanks",
    "makasih",
    "bagus",
    "mantap",
    "apa",
    "berapa",
    "cari",
    "carikan",
    "tentang",
    "cara",
    "rekomendasi",
    "recommend",
    "saran",
    "saranin",
    "cek",
    "kalau",
    "lagi",
    "bingung",
    "dulu",
    "dua",
    "duanya",
    "paling",
    "relevan",
    "sini",
    "mau",
    "bantu",
    "pilih",
    "pilihin",
    "lebih",
    "santai",
    "coba",
    "cobain",
    "gas",
    "lanjut",
    "dia",
    "ini",
    "itu",
    "the",
    "and",
    "atau",
    "dan",
  ]);

  return Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !stopWords.has(token)),
    ),
  ).slice(0, 6);
}

function titlePhraseTerms(query: string) {
  const terms = new Set<string>();

  for (const chunk of query.split(/[;|]+/)) {
    const term = chunk
      .replace(/\b(anime|donghua|rekomendasi|recommend|coba|dong|itu)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (term.split(/\s+/).length >= 2) terms.add(term);
  }

  for (const match of query.matchAll(
    /\b(?:[A-Z][A-Za-z0-9'’:-]*|[0-9]+)(?:\s+(?:[A-Z][A-Za-z0-9'’:-]*|[0-9]+)){1,7}\b/g,
  )) {
    const term = match[0].replace(/\s+/g, " ").trim();
    if (term.split(/\s+/).length >= 2) terms.add(term);
    if (terms.size >= 6) break;
  }

  return Array.from(terms).slice(0, 6);
}

function aliasTerms(query: string) {
  const text = query.toLowerCase();
  const terms = new Set<string>();
  const seasonMatch = text.match(/\bseason\s*(\d{1,3})\b/);

  if (/\bbtth\b/.test(text)) {
    terms.add("Battle Through the Heavens");
    if (seasonMatch) {
      terms.add(`Battle Through the Heavens Season ${seasonMatch[1]}`);
    }
  }

  if (/\bsoul\s*land\b|\bdouluo\s*dalu\b/.test(text)) {
    terms.add("Soul Land");
    if (seasonMatch) terms.add(`Soul Land Season ${seasonMatch[1]}`);
  }

  if (/\bswallowed\s*star\b|\btunshi\s*xingkong\b/.test(text)) {
    terms.add("Swallowed Star");
    if (seasonMatch) terms.add(`Swallowed Star Season ${seasonMatch[1]}`);
  }

  return Array.from(terms);
}

function hasExplicitCardIntent(query: string) {
  return /\b(anime|donghua|episode|eps?|season|movie|film|rekomendasi|recommend|saran|cari|carikan|ada|nonton|tonton|genre|romance|action|fantasy|cultivation|xianxia|wuxia|judul|rilis|terbaru|lanjut|tamat|sub(?:title)?)\b/i.test(
    query,
  );
}

function extractEpisodeNumbers(query: string) {
  const numbers = new Set<number>();
  for (const match of query.matchAll(
    /\b(?:ep|eps|episode)\s*\.?\s*(\d{1,4})\b/gi,
  )) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && number > 0) numbers.add(number);
  }
  return Array.from(numbers).slice(0, 4);
}

function episodeNumberFromText(value: string) {
  const match = value.match(/\b(?:ep|eps|episode)[\s.-]*(\d{1,4})\b/i);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function scoreText(value: string, tokens: string[], slug: string) {
  const text = value.toLowerCase();
  const slugText = slug.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (text.includes(token)) score += 2;
    if (slugText.includes(token)) score += 3;
  }
  if (tokens.length > 1 && tokens.every((token) => text.includes(token))) {
    score += 8;
  }
  if (tokens.length > 1 && tokens.every((token) => slugText.includes(token))) {
    score += 10;
  }
  return score;
}

function scoreCandidate(
  value: string,
  tokens: string[],
  slug: string,
  exactTerms: string[] = [],
) {
  const text = value.toLowerCase();
  const slugText = slug.toLowerCase();
  let score = scoreText(value, tokens, slug);

  for (const term of exactTerms) {
    const cleanTerm = term.toLowerCase().replace(/\s+/g, " ").trim();
    if (!cleanTerm) continue;

    const slugTerm = slugifyQuery(cleanTerm);
    if (text.includes(cleanTerm) || slugText.includes(slugTerm)) {
      score += /\bseason\s*\d+\b/i.test(cleanTerm) ? 40 : 16;
    }
  }

  return score;
}

function animeToCard(anime: {
  id: number;
  title: string;
  slug: string;
  thumbnail: string | null;
  bigCover: string | null;
  synopsis: string | null;
}): ChatContextPayload {
  return {
    type: "anime",
    id: String(anime.id),
    title: anime.title,
    animeTitle: null,
    thumbnail: anime.thumbnail ?? anime.bigCover ?? null,
    description: compactText(anime.synopsis),
    slug: anime.slug,
    animeSlug: null,
    url: `/anime/${anime.slug}`,
  };
}

function episodeToCard(episode: {
  id: number;
  title: string;
  slug: string;
  number: number;
  thumbnail: string | null;
  anime: {
    title: string;
    slug: string;
    thumbnail: string | null;
    bigCover: string | null;
    synopsis: string | null;
  };
}): ChatContextPayload {
  return {
    type: "episode",
    id: String(episode.id),
    title: episode.title || `Episode ${episode.number}`,
    animeTitle: episode.anime.title,
    thumbnail:
      episode.thumbnail ?? episode.anime.thumbnail ?? episode.anime.bigCover,
    description: compactText(episode.anime.synopsis),
    slug: episode.slug,
    animeSlug: episode.anime.slug,
    url: `/anime/${episode.anime.slug}/${episode.slug}`,
  };
}

export async function retrieveWeebinContext(
  query: string,
): Promise<ChatbotRetrievalContext> {
  const cleanQuery = query.replace(/\s+/g, " ").trim();
  const tokens = queryTokens(cleanQuery);
  const slug = slugifyQuery(cleanQuery);
  const episodeNumbers = extractEpisodeNumbers(cleanQuery);
  const hasEpisodeIntent = /\b(?:ep|eps|episode)\b/i.test(cleanQuery);
  const phraseTerms = titlePhraseTerms(cleanQuery);
  const aliases = aliasTerms(cleanQuery);
  const scoreTokens = Array.from(
    new Set([...tokens, ...aliases.flatMap((alias) => queryTokens(alias))]),
  );
  const exactTerms = [...aliases, ...phraseTerms];
  const searchableTerms = [...aliases, ...phraseTerms, cleanQuery, slug, ...tokens]
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .slice(0, 8);

  if (searchableTerms.length === 0 && episodeNumbers.length === 0) {
    return {
      query: cleanQuery,
      animeCandidates: [],
      episodeCandidates: [],
      cards: [],
      shouldShowCards: false,
    };
  }

  const [animes, episodes] = await Promise.all([
    searchableTerms.length
      ? prisma.anime.findMany({
          where: {
            OR: searchableTerms.flatMap((term) => [
              { title: { contains: term } },
              { slug: { contains: term } },
              { alternativeTitles: { contains: term } },
              { synopsis: { contains: term } },
              { genres: { some: { genre: { name: { contains: term } } } } },
            ]),
          },
          select: {
            id: true,
            title: true,
            slug: true,
            thumbnail: true,
            bigCover: true,
            alternativeTitles: true,
            synopsis: true,
            status: true,
            type: true,
            totalEpisodes: true,
            genres: { select: { genre: { select: { name: true } } }, take: 8 },
          },
          orderBy: [{ updatedAt: "desc" }],
          take: 24,
        })
      : Promise.resolve([]),
    prisma.episode.findMany({
      where: {
        OR: [
          ...searchableTerms.flatMap((term) => [
            { title: { contains: term } },
            { slug: { contains: term } },
            { anime: { title: { contains: term } } },
            { anime: { slug: { contains: term } } },
            { anime: { synopsis: { contains: term } } },
          ]),
          ...(episodeNumbers.length ? [{ number: { in: episodeNumbers } }] : []),
        ],
      },
      select: {
        id: true,
        title: true,
        slug: true,
        number: true,
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
      orderBy: [{ updatedAt: "desc" }],
      take: 24,
    }),
  ]);

  const sortedAnimes = animes
    .map((anime) => ({
      anime,
      score: scoreCandidate(
        `${anime.title} ${anime.alternativeTitles ?? ""} ${anime.synopsis ?? ""} ${anime.genres
          .map((item) => item.genre.name)
          .join(" ")}`,
        scoreTokens,
        anime.slug,
        exactTerms,
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.anime);

  const scoredEpisodes = episodes.map((episode) => {
    const displayNumber =
      episodeNumberFromText(`${episode.title} ${episode.slug}`) ?? episode.number;
    const matchesRequestedEpisode = episodeNumbers.includes(displayNumber);
    const baseScore = scoreCandidate(
      `${episode.title} ${episode.anime.title} ${episode.anime.synopsis ?? ""}`,
      scoreTokens,
      `${episode.anime.slug} ${episode.slug}`,
      exactTerms,
    );
    const numberBonus = matchesRequestedEpisode ? 24 : 0;
    return {
      episode,
      baseScore,
      matchesRequestedEpisode,
      score: baseScore + numberBonus,
    };
  });
  const exactEpisodeMatches =
    hasEpisodeIntent && episodeNumbers.length
      ? scoredEpisodes.filter(
          (item) => item.matchesRequestedEpisode && item.baseScore > 0,
        )
      : [];
  const sortedEpisodes = (exactEpisodeMatches.length ? exactEpisodeMatches : scoredEpisodes)
    .filter((item) => item.score > 0 && (item.baseScore > 0 || scoreTokens.length === 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((item) => item.episode);

  const strongestScore = Math.max(
    0,
    ...animes.map((anime) =>
      scoreCandidate(
        `${anime.title} ${anime.alternativeTitles ?? ""}`,
        scoreTokens,
        anime.slug,
        exactTerms,
      ),
    ),
    ...episodes.map((episode) =>
      scoreCandidate(
        `${episode.title} ${episode.anime.title}`,
        scoreTokens,
        `${episode.anime.slug} ${episode.slug}`,
        exactTerms,
      ),
    ),
  );
  const shouldShowCards =
    hasExplicitCardIntent(cleanQuery) ||
    (tokens.length > 0 &&
      tokens.length <= 2 &&
      strongestScore >= Math.max(6, tokens.length * 4));

  const animeCandidates: ChatbotAnimeCandidate[] = sortedAnimes.map((anime) => ({
    id: anime.id,
    title: anime.title,
    slug: anime.slug,
    thumbnail: anime.thumbnail ?? anime.bigCover ?? null,
    synopsis: compactText(anime.synopsis, 360),
    status: anime.status,
    type: anime.type,
    totalEpisodes: anime.totalEpisodes,
    genres: anime.genres.map((item) => item.genre.name).filter(Boolean),
    url: `/anime/${anime.slug}`,
  }));

  const episodeCandidates: ChatbotEpisodeCandidate[] = sortedEpisodes.map(
    (episode) => ({
      id: episode.id,
      title: episode.title || `Episode ${episode.number}`,
      slug: episode.slug,
      number: episode.number,
      thumbnail:
        episode.thumbnail ??
        episode.anime.thumbnail ??
        episode.anime.bigCover ??
        null,
      animeTitle: episode.anime.title,
      animeSlug: episode.anime.slug,
      animeSynopsis: compactText(episode.anime.synopsis, 260),
      url: `/anime/${episode.anime.slug}/${episode.slug}`,
    }),
  );

  const cards: ChatContextPayload[] = [];
  const seen = new Set<string>();
  const orderedCards = hasEpisodeIntent
    ? [...sortedEpisodes.map(episodeToCard), ...sortedAnimes.map(animeToCard)]
    : [...sortedAnimes.map(animeToCard), ...sortedEpisodes.map(episodeToCard)];

  for (const card of orderedCards) {
    const key = `${card.type}:${card.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(card);
    if (cards.length >= 5) break;
  }
  const exactSeasonTerms = exactTerms
    .filter((term) => /\bseason\s*\d+\b/i.test(term))
    .map((term) => ({ text: term.toLowerCase(), slug: slugifyQuery(term) }));
  const focusedCards = exactSeasonTerms.length
    ? cards.filter((card) => {
        const title = `${card.title ?? ""} ${card.animeTitle ?? ""}`.toLowerCase();
        const slugs = `${card.slug ?? ""} ${card.animeSlug ?? ""}`.toLowerCase();
        return exactSeasonTerms.some(
          (term) => title.includes(term.text) || slugs.includes(term.slug),
        );
      })
    : cards;

  return {
    query: cleanQuery,
    animeCandidates,
    episodeCandidates,
    cards: shouldShowCards
      ? (focusedCards.length > 0 ? focusedCards : cards).slice(0, 5)
      : [],
    shouldShowCards,
  };
}
