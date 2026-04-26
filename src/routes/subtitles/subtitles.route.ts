import fs from "fs";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  getAutoGenerateSubtitleJob,
  startAutoGenerateSubtitleJob,
} from "../../services/subtitle-auto-generate.service";
import { reviseSubtitleTrackByInstruction } from "../../services/subtitle-ai-instruction.service";
import { reviseSubtitleTrackByInstructionStream } from "../../services/subtitle-ai-instruction-stream.service";
import {
  createSubtitleTrack,
  deleteSubtitleCue,
  exportSubtitleTrackVttByServerId,
  importSubtitleFile,
  listSubtitleTracks,
  listSubtitles,
  saveSubtitleCues,
  subtitleFilePath,
} from "../../services/subtitle.service";
import { badRequest, notFound } from "../../utils/http-error";
import { created, ok, sendResponse } from "../../utils/response";

type MultipartPayload = {
  body: Record<string, string>;
  file?: { filename: string; buffer: Buffer };
};

async function parseMultipart(
  request: FastifyRequest,
): Promise<MultipartPayload> {
  const multipartRequest = request as FastifyRequest & {
    isMultipart?: () => boolean;
    parts: () => AsyncIterable<any>;
  };

  if (!multipartRequest.isMultipart?.()) {
    return { body: (request.body ?? {}) as Record<string, string> };
  }

  const body: Record<string, string> = {};
  let file: MultipartPayload["file"];

  for await (const part of multipartRequest.parts()) {
    if (part.type === "file") {
      file = { filename: part.filename, buffer: await part.toBuffer() };
      continue;
    }
    body[part.fieldname] = String(part.value ?? "");
  }

  return { body, file };
}

function resolveBaseUrl(request: FastifyRequest) {
  const host =
    (typeof request.headers["x-forwarded-host"] === "string" &&
      request.headers["x-forwarded-host"]) ||
    request.headers.host ||
    `localhost:${process.env.PORT || 3000}`;
  const protocol =
    (typeof request.headers["x-forwarded-proto"] === "string" &&
      request.headers["x-forwarded-proto"].split(",")[0]?.trim()) ||
    "http";

  return `${protocol}://${host}`;
}

function writeStreamEvent(
  reply: {
    raw: NodeJS.WritableStream & {
      destroyed?: boolean;
      writableEnded?: boolean;
    };
  },
  event: string,
  data: Record<string, unknown>,
) {
  if (reply.raw.destroyed || reply.raw.writableEnded) return false;

  try {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export const subtitlesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (request, reply) => {
    const { episodeId } = request.query as { episodeId?: string };
    const id = Number(episodeId);
    if (!Number.isInteger(id) || id <= 0)
      throw badRequest("episodeId tidak valid");
    return ok(reply, { data: await listSubtitles(id) });
  });

  app.get("/files/:fileName", async (request, reply) => {
    const { fileName } = request.params as { fileName: string };
    const filePath = subtitleFilePath(fileName);

    if (!fs.existsSync(filePath))
      throw notFound("File subtitle tidak ditemukan");

    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .type("text/vtt; charset=utf-8")
      .send(fs.createReadStream(filePath));
  });

  app.get("/:episodeId/:serverId/:langVtt", async (request, reply) => {
    const { episodeId, serverId, langVtt } = request.params as {
      episodeId: string;
      serverId: string;
      langVtt: string;
    };
    const language = langVtt.replace(/\.vtt$/i, "");
    const content = await exportSubtitleTrackVttByServerId(
      Number(episodeId),
      Number(serverId),
      language,
    );

    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", "no-store")
      .type("text/vtt; charset=utf-8")
      .send(content);
  });

  app.get(
    "/auto-generate/:jobId",
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      return ok(reply, { data: getAutoGenerateSubtitleJob(jobId) });
    },
  );

  app.get("/:episodeId/:serverUrl", async (request, reply) => {
    const { episodeId, serverUrl } = request.params as {
      episodeId: string;
      serverUrl: string;
    };
    const tracks = await listSubtitleTracks(
      Number(episodeId),
      decodeURIComponent(serverUrl),
    );
    return ok(reply, { data: { tracks } });
  });

  app.post(
    "/auto-generate",
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const body = request.body as {
        episodeId?: number | string;
        serverUrl?: string;
        language?: string;
        label?: string;
        sourceLanguage?: string;
        transcribeModel?: string;
        textModel?: string;
        instructions?: string;
        instructionMessages?: Array<{
          role?: "user" | "assistant";
          content?: string;
        }>;
        context?: Record<string, unknown>;
      };
      const host =
        (typeof request.headers["x-forwarded-host"] === "string" &&
          request.headers["x-forwarded-host"]) ||
        request.headers.host ||
        `localhost:${process.env.PORT || 3000}`;
      const protocol =
        (typeof request.headers["x-forwarded-proto"] === "string" &&
          request.headers["x-forwarded-proto"].split(",")[0]?.trim()) ||
        "http";

      const job = startAutoGenerateSubtitleJob({
        ...body,
        baseUrl: `${protocol}://${host}`,
        userId: request.user.id,
      });
      return sendResponse(reply, {
        status: 202,
        message: "Auto generate subtitle dimulai",
        data: job,
      });
    },
  );

  app.post(
    "/ai-revise-stream",
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const baseUrl = resolveBaseUrl(request);
      const controller = new AbortController();
      const abortStream = () => controller.abort();

      request.raw.on("aborted", abortStream);
      request.raw.on("close", abortStream);

      // Ambil origin dari request, fallback ke host
      const origin = request.headers["origin"] || "*";

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": origin, // ✅ reflect origin
        "Access-Control-Allow-Credentials": "true", // ✅ wajib jika credentials: include
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": connected\n\n");

      try {
        const result = await reviseSubtitleTrackByInstructionStream(
          {
            ...(request.body as any),
            userId: request.user.id,
            baseUrl,
          },
          {
            signal: controller.signal,
            onStage: (stage, message) => {
              writeStreamEvent(reply, "stage", { stage, message });
            },
            onDelta: (text, fullText) => {
              writeStreamEvent(reply, "delta", { text, fullText });
            },
          },
        );

        writeStreamEvent(reply, "done", result);
      } catch (error) {
        const isAborted =
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError");

        if (isAborted) {
          writeStreamEvent(reply, "aborted", {
            message: "Generasi AI dihentikan.",
          });
        } else {
          writeStreamEvent(reply, "error", {
            message:
              error instanceof Error ? error.message : "Gagal stream revisi AI",
          });
        }
      } finally {
        request.raw.removeListener("aborted", abortStream);
        request.raw.removeListener("close", abortStream);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    },
  );

  app.post(
    "/ai-revise",
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const result = await reviseSubtitleTrackByInstruction({
        ...(request.body as any),
        userId: request.user.id,
        baseUrl: resolveBaseUrl(request),
      });
      return ok(reply, { data: result });
    },
  );

  app.post(
    "/track",
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const track = await createSubtitleTrack(request.body as any);
      return created(reply, { data: track });
    },
  );

  app.post(
    "/save",
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const body = request.body as { trackId?: number; cues?: unknown[] };
      const track = await saveSubtitleCues(
        Number(body.trackId),
        body.cues as any[],
      );
      return ok(reply, { data: track });
    },
  );

  app.delete(
    "/cue/:id",
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return ok(reply, { data: await deleteSubtitleCue(Number(id)) });
    },
  );

  app.post(
    "/import",
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const { body, file } = await parseMultipart(request);
      const track = await importSubtitleFile(body, file);
      return created(reply, { data: track });
    },
  );
};

export default subtitlesRoutes;
