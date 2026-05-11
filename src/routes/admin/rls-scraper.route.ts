import type { FastifyPluginAsync } from "fastify";
import {
  addReelshortEpisodeProgress,
  addReelshortImportItem,
  addReelshortImportLog,
  deleteReelshortImport,
  finishReelshortImport,
  getReelshortImport,
  initReelshortImport,
  subscribeReelshortImport,
} from "../../lib/reelshortImportStore";
import { importReelshortMovieWithProgress } from "../../services/scraper-service/importReelshort.service";
import { badRequest } from "../../utils/http-error";
import { ok, sendError } from "../../utils/response";

type ImportBody = {
  urls?: unknown;
};

function cleanUrls(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

async function runImportJob(id: string, urls: string[]) {
  let hasError = false;

  for (const sourceUrl of urls) {
    try {
      const result = await importReelshortMovieWithProgress(sourceUrl, {
        onTotal: (total) => addReelshortEpisodeProgress(id, total),
        onEpisode: () => addReelshortEpisodeProgress(id),
        onLog: (type, message) => addReelshortImportLog(id, type, message),
      });
      addReelshortImportItem(id, sourceUrl, result);
      addReelshortImportLog(id, "success", `${result.title} tersimpan ke DB`);
    } catch (error) {
      hasError = true;
      const normalized = error instanceof Error ? error : new Error("Import ReelShort gagal");
      addReelshortImportItem(id, sourceUrl, normalized);
      addReelshortImportLog(id, "error", `${sourceUrl}: ${normalized.message}`);
    }
  }

  finishReelshortImport(id, hasError ? "error" : "done");
}

export const rlsScraperRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.post("/import", async (request, reply) => {
    const body = request.body as ImportBody | null;
    const urls = cleanUrls(body?.urls);
    if (!urls.length) throw badRequest("Minimal satu URL ReelShort wajib diisi");

    const id = `rls:${Date.now()}`;
    initReelshortImport(id, urls);
    addReelshortImportLog(id, "info", `Import dimulai untuk ${urls.length} URL`);
    void runImportJob(id, urls).catch((error) => {
      request.log.error(error);
      addReelshortImportLog(
        id,
        "error",
        error instanceof Error ? error.message : "Import ReelShort gagal",
      );
      finishReelshortImport(id, "error");
    });

    return ok(reply, {
      message: "ReelShort import started",
      data: {
        importId: id,
        streamUrl: `/api/admin/rls-scraper/import/${encodeURIComponent(id)}/stream`,
      },
    });
  });

  app.get("/import/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const state = getReelshortImport(id);
    if (!state) {
      return sendError(reply, {
        status: 404,
        message: "Import ReelShort tidak ditemukan",
        errorCode: "RLS_IMPORT_NOT_FOUND",
      });
    }

    return ok(reply, { data: state });
  });

  app.get("/import/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const origin = request.headers.origin;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    });

    const write = (payload: unknown) => {
      reply.raw.write("event: import\n");
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    write(getReelshortImport(id));
    const unsubscribe = subscribeReelshortImport(id, write);
    const heartbeat = setInterval(() => {
      reply.raw.write("event: heartbeat\n");
      reply.raw.write("data: {}\n\n");
    }, 15000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });

  app.delete("/import/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = deleteReelshortImport(id);
    if (!deleted) {
      return sendError(reply, {
        status: 404,
        message: "Import ReelShort tidak ditemukan",
        errorCode: "RLS_IMPORT_NOT_FOUND",
      });
    }

    return ok(reply, { message: "Import ReelShort dihapus", data: { id } });
  });
};
