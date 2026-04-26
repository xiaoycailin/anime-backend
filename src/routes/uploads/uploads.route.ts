import type { FastifyPluginAsync } from "fastify";
import { created } from "../../utils/response";
import { badRequest } from "../../utils/http-error";
import { uploadBufferToR2 } from "../../utils/r2";

const ALLOWED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const uploadsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.post("/r2-asset-upload", async (request, reply) => {
    if (!request.isMultipart()) {
      throw badRequest("Content-Type harus multipart/form-data");
    }

    const file = await request.file();
    if (!file) throw badRequest("File gambar wajib diupload");

    if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      throw badRequest("Tipe file tidak didukung", {
        allowed: Array.from(ALLOWED_IMAGE_MIME),
      });
    }

    const buffer = await file.toBuffer();
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw badRequest("Ukuran file maksimal 5MB");
    }

    const uploaded = await uploadBufferToR2({
      buffer,
      filename: file.filename,
      contentType: file.mimetype,
    });

    return created(reply, {
      message: "Upload R2 berhasil",
      data: {
        url: uploaded.url,
        key: uploaded.key,
        filename: uploaded.filename,
        contentType: uploaded.contentType,
        size: uploaded.size,
      },
    });
  });
};
