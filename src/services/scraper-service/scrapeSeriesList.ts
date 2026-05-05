import * as cheerio from "cheerio";
import {
  AnimeDetail,
  AnimeEpisode,
  AnimeServer,
  AnimeTag,
  AnimeMetadata,
  ListType,
} from "./types";
import { insertAnime } from "../insertAnimeList";

import {
  initProgress,
  addLog,
  incrementProcessed,
  finishProgress,
  getProgress,
  upsertAnimeUpdate,
} from "../../lib/progessStore";
import { createRoleNotification } from "../notification.service";
import { createSegmentNotification } from "../notification.service";

type ScrapeRunContext = {
  initiatedById?: number | null;
  initiatedByUsername?: string | null;
  recentEpisodeLimit?: number;
};

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch target URL: ${response.status}`);
  }

  return response.text();
}

function getSeriesList(htmlStr: string): ListType[] {
  const $ = cheerio.load(htmlStr);
  const results: ListType[] = [];

  $("body #content .listupd article.bs").each((_, el) => {
    const anchor = $(el).find('a[itemprop="url"]');

    results.push({
      title: anchor.attr("title") ?? null,
      href: anchor.attr("href") ?? null,
      thumbnail: anchor.find("img").attr("src") ?? null,
      type: anchor.find(".typez").text().trim() || null,
      status: anchor.find(".epx").text().trim() || null,
      sub: anchor.find(".sb").text().trim() || null,
    });
  });

  return results;
}

function getDetailSeries(htmlStr: string): AnimeDetail {
  const $ = cheerio.load(htmlStr);

  const metadata: AnimeMetadata = {};
  $(".spe span").each((_, el) => {
    const text = $(el).text();
    const match = text.match(/^([^:]+):\s*(.+)$/s);
    if (match) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
      metadata[key] = match[2].trim();
    }
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
    .reduce<AnimeServer[]>((acc, s) => {
      if (!s.value) return acc;
      try {
        const frame = cheerio.load(atob(s.value));
        const src = frame("iframe").attr("src")?.trim();
        if (src) acc.push({ value: src, label: s.label });
      } catch {
        // skip invalid base64
      }
      return acc;
    }, []);
}

export default async function scrape(
  url: string,
  context: ScrapeRunContext = {},
): Promise<AnimeDetail[]> {
  const recentEpisodeLimit = Math.max(1, context.recentEpisodeLimit ?? 2);
  const listHtml = await fetchPage(url);
  const seriesList = getSeriesList(listHtml);

  initProgress(url, seriesList.length, recentEpisodeLimit);
  addLog(url, "info", `Found ${seriesList.length} series to scrape`);
  addLog(
    url,
    "info",
    `Episode scan mode: latest ${recentEpisodeLimit} episode(s) only`,
  );

  const withDetails: AnimeDetail[] = [];

  for (const series of seriesList) {
    if (!series.href) {
      addLog(url, "error", `Skipped (no href): ${series.title}`);
      continue;
    }

    try {
      addLog(url, "info", `Fetching detail: ${series.title}`);
      const detail = getDetailSeries(await fetchPage(series.href));
      addLog(
        url,
        "info",
        `Got detail: ${detail.title} — ${detail.episodes.length} episodes`,
      );

      const totalEpisodesDetected = detail.episodes.length;
      const episodesToScan = [...detail.episodes]
        .sort((left, right) => {
          const leftNumber = Number.parseFloat(left.number) || 0;
          const rightNumber = Number.parseFloat(right.number) || 0;
          return rightNumber - leftNumber;
        })
        .slice(0, recentEpisodeLimit);
      addLog(
        url,
        "info",
        `  ↳ Scanning ${episodesToScan.length}/${totalEpisodesDetected} latest episode(s)`,
      );

      detail.episodes = (
        await Promise.all(
          episodesToScan.map(async (episode): Promise<AnimeEpisode | null> => {
            if (!episode.href) return null;

            addLog(url, "info", `  ↳ Fetching episode: ${episode.title}`);
            const servers = getDetailEpisode(await fetchPage(episode.href));
            addLog(
              url,
              "info",
              `  ↳ Got ${servers.length} server(s) for: ${episode.title}`,
            );

            return { ...episode, servers };
          }),
        )
      ).filter((ep): ep is AnimeEpisode => ep !== null);

      addLog(url, "info", `Inserting to DB: ${detail.title}`);
      const insertResult = await insertAnime(detail);

      incrementProcessed(url);
      addLog(
        url,
        "success",
        `✓ Done: ${detail.title} (+${insertResult.newEpisodesAdded} eps baru)`,
      );
      upsertAnimeUpdate(url, {
        animeTitle: insertResult.animeTitle,
        animeSlug: insertResult.animeSlug,
        isNewAnime: insertResult.isNewAnime,
        totalEpisodesDetected,
        scannedEpisodes: detail.episodes.length,
        newEpisodesAdded: insertResult.newEpisodesAdded,
        newEpisodeNumbers: insertResult.newEpisodeNumbers,
      });

      if (insertResult.isNewAnime) {
        const genres = [...new Set(detail.genres.map((item) => item.trim()).filter(Boolean))];
        if (genres.length > 0) {
          await createSegmentNotification({
            segment: { type: "genres", genres },
            category: "content_new",
            type: "anime_scraped_new",
            title: `Anime baru: ${insertResult.animeTitle}`,
            message: `Anime baru ditambahkan dari scraping.`,
            link: `/anime/${insertResult.animeSlug}`,
            image: detail.thumbnail ?? null,
            topic: "anime-new",
            payload: {
              animeSlug: insertResult.animeSlug,
              animeTitle: insertResult.animeTitle,
              genres,
            },
            createdById: context.initiatedById ?? null,
          });
        }
      } else if (insertResult.newEpisodesAdded > 0) {
        await createSegmentNotification({
          segment: { type: "anime-engaged", animeId: insertResult.animeId },
          category: "content_update",
          type: "anime_scraped_new_episode",
          title: `Update episode: ${insertResult.animeTitle}`,
          message: `${insertResult.newEpisodesAdded} episode baru ditambahkan.`,
          link: `/anime/${insertResult.animeSlug}`,
          image: null,
          topic: "anime-update",
          payload: {
            animeId: insertResult.animeId,
            animeSlug: insertResult.animeSlug,
            animeTitle: insertResult.animeTitle,
            newEpisodesAdded: insertResult.newEpisodesAdded,
            newEpisodeNumbers: insertResult.newEpisodeNumbers,
          },
          createdById: context.initiatedById ?? null,
        });
      }

      withDetails.push(detail);
    } catch (err) {
      incrementProcessed(url);
      addLog(
        url,
        "error",
        `✗ Failed: ${series.title} — ${(err as Error).message}`,
      );
    }
  }

  finishProgress(url, "done");
  addLog(
    url,
    "success",
    `All done. ${withDetails.length}/${seriesList.length} series inserted.`,
  );

  if (context.initiatedById) {
    const progressState = getProgress(url);
    const newAnimeCount = progressState?.summary.newAnimeCount ?? 0;
    const newEpisodesTotal = progressState?.summary.newEpisodesTotal ?? 0;

    await createRoleNotification({
      role: "admin",
      category: "admin_operational",
      type: "scraping_finished",
      title: "Scraping selesai",
      message: `Scraping selesai total ${newAnimeCount} anime baru dan ${newEpisodesTotal} ep baru.`,
      link: "/admin/scraping-progress",
      topic: "admin-scraping",
      payload: {
        url,
        inserted: withDetails.length,
        total: seriesList.length,
        newAnimeCount,
        newEpisodesTotal,
      },
      createdById: context.initiatedById,
    });
  }

  return withDetails;
}
