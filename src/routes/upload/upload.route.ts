import path from "path";
import fs from "fs/promises";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/prisma";
import { created, ok } from "../../utils/response";
import { badRequest, notFound, unauthorized } from "../../utils/http-error";
import {
  appendEncodingLog,
  clearChunkSet,
  clearEncodingLogs,
  createUploadSession,
  ensureSessionUsable,
  ensureUploadTempDir,
  failSession,
  findActiveSessionForEpisode,
  getEncodingLogs,
  getReceivedChunks,
  getUploadSession,
  isValidResolution,
  markSessionExpiredIfNeeded,
  recordChunkReceived,
  serializeSession,
  updateSessionStatus,
  uploadEventChannel,
  uploadTempDir,
  VALID_RESOLUTIONS,
  cleanupUploadTempDir,
  publishUploadEvent,
  type UrlSourceInput,
  type UrlSourceProgress,
} from "../../services/upload-session.service";
import {
  enqueueEncoding,
  generateVideoId,
  reconcileEncodingJobForSession,
} from "../../services/video-pipeline.service";
import {
  enqueueUrlUpload,
  prepareUrlUploadSession,
} from "../../services/url-upload-queue.service";
import {
  clearPlaylistCache,
  clearSegmentSet,
  failUrlSession,
  fetchRemoteBuffer,
  fetchRemoteText,
  finalizeUrlSession,
  getDoneSegments,
  ingestSegmentBuffer,
  parseMediaPlaylist,
  recallPlaylist,
  refreshUrlProgress,
  rememberPlaylist,
  setUrlSourceStatus,
} from "../../services/url-ingest.service";
import { createRedisSubscriber } from "../../lib/redis";

const MAX_CHUNK_SIZE = 20 * 1024 * 1024;
const MAX_SEGMENT_SIZE = 25 * 1024 * 1024;

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  // SSE handles its own (query-token based) auth, so we skip the global hook
  // for that route only.
  app.addHook("preHandler", async (request, reply) => {
    const req = request as any;
    const routePath: string =
      req.routeOptions?.url ?? req.routerPath ?? request.url ?? "";
    if (typeof routePath === "string" && routePath.endsWith("/events")) {
      return;
    }
    await app.adminAuthenticate(request, reply);
  });

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

    let checked = await markSessionExpiredIfNeeded(session);
    if (checked.status === "processing") {
      await reconcileEncodingJobForSession(checked);
      checked = (await getUploadSession(uploadId)) ?? checked;
    }
    const receivedChunks = await getReceivedChunks(uploadId);
    const encodingLogs = await getEncodingLogs(uploadId);

    return ok(reply, {
      message: "Upload status fetched",
      data: {
        ...serializeSession(checked),
        receivedChunks: receivedChunks.length,
        receivedChunkIndexes: receivedChunks,
        encodingLogs,
      },
    });
  });

  app.get("/active", async (request, reply) => {
    const query = request.query as { episodeId?: string };
    const episodeId = Number(query.episodeId);
    if (!Number.isFinite(episodeId) || episodeId <= 0) {
      throw badRequest("episodeId tidak valid");
    }

    let session = await findActiveSessionForEpisode(episodeId);
    if (!session) {
      return ok(reply, { message: "Tidak ada session aktif", data: null });
    }

    if (session.status === "processing") {
      await reconcileEncodingJobForSession(session);
      session = (await getUploadSession(session.id)) ?? session;
    }
    const receivedChunks = await getReceivedChunks(session.id);
    const encodingLogs = await getEncodingLogs(session.id);

    return ok(reply, {
      message: "Active session ditemukan",
      data: {
        ...serializeSession(session),
        receivedChunks: receivedChunks.length,
        receivedChunkIndexes: receivedChunks,
        encodingLogs,
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
      (session.fileName !== null &&
        fileName !== null &&
        session.fileName !== fileName) ||
      (session.fileSize !== null &&
        fileSize !== null &&
        session.fileSize !== fileSize) ||
      (session.fileLastModified !== null &&
        fileLastModified !== null &&
        session.fileLastModified !== fileLastModified);

    if (fileChanged) {
      await cleanupUploadTempDir(uploadId);
      await clearChunkSet(uploadId);
      await clearEncodingLogs(uploadId);
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

    await clearEncodingLogs(uploadId);
    await appendEncodingLog(uploadId, "Upload lengkap, menyiapkan encoding");
    await updateSessionStatus(uploadId, {
      status: "processing",
      videoId,
      uploadProgress: 100,
      encodingProgress: 0,
      r2UploadProgress: 0,
      currentResolution: null,
      resolutionsDone: [],
      masterPlaylistUrl: null,
      errorMessage: null,
    });

    try {
      await enqueueEncoding({
        uploadId,
        videoId,
        episodeId: session.episodeId,
        inputPath: "",
        initialResolution: session.initialResolution,
        totalChunks,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Gagal memasukkan job encoding";
      await appendEncodingLog(uploadId, message, "error");
      await failSession(uploadId, message);
      throw badRequest(`Gagal memulai encoding: ${message}`);
    }

    return ok(reply, {
      message: "Upload selesai, encoding mulai",
      data: {
        uploadId,
        videoId,
        status: "processing",
      },
    });
  });

  // ── URL UPLOAD MODE ───────────────────────────────────────────────────────

  app.post("/url-session", async (request, reply) => {
    const body = (request.body ?? {}) as {
      sesid?: string;
      episodeId?: number | string;
      sources?: Array<{ resolution: number | string; url: string }>;
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

    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      throw badRequest("sources wajib diisi (minimal 1)");
    }

    const sources: UrlSourceInput[] = [];
    const seen = new Set<number>();
    for (const raw of body.sources) {
      const resolution = Number(raw?.resolution);
      const url = typeof raw?.url === "string" ? raw.url.trim() : "";
      if (!isValidResolution(resolution)) {
        throw badRequest(
          `resolution harus salah satu dari ${VALID_RESOLUTIONS.join(", ")}`,
        );
      }
      if (!/^https?:\/\//i.test(url)) {
        throw badRequest("URL harus diawali http(s)://");
      }
      if (seen.has(resolution)) {
        throw badRequest(`Resolusi ${resolution}p didaftarkan dua kali`);
      }
      seen.add(resolution);
      sources.push({ resolution, url });
    }

    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      select: { id: true },
    });
    if (!episode) throw notFound("Episode tidak ditemukan");

    // Resume by-payload: reuse active session if its sources match exactly.
    const active = await findActiveSessionForEpisode(episodeId);
    if (active && active.mode === "url" && active.urlSources) {
      const sameSources =
        active.urlSources.length === sources.length &&
        sources.every((src) =>
          active.urlSources!.some(
            (existing) =>
              existing.resolution === src.resolution &&
              existing.url === src.url,
          ),
        );
      if (sameSources) {
        return ok(reply, {
          message: "Resume URL session aktif",
          data: serializeSession(active),
        });
      }
    }

    const initialResolution = sources.reduce(
      (max, src) => Math.max(max, src.resolution),
      0,
    );

    const initialProgress: UrlSourceProgress[] = sources.map((src) => ({
      resolution: src.resolution,
      url: src.url,
      totalSegments: null,
      completedSegments: 0,
      status: "pending",
      errorMessage: null,
    }));

    const session = await createUploadSession({
      episodeId,
      sesid: sesid || null,
      initialResolution,
      mode: "url",
      urlSources: sources,
      urlProgress: initialProgress,
    });

    await appendEncodingLog(
      session.id,
      `Session URL dibuat dengan ${sources.length} source`,
    );
    const prepared = await prepareUrlUploadSession(session.id);
    await enqueueUrlUpload(session.id);

    return created(reply, {
      message: "URL upload session queued",
      data: serializeSession(prepared),
    });
  });

  app.post("/url-fetch-text", async (request, reply) => {
    const body = (request.body ?? {}) as { url?: string };
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) {
      throw badRequest("URL tidak valid");
    }
    try {
      const text = await fetchRemoteText(url);
      return ok(reply, {
        message: "Fetched",
        data: { text, length: text.length },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Gagal fetch playlist";
      throw badRequest(message);
    }
  });

  app.post("/:uploadId/url-playlist", async (request, reply) => {
    const { uploadId } = request.params as { uploadId: string };
    const session = await ensureSessionUsable(uploadId).catch((error) => {
      const status = (error as any)?.statusCode ?? 400;
      reply.code(status);
      throw error;
    });

    if (session.mode !== "url") {
      throw badRequest("Session bukan mode URL");
    }

    const body = (request.body ?? {}) as {
      resolution?: number;
      raw?: string;
      baseUrl?: string;
    };
    const resolution = Number(body.resolution);
    const raw = typeof body.raw === "string" ? body.raw : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";

    if (!isValidResolution(resolution)) {
      throw badRequest("resolution tidak valid");
    }
    const matchingSource = (session.urlSources ?? []).find(
      (src) => src.resolution === resolution,
    );
    if (!matchingSource) {
      throw badRequest(`Resolusi ${resolution}p tidak ada di session`);
    }
    if (!raw || !baseUrl) {
      throw badRequest("raw dan baseUrl wajib diisi");
    }

    let parsed;
    try {
      parsed = parseMediaPlaylist(raw, baseUrl);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Playlist tidak valid";
      await setUrlSourceStatus(uploadId, resolution, matchingSource.url, {
        status: "failed",
        errorMessage: message,
      });
      throw badRequest(message);
    }

    await rememberPlaylist(uploadId, resolution, raw, baseUrl);
    await setUrlSourceStatus(uploadId, resolution, matchingSource.url, {
      status: "uploading",
      totalSegments: parsed.segments.length,
      errorMessage: null,
    });

    if (!session.videoId) {
      const videoId = generateVideoId();
      await updateSessionStatus(uploadId, { videoId, status: "uploading" });
    } else if (session.status === "idle") {
      await updateSessionStatus(uploadId, { status: "uploading" });
    }

    await refreshUrlProgress(uploadId);
    const done = await getDoneSegments(uploadId, resolution);

    return ok(reply, {
      message: "Playlist tersimpan",
      data: {
        resolution,
        totalSegments: parsed.segments.length,
        targetDuration: parsed.targetDuration,
        segments: parsed.segments.map((seg) => ({
          index: seg.index,
          url: seg.url,
          durationSec: seg.durationSec,
        })),
        completedIndexes: done,
      },
    });
  });

  app.post("/:uploadId/url-segment", async (request, reply) => {
    const { uploadId } = request.params as { uploadId: string };
    const session = await ensureSessionUsable(uploadId).catch((error) => {
      const status = (error as any)?.statusCode ?? 400;
      reply.code(status);
      throw error;
    });

    if (session.mode !== "url") throw badRequest("Session bukan mode URL");
    if (!session.videoId) throw badRequest("videoId belum diset");

    if (!request.isMultipart()) {
      throw badRequest("Content-Type harus multipart/form-data");
    }

    let resolution = -1;
    let segmentIndex = -1;
    let buffer: Buffer | null = null;

    for await (const part of request.parts()) {
      if (part.type === "field") {
        const value = String(part.value ?? "");
        if (part.fieldname === "resolution") resolution = Number(value);
        else if (part.fieldname === "segmentIndex") {
          segmentIndex = Number(value);
        }
      } else if (part.type === "file" && part.fieldname === "segment") {
        const buf = await part.toBuffer();
        if (buf.length > MAX_SEGMENT_SIZE) {
          throw badRequest("Segmen melebihi 25MB");
        }
        buffer = buf;
      }
    }

    if (!buffer) throw badRequest("Field 'segment' wajib");
    if (!isValidResolution(resolution)) {
      throw badRequest("resolution tidak valid");
    }
    if (!Number.isFinite(segmentIndex) || segmentIndex < 0) {
      throw badRequest("segmentIndex tidak valid");
    }
    const matchingSource = (session.urlSources ?? []).find(
      (src) => src.resolution === resolution,
    );
    if (!matchingSource) {
      throw badRequest(`Resolusi ${resolution}p tidak ada di session`);
    }

    const result = await ingestSegmentBuffer({
      uploadId,
      videoId: session.videoId,
      resolution,
      segmentIndex,
      buffer,
    });

    const refreshed = await refreshUrlProgress(uploadId);

    return ok(reply, {
      message: result.duplicate ? "Segmen sudah ada" : "Segmen ter-upload",
      data: {
        resolution,
        segmentIndex,
        size: result.size,
        duplicate: result.duplicate,
        uploadProgress: refreshed?.uploadProgress ?? 0,
      },
    });
  });

  app.post("/:uploadId/url-segment-proxy", async (request, reply) => {
    const { uploadId } = request.params as { uploadId: string };
    const session = await ensureSessionUsable(uploadId).catch((error) => {
      const status = (error as any)?.statusCode ?? 400;
      reply.code(status);
      throw error;
    });

    if (session.mode !== "url") throw badRequest("Session bukan mode URL");
    if (!session.videoId) throw badRequest("videoId belum diset");

    const body = (request.body ?? {}) as {
      resolution?: number;
      segmentIndex?: number;
      url?: string;
    };
    const resolution = Number(body.resolution);
    const segmentIndex = Number(body.segmentIndex);
    const url = typeof body.url === "string" ? body.url.trim() : "";

    if (!isValidResolution(resolution)) {
      throw badRequest("resolution tidak valid");
    }
    if (!Number.isFinite(segmentIndex) || segmentIndex < 0) {
      throw badRequest("segmentIndex tidak valid");
    }
    if (!/^https?:\/\//i.test(url)) {
      throw badRequest("URL segmen tidak valid");
    }
    const matchingSource = (session.urlSources ?? []).find(
      (src) => src.resolution === resolution,
    );
    if (!matchingSource) {
      throw badRequest(`Resolusi ${resolution}p tidak ada di session`);
    }

    let buffer: Buffer;
    try {
      buffer = await fetchRemoteBuffer(url);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Fetch segmen gagal";
      throw badRequest(message);
    }
    if (buffer.length > MAX_SEGMENT_SIZE) {
      throw badRequest("Segmen melebihi 25MB");
    }

    const result = await ingestSegmentBuffer({
      uploadId,
      videoId: session.videoId,
      resolution,
      segmentIndex,
      buffer,
    });

    const refreshed = await refreshUrlProgress(uploadId);

    return ok(reply, {
      message: result.duplicate ? "Segmen sudah ada" : "Segmen ter-upload (server fetch)",
      data: {
        resolution,
        segmentIndex,
        size: result.size,
        duplicate: result.duplicate,
        uploadProgress: refreshed?.uploadProgress ?? 0,
      },
    });
  });

  app.post("/:uploadId/url-finalize", async (request, reply) => {
    const { uploadId } = request.params as { uploadId: string };
    const session = await ensureSessionUsable(uploadId).catch((error) => {
      const status = (error as any)?.statusCode ?? 400;
      reply.code(status);
      throw error;
    });

    if (session.mode !== "url") throw badRequest("Session bukan mode URL");

    await updateSessionStatus(uploadId, {
      status: "processing",
      encodingProgress: 0,
      r2UploadProgress: 0,
    });

    try {
      const result = await finalizeUrlSession(uploadId);
      return ok(reply, {
        message: "Selesai, master playlist & server R2 terpasang",
        data: {
          uploadId,
          videoId: session.videoId,
          masterUrl: result.masterUrl,
          resolutions: result.resolutions,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Finalize gagal";
      await failUrlSession(uploadId, message);
      throw badRequest(message);
    }
  });

  app.post("/:uploadId/url-reset", async (request, reply) => {
    const { uploadId } = request.params as { uploadId: string };
    const body = (request.body ?? {}) as { resolution?: number };
    const resolution = Number(body.resolution);
    if (!isValidResolution(resolution)) {
      throw badRequest("resolution tidak valid");
    }
    await clearSegmentSet(uploadId, resolution);
    await clearPlaylistCache(uploadId, resolution);
    await refreshUrlProgress(uploadId);
    return ok(reply, { message: "Segmen di-reset", data: { resolution } });
  });

  // ── SSE: realtime status + logs ────────────────────────────────────────────

  app.get("/:uploadId/events", async (request, reply) => {
    const { uploadId } = request.params as { uploadId: string };
    const query = request.query as { token?: string };

    // Manual auth: EventSource cannot send Authorization header.
    const token = (query.token ?? "").trim();
    if (!token) throw unauthorized("Token wajib di query (?token=...)");

    let payload: any;
    try {
      payload = await app.jwt.verify(token);
    } catch {
      throw unauthorized("Token invalid atau expired");
    }
    const userId = Number(payload?.id);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw unauthorized("Token payload invalid");
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (user?.role !== "admin") {
      throw unauthorized("Akses ditolak");
    }

    const session = await getUploadSession(uploadId);
    if (!session) throw notFound("Upload session tidak ditemukan");

    const origin = request.headers["origin"] || "*";
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    const writeEvent = (event: string, data: unknown) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      try {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        // ignore
      }
    };

    // Send initial snapshot.
    const logs = await getEncodingLogs(uploadId);
    writeEvent("snapshot", {
      session: serializeSession(session),
      logs,
    });

    const subscriber = createRedisSubscriber();
    const channel = uploadEventChannel(uploadId);

    const onMessage = (incomingChannel: string, message: string) => {
      if (incomingChannel !== channel) return;
      try {
        const parsed = JSON.parse(message);
        if (parsed?.type === "status") {
          writeEvent("status", parsed.session);
        } else if (parsed?.type === "log") {
          writeEvent("log", parsed.entry);
        }
      } catch {
        // ignore malformed events
      }
    };

    subscriber.on("message", onMessage);
    await subscriber.subscribe(channel).catch((error) => {
      writeEvent("error", { message: `Subscribe gagal: ${error?.message ?? error}` });
    });

    const heartbeat = setInterval(() => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        // ignore
      }
    }, 25_000);

    const close = async () => {
      clearInterval(heartbeat);
      try {
        subscriber.off("message", onMessage);
        await subscriber.unsubscribe(channel).catch(() => undefined);
      } finally {
        try {
          await subscriber.quit();
        } catch {
          subscriber.disconnect();
        }
      }
      if (!reply.raw.writableEnded) {
        try {
          reply.raw.end();
        } catch {
          // ignore
        }
      }
    };

    request.raw.on("close", close);
    request.raw.on("end", close);
  });
};

// Re-publish initial snapshot helper (used elsewhere if needed)
export async function emitUploadSnapshot(uploadId: string) {
  const session = await getUploadSession(uploadId);
  if (!session) return;
  await publishUploadEvent(uploadId, {
    type: "status",
    session: serializeSession(session),
  });
}
