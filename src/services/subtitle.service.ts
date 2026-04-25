import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { badRequest, conflict, notFound } from "../utils/http-error";

type SubtitleInput = {
  episodeId?: number | string;
  serverUrl?: string;
  language?: string;
  label?: string;
  fileUrl?: string;
};

type UploadedSubtitle = {
  filename: string;
  buffer: Buffer;
};

type CueInput = {
  id?: number;
  startTime?: number;
  endTime?: number;
  text?: string;
};

type TrackInput = {
  episodeId?: number | string;
  serverUrl?: string;
  language?: string;
  label?: string;
};

const subtitleDir = path.join(process.cwd(), "uploads", "subtitles");
const allowedFormats = new Set(["srt", "vtt"]);

function normalizeLanguage(language?: string) {
  const value = language?.trim().toLowerCase();
  if (!value) throw badRequest("Language wajib diisi");
  if (!/^[a-z0-9-]{2,20}$/i.test(value))
    throw badRequest("Language tidak valid");
  return value;
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function detectFormat(nameOrUrl = "", content = ""): "vtt" | "srt" {
  const ext = path.extname(nameOrUrl).slice(1).toLowerCase();
  if (allowedFormats.has(ext)) return ext as "vtt" | "srt";
  return content.trimStart().startsWith("WEBVTT") ? "vtt" : "srt";
}

export function srtToVtt(input: string) {
  const body = input
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .trim();
  return body.startsWith("WEBVTT") ? `${body}\n` : `WEBVTT\n\n${body}\n`;
}

function assertSubtitleContent(content: string) {
  if (!content.includes("-->")) throw badRequest("File subtitle tidak valid");
}

function toSubtitleFileName(originalName: string) {
  const base = path
    .basename(originalName, path.extname(originalName))
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${Date.now()}-${crypto.randomUUID()}-${base || "subtitle"}.vtt`;
}

export function subtitleFilePath(fileName: string) {
  const safeName = path.basename(fileName);
  return path.join(subtitleDir, safeName);
}

async function saveUploadedSubtitle(file: UploadedSubtitle) {
  const raw = file.buffer.toString("utf8");
  const format = detectFormat(file.filename, raw);
  if (!allowedFormats.has(format))
    throw badRequest("Format subtitle tidak valid");

  const content = format === "srt" ? srtToVtt(raw) : raw;
  assertSubtitleContent(content);

  const fileName = toSubtitleFileName(file.filename);
  await fs.mkdir(subtitleDir, { recursive: true });
  await fs.writeFile(path.join(subtitleDir, fileName), content, "utf8");

  return {
    fileUrl: `/api/subtitles/files/${fileName}`,
    format: "vtt" as const,
  };
}

async function assertEpisodeServer(episodeId: number, serverUrl: string) {
  const [episode, server] = await Promise.all([
    prisma.episode.findUnique({
      where: { id: episodeId },
      select: { id: true },
    }),
    prisma.server.findFirst({
      where: { episodeId, value: serverUrl },
      select: { id: true },
    }),
  ]);

  if (!episode) throw notFound("Episode tidak ditemukan");
  if (!server) throw badRequest("Server URL tidak terdaftar di episode ini");
}

function duplicateError(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw conflict("Subtitle bahasa ini sudah ada untuk server tersebut");
  }
  throw error;
}

export async function listSubtitles(episodeId: number) {
  if (!Number.isInteger(episodeId) || episodeId <= 0)
    throw badRequest("episodeId tidak valid");
  return prisma.subtitle.findMany({
    where: { episodeId },
    orderBy: [{ serverUrl: "asc" }, { language: "asc" }],
  });
}

export async function createSubtitle(
  input: SubtitleInput,
  file?: UploadedSubtitle,
) {
  const episodeId = Number(input.episodeId);
  const serverUrl = cleanString(input.serverUrl);
  const language = normalizeLanguage(input.language);
  const label = cleanString(input.label) || language.toUpperCase();

  if (!Number.isInteger(episodeId) || episodeId <= 0)
    throw badRequest("episodeId tidak valid");
  if (!serverUrl) throw badRequest("serverUrl wajib diisi");
  await assertEpisodeServer(episodeId, serverUrl);

  const stored = file
    ? await saveUploadedSubtitle(file)
    : {
        fileUrl: cleanString(input.fileUrl),
        format: detectFormat(input.fileUrl) as "vtt" | "srt",
      };

  if (!stored.fileUrl) throw badRequest("File atau URL subtitle wajib diisi");

  return prisma.subtitle
    .create({
      data: {
        episodeId,
        serverUrl,
        language,
        label,
        fileUrl: stored.fileUrl,
        format: stored.format,
      },
    })
    .catch(duplicateError);
}

export async function updateSubtitle(
  id: number,
  input: Partial<SubtitleInput>,
) {
  if (!Number.isInteger(id) || id <= 0)
    throw badRequest("id subtitle tidak valid");

  const data: Prisma.SubtitleUpdateInput = {};
  if (input.language !== undefined)
    data.language = normalizeLanguage(input.language);
  if (input.label !== undefined) data.label = cleanString(input.label);
  if (input.fileUrl !== undefined) {
    data.fileUrl = cleanString(input.fileUrl);
    data.format = detectFormat(input.fileUrl);
  }

  if (Object.keys(data).length === 0)
    throw badRequest("Tidak ada data yang diubah");

  return prisma.subtitle.update({ where: { id }, data }).catch(duplicateError);
}

export async function deleteSubtitle(id: number) {
  if (!Number.isInteger(id) || id <= 0)
    throw badRequest("id subtitle tidak valid");
  await prisma.subtitle.delete({ where: { id } });
  return { message: "deleted" };
}

export async function importSubtitle(input: {
  episodeId?: number | string;
  fromServerUrl?: string;
  toServerUrl?: string;
  language?: string;
}) {
  const episodeId = Number(input.episodeId);
  const fromServerUrl = cleanString(input.fromServerUrl);
  const toServerUrl = cleanString(input.toServerUrl);
  const language = normalizeLanguage(input.language);

  if (!Number.isInteger(episodeId) || episodeId <= 0)
    throw badRequest("episodeId tidak valid");
  if (!fromServerUrl || !toServerUrl)
    throw badRequest("Server sumber dan tujuan wajib diisi");
  if (fromServerUrl === toServerUrl)
    throw badRequest("Server sumber dan tujuan harus berbeda");

  await assertEpisodeServer(episodeId, toServerUrl);

  const source = await prisma.subtitle.findUnique({
    where: {
      episodeId_serverUrl_language: {
        episodeId,
        serverUrl: fromServerUrl,
        language,
      },
    },
  });

  if (!source) throw notFound("Subtitle sumber tidak ditemukan");

  return prisma.subtitle
    .create({
      data: {
        episodeId,
        serverUrl: toServerUrl,
        language: source.language,
        label: source.label,
        fileUrl: source.fileUrl,
        format: source.format,
      },
    })
    .catch(duplicateError);
}

function cueOrder(
  left: { startTime: number; endTime: number },
  right: { startTime: number; endTime: number },
) {
  if (left.startTime !== right.startTime)
    return left.startTime - right.startTime;
  return left.endTime - right.endTime;
}

function clampCue(input: CueInput, index: number) {
  const startTime = Math.max(0, Number(input.startTime ?? 0));
  const requestedEnd = Math.max(0, Number(input.endTime ?? startTime + 2));
  const endTime = Math.max(startTime + 0.1, requestedEnd);

  return {
    startTime,
    endTime,
    text: cleanString(input.text),
    orderIndex: index,
  };
}

function toTimestamp(seconds: number) {
  const value = Math.max(0, seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const wholeSeconds = Math.floor(value % 60);
  const millis = Math.round((value - Math.floor(value)) * 1000);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function parseTimestamp(value: string) {
  const match = value.trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) return null;

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);

  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function stripCueSettings(timestamp: string) {
  return timestamp.trim().split(/\s+/)[0];
}

export function parseSubtitleCues(input: string) {
  const normalized = srtToVtt(input)
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !/^WEBVTT($|\s)/i.test(line.trim()))
    .join("\n");

  const blocks = normalized.split(/\n{2,}/);
  const cues: CueInput[] = [];

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);
    if (lines.length === 0) continue;

    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex === -1) continue;

    const [startRaw, endRaw] = lines[timeIndex].split("-->");
    const startTime = parseTimestamp(stripCueSettings(startRaw));
    const endTime = parseTimestamp(stripCueSettings(endRaw));
    if (startTime === null || endTime === null || endTime <= startTime)
      continue;

    cues.push({
      startTime,
      endTime,
      text: lines.slice(timeIndex + 1).join("\n"),
    });
  }

  return cues;
}

export function cuesToVtt(
  cues: { startTime: number; endTime: number; text: string }[],
) {
  const body = [...cues]
    .sort(cueOrder)
    .map(
      (cue) =>
        `${toTimestamp(cue.startTime)} --> ${toTimestamp(cue.endTime)}\n${cue.text.trim()}`,
    )
    .join("\n\n");

  return `WEBVTT\n\n${body}${body ? "\n" : ""}`;
}

export async function listSubtitleTracks(episodeId: number, serverUrl: string) {
  if (!Number.isInteger(episodeId) || episodeId <= 0)
    throw badRequest("episodeId tidak valid");
  if (!serverUrl) throw badRequest("serverUrl wajib diisi");

  return prisma.subtitleTrack.findMany({
    where: { episodeId, serverUrl },
    orderBy: { language: "asc" },
    include: {
      cues: { orderBy: [{ orderIndex: "asc" }, { startTime: "asc" }] },
    },
  });
}

export async function createSubtitleTrack(input: TrackInput) {
  const episodeId = Number(input.episodeId);
  const serverUrl = cleanString(input.serverUrl);
  const language = normalizeLanguage(input.language);
  const label = cleanString(input.label) || language.toUpperCase();

  if (!Number.isInteger(episodeId) || episodeId <= 0)
    throw badRequest("episodeId tidak valid");
  if (!serverUrl) throw badRequest("serverUrl wajib diisi");
  await assertEpisodeServer(episodeId, serverUrl);

  return prisma.subtitleTrack.upsert({
    where: { episodeId_serverUrl_language: { episodeId, serverUrl, language } },
    update: { label },
    create: { episodeId, serverUrl, language, label },
  });
}

export async function saveSubtitleCues(trackId: number, cues: CueInput[]) {
  if (!Number.isInteger(trackId) || trackId <= 0)
    throw badRequest("trackId tidak valid");
  if (!Array.isArray(cues)) throw badRequest("cues wajib array");

  const track = await prisma.subtitleTrack.findUnique({
    where: { id: trackId },
    select: { id: true },
  });
  if (!track) throw notFound("Track subtitle tidak ditemukan");

  const normalized = cues
    .map(clampCue)
    .filter((cue) => cue.text.length > 0)
    .sort(cueOrder)
    .map((cue, index) => ({ ...cue, orderIndex: index }));

  return prisma.$transaction(async (tx) => {
    await tx.subtitleCue.deleteMany({ where: { trackId } });
    if (normalized.length > 0) {
      await tx.subtitleCue.createMany({
        data: normalized.map((cue) => ({ ...cue, trackId })),
      });
    }
    return tx.subtitleTrack.findUniqueOrThrow({
      where: { id: trackId },
      include: {
        cues: { orderBy: [{ orderIndex: "asc" }, { startTime: "asc" }] },
      },
    });
  });
}

export async function deleteSubtitleCue(cueId: number) {
  if (!Number.isInteger(cueId) || cueId <= 0)
    throw badRequest("cue id tidak valid");
  await prisma.subtitleCue.delete({ where: { id: cueId } });
  return { message: "deleted" };
}

export async function exportSubtitleTrackVtt(
  episodeId: number,
  serverUrl: string,
  language: string,
) {
  const track = await prisma.subtitleTrack.findUnique({
    where: {
      episodeId_serverUrl_language: {
        episodeId,
        serverUrl,
        language: normalizeLanguage(language),
      },
    },
    include: {
      cues: { orderBy: [{ orderIndex: "asc" }, { startTime: "asc" }] },
    },
  });

  if (!track) throw notFound("Track subtitle tidak ditemukan");
  return cuesToVtt(track.cues);
}

export async function importSubtitleFile(
  input: TrackInput,
  file?: UploadedSubtitle,
) {
  const track = await createSubtitleTrack(input);
  const source =
    file?.buffer.toString("utf8") ??
    cleanString((input as TrackInput & { content?: string }).content);
  if (!source) throw badRequest("File subtitle wajib diisi");

  const cues = parseSubtitleCues(source);
  if (cues.length === 0)
    throw badRequest("File subtitle tidak memiliki cue valid");

  return saveSubtitleCues(track.id, cues);
}
