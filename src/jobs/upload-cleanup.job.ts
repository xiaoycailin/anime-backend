import path from "path";
import fs from "fs/promises";
import { prisma } from "../lib/prisma";
import {
  cleanupUploadTempDir,
  UPLOAD_TMP_ROOT,
} from "../services/upload-session.service";

const SWEEP_INTERVAL_MS = Number(process.env.UPLOAD_SWEEP_INTERVAL_MS ?? 60 * 60 * 1000);
const ORPHAN_GRACE_MS = Number(process.env.UPLOAD_ORPHAN_GRACE_MS ?? 6 * 60 * 60 * 1000);

let timer: NodeJS.Timeout | null = null;
let running = false;

async function expireOverdueSessions() {
  await (prisma as any).uploadSession.updateMany({
    where: {
      status: { in: ["idle", "uploading"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "expired" },
  });
}

async function cleanCompletedDbSessions() {
  const sessions: { id: string }[] = await (prisma as any).uploadSession.findMany({
    where: {
      status: { in: ["expired", "failed"] },
    },
    select: { id: true },
    take: 200,
  });

  for (const session of sessions) {
    await cleanupUploadTempDir(session.id).catch(() => undefined);
  }
}

async function cleanOrphanTempDirs() {
  let entries: string[];
  try {
    entries = await fs.readdir(UPLOAD_TMP_ROOT);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!/^[0-9a-fA-F-]{20,}$/.test(entry)) continue;

    const dir = path.join(UPLOAD_TMP_ROOT, entry);
    let stat: import("fs").Stats;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const session = await (prisma as any).uploadSession.findUnique({
      where: { id: entry },
      select: { status: true, updatedAt: true },
    });

    if (!session) {
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > ORPHAN_GRACE_MS) {
        await cleanupUploadTempDir(entry).catch(() => undefined);
      }
      continue;
    }

    if (session.status === "completed") {
      await cleanupUploadTempDir(entry).catch(() => undefined);
    }
  }
}

export async function runUploadCleanup(logger?: {
  info?: (msg: string) => void;
  error?: (msg: string, err?: unknown) => void;
}) {
  if (running) return;
  running = true;
  try {
    await expireOverdueSessions();
    await cleanCompletedDbSessions();
    await cleanOrphanTempDirs();
    logger?.info?.("[upload-cleanup] sweep done");
  } catch (error) {
    logger?.error?.("[upload-cleanup] sweep error", error);
  } finally {
    running = false;
  }
}

export function startUploadCleanupJob(logger?: {
  info?: (msg: string) => void;
  error?: (msg: string, err?: unknown) => void;
}) {
  if (timer) return;

  void runUploadCleanup(logger);
  timer = setInterval(() => {
    void runUploadCleanup(logger);
  }, SWEEP_INTERVAL_MS);

  if (typeof timer.unref === "function") timer.unref();

  logger?.info?.(
    `[upload-cleanup] scheduled every ${Math.round(SWEEP_INTERVAL_MS / 60000)}m`,
  );
}

export function stopUploadCleanupJob() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
