import crypto from "crypto";
import path from "path";
import fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";

export const UPLOAD_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const UPLOAD_SESSION_TTL_SEC = UPLOAD_SESSION_TTL_MS / 1000;

export const UPLOAD_TMP_ROOT =
  process.env.UPLOAD_TMP_DIR || path.join(process.cwd(), "tmp", "uploads");

if (!existsSync(UPLOAD_TMP_ROOT)) {
  mkdirSync(UPLOAD_TMP_ROOT, { recursive: true });
}

export type UploadSessionStatus =
  | "idle"
  | "uploading"
  | "processing"
  | "completed"
  | "failed"
  | "expired";

export type UploadSessionRecord = {
  id: string;
  episodeId: number;
  sesid: string | null;
  status: UploadSessionStatus;
  initialResolution: number;
  totalChunks: number | null;
  receivedChunks: number;
  uploadProgress: number;
  encodingProgress: number;
  r2UploadProgress: number;
  currentResolution: number | null;
  resolutionsDone: number[];
  fileName: string | null;
  fileSize: number | null;
  fileLastModified: number | null;
  videoId: string | null;
  masterPlaylistUrl: string | null;
  errorMessage: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export const VALID_RESOLUTIONS = [144, 240, 480, 720, 1080] as const;
export type ValidResolution = (typeof VALID_RESOLUTIONS)[number];

export function isValidResolution(value: unknown): value is ValidResolution {
  return (
    typeof value === "number" &&
    (VALID_RESOLUTIONS as readonly number[]).includes(value)
  );
}

const REDIS_KEY_PREFIX = "upload:session:";
const REDIS_CHUNK_KEY_PREFIX = "upload:chunks:";

function redisSessionKey(uploadId: string) {
  return `${REDIS_KEY_PREFIX}${uploadId}`;
}

function redisChunkKey(uploadId: string) {
  return `${REDIS_CHUNK_KEY_PREFIX}${uploadId}`;
}

export function uploadTempDir(uploadId: string) {
  return path.join(UPLOAD_TMP_ROOT, uploadId);
}

export async function ensureUploadTempDir(uploadId: string) {
  const dir = uploadTempDir(uploadId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanupUploadTempDir(uploadId: string) {
  const dir = uploadTempDir(uploadId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function toRecord(row: any): UploadSessionRecord {
  return {
    id: row.id,
    episodeId: row.episodeId,
    sesid: row.sesid ?? null,
    status: row.status as UploadSessionStatus,
    initialResolution: row.initialResolution,
    totalChunks: row.totalChunks ?? null,
    receivedChunks: row.receivedChunks ?? 0,
    uploadProgress: Number(row.uploadProgress ?? 0),
    encodingProgress: Number(row.encodingProgress ?? 0),
    r2UploadProgress: Number(row.r2UploadProgress ?? 0),
    currentResolution: row.currentResolution ?? null,
    resolutionsDone: Array.isArray(row.resolutionsDone)
      ? row.resolutionsDone
      : [],
    fileName: row.fileName ?? null,
    fileSize:
      row.fileSize === null || row.fileSize === undefined
        ? null
        : typeof row.fileSize === "bigint"
          ? Number(row.fileSize)
          : Number(row.fileSize),
    fileLastModified:
      row.fileLastModified === null || row.fileLastModified === undefined
        ? null
        : typeof row.fileLastModified === "bigint"
          ? Number(row.fileLastModified)
          : Number(row.fileLastModified),
    videoId: row.videoId ?? null,
    masterPlaylistUrl: row.masterPlaylistUrl ?? null,
    errorMessage: row.errorMessage ?? null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createUploadSession(input: {
  episodeId: number;
  sesid?: string | null;
  initialResolution?: number;
}): Promise<UploadSessionRecord> {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS);
  const initialResolution = isValidResolution(input.initialResolution)
    ? input.initialResolution
    : 720;

  const row = await (prisma as any).uploadSession.create({
    data: {
      id,
      episodeId: input.episodeId,
      sesid: input.sesid ?? null,
      status: "idle",
      initialResolution,
      resolutionsDone: [],
      expiresAt,
    },
  });

  await ensureUploadTempDir(id);

  await redis.set(
    redisSessionKey(id),
    JSON.stringify({ status: "idle", expiresAt: expiresAt.toISOString() }),
    "PX",
    UPLOAD_SESSION_TTL_MS,
  );

  return toRecord(row);
}

export async function getUploadSession(
  uploadId: string,
): Promise<UploadSessionRecord | null> {
  const row = await (prisma as any).uploadSession.findUnique({
    where: { id: uploadId },
  });
  if (!row) return null;
  return toRecord(row);
}

export async function findActiveSessionForEpisode(
  episodeId: number,
): Promise<UploadSessionRecord | null> {
  const row = await (prisma as any).uploadSession.findFirst({
    where: {
      episodeId,
      status: { in: ["idle", "uploading", "processing"] },
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  return toRecord(row);
}

export async function markSessionExpiredIfNeeded(
  session: UploadSessionRecord,
): Promise<UploadSessionRecord> {
  if (session.status === "completed" || session.status === "failed") {
    return session;
  }

  if (session.expiresAt.getTime() <= Date.now() && session.status !== "expired") {
    const updated = await (prisma as any).uploadSession.update({
      where: { id: session.id },
      data: { status: "expired" },
    });
    await redis.del(redisSessionKey(session.id));
    return toRecord(updated);
  }

  return session;
}

export async function recordChunkReceived(
  uploadId: string,
  chunkIndex: number,
): Promise<boolean> {
  // Returns true if this is a new chunk, false if duplicate
  const added = await redis.sadd(redisChunkKey(uploadId), String(chunkIndex));
  await redis.pexpire(redisChunkKey(uploadId), UPLOAD_SESSION_TTL_MS);
  return added === 1;
}

export async function getReceivedChunks(uploadId: string): Promise<number[]> {
  const members = await redis.smembers(redisChunkKey(uploadId));
  return members
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

export async function clearChunkSet(uploadId: string) {
  await redis.del(redisChunkKey(uploadId));
}

export async function updateSessionStatus(
  uploadId: string,
  data: {
    status?: UploadSessionStatus;
    totalChunks?: number;
    receivedChunks?: number;
    uploadProgress?: number;
    encodingProgress?: number;
    r2UploadProgress?: number;
    currentResolution?: number | null;
    resolutionsDone?: number[];
    fileName?: string | null;
    fileSize?: number | null;
    fileLastModified?: number | null;
    videoId?: string | null;
    masterPlaylistUrl?: string | null;
    errorMessage?: string | null;
    expiresAt?: Date;
  },
): Promise<UploadSessionRecord> {
  const updateData: any = { ...data };
  if (typeof data.fileSize === "number") {
    updateData.fileSize = BigInt(Math.max(0, Math.floor(data.fileSize)));
  }
  if (typeof data.fileLastModified === "number") {
    updateData.fileLastModified = BigInt(
      Math.max(0, Math.floor(data.fileLastModified)),
    );
  }
  const row = await (prisma as any).uploadSession.update({
    where: { id: uploadId },
    data: updateData,
  });
  return toRecord(row);
}

export async function expireSessionImmediately(uploadId: string) {
  await (prisma as any).uploadSession.update({
    where: { id: uploadId },
    data: {
      status: "completed",
      expiresAt: new Date(),
    },
  });
  await redis.del(redisSessionKey(uploadId));
  await clearChunkSet(uploadId);
}

export async function failSession(uploadId: string, message: string) {
  try {
    await (prisma as any).uploadSession.update({
      where: { id: uploadId },
      data: {
        status: "failed",
        errorMessage: message.slice(0, 1000),
      },
    });
  } catch {
    // ignore
  }
  await redis.del(redisSessionKey(uploadId));
}

export async function ensureSessionUsable(
  uploadId: string,
): Promise<UploadSessionRecord> {
  const session = await getUploadSession(uploadId);
  if (!session) {
    const error = new Error("Upload session tidak ditemukan");
    (error as any).statusCode = 404;
    throw error;
  }

  const checked = await markSessionExpiredIfNeeded(session);

  if (checked.status === "expired") {
    const error = new Error("Upload session sudah kadaluarsa");
    (error as any).statusCode = 410;
    throw error;
  }

  if (checked.status === "completed") {
    const error = new Error("Upload session sudah selesai");
    (error as any).statusCode = 409;
    throw error;
  }

  if (checked.status === "failed") {
    const error = new Error("Upload session gagal — buat session baru");
    (error as any).statusCode = 409;
    throw error;
  }

  return checked;
}
