import * as cheerio from "cheerio";
import { getOrSetCache } from "../lib/cache";

const SCHEDULE_URL = "https://anichin.cafe/schedule/";
const SCHEDULE_CACHE_KEY = "schedule:anichin:v1";
const SCHEDULE_TTL_SECONDS = 20 * 60;

export type AnichinScheduleItem = {
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
  scheduleStatus: "upcoming" | "released";
  scheduleSource: "anichin.schedule";
  notificationSent: boolean;
  animeStatus: string | null;
  animeType: string | null;
};

const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function slugFromHref(href: string) {
  try {
    return new URL(href).pathname.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
  } catch {
    return "";
  }
}

function formatDateJakarta(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTimeJakarta(date: Date) {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function startOfJakartaDate(date = new Date()) {
  const [year, month, day] = formatDateJakarta(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, -7, 0, 0, 0));
}

function getJakartaDayIndex(date = new Date()) {
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
  })
    .format(date)
    .toLowerCase();

  return DAY_INDEX[dayName] ?? 0;
}

function dateForScheduleDay(dayName: string, now = new Date()) {
  const targetDay = DAY_INDEX[dayName.toLowerCase()];
  if (targetDay === undefined) return startOfJakartaDate(now);

  const todayStart = startOfJakartaDate(now);
  const todayIndex = getJakartaDayIndex(now);
  const diff = (targetDay - todayIndex + 7) % 7;
  const result = new Date(todayStart);
  result.setUTCDate(result.getUTCDate() + diff);
  return result;
}

function withAnichinTime(date: Date, timeText: string, timestampText?: string) {
  const timestamp = Number(timestampText);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return new Date(timestamp * 1000);
  }

  const match = timeText.match(/(\d{1,2})[:.](\d{2})/);
  if (!match) return date;
  const [year, month, day] = formatDateJakarta(date).split("-").map(Number);
  const displayHour = Number(match[1]);
  const hour = displayHour > 0 && displayHour < 12 ? displayHour + 12 : displayHour;
  const minute = Number(match[2]);
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute, 0, 0));
}

function normalizeEpisodeNumber(value: string) {
  const parsed = Number.parseInt(value.replace(/\D+/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchScheduleHtml() {
  const response = await fetch(SCHEDULE_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Anichin schedule: ${response.status}`);
  }

  return response.text();
}

async function scrapeAnichinSchedule(): Promise<AnichinScheduleItem[]> {
  const html = await fetchScheduleHtml();
  const $ = cheerio.load(html);
  const items: AnichinScheduleItem[] = [];

  $(".schedulepage").each((_, section) => {
    const dayName = $(section).find(".releases h3, .releases").first().text().trim();
    const dayDate = dateForScheduleDay(dayName);

    $(section)
      .find(".bs")
      .each((index, item) => {
        const anchor = $(item).find("a").first();
        const href = anchor.attr("href") ?? "";
        const animeTitle =
          anchor.attr("title")?.trim() || $(item).find(".tt").text().trim();
        if (!animeTitle || !href) return;

        const rawTime = $(item).find(".epx").first().text().trim();
        const rawEpisode = $(item).find(".sb").first().text().trim();
        const releaseTimestamp = $(item).find("[data-rlsdt]").first().attr("data-rlsdt");
        const isReleased = rawTime.toLowerCase().includes("released");
        const scheduledAt = withAnichinTime(dayDate, rawTime, releaseTimestamp);
        const animeSlug = slugFromHref(href);
        const episodeNumber = normalizeEpisodeNumber(rawEpisode);
        const episode = rawEpisode && rawEpisode !== "??" ? `Ep ${rawEpisode}` : "Ep ??";

        items.push({
          id: -(items.length + index + 1),
          animeId: 0,
          animeTitle,
          animeSlug,
          title: `${animeTitle} Episode ${rawEpisode || "??"}`,
          episode,
          episodeNumber,
          thumbnail: $(item).find("img").first().attr("src") ?? null,
          href: animeSlug ? `/anime/${animeSlug}` : href,
          sourceUrl: href,
          scheduledAt: scheduledAt.toISOString(),
          releasedAt: isReleased ? scheduledAt.toISOString() : null,
          releaseTime: isReleased ? "Released" : formatTimeJakarta(scheduledAt),
          scheduleStatus: isReleased ? "released" : "upcoming",
          scheduleSource: "anichin.schedule",
          notificationSent: false,
          animeStatus: null,
          animeType: null,
        });
      });
  });

  return items.sort(
    (left, right) =>
      new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime(),
  );
}

export async function getAnichinSchedule() {
  return getOrSetCache<AnichinScheduleItem[]>(
    SCHEDULE_CACHE_KEY,
    SCHEDULE_TTL_SECONDS,
    scrapeAnichinSchedule,
  );
}
