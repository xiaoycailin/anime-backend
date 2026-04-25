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
} from "../../lib/progessStore";
import { createRoleNotification } from "../notification.service";

type ScrapeRunContext = {
  initiatedById?: number | null;
  initiatedByUsername?: string | null;
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
  const listHtml = await fetchPage(url);
  const seriesList = getSeriesList(listHtml);

  initProgress(url, seriesList.length);
  addLog(url, "info", `Found ${seriesList.length} series to scrape`);

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

      detail.episodes = (
        await Promise.all(
          detail.episodes.map(async (episode): Promise<AnimeEpisode | null> => {
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
      await insertAnime(detail);

      incrementProcessed(url);
      addLog(
        url,
        "success",
        `✓ Done: ${detail.title} (${detail.episodes.length} eps)`,
      );

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
    await createRoleNotification({
      role: "admin",
      category: "admin_operational",
      type: "scraping_finished",
      title: "Scraping selesai",
      message: `${context.initiatedByUsername ?? "Admin"} menyelesaikan scraping ${withDetails.length}/${seriesList.length} series.`,
      link: "/admin/scraping-progress",
      topic: "admin-scraping",
      payload: {
        url,
        inserted: withDetails.length,
        total: seriesList.length,
      },
      createdById: context.initiatedById,
    });
  }

  return withDetails;
}
