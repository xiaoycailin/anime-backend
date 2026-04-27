import type { FastifyPluginAsync } from "fastify";
import { created, ok } from "../../utils/response";
import { badRequest } from "../../utils/http-error";
import { deleteR2Object, listR2Objects, uploadBufferToR2 } from "../../utils/r2";

const ASSET_PREFIX = "content/assets/";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 25_000;

type UrlUploadBody = {
  url?: string;
  filename?: string;
};

type DeleteAssetBody = {
  key?: string;
};

type ListAssetsQuery = {
  cursor?: string;
  limit?: string;
};

function isImageContentType(value: string | undefined | null) {
  return value?.toLowerCase().trim().startsWith("image/") ?? false;
}

function assetFolder() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${ASSET_PREFIX}${year}/${month}`;
}

function validateAssetKey(key: string | undefined) {
  const cleanKey = key?.trim().replace(/^\/+/, "") ?? "";
  if (!cleanKey || !cleanKey.startsWith(ASSET_PREFIX) || cleanKey.includes("..")) {
    throw badRequest("Key asset tidak valid");
  }
  return cleanKey;
}

function filenameFromUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const segment = decodeURIComponent(segments[segments.length - 1] ?? "");
    return segment || "remote-image";
  } catch {
    return "remote-image";
  }
}

async function downloadImageFromUrl(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw badRequest("URL gambar tidak valid");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("URL harus memakai http atau https");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(parsed.href, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "anime-assets-uploader/1.0",
        Accept: "image/*",
      },
    });

    if (!response.ok) {
      throw badRequest(`Gagal download gambar (${response.status})`);
    }

    const contentType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();

    if (!isImageContentType(contentType)) {
      throw badRequest("URL harus mengarah ke file image/*", {
        contentType: contentType ?? null,
      });
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_IMAGE_BYTES) {
      throw badRequest("Ukuran gambar maksimal 10MB");
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw badRequest("Ukuran gambar maksimal 10MB");
    }

    return {
      buffer,
      contentType: contentType ?? "image/*",
      filename: filenameFromUrl(parsed.href),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadImageBuffer(input: {
  buffer: Buffer;
  filename: string;
  contentType: string;
}) {
  if (!isImageContentType(input.contentType)) {
    throw badRequest("Tipe file harus image/*");
  }

  if (input.buffer.length > MAX_IMAGE_BYTES) {
    throw badRequest("Ukuran gambar maksimal 10MB");
  }

  return uploadBufferToR2({
    buffer: input.buffer,
    filename: input.filename,
    contentType: input.contentType,
    folder: assetFolder(),
  });
}

export const uploadsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.get("/assets", async (request, reply) => {
    const query = request.query as ListAssetsQuery;
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 80) || 80));
    const result = await listR2Objects({
      prefix: ASSET_PREFIX,
      cursor: query.cursor || null,
      limit,
    });

    return ok(reply, {
      message: "R2 asset list fetched",
      data: result.items,
      meta: {
        bucket: result.bucket,
        prefix: result.prefix,
        nextCursor: result.nextCursor,
        limit,
      },
    });
  });

  app.post("/assets/file", async (request, reply) => {
    if (!request.isMultipart()) {
      throw badRequest("Content-Type harus multipart/form-data");
    }

    const file = await request.file();
    if (!file) throw badRequest("File gambar wajib diupload");

    if (!isImageContentType(file.mimetype)) {
      throw badRequest("Tipe file harus image/*");
    }

    const buffer = await file.toBuffer();
    const uploaded = await uploadImageBuffer({
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

  app.post("/assets/url", async (request, reply) => {
    const body = request.body as UrlUploadBody;
    const rawUrl = body?.url?.trim();
    if (!rawUrl) throw badRequest("URL gambar wajib diisi");

    const downloaded = await downloadImageFromUrl(rawUrl);
    const uploaded = await uploadImageBuffer({
      buffer: downloaded.buffer,
      filename: body.filename?.trim() || downloaded.filename,
      contentType: downloaded.contentType,
    });

    return created(reply, {
      message: "Upload URL R2 berhasil",
      data: {
        url: uploaded.url,
        key: uploaded.key,
        filename: uploaded.filename,
        contentType: uploaded.contentType,
        size: uploaded.size,
      },
    });
  });

  app.delete("/assets", async (request, reply) => {
    const body = request.body as DeleteAssetBody;
    const key = validateAssetKey(body?.key);
    const deleted = await deleteR2Object(key);

    return ok(reply, {
      message: "R2 asset deleted",
      data: deleted,
    });
  });

  app.post("/r2-asset-upload", async (request, reply) => {
    if (!request.isMultipart()) {
      throw badRequest("Content-Type harus multipart/form-data");
    }

    const file = await request.file();
    if (!file) throw badRequest("File gambar wajib diupload");

    if (!isImageContentType(file.mimetype)) {
      throw badRequest("Tipe file harus image/*");
    }

    const buffer = await file.toBuffer();
    const uploaded = await uploadImageBuffer({
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
