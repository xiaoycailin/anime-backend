import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  saveYouTubeCookies,
  youtubeCookiesStatus,
} from "../../services/youtube-cookies.service";
import { badRequest } from "../../utils/http-error";
import { ok } from "../../utils/response";

type MultipartFile = {
  type: "file";
  fieldname: string;
  filename: string;
  toBuffer: () => Promise<Buffer>;
};

async function readCookiesUpload(request: FastifyRequest) {
  const multipartRequest = request as FastifyRequest & {
    isMultipart?: () => boolean;
    parts: () => AsyncIterable<MultipartFile | Record<string, unknown>>;
  };

  if (!multipartRequest.isMultipart?.()) {
    throw badRequest("Upload cookies wajib multipart/form-data");
  }

  for await (const part of multipartRequest.parts()) {
    if ((part as MultipartFile).type !== "file") continue;
    const file = part as MultipartFile;
    if (file.fieldname !== "file") continue;

    return {
      filename: file.filename,
      buffer: await file.toBuffer(),
    };
  }

  throw badRequest("File cookies wajib diupload dengan field 'file'");
}

export const youtubeToolsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.get("/cookies", async (_request, reply) => {
    return ok(reply, { data: await youtubeCookiesStatus() });
  });

  app.post("/cookies", async (request, reply) => {
    const upload = await readCookiesUpload(request);
    const status = await saveYouTubeCookies(upload.buffer);

    return ok(reply, {
      message: `Cookies YouTube disimpan: ${upload.filename}`,
      data: status,
    });
  });
};

export default youtubeToolsRoutes;
