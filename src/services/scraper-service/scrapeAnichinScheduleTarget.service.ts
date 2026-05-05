import * as cheerio from "cheerio";
import { CacheInvalidator } from "../../lib/cache";
import { insertAnime, type InsertAnimeResult } from "../insertAnimeList";
import { createSegmentNotification } from "../notification.service";
import type {
  AnimeDetail,
  AnimeEpisode,
  AnimeMetadata,
  AnimeServer,
  AnimeTag,
} from "./types";

type TargetInput = {
  animeTitle: string;
  animeSlug: string;
  sourceUrl: string;
  episodeNumber?: number | null;
};

export type AnichinTargetScrapeResult = InsertAnimeResult & {
  matchedEpisodes: number;
};

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Anichin target: ${response.status}`);
  }

  return response.text();
}

function getDetailSeries(htmlStr: string): AnimeDetail {
  const $ = cheerio.load(htmlStr);
  const metadata: AnimeMetadata = {};

  $(".spe span").each((_, el) => {
    const text = $(el).text();
    const match = text.match(/^([^:]+):\s*(.+)$/s);
    if (!match) return;

    const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
    metadata[key] = match[2].trim();
  });

  const episodes: AnimeEpisode[] = [];
  $(".eplister ul li").each((_, el) => {
    const a = $(el).find("a");
    episodes.push({
      number: $(el).find(".epl-num").text().trim(),
      title: $(el).find(".epl-title").text().trim(),
      href: a.attr("href") ?? null,
      sub: $(el).find(".epl-sub span").text().trim(),
      date: $(el).find(".epl-date").text().trim(),
    });
  });

  const tags: AnimeTag[] = $(".bottom.tags a")
    .map((_, el) => ({
      label: $(el).text().trim(),
      href: $(el).attr("href") ?? null,
    }))
    .get();

  return {
    title: $("h1.entry-title").text().trim(),
    bigCover: $(".bigcover .ime img").attr("src") ?? null,
    thumbnail: $('.thumb img[itemprop="image"]').attr("src") ?? null,
    rating: $('meta[itemprop="ratingValue"]').attr("content") ?? null,
    synopsis: $(".entry-content p")
      .map((_, el) => $(el).text().trim())
      .get()
      .join("\n"),
    alternativeTitles: $(".alter").text().trim() || null,
    followed:
      $(".bmc")
        .text()
        .replace(/[^0-9]/g, "") || null,
    metadata,
    genres: $(".genxed a")
      .map((_, el) => $(el).text().trim())
      .get(),
    episodes,
    tags,
  };
}

function getDetailEpisode(htmlStr: string): AnimeServer[] {
  const $ = cheerio.load(htmlStr);

  return $(".postbody article .item.video-nav select option")
    .map((_, el) => ({
      value: $(el).attr("value") ?? null,
      label: $(el).text().trim(),
    }))
    .get()
    .reduce<AnimeServer[]>((acc, server) => {
      if (!server.value) return acc;
      try {
        const frame = cheerio.load(atob(server.value));
        const src = frame("iframe").attr("src")?.trim();
        if (src) acc.push({ value: src, label: server.label });
      } catch {
        // skip invalid server payload
      }
      return acc;
    }, []);
}

function episodeNumber(episode: AnimeEpisode) {
  return Number.parseFloat(episode.number) || 0;
}

function selectTargetEpisodes(
  episodes: AnimeEpisode[],
  expectedEpisodeNumber?: number | null,
) {
  const sorted = [...episodes].sort(
    (left, right) => episodeNumber(right) - episodeNumber(left),
  );

  if (expectedEpisodeNumber && expectedEpisodeNumber > 0) {
    return sorted.filter((episode) => episodeNumber(episode) === expectedEpisodeNumber);
  }

  return sorted.slice(0, 2);
}

async function notifyUsersIfNeeded(
  detail: AnimeDetail,
  result: InsertAnimeResult,
) {
  if (result.isNewAnime || result.newEpisodesAdded <= 0) return;

  await createSegmentNotification({
    segment: { type: "anime-engaged", animeId: result.animeId },
    category: "content_update",
    type: "anime_schedule_new_episode",
    title: `Episode baru: ${result.animeTitle}`,
    message: `${result.newEpisodesAdded} episode baru sudah tersedia.`,
    link: `/anime/${result.animeSlug}`,
    image: detail.thumbnail ?? null,
    topic: "anime-update",
    payload: {
      animeId: result.animeId,
      animeSlug: result.animeSlug,
      animeTitle: result.animeTitle,
      newEpisodesAdded: result.newEpisodesAdded,
      newEpisodeNumbers: result.newEpisodeNumbers,
    },
  });
}

export async function scrapeAnichinScheduleTarget(
  target: TargetInput,
): Promise<AnichinTargetScrapeResult> {
  const detail = getDetailSeries(await fetchPage(target.sourceUrl));
  const matchedEpisodes = selectTargetEpisodes(
    detail.episodes,
    target.episodeNumber,
  );

  if (matchedEpisodes.length === 0) {
    return {
      animeId: 0,
      animeTitle: target.animeTitle,
      animeSlug: target.animeSlug,
      isNewAnime: false,
      newEpisodesAdded: 0,
      newEpisodeNumbers: [],
      matchedEpisodes: 0,
    };
  }

  detail.episodes = (
    await Promise.all(
      matchedEpisodes.map(async (episode): Promise<AnimeEpisode | null> => {
        if (!episode.href) return null;
        const servers = getDetailEpisode(await fetchPage(episode.href));
        return { ...episode, servers };
      }),
    )
  ).filter((episode): episode is AnimeEpisode => episode !== null);

  const result = await insertAnime(detail);

  if (result.newEpisodesAdded > 0) {
    await CacheInvalidator.onEpisodeChange(result.animeSlug);
  }

  await notifyUsersIfNeeded(detail, result);

  return {
    ...result,
    matchedEpisodes: detail.episodes.length,
  };
}
