import path from "path";
import fs from "fs/promises";
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../lib/prisma";
import { created, ok } from "../../utils/response";
import { badRequest, notFound } from "../../utils/http-error";
import {
  clearChunkSet,
  createUploadSession,
  ensureSessionUsable,
  ensureUploadTempDir,
  findActiveSessionForEpisode,
  getReceivedChunks,
  getUploadSession,
  isValidResolution,
  markSessionExpiredIfNeeded,
  recordChunkReceived,
  updateSessionStatus,
  uploadTempDir,
  VALID_RESOLUTIONS,
  cleanupUploadTempDir,
} from "../../services/upload-session.service";
import {
  enqueueEncoding,
  generateVideoId,
} from "../../services/video-pipeline.service";

const MAX_CHUNK_SIZE = 20 * 1024 * 1024;

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.adminAuthenticate);

  app.post("/session", async (request, reply) => {
    const body = (request.body ?? {}) as {
      sesid?: string;
      episodeId?: number | string;
      initialResolution?: number | string;
    };

    const sesid = typeof body.sesid === "string" ? body.sesid.trim() : "";
    let episodeId = Number(body.episodeId);

    if (!Number.isFinite(episodeId) || episodeId <= 0) {
      const match = sesid.match(/(\d+)/);
      if (match) episodeId = Number(match[1]);
    }

    if (!Number.isFinite(episodeId) || episodeId <= 0) {
      throw badRequest("episodeId tidak valid");
    }

    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      select: { id: true },
    });
    if (!episode) throw notFound("Episode tidak ditemukan");

    const initialResolution = Number(body.initialResolution);
    if (
      body.initialResolution !== undefined &&
      !isValidResolution(initialResolution)
    ) {
      throw badRequest(
        `initialResolution harus salah satu dari ${VALID_RESOLUTIONS.join(", ")}`,
      );
    }

    const session = await createUploadSession({
      episodeId,
      sesid: sesid || null,
      initialResolution: isValidResolution(initialResolution)
        ? initialResolution
        : 720,
    });

    return created(reply, {
      message: "Upload session created",
      data: {
        uploadId: session.id,
        uploadUrl: `/api/upload/${session.id}/chunk`,
        statusUrl: `/api/upload/${session.id}/status`,
        completeUrl: `/api/upload/${session.id}/complete`,
        expiresAt: session.expiresAt.toISOString(),
        initialResolution: session.initialResolution,
      },
    });
  });

  app.get("/:uploadId/status", async (request, reply) => {
    const { uploadId } = request.params as { uploadId: string };
    const session = await getUploadSession(uploadId);
    if (!session) throw notFound("Upload session tidak ditemukan");

    const checked = await markSessionExpiredIfNeeded(session);
    const receivedChunks = await getReceivedChunks(uploadId);

    return ok(reply, {
      message: "Upload status fetched",
      data: {
        uploadId: checked.id,
        episodeId: checked.episodeId,
        status: checked.status,
        expiresAt: checked.expiresAt.toISOString(),
        totalChunks: checked.totalChunks,
        receivedChunks: receivedChunks.length,
        receivedChunkIndexes: receivedChunks,
        uploadProgress: checked.uploadProgress,
        encodingProgress: checked.encodingProgress,
        r2UploadProgress: checked.r2UploadProgress,
        currentResolution: checked.currentResolution,
        resolutionsCompleted: checked.resolutionsDone,
        masterPlaylistUrl: checked.masterPlaylistUrl,
        videoId: checked.videoId,
        errorMessage: checked.errorMessage,
        fileName: checked.fileName,
        fileSize: checked.fileSize,
        fileLastModified: checked.fileLastModified,
        initialResolution: checked.initialResolution,
      },
    });
  });

  app.get("/active", async (request, reply) => {
    const query = request.query as { episodeId?: string };
    const episodeId = Number(query.episodeId);
    if (!Number.isFinite(episodeId) || episodeId <= 0) {
      throw badRequest("episodeId tidak valid");
    }

    const session = await findActiveSessionForEpisode(episodeId);
    if (!session) {
      return ok(reply, { message: "Tidak ada session aktif", data: null });
    }

    const receivedChunks = await getReceivedChunks(session.id);

    return ok(reply, {
      message: "Active session ditemukan",
      data: {
        uploadId: session.id,
        episodeId: session.episodeId,
        status: session.status,
        expiresAt: session.expiresAt.toISOString(),
        totalChunks: session.totalChunks,
        receivedChunks: receivedChunks.length,
        receivedChunkIndexes: receivedChunks,
        uploadProgress: session.uploadProgress,
        encodingProgress: session.encodingProgress,
        r2UploadProgress: session.r2UploadProgress,
        currentResolution: session.currentResolution,
        resolutionsCompleted: session.resolutionsDone,
        masterPlaylistUrl: session.masterPlaylistUrl,
        videoId: session.videoId,
        errorMessage: session.errorMessage,
        fileName: session.fileName,
        fileSize: session.fileSize,
        fileLastModified: session.fileLastModified,
        initialResolution: session.initialResolution,
      },
    });
  });

  app.post("/:uploadId/chunk", async (request, reply) => {
    const { uploadId } = request.params as { uploadId: string };

    const session = await ensureSessionUsable(uploadId).catch((error) => {
      const status = (error as any)?.statusCode ?? 400;
      reply.code(status);
      throw error;
    });

    if (!request.isMultipart()) {
      throw badRequest("Content-Type harus multipart/form-data");
    }

    let chunkIndex = -1;
    let totalChunks = 0;
    let fileName: string | null = null;
    let fileSize: number | null = null;
    let fileLastModified: number | null = null;
    let chunkBuffer: Buffer | null = null;
    let initialResolutionField: number | null = null;

    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === "field") {
        const value = String(part.value ?? "");
        if (part.fieldname === "chunkIndex") chunkIndex = Number(value);
        else if (part.fieldname === "totalChunks") totalChunks = Number(value);
        else if (part.fieldname === "fileName") fileName = value;
        else if (part.fieldname === "fileSize") fileSize = Number(value);
        else if (part.fieldname === "fileLastModified") {
          fileLastModified = Number(value);
        } else if (part.fieldname === "initialResolution") {
          initialResolutionField = Number(value);
        }
      } else if (part.type === "file" && part.fieldname === "chunk") {
        const buffer = await part.toBuffer();
        if (buffer.length > MAX_CHUNK_SIZE) {
          throw badRequest("Ukuran chunk melebihi batas 20MB");
        }
        chunkBuffer = buffer;
      }
    }

    if (!chunkBuffer) throw badRequest("Field 'chunk' wajib diisi");
    if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
      throw badRequest("chunkIndex tidak valid");
    }
    if (!Number.isFinite(totalChunks) || totalChunks <= 0) {
      throw badRequest("totalChunks tidak valid");
    }
    if (chunkIndex >= totalChunks) {
      throw badRequest("chunkIndex melebihi totalChunks");
    }

    const fileChanged =
      (session.fileName !== null && fileName !== null && session.fileName !== fileName) ||
      (session.fileSize !== null && fileSize !== null && session.fileSize !== fileSize) ||
      (session.fileLastModified !== null &&
        fileLastModified !== null &&
        session.fileLastModified !== fileLastModified);

    if (fileChanged) {
      await cleanupUploadTempDir(uploadId);
      await clearChunkSet(uploadId);
      await ensureUploadTempDir(uploadId);
      await updateSessionStatus(uploadId, {
        fileName: fileName ?? null,
        fileSize: typeof fileSize === "number" ? fileSize : null,
        fileLastModified:
          typeof fileLastModified === "number" ? fileLastModified : null,
        receivedChunks: 0,
        uploadProgress: 0,
        encodingProgress: 0,
        r2UploadProgress: 0,
        resolutionsDone: [],
        currentResolution: null,
        videoId: null,
        masterPlaylistUrl: null,
        status: "uploading",
      });
    }

    const dir = await ensureUploadTempDir(uploadId);
    const chunkPath = path.join(dir, `chunk_${chunkIndex}`);

    let alreadyOnDisk = false;
    try {
      await fs.access(chunkPath);
      alreadyOnDisk = true;
    } catch {
      // not yet written
    }

    let isNew = false;
    if (!alreadyOnDisk) {
      const tmpPath = `${chunkPath}.partial`;
      await fs.writeFile(tmpPath, chunkBuffer);
      await fs.rename(tmpPath, chunkPath);
      isNew = true;
    }

    await recordChunkReceived(uploadId, chunkIndex);

    const receivedChunks = await getReceivedChunks(uploadId);
    const uploadProgress = (receivedChunks.length / totalChunks) * 100;

    const updates: Parameters<typeof updateSessionStatus>[1] = {
      status: session.status === "idle" ? "uploading" : session.status,
      totalChunks,
      receivedChunks: receivedChunks.length,
      uploadProgress: Number(uploadProgress.toFixed(2)),
    };

    if (fileName && !session.fileName) updates.fileName = fileName;
    if (fileSize && fileSize > 0 && !session.fileSize) {
      updates.fileSize = fileSize;
    }
    if (
      typeof fileLastModified === "number" &&
      fileLastModified > 0 &&
      !session.fileLastModified
    ) {
      updates.fileLastModified = fileLastModified;
    }
    if (
      initialResolutionField &&
      isValidResolution(initialResolutionField) &&
      session.initialResolution !== initialResolutionField
    ) {
      // allow client to refine initial resolution before completion
      (updates as any).initialResolution = initialResolutionField;
    }

    const updated = await updateSessionStatus(uploadId, updates);

    return ok(reply, {
      message: "Chunk diterima",
      data: {
        uploadId,
        chunkIndex,
        duplicate: !isNew,
        receivedChunks: receivedChunks.length,
        totalChunks,
        uploadProgress: updated.uploadProgress,
        status: updated.status,
      },
    });
  });

  app.post("/:uploadId/complete", async (request, reply) => {
    const { uploadId } = request.params as { uploadId: string };

    const session = await ensureSessionUsable(uploadId).catch((error) => {
      const status = (error as any)?.statusCode ?? 400;
      reply.code(status);
      throw error;
    });

    const totalChunks = session.totalChunks;
    if (!totalChunks || totalChunks <= 0) {
      throw badRequest("totalChunks belum diset");
    }

    const received = await getReceivedChunks(uploadId);
    const missing: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
      if (!received.includes(i)) missing.push(i);
    }

    if (missing.length > 0) {
      reply.code(409);
      return ok(reply, {
        message: "Chunk belum lengkap",
        data: {
          status: "incomplete",
          missingChunks: missing,
          receivedChunks: received.length,
          totalChunks,
        },
      });
    }

    // Verify all chunks exist on disk
    const dir = uploadTempDir(uploadId);
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(dir, `chunk_${i}`);
      try {
        await fs.access(chunkPath);
      } catch {
        throw badRequest(`Chunk ${i} hilang di server`);
      }
    }

    const videoId = session.videoId ?? generateVideoId();

    await updateSessionStatus(uploadId, {
      status: "processing",
      videoId,
      uploadProgress: 100,
    });

    await enqueueEncoding({
      uploadId,
      videoId,
      episodeId: session.episodeId,
      inputPath: "",
      initialResolution: session.initialResolution,
      totalChunks,
    });

    return ok(reply, {
      message: "Upload selesai, encoding mulai",
      data: {
        uploadId,
        videoId,
        status: "processing",
      },
    });
  });
};
