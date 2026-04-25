import type { FastifyPluginAsync } from "fastify";
import { exportSubtitleTrackVtt } from "../../services/subtitle.service";
import { generateSubtitleRangeWithAi } from "../../services/subtitle-ai-range-generate.service";
import { translateSubtitleCueTextWithAi } from "../../services/subtitle-ai-text-translate.service";
import { ok } from "../../utils/response";

export const subtitleRoute: FastifyPluginAsync = async (app) => {
  app.post(
    "/ai/generate",
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const result = await generateSubtitleRangeWithAi({
        ...(request.body as Record<string, unknown>),
        baseUrl:
          ((typeof request.headers["x-forwarded-proto"] === "string"
            ? request.headers["x-forwarded-proto"].split(",")[0]?.trim()
            : "http") +
            "://" +
            ((typeof request.headers["x-forwarded-host"] === "string" &&
              request.headers["x-forwarded-host"]) ||
              request.headers.host ||
              `localhost:${process.env.PORT || 3000}`)) as string,
      });
      return ok(reply, { data: result });
    },
  );

  app.post(
    "/ai/translate-text",
    { preHandler: app.adminAuthenticate },
    async (request, reply) => {
      const result = await translateSubtitleCueTextWithAi(
        request.body as Record<string, unknown>,
      );
      return ok(reply, { data: result });
    },
  );

  app.get("/:episodeId/:serverUrl/:langVtt", async (request, reply) => {
    const { episodeId, serverUrl, langVtt } = request.params as {
      episodeId: string;
      serverUrl: string;
      langVtt: string;
    };
    const language = langVtt.replace(/\.vtt$/i, "");
    const content = await exportSubtitleTrackVtt(
      Number(episodeId),
      decodeURIComponent(serverUrl),
      language,
    );

    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", "no-store")
      .type("text/vtt; charset=utf-8")
      .send(content);
  });
};

export default subtitleRoute;
