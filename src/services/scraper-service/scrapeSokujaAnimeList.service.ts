import * as cheerio from "cheerio";
import type {
  AnimeDetail,
  AnimeEpisode,
  AnimeMetadata,
  AnimeTag,
} from "./types";

const SOKUJA_ORIGIN = "https://x5.sokuja.uk";
const DEFAULT_PAGE_SIZE = 24;

export type SokujaAnimeCard = {
  source: "sokuja";
  sourceUrl: string;
  page: number;
  title: string;
  slug: string;
  detailUrl: string;
  thumbnail: string | null;
  bigCover: string | null;
  rating: number | null;
  status: string | null;
  released: string | null;
  type: string | null;
};

export type SokujaAnimeDatabasePayload = {
  slug: string;
  title: string;
  thumbnail: string | null;
  bigCover: string | null;
  rating: number | null;
  status: string | null;
  released: string | null;
  type: string | null;
};

export type SokujaAnimePageResult = {
  page: number;
  sourceUrl: string;
  totalFound: number | null;
  pageSize: number;
  estimatedTotalPages: number | null;
  items: SokujaAnimeCard[];
  databasePayload: SokujaAnimeDatabasePayload[];
  animeDetails?: AnimeDetail[];
};

export type SokujaAnimePagesResult = {
  fromPage: number;
  toPage: number;
  totalFound: number | null;
  estimatedTotalPages: number | null;
  count: number;
  items: SokujaAnimeCard[];
  databasePayload: SokujaAnimeDatabasePayload[];
  animeDetails?: AnimeDetail[];
};

export type SokujaAnimeScrapeOptions = {
  includeDetails?: boolean;
  includeEpisodeServers?: boolean;
  episodeMode?: "full" | "recent";
  episodeLimit?: number;
};

function buildAnimeListUrl(page: number) {
  const url = new URL("/anime/", SOKUJA_ORIGIN);
  url.searchParams.set("page", String(page));
  return url.href;
}

async function fetchSokujaPage(page: number): Promise<{
  html: string;
  sourceUrl: string;
}> {
  const sourceUrl = buildAnimeListUrl(page);
  const response = await fetch(sourceUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Sokuja page ${page}: ${response.status}`);
  }

  return {
    html: await response.text(),
    sourceUrl,
  };
}

function normalizePage(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function normalizeType(type: string | null) {
  if (!type) return null;
  return type.trim().toUpperCase() === "TV" ? "Anime" : type.trim();
}

function parseRating(value: string | null) {
  if (!value) return null;
  const rating = Number.parseFloat(value.replace("★", "").trim());
  return Number.isFinite(rating) ? rating : null;
}

function extractSlug(href: string) {
  return href.replace(/^\/anime\//, "").replace(/^\/+|\/+$/g, "");
}

function extractPathSlug(href: string) {
  return new URL(href, SOKUJA_ORIGIN).pathname.replace(/^\/+|\/+$/g, "");
}

function extractAnimeBaseSlug(slug: string) {
  return slug.replace(/-subtitle-indonesia$/i, "");
}

function normalizeDetailTitle(title: string) {
  return title.replace(/\s+Subtitle\s+Indonesia$/i, "").trim();
}

function normalizeMetadataKey(label: string) {
  const keyMap: Record<string, string> = {
    status: "status",
    tipe: "type",
    tahun: "released",
    musim: "season",
    subtitle: "subtitle",
    fansub: "fansub",
    studio: "studio",
    sutradara: "director",
    produser: "producer",
    negara: "country",
    durasi: "duration",
    episode: "episodes",
    episodes: "episodes",
    jaringan: "network",
  };
  const key = label.trim().toLowerCase();
  return keyMap[key] ?? key.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeImageUrl(src: string | undefined) {
  if (!src) return null;

  const imageUrl = new URL(src, SOKUJA_ORIGIN);
  if (imageUrl.pathname !== "/_next/image/") {
    return imageUrl.href;
  }

  const originalUrl = imageUrl.searchParams.get("url");
  if (!originalUrl) return imageUrl.href;

  return new URL(originalUrl, SOKUJA_ORIGIN).href;
}

function uniqueValues(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseInfoMetadata($: cheerio.CheerioAPI): AnimeMetadata {
  const metadata: AnimeMetadata = {};
  const infoHeading = $("h2")
    .filter((_, element) => /informasi anime/i.test($(element).text()))
    .first();

  infoHeading.parent().find("dl > div").each((_, element) => {
    const label = $(element).find("dt").first().text().trim();
    const value = $(element).find("dd").first().text().replace(/\s+/g, " ").trim();
    const key = normalizeMetadataKey(label);

    if (key && value) {
      metadata[key] = key === "type" ? normalizeType(value) ?? value : value;
    }
  });

  return metadata;
}

function parseSynopsis($: cheerio.CheerioAPI) {
  const synopsisHeading = $("h2")
    .filter((_, element) => /sinopsis|synopsis/i.test($(element).text()))
    .first();

  return synopsisHeading
    .parent()
    .find(".prose p")
    .map((_, element) => $(element).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean)
    .join("\n");
}

function parseDetailImages($: cheerio.CheerioAPI, fallback: string | null) {
  const poster = normalizeImageUrl($("main img").first().attr("src")) ?? fallback;
  const gallery = $("h2")
    .filter((_, element) => /galeri/i.test($(element).text()))
    .first()
    .parent()
    .find("img")
    .map((_, element) => normalizeImageUrl($(element).attr("src")))
    .get()
    .filter(Boolean);

  return {
    poster,
    gallery,
  };
}

function parseTags($: cheerio.CheerioAPI, selector: string): AnimeTag[] {
  return $(selector)
    .map((_, element) => ({
      label: $(element).text().replace(/\s+/g, " ").trim(),
      href: $(element).attr("href") ?? null,
    }))
    .get()
    .filter((tag) => Boolean(tag.label));
}

function parseDetailGenres($: cheerio.CheerioAPI) {
  return uniqueValues(
    $('a[href^="/genre/"]')
      .map((_, element) => $(element).text().trim())
      .get()
      .filter((genre) => !/^genre$/i.test(genre)),
  );
}

function parseEpisodeNumber(text: string, href: string | null) {
  const slug = href ? extractPathSlug(href) : "";
  const slugMatch = slug.match(/(?:^|-)episode-(\d+)(?:-|$)/i);
  if (slugMatch) return slugMatch[1];

  const source = text.replace(/\s+/g, " ").trim();
  const match = source.match(/\bepisode\s+(\d{1,4})\b/i) ?? source.match(/\bep\s*(\d{1,4})\b/i);
  return match?.[1] ?? "0";
}

function parseEpisodeDate($: cheerio.CheerioAPI, element: Parameters<typeof $>[0]) {
  const directDate = $(element).find("span.text-xs").first().text().replace(/\s+/g, " ").trim();
  if (directDate) return directDate;

  const text = $(element).text().replace(/\s+/g, " ").trim();
  return (
    text.match(/(\d+\s+(?:menit|jam|hari|minggu|bulan|tahun)\s+lalu)$/i)?.[1] ?? ""
  );
}

function parseEpisodes($: cheerio.CheerioAPI, animeSlug: string): AnimeEpisode[] {
  const animeBaseSlug = extractAnimeBaseSlug(animeSlug);
  const seen = new Set<string>();

  return $('a[href*="episode"][href$="subtitle-indonesia/"]')
    .map((_, element): AnimeEpisode | null => {
      const anchor = $(element);
      const href = anchor.attr("href") ?? null;
      if (!href) return null;

      const absoluteHref = new URL(href, SOKUJA_ORIGIN).href;
      const episodeSlug = extractPathSlug(absoluteHref);
      if (!episodeSlug.includes(animeBaseSlug) || seen.has(absoluteHref)) return null;

      const number = parseEpisodeNumber(anchor.text(), href);
      if (number === "0") return null;
      seen.add(absoluteHref);

      return {
        number,
        title: `Episode ${number}`,
        href: absoluteHref,
        thumbnail: normalizeImageUrl(anchor.find("img").first().attr("src")),
        sub: "Sub",
        date: parseEpisodeDate($, element),
        status: "published",
      };
    })
    .get()
    .filter((episode): episode is AnimeEpisode => episode !== null);
}

function parseEpisodeSourceId(html: string) {
  const match = html.match(/\\"episodeId\\":(\d+)/) ?? html.match(/"episodeId":(\d+)/);
  if (!match) return null;

  const sourceId = Number.parseInt(match[1], 10);
  return Number.isFinite(sourceId) ? sourceId : null;
}

export async function fetchSokujaEpisodeMirrors(episodeId: number, referer: string) {
  const response = await fetch(`${SOKUJA_ORIGIN}/api/video-mirrors/?e=${episodeId}`, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      Referer: referer,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Sokuja video mirrors: ${response.status}`);
  }

  const payload = (await response.json()) as {
    mirrors?: Array<{
      serverName?: string;
      embedUrl?: string;
      quality?: string;
    }>;
  };

  return (payload.mirrors ?? [])
    .map((mirror, index) => ({
      label: `${mirror.serverName ?? "SOKUJA"} ${mirror.quality ?? ""}`.trim(),
      value: mirror.embedUrl,
      isPrimary: index === 0,
    }))
    .filter((server) => Boolean(server.value));
}

async function enrichEpisodeWithServers(episode: AnimeEpisode): Promise<AnimeEpisode> {
  if (!episode.href) return episode;

  let html: string;
  try {
    html = await fetchDetailPage(episode.href);
  } catch {
    return {
      ...episode,
      servers: [],
    };
  }

  const $ = cheerio.load(html);
  const episodeId = parseEpisodeSourceId(html);
  const thumbnail =
    normalizeImageUrl($('meta[property="og:image"]').attr("content")) ?? episode.thumbnail;
  const date =
    $(".flex.flex-wrap.items-center.gap-3.text-xs.text-gray-400 span")
      .eq(1)
      .text()
      .replace(/\s+/g, " ")
      .trim() || episode.date;
  let servers: AnimeEpisode["servers"] = [];

  if (episodeId) {
    try {
      servers = await fetchSokujaEpisodeMirrors(episodeId, episode.href);
    } catch {
      servers = [];
    }
  }

  return {
    ...episode,
    thumbnail,
    date,
    sourceEpisodeId: episodeId,
    servers,
  };
}

async function fetchDetailPage(detailUrl: string) {
  const response = await fetch(detailUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Sokuja detail: ${response.status}`);
  }

  return response.text();
}

export async function scrapeSokujaAnimeDetail(
  card: SokujaAnimeCard,
  options: SokujaAnimeScrapeOptions = {},
): Promise<AnimeDetail> {
  const html = await fetchDetailPage(card.detailUrl);
  const $ = cheerio.load(html);
  const title = normalizeDetailTitle($("h1").first().text().trim()) || card.title;
  const metadata = parseInfoMetadata($);
  const { poster, gallery } = parseDetailImages($, card.thumbnail);
  const cast = parseTags($, 'a[href^="/cast/"]');
  const tags = [
    ...parseTags($, 'a[href^="/studio/"]'),
    ...parseTags($, 'a[href^="/director/"]'),
    ...parseTags($, 'a[href^="/season/"]'),
  ];

  if (!metadata.status && card.status) metadata.status = card.status;
  if (!metadata.type && card.type) metadata.type = card.type;
  if (!metadata.released && card.released) metadata.released = card.released;
  if (gallery.length) metadata.gallery = JSON.stringify(gallery);
  if (cast.length) metadata.cast = JSON.stringify(cast);

  const episodes = parseEpisodes($, card.slug);
  const scanEpisodes =
    options.episodeMode === "recent"
      ? [...episodes]
          .sort((left, right) => (Number(right.number) || 0) - (Number(left.number) || 0))
          .slice(0, Math.max(1, options.episodeLimit ?? 2))
      : episodes;
  const enrichedEpisodes = options.includeEpisodeServers
    ? await Promise.all(scanEpisodes.map((episode) => enrichEpisodeWithServers(episode)))
    : scanEpisodes;
  if (enrichedEpisodes.length && !metadata.episodes) {
    metadata.episodes = String(enrichedEpisodes.length);
  }

  return {
    title,
    thumbnail: poster,
    bigCover: poster,
    rating: card.rating === null ? null : String(card.rating),
    alternativeTitles: null,
    synopsis: parseSynopsis($),
    metadata,
    genres: parseDetailGenres($),
    episodes: enrichedEpisodes,
    followed: null,
    tags,
  };
}

function parseTotalFound($: cheerio.CheerioAPI) {
  const summaryText = $("main p")
    .filter((_, element) => /\d+\s+anime\s+ditemukan/i.test($(element).text()))
    .first()
    .text();
  const match = summaryText.match(/(\d+)\s+anime\s+ditemukan/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function toDatabasePayload(item: SokujaAnimeCard): SokujaAnimeDatabasePayload {
  return {
    slug: item.slug,
    title: item.title,
    thumbnail: item.thumbnail,
    bigCover: item.bigCover,
    rating: item.rating,
    status: item.status,
    released: item.released,
    type: item.type,
  };
}

function parseAnimeCards(
  html: string,
  page: number,
  sourceUrl: string,
): SokujaAnimeCard[] {
  const $ = cheerio.load(html);

  return $('a.group.block[href^="/anime/"]')
    .map((_, element): SokujaAnimeCard | null => {
      const card = $(element);
      const href = card.attr("href");
      const title = card.find("h3").first().text().trim();

      if (!href || !title) return null;

      const badges = card
        .find("span")
        .map((_, badge) => $(badge).text().replace(/\s+/g, " ").trim())
        .get()
        .filter(Boolean);
      const thumbnail = normalizeImageUrl(card.find("img").first().attr("src"));
      const released = card.find("p").first().text().trim() || null;

      return {
        source: "sokuja",
        sourceUrl,
        page,
        title,
        slug: extractSlug(href),
        detailUrl: new URL(href, SOKUJA_ORIGIN).href,
        thumbnail,
        bigCover: thumbnail,
        rating: parseRating(badges[1] ?? null),
        status: badges[2] ?? null,
        released,
        type: normalizeType(badges[0] ?? null),
      };
    })
    .get()
    .filter((item): item is SokujaAnimeCard => item !== null);
}

export async function scrapeSokujaAnimePage(
  pageInput = 1,
  options: SokujaAnimeScrapeOptions = {},
): Promise<SokujaAnimePageResult> {
  const page = normalizePage(pageInput);
  const { html, sourceUrl } = await fetchSokujaPage(page);
  const $ = cheerio.load(html);
  const totalFound = parseTotalFound($);
  const items = parseAnimeCards(html, page, sourceUrl);
  const pageSize = items.length || DEFAULT_PAGE_SIZE;

  const animeDetails = options.includeDetails
    ? await Promise.all(items.map((item) => scrapeSokujaAnimeDetail(item, options)))
    : undefined;

  return {
    page,
    sourceUrl,
    totalFound,
    pageSize,
    estimatedTotalPages: totalFound ? Math.ceil(totalFound / pageSize) : null,
    items,
    databasePayload: items.map(toDatabasePayload),
    ...(animeDetails ? { animeDetails } : {}),
  };
}

export async function scrapeSokujaAnimePages(
  fromPageInput = 1,
  toPageInput = fromPageInput,
  options: SokujaAnimeScrapeOptions = {},
): Promise<SokujaAnimePagesResult> {
  const fromPage = normalizePage(fromPageInput);
  const toPage = Math.max(fromPage, normalizePage(toPageInput));
  const pageResults: SokujaAnimePageResult[] = [];

  for (let page = fromPage; page <= toPage; page += 1) {
    pageResults.push(await scrapeSokujaAnimePage(page, options));
  }

  const items = pageResults.flatMap((result) => result.items);
  const animeDetails = pageResults.flatMap((result) => result.animeDetails ?? []);
  const totalFound = pageResults.find((result) => result.totalFound)?.totalFound ?? null;
  const estimatedTotalPages =
    pageResults.find((result) => result.estimatedTotalPages)?.estimatedTotalPages ??
    null;

  return {
    fromPage,
    toPage,
    totalFound,
    estimatedTotalPages,
    count: items.length,
    items,
    databasePayload: items.map(toDatabasePayload),
    ...(options.includeDetails ? { animeDetails } : {}),
  };
}
