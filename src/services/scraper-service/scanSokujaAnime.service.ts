import {
  scrapeSokujaAnimeDetail,
  scrapeSokujaAnimePage,
  type SokujaAnimeCard,
} from "./scrapeSokujaAnimeList.service";
import {
  addSokujaScanItem,
  addSokujaScanLog,
  finishSokujaScan,
  initSokujaScan,
  setSokujaScanTotal,
} from "../../lib/sokujaScanStore";

type ScanOptions = {
  id: string;
  fromPage: number;
  toPage: number;
  episodeMode: "full" | "recent";
  episodeLimit: number;
};

export async function runSokujaScan(options: ScanOptions) {
  initSokujaScan(options);
  addSokujaScanLog(
    options.id,
    "info",
    `Scan Sokuja page ${options.fromPage}-${options.toPage} dimulai.`,
  );
  addSokujaScanLog(
    options.id,
    "info",
    options.episodeMode === "full"
      ? "Episode scan mode: full episode + full server."
      : `Episode scan mode: ${options.episodeLimit} episode terbaru.`,
  );

  try {
    const cards: SokujaAnimeCard[] = [];
    for (let page = options.fromPage; page <= options.toPage; page += 1) {
      addSokujaScanLog(options.id, "info", `Fetching list page ${page}...`);
      const result = await scrapeSokujaAnimePage(page, { includeDetails: false });
      cards.push(...result.items);
      setSokujaScanTotal(options.id, cards.length);
      addSokujaScanLog(options.id, "success", `Page ${page}: ${result.items.length} anime ditemukan.`);
    }

    setSokujaScanTotal(options.id, cards.length);

    for (const card of cards) {
      try {
        addSokujaScanLog(options.id, "info", `Fetching detail: ${card.title}`);
        const detail = await scrapeSokujaAnimeDetail(card, {
          includeEpisodeServers: true,
          episodeMode: options.episodeMode,
          episodeLimit: options.episodeLimit,
        });

        addSokujaScanItem(options.id, { card, detail });
        addSokujaScanLog(
          options.id,
          "success",
          `Ready: ${card.title} (${detail.episodes.length} eps, ${detail.episodes.reduce(
            (sum, episode) => sum + (episode.servers?.length ?? 0),
            0,
          )} server)`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        addSokujaScanItem(options.id, { card, error: message });
        addSokujaScanLog(options.id, "error", `Failed: ${card.title} - ${message}`);
      }
    }

    finishSokujaScan(options.id, "done");
    addSokujaScanLog(options.id, "success", `Scan selesai. ${cards.length} anime diproses.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    addSokujaScanLog(options.id, "error", `Scan gagal: ${message}`);
    finishSokujaScan(options.id, "error");
  }
}
