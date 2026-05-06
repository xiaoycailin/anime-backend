import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { getOrSetCache } from "../lib/cache";

const SOKUJA_ORIGIN = "https://x5.sokuja.uk";
const SOKUJA_SCHEDULE_URL = `${SOKUJA_ORIGIN}/jadwal-rilis-anime/`;
const SOKUJA_SCHEDULE_CACHE_KEY = "schedule:sokuja:v1";
const SOKUJA_SCHEDULE_TTL_SECONDS = 20 * 60;

const DAY_INDEX: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 0,
};

const DAY_SECTIONS = Object.keys(DAY_INDEX);

export type SokujaScheduleItem = {
  id: number;
  animeId: number;
  animeTitle: string;
  animeSlug: string;
  title: string;
  episode: string;
  episodeNumber: number;
  thumbnail: string | null;
  href: string;
  sourceUrl: string;
  scheduledAt: string;
  releasedAt: string | null;
  releaseTime: string;
  scheduleStatus: "upcoming";
  scheduleSource: "sokuja.schedule";
  notificationSent: boolean;
  animeStatus: string | null;
  animeType: string | null;
};

function formatDateJakarta(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function startOfJakartaDate(date = new Date()) {
  const [year, month, day] = formatDateJakarta(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, -7, 0, 0, 0));
}

function getJakartaDayIndex(date = new Date()) {
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    weekday: "short",
  }).format(date).toLowerCase();

  return DAY_INDEX[dayName.slice(0, 3)] ?? 0;
}

function dateForSection(sectionId: string, now = new Date()) {
  const targetDay = DAY_INDEX[sectionId];
  const todayStart = startOfJakartaDate(now);
  const todayIndex = getJakartaDayIndex(now);
  const diff = (targetDay - todayIndex + 7) % 7;
  const result = new Date(todayStart);
  result.setUTCDate(result.getUTCDate() + diff);
  return result;
}

function withScheduleTime(date: Date, timeText: string) {
  const match = timeText.match(/(\d{1,2})[:.](\d{2})/);
  if (!match) return null;

  const [year, month, day] = formatDateJakarta(date).split("-").map(Number);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute, 0, 0));
}

function extractSlug(href: string) {
  return new URL(href, SOKUJA_ORIGIN).pathname
    .replace(/^\/anime\//, "")
    .replace(/^\/+|\/+$/g, "");
}

function normalizeType(type: string | null) {
  if (!type) return null;
  const value = type.trim();
  return value.toUpperCase() === "TV" ? "Anime" : value;
}

function normalizeImageUrl(src: string | undefined) {
  if (!src) return null;

  const imageUrl = new URL(src, SOKUJA_ORIGIN);
  if (imageUrl.pathname !== "/_next/image/") return imageUrl.href;

  const originalUrl = imageUrl.searchParams.get("url");
  return originalUrl ? new URL(originalUrl, SOKUJA_ORIGIN).href : imageUrl.href;
}

async function fetchScheduleHtml() {
  const response = await fetch(SOKUJA_SCHEDULE_URL, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Sokuja schedule: ${response.status}`);
  }

  return response.text();
}

function parseCard(
  $: cheerio.CheerioAPI,
  element: Element,
  sectionId: string,
  index: number,
): SokujaScheduleItem | null {
  const anchor = $(element);
  const href = anchor.attr("href");
  const title = anchor.find("h3").first().text().replace(/\s+/g, " ").trim();
  if (!href || !title) return null;

  const badges = anchor
    .find("span")
    .map((_, badge) => $(badge).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean);
  const timeText = badges.find((badge) => /\d{1,2}[:.]\d{2}/.test(badge));
  if (!timeText) return null;

  const scheduledAt = withScheduleTime(dateForSection(sectionId), timeText);
  if (!scheduledAt) return null;

  const detailUrl = new URL(href, SOKUJA_ORIGIN).href;
  const animeSlug = extractSlug(detailUrl);
  const typeBadge = badges.find((badge) => !/\d{1,2}[:.]\d{2}/.test(badge)) ?? null;

  return {
    id: -(20_000 + index),
    animeId: 0,
    animeTitle: title,
    animeSlug,
    title,
    episode: "Tayang",
    episodeNumber: 0,
    thumbnail: normalizeImageUrl(anchor.find("img").first().attr("src")),
    href: `/anime/${animeSlug}`,
    sourceUrl: detailUrl,
    scheduledAt: scheduledAt.toISOString(),
    releasedAt: null,
    releaseTime: timeText.replace(/\s*WIB$/i, "").trim(),
    scheduleStatus: "upcoming",
    scheduleSource: "sokuja.schedule",
    notificationSent: false,
    animeStatus: null,
    animeType: normalizeType(typeBadge),
  };
}

async function scrapeSokujaSchedule(): Promise<SokujaScheduleItem[]> {
  const html = await fetchScheduleHtml();
  const $ = cheerio.load(html);
  const items: SokujaScheduleItem[] = [];

  for (const sectionId of DAY_SECTIONS) {
    $(`#${sectionId}`)
      .find('a[href^="/anime/"]')
      .each((index, element) => {
        const item = parseCard($, element, sectionId, items.length + index + 1);
        if (item) items.push(item);
      });
  }

  return items.sort(
    (left, right) =>
      new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime(),
  );
}

export async function getSokujaSchedule() {
  return getOrSetCache<SokujaScheduleItem[]>(
    SOKUJA_SCHEDULE_CACHE_KEY,
    SOKUJA_SCHEDULE_TTL_SECONDS,
    scrapeSokujaSchedule,
  );
}
