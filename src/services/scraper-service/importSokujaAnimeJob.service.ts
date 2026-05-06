import {
  scrapeSokujaAnimeDetail,
  scrapeSokujaAnimePage,
  type SokujaAnimeCard,
} from "./scrapeSokujaAnimeList.service";
import {
  importOneSokujaAnime,
  type SokujaListItem,
} from "./importSokujaAnime.service";
import {
  addSokujaScanItem,
  addSokujaScanLog,
  finishSokujaScan,
  initSokujaScan,
  setSokujaScanTotal,
} from "../../lib/sokujaScanStore";

type ImportJobOptions = {
  id: string;
  fromPage: number;
  toPage: number;
  episodeMode: "full" | "recent";
  episodeLimit: number;
};

function itemForImport(card: SokujaAnimeCard): SokujaListItem {
  return {
    slug: card.slug,
    title: card.title,
    thumbnail: card.thumbnail,
    bigCover: card.bigCover,
    rating: card.rating,
    status: card.status,
    released: card.released,
    type: card.type,
  };
}

export async function runSokujaImportJob(options: ImportJobOptions) {
  initSokujaScan(options);
  addSokujaScanLog(
    options.id,
    "info",
    `Import Sokuja page ${options.fromPage}-${options.toPage} dimulai.`,
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

        addSokujaScanLog(options.id, "info", `Upsert DB: ${card.title}`);
        const imported = await importOneSokujaAnime(itemForImport(card), detail);
        addSokujaScanItem(options.id, { card, detail });
        addSokujaScanLog(
          options.id,
          "success",
          `Imported: ${card.title} (${imported.episodeCount} eps, ${imported.serverCount} server)`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        addSokujaScanItem(options.id, { card, error: message });
        addSokujaScanLog(options.id, "error", `Failed import: ${card.title} - ${message}`);
      }
    }

    finishSokujaScan(options.id, "done");
    addSokujaScanLog(options.id, "success", `Import selesai. ${cards.length} anime diproses.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    addSokujaScanLog(options.id, "error", `Import gagal: ${message}`);
    finishSokujaScan(options.id, "error");
  }
}
