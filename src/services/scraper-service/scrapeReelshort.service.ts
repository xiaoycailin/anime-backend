import * as cheerio from "cheerio";
import { badRequest } from "../../utils/http-error";
import {
  fetchReelshortChapterApiDetail,
  type ReelshortPlayInfoItem,
  type ReelshortChapterApiDetail,
} from "./reelshortClient";

export const REELSHORT_PROVIDER_CODE = "rls";

type JsonRecord = Record<string, unknown>;

type ReelshortNextData = {
  props?: {
    pageProps?: JsonRecord & {
      data?: ReelshortPageData;
    };
  };
  query?: {
    slug?: string;
  };
  locale?: string;
};

type ReelshortPageData = {
  book_id?: unknown;
  book_title?: unknown;
  book_pic?: unknown;
  chapter_id?: unknown;
  chapter_desc?: unknown;
  episode?: unknown;
  serial_number?: unknown;
  special_desc?: unknown;
  total?: unknown;
  tag?: unknown;
  tag_list?: unknown;
  online_base?: unknown;
  video_pic?: unknown;
  video_url?: unknown;
};

type ReelshortRawEpisode = {
  chapter_id?: unknown;
  status?: unknown;
  like_count?: unknown;
  serial_number?: unknown;
};

export type ReelshortEpisode = {
  number: number;
  label: string;
  chapterId: string;
  url: string;
  status: number | null;
  likeCount: number | null;
};

export type ReelshortTag = {
  id: string | null;
  categoryId: string | null;
  text: string;
};

export type ReelshortDetail = {
  provider: typeof REELSHORT_PROVIDER_CODE;
  source: "reelshort";
  sourceUrl: string;
  bookId: string | null;
  slug: string;
  title: string;
  imageUrl: string | null;
  tags: string[];
  tagItems: ReelshortTag[];
  totalEpisodes: number;
  episodes: ReelshortEpisode[];
};

export type ReelshortPlaylist = {
  quality: string;
  definition: string | null;
  isCurrent: boolean;
  url: string;
  bitrate?: number | null;
  codec?: string | null;
};

export type ReelshortEpisodeDetail = {
  provider: typeof REELSHORT_PROVIDER_CODE;
  source: "reelshort";
  sourceUrl: string;
  bookId: string | null;
  chapterId: string | null;
  slug: string;
  episodeNumber: number | null;
  title: string;
  plot: string | null;
  thumbnail: string | null;
  playlistUrl: string | null;
  playlists: ReelshortPlaylist[];
  isLocked: boolean | null;
  unlockCost: number | null;
  hasSignedPlayInfo: boolean;
};

const REELSHORT_ORIGIN = "https://www.reelshort.com";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
};

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanTitle(value: string | null) {
  return (
    value
      ?.replace(/\s*Tonton\s+Film\s+Online\s*\|\s*ReelShort\s*$/i, "")
      .replace(/\s*\|\s*ReelShort\s*$/i, "")
      .trim() ?? ""
  );
}

function assertReelshortUrl(rawUrl: string, pathKind: "movie" | "episodes") {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw badRequest("URL ReelShort tidak valid");
  }

  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !["reelshort.com", "www.reelshort.com"].includes(host)) {
    throw badRequest("URL harus dari reelshort.com");
  }

  if (!parsed.pathname.includes(`/${pathKind}/`)) {
    throw badRequest(`URL ReelShort harus halaman ${pathKind}`);
  }

  parsed.hostname = "www.reelshort.com";
  return parsed;
}

function extractNextData(html: string): ReelshortNextData | null {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) return null;

  try {
    return JSON.parse(match[1]) as ReelshortNextData;
  } catch {
    return null;
  }
}

function getPageData(nextData: ReelshortNextData | null) {
  return nextData?.props?.pageProps?.data ?? null;
}

function getPageProps(nextData: ReelshortNextData | null) {
  return nextData?.props?.pageProps ?? null;
}

function getSlug(sourceUrl: URL, nextData: ReelshortNextData | null) {
  const querySlug = asString(nextData?.query?.slug);
  if (querySlug) return querySlug;

  const marker = sourceUrl.pathname.includes("/episodes/") ? "/episodes/" : "/movie/";
  const markerIndex = sourceUrl.pathname.indexOf(marker);
  if (markerIndex === -1)
    return sourceUrl.pathname.split("/").filter(Boolean).pop() ?? "";

  return decodeURIComponent(sourceUrl.pathname.slice(markerIndex + marker.length));
}

function getLocale(sourceUrl: URL, nextData: ReelshortNextData | null) {
  const nextLocale = asString(nextData?.locale);
  if (nextLocale) return nextLocale;

  const firstSegment = sourceUrl.pathname.split("/").filter(Boolean)[0];
  return firstSegment && firstSegment !== "movie" ? firstSegment : "id";
}

function getMeta($: cheerio.CheerioAPI, selector: string) {
  return asString($(selector).attr("content"));
}

function buildEpisodeUrl(locale: string, slug: string, episode: ReelshortRawEpisode) {
  const number = asNumber(episode.serial_number);
  const chapterId = asString(episode.chapter_id);
  if (!number || number < 1 || !chapterId) return null;

  return {
    number: Math.trunc(number),
    label: `EP ${Math.trunc(number)}`,
    chapterId,
    url: `${REELSHORT_ORIGIN}/${locale}/episodes/episode-${Math.trunc(number)}-${slug}-${chapterId}`,
    status: asNumber(episode.status),
    likeCount: asNumber(episode.like_count),
  };
}

function parseEpisodes(data: ReelshortPageData | null, locale: string, slug: string) {
  if (!Array.isArray(data?.online_base)) return [];

  return data.online_base
    .map((item) => asRecord(item) as ReelshortRawEpisode | null)
    .filter((item): item is ReelshortRawEpisode => Boolean(item))
    .map((item) => buildEpisodeUrl(locale, slug, item))
    .filter((item): item is ReelshortEpisode => Boolean(item))
    .sort((a, b) => a.number - b.number);
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function parseTagItems(data: ReelshortPageData | null): ReelshortTag[] {
  if (!Array.isArray(data?.tag_list)) return [];

  return data.tag_list
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => Boolean(item))
    .map((item) => {
      const text = asString(item.text);
      if (!text) return null;

      return {
        id: asString(item.id),
        categoryId: asString(item.category_id),
        text,
      };
    })
    .filter((item): item is ReelshortTag => Boolean(item));
}

function parseTags(data: ReelshortPageData | null, tagItems: ReelshortTag[]) {
  const directTags = Array.isArray(data?.tag)
    ? data.tag.map((item) => asString(item)).filter((item): item is string => Boolean(item))
    : [];

  return uniqueStrings([...tagItems.map((item) => item.text), ...directTags]);
}

function normalizeM3u8Url(rawUrl: string) {
  return rawUrl.replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
}

function getM3u8Quality(url: string) {
  const match = url.match(/-([a-z]{2})\.m3u8(?:$|[?#])/i);
  const quality = match?.[1]?.toLowerCase();
  return quality ?? "unknown";
}

function normalizeDefinition(value: unknown) {
  const numeric = asNumber(value);
  if (!numeric) return null;
  if (numeric >= 800) return "1080P";
  if (numeric >= 700) return "720P";
  if (numeric >= 500) return "540P";
  return `${Math.trunc(numeric)}P`;
}

function normalizeDefinitionLabel(value: unknown) {
  return normalizeDefinition(value) ?? asString(value);
}

function parseBitrate(value: unknown) {
  const bitrate = asNumber(value);
  return bitrate ? Math.round(bitrate * 1000) : null;
}

function parseBooleanAttr(value: string | undefined) {
  return value === "true" || value === "selected";
}

function parseQualityOptionAttrs(rawAttrs: string) {
  const attrs = new Map<string, string>();

  for (const match of rawAttrs.matchAll(/([\w-]+)=["']([^"']+)["']/g)) {
    attrs.set(match[1].toLowerCase(), match[2]);
  }

  return attrs;
}

function buildPlaylistFromAttrs(attrs: Map<string, string>) {
  const url = asString(attrs.get("url"));
  if (!url || !url.includes(".m3u8")) return null;

  const definition = asString(attrs.get("definition")) || asString(attrs.get("showtext"));
  return {
    quality: definition ?? getM3u8Quality(url),
    definition,
    isCurrent:
      parseBooleanAttr(attrs.get("iscurrent")) ||
      parseBooleanAttr(attrs.get("selected")),
    url: normalizeM3u8Url(url),
  };
}

function parseQualityOptions($: cheerio.CheerioAPI, html: string) {
  const options: ReelshortPlaylist[] = [];

  $(".option-item[url], li[url][definition]").each((_, element) => {
    const node = $(element);
    const attrs = parseQualityOptionAttrs(
      Object.entries(element.attribs ?? {})
        .map(([key, value]) => `${key}="${value}"`)
        .join(" "),
    );
    const playlist = buildPlaylistFromAttrs(attrs);
    if (!playlist) return;

    options.push({
      ...playlist,
      isCurrent: playlist.isCurrent || node.hasClass("selected"),
    });
  });

  for (const match of html.matchAll(/<li\b[^>]*class=["'][^"']*option-item[^"']*["'][^>]*>/gi)) {
    const playlist = buildPlaylistFromAttrs(parseQualityOptionAttrs(match[0]));
    if (playlist) options.push(playlist);
  }

  const unique = new Map(options.map((item) => [item.url, item]));
  return Array.from(unique.values());
}

function collectM3u8Urls(html: string, data: ReelshortPageData | null) {
  const urls = new Map<string, ReelshortPlaylist>();
  const videoUrl = asString(data?.video_url);
  if (videoUrl) {
    const url = normalizeM3u8Url(videoUrl);
    urls.set(url, {
      quality: getM3u8Quality(url),
      definition: null,
      isCurrent: true,
      url,
    });
  }

  for (const match of html.matchAll(/https?:[^"'<>\\]+?\.m3u8[^"'<>\\]*/g)) {
    const url = normalizeM3u8Url(match[0]);
    if (!urls.has(url)) {
      urls.set(url, {
        quality: getM3u8Quality(url),
        definition: null,
        isCurrent: false,
        url,
      });
    }
  }

  return Array.from(urls.values());
}

function parsePlayInfoPlaylists(items: ReelshortPlayInfoItem[]) {
  const preferred = new Map<string, ReelshortPlaylist>();

  for (const item of items) {
    const url = asString(item.PlayURL);
    if (!url || !url.includes(".m3u8")) continue;

    const definition = normalizeDefinitionLabel(item.Dpi);
    const key = definition ?? getM3u8Quality(url);
    const playlist: ReelshortPlaylist = {
      quality: definition ?? getM3u8Quality(url),
      definition,
      isCurrent: Boolean(item.MultiBit),
      url: normalizeM3u8Url(url),
      bitrate: parseBitrate(item.Bitrate),
      codec: asString(item.Encode),
    };
    const current = preferred.get(key);
    const currentCodec = current?.codec?.toLowerCase();
    const nextCodec = playlist.codec?.toLowerCase();
    const shouldReplace =
      !current ||
      (currentCodec !== "h264" && nextCodec === "h264") ||
      (!current.isCurrent && playlist.isCurrent);
    if (shouldReplace) preferred.set(key, playlist);
  }

  return Array.from(preferred.values());
}

function getQualityCandidates(playlists: ReelshortPlaylist[]) {
  const candidates = new Map(playlists.map((item) => [item.url, item]));

  for (const item of playlists) {
    const url = item.url;
    if (!/-[a-z]{2}\.m3u8(?:$|[?#])/i.test(url)) continue;
    for (const quality of ["ld", "sd", "hd"]) {
      const nextUrl = url.replace(/-[a-z]{2}(\.m3u8(?:$|[?#]))/i, `-${quality}$1`);
      if (!candidates.has(nextUrl)) {
        candidates.set(nextUrl, {
          quality,
          definition: null,
          isCurrent: false,
          url: nextUrl,
        });
      }
    }
  }

  return Array.from(candidates.values());
}

async function playlistExists(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
    });

    if (response.ok) return true;
    if (response.status !== 405 && response.status !== 403) return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }

  return false;
}

async function parsePlaylists(
  html: string,
  $: cheerio.CheerioAPI,
  data: ReelshortPageData | null,
  sourceUrl: URL,
  locale: string,
  chapterApiDetail: ReelshortChapterApiDetail | null,
) {
  const playInfoOptions = parsePlayInfoPlaylists(chapterApiDetail?.playInfo ?? []);
  const explicitOptions = parseQualityOptions($, html);
  const rawUrls = [
    ...playInfoOptions,
    ...explicitOptions,
    ...collectM3u8Urls(html, data),
  ];
  const uniqueRawUrls = new Map<string, ReelshortPlaylist>();
  for (const item of rawUrls) {
    if (!uniqueRawUrls.has(item.url)) uniqueRawUrls.set(item.url, item);
  }
  const candidates = getQualityCandidates(Array.from(uniqueRawUrls.values()));
  const checked = await Promise.all(
    candidates.map(async (item) => ({
      ...item,
      exists: uniqueRawUrls.has(item.url) || (await playlistExists(item.url)),
    })),
  );

  return checked
    .filter((item) => item.exists)
    .map((item) => ({
      quality: item.quality,
      definition: item.definition,
      isCurrent: item.isCurrent,
      url: item.url,
      bitrate: item.bitrate,
      codec: item.codec,
    }))
    .sort((a, b) => {
      const order = { "1080P": 0, "720P": 1, "540P": 2, hd: 3, sd: 4, ld: 5, unknown: 6 };
      return (order[a.quality as keyof typeof order] ?? 99) - (order[b.quality as keyof typeof order] ?? 99);
    });
}

async function fetchReelshortHtml(url: URL) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`ReelShort fetch failed: ${response.status}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export async function scrapeReelshortDetail(rawUrl: string): Promise<ReelshortDetail> {
  const sourceUrl = assertReelshortUrl(rawUrl, "movie");
  const html = await fetchReelshortHtml(sourceUrl);
  const $ = cheerio.load(html);
  const nextData = extractNextData(html);
  const data = getPageData(nextData);
  const slug = getSlug(sourceUrl, nextData);
  const locale = getLocale(sourceUrl, nextData);
  const title = cleanTitle(
    asString(data?.book_title) ||
      getMeta($, 'meta[property="og:title"]') ||
      getMeta($, 'meta[name="twitter:title"]') ||
      asString($("title").first().text()),
  );
  const imageUrl =
    asString(data?.book_pic) ||
    getMeta($, 'meta[property="og:image"]') ||
    getMeta($, 'meta[name="twitter:image"]');
  const episodes = parseEpisodes(data, locale, slug);
  const tagItems = parseTagItems(data);
  const tags = parseTags(data, tagItems);
  const total = asNumber(data?.total);

  if (!title) {
    throw new Error("ReelShort title tidak ditemukan");
  }

  return {
    provider: REELSHORT_PROVIDER_CODE,
    source: "reelshort",
    sourceUrl: sourceUrl.toString(),
    bookId: asString(data?.book_id),
    slug,
    title,
    imageUrl,
    tags,
    tagItems,
    totalEpisodes: total ? Math.trunc(total) : episodes.length,
    episodes,
  };
}

export async function scrapeReelshortEpisodeDetail(
  rawUrl: string,
): Promise<ReelshortEpisodeDetail> {
  const sourceUrl = assertReelshortUrl(rawUrl, "episodes");
  const html = await fetchReelshortHtml(sourceUrl);
  const $ = cheerio.load(html);
  const nextData = extractNextData(html);
  const data = getPageData(nextData);
  const pageProps = getPageProps(nextData);
  const slug = getSlug(sourceUrl, nextData);
  const locale = getLocale(sourceUrl, nextData);
  const chapterApiDetail = await fetchReelshortChapterApiDetail({
    bookId: asString(data?.book_id),
    chapterId: asString(data?.chapter_id),
    referer: sourceUrl.toString(),
    locale,
  });
  const bookTitle = cleanTitle(
    asString(data?.book_title) ||
      getMeta($, 'meta[property="og:title"]') ||
      getMeta($, 'meta[name="twitter:title"]') ||
      asString($("title").first().text()),
  );
  const episodeLabel = asString(data?.episode) || asString(pageProps?.episode);
  const episodeNumber = asNumber(data?.serial_number) || asNumber(pageProps?.serial_number);
  const title = episodeLabel && bookTitle ? `${episodeLabel} - ${bookTitle}` : bookTitle;
  const playlists = await parsePlaylists(html, $, data, sourceUrl, locale, chapterApiDetail);
  const primaryUrl = asString(data?.video_url);

  if (!title) {
    throw new Error("ReelShort episode title tidak ditemukan");
  }

  return {
    provider: REELSHORT_PROVIDER_CODE,
    source: "reelshort",
    sourceUrl: sourceUrl.toString(),
    bookId: asString(data?.book_id),
    chapterId: asString(data?.chapter_id),
    slug,
    episodeNumber: episodeNumber ? Math.trunc(episodeNumber) : null,
    title,
    plot: asString(data?.chapter_desc) || asString(data?.special_desc),
    thumbnail:
      asString(data?.video_pic) ||
      asString(data?.book_pic) ||
      getMeta($, 'meta[property="og:image"]') ||
      getMeta($, 'meta[name="twitter:image"]'),
    playlistUrl: primaryUrl || playlists[0]?.url || null,
    playlists,
    isLocked: chapterApiDetail?.isLocked ?? null,
    unlockCost: chapterApiDetail?.unlockCost ?? null,
    hasSignedPlayInfo: Boolean(chapterApiDetail?.playInfo.length),
  };
}
