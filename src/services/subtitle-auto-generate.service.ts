import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { notFound } from "../utils/http-error";
import { createSubtitleTrack, saveSubtitleCues } from "./subtitle.service";
import { createRoleNotification } from "./notification.service";
import {
  extractAudioChunk,
  prepareAutoGenerateInput,
  transcribeAudioChunk,
  translateSegments,
  type AutoGenerateInput,
} from "./subtitle-auto-generate-core.service";

type SubtitleAutoGenerateJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

type SubtitleAutoGenerateJob = {
  id: string;
  status: SubtitleAutoGenerateJobStatus;
  progress: number;
  stage: string;
  message: string;
  episodeId: number | null;
  serverUrl: string;
  language: string;
  label: string;
  totalChunks: number;
  processedChunks: number;
  track: Awaited<ReturnType<typeof saveSubtitleCues>> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

type SavedSubtitleTrack = Awaited<ReturnType<typeof saveSubtitleCues>>;
type SavedCue = SavedSubtitleTrack["cues"][number];

const FINAL_JOB_TTL = 60 * 60 * 1000;
const jobs = new Map<string, SubtitleAutoGenerateJob>();

function nowIso() {
  return new Date().toISOString();
}

function pruneJobs() {
  const cutoff = Date.now() - FINAL_JOB_TTL;
  for (const [id, job] of jobs.entries()) {
    const updatedAt = Date.parse(job.updatedAt);
    const isFinal = job.status === "completed" || job.status === "failed";
    if (isFinal && Number.isFinite(updatedAt) && updatedAt < cutoff) {
      jobs.delete(id);
    }
  }
}

function toPublicJob(job: SubtitleAutoGenerateJob) {
  return { ...job };
}

function createJob(input: AutoGenerateInput): SubtitleAutoGenerateJob {
  return {
    id: randomUUID(),
    status: "queued",
    progress: 0,
    stage: "queued",
    message: "Job subtitle masuk antrean",
    episodeId: Number(input.episodeId) || null,
    serverUrl: typeof input.serverUrl === "string" ? input.serverUrl : "",
    language: typeof input.language === "string" ? input.language : "",
    label: typeof input.label === "string" ? input.label : "",
    totalChunks: 0,
    processedChunks: 0,
    track: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: null,
  };
}

function updateJob(
  jobId: string,
  patch: Partial<SubtitleAutoGenerateJob>,
) {
  const current = jobs.get(jobId);
  if (!current) return null;

  const next = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  };
  jobs.set(jobId, next);
  return next;
}

function progressForChunk(chunkIndex: number, totalChunks: number) {
  return Math.max(
    10,
    Math.min(92, Math.round(10 + (chunkIndex / Math.max(1, totalChunks)) * 82)),
  );
}

function cueOrder(
  left: { startTime: number; endTime: number },
  right: { startTime: number; endTime: number },
) {
  if (left.startTime !== right.startTime) {
    return left.startTime - right.startTime;
  }
  return left.endTime - right.endTime;
}

function normalizeCueText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function dedupeSegments(
  segments: Array<{ startTime: number; endTime: number; text: string }>,
) {
  const sorted = [...segments].sort(cueOrder);
  const deduped: Array<{ startTime: number; endTime: number; text: string }> = [];

  for (const segment of sorted) {
    const previous = deduped[deduped.length - 1];
    if (
      previous &&
      normalizeCueText(previous.text) === normalizeCueText(segment.text) &&
      Math.abs(previous.startTime - segment.startTime) <= 0.75
    ) {
      previous.endTime = Math.max(previous.endTime, segment.endTime);
      continue;
    }
    deduped.push({ ...segment });
  }

  return deduped;
}

function cueToSegment(cue: { startTime: number; endTime: number; text: string }) {
  return {
    startTime: cue.startTime,
    endTime: cue.endTime,
    text: cue.text,
  };
}

function cueMidpoint(cue: { startTime: number; endTime: number }) {
  return cue.startTime + (cue.endTime - cue.startTime) / 2;
}

function chunkHasExistingCue(
  cues: Array<{ startTime: number; endTime: number; text: string }>,
  chunkStart: number,
  chunkEnd: number,
) {
  return cues.some((cue) => {
    const middle = cueMidpoint(cue);
    return middle >= chunkStart && middle < chunkEnd && cue.text.trim();
  });
}

async function loadTrackWithCues(trackId: number) {
  return prisma.subtitleTrack.findUniqueOrThrow({
    where: { id: trackId },
    include: {
      cues: { orderBy: [{ orderIndex: "asc" }, { startTime: "asc" }] },
    },
  });
}

async function saveMergedTrackCues(
  trackId: number,
  existingCues: SavedCue[],
  nextSegments: Array<{ startTime: number; endTime: number; text: string }>,
) {
  const merged = dedupeSegments([
    ...existingCues.map(cueToSegment),
    ...nextSegments,
  ]);
  return saveSubtitleCues(trackId, merged);
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Gagal auto generate subtitle";
}

function formatDuration(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const remain = whole % 60;
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

async function loadEpisodeAiContext(episodeId: number) {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    select: {
      number: true,
      title: true,
      anime: { select: { title: true } },
    },
  });

  return {
    animeTitle: episode?.anime?.title ?? "",
    episodeTitle: episode?.title ?? "",
    episodeNumber: episode?.number,
  };
}

async function runAutoGenerateJob(jobId: string, input: AutoGenerateInput) {
  try {
    const initiatedById = Number((input as any).userId || 0) || null;
    updateJob(jobId, {
      status: "running",
      stage: "preparing",
      progress: 2,
      message: "Menyiapkan stream video...",
      error: null,
    });

    const prepared = await prepareAutoGenerateInput(input);
    const episodeContext = await loadEpisodeAiContext(prepared.episodeId);
    updateJob(jobId, {
      episodeId: prepared.episodeId,
      serverUrl: prepared.serverUrl,
      language: prepared.language,
      label: prepared.label,
      totalChunks: prepared.totalChunks,
      processedChunks: 0,
      progress: 8,
      stage: "preparing",
      message: prepared.durationEstimated
        ? `Durasi stream tidak terbaca, pakai estimasi ${formatDuration(prepared.durationSeconds)}`
        : `Durasi video ${formatDuration(prepared.durationSeconds)}, diproses ${prepared.totalChunks} chunk`,
    });

    const collected: Array<{ startTime: number; endTime: number; text: string }> =
      [];
    const track = await createSubtitleTrack({
      episodeId: prepared.episodeId,
      serverUrl: prepared.serverUrl,
      language: prepared.language,
      label: prepared.label,
    });
    let savedTrack = await loadTrackWithCues(track.id);
    let existingCues = savedTrack.cues;

    for (let chunkIndex = 0; chunkIndex < prepared.totalChunks; chunkIndex += 1) {
      const chunkNumber = chunkIndex + 1;
      const chunkStart = chunkIndex * prepared.chunkSeconds;
      const chunkDuration = Math.min(
        prepared.chunkSeconds,
        Math.max(1, prepared.durationSeconds - chunkStart),
      );
      const chunkEnd = chunkStart + chunkDuration;

      if (chunkHasExistingCue(existingCues, chunkStart, chunkEnd)) {
        updateJob(jobId, {
          stage: "skipping",
          processedChunks: chunkNumber,
          progress: progressForChunk(chunkNumber, prepared.totalChunks),
          message: `Chunk ${chunkNumber}/${prepared.totalChunks} sudah punya cue, dilewati`,
          track: savedTrack,
        });
        continue;
      }

      updateJob(jobId, {
        stage: "extracting",
        progress: progressForChunk(chunkIndex, prepared.totalChunks),
        message: `Ekstrak audio chunk ${chunkNumber}/${prepared.totalChunks}`,
      });

      const audioBuffer = await extractAudioChunk(
        prepared.streamUrl,
        chunkStart,
        chunkDuration,
      );

      if (!audioBuffer) {
        updateJob(jobId, {
          processedChunks: chunkNumber,
          progress: progressForChunk(chunkNumber, prepared.totalChunks),
          message: `Chunk ${chunkNumber}/${prepared.totalChunks} tidak punya audio yang bisa diproses`,
        });
        continue;
      }

      updateJob(jobId, {
        stage: "transcribing",
        progress: progressForChunk(chunkIndex + 0.33, prepared.totalChunks),
        message: `Transkripsi chunk ${chunkNumber}/${prepared.totalChunks}`,
      });
      const transcribed = await transcribeAudioChunk(
        audioBuffer,
        prepared.sourceLanguage,
        prepared.transcribeModel,
      );

      if (transcribed.length === 0) {
        updateJob(jobId, {
          processedChunks: chunkNumber,
          progress: progressForChunk(chunkNumber, prepared.totalChunks),
          message: `Chunk ${chunkNumber}/${prepared.totalChunks} selesai, tidak ada dialog terdeteksi`,
        });
        continue;
      }

      updateJob(jobId, {
        stage: "translating",
        progress: progressForChunk(chunkIndex + 0.66, prepared.totalChunks),
        message: `Translate chunk ${chunkNumber}/${prepared.totalChunks} ke Indonesia`,
      });
      const translated = await translateSegments(transcribed, prepared.label, {
        textModel: prepared.textModel,
        instructions: prepared.instructions,
        instructionMessages: prepared.instructionMessages,
        context: {
          ...episodeContext,
          ...prepared.context,
          targetLanguage: prepared.language,
          targetLabel: prepared.label,
        },
      });

      const nextSegments = translated.map((segment) => {
          const startTime = Math.max(0, chunkStart + segment.startTime);
          const cappedEnd = Math.min(
            chunkStart + chunkDuration,
            chunkStart + segment.endTime,
          );
          return {
            startTime,
            endTime: Math.max(startTime + 0.1, cappedEnd),
            text: segment.text,
          };
        });
      collected.push(...nextSegments);

      savedTrack = await saveMergedTrackCues(track.id, existingCues, nextSegments);
      existingCues = savedTrack.cues;

      updateJob(jobId, {
        processedChunks: chunkNumber,
        progress: progressForChunk(chunkNumber, prepared.totalChunks),
        message: `Chunk ${chunkNumber}/${prepared.totalChunks} tersimpan ke database (${savedTrack.cues.length} cue)`,
        track: savedTrack,
      });
    }

    savedTrack = await loadTrackWithCues(track.id);
    if (savedTrack.cues.length === 0 && collected.length === 0) {
      throw new Error("Tidak ada subtitle yang berhasil digenerate dari video ini");
    }

    updateJob(jobId, {
      status: "completed",
      stage: "completed",
      progress: 100,
      processedChunks: prepared.totalChunks,
      message: `Subtitle ${savedTrack.label} selesai, ${savedTrack.cues.length} cue tersimpan`,
      track: savedTrack,
      error: null,
      finishedAt: nowIso(),
    });

    if (initiatedById && savedTrack) {
      await createRoleNotification({
        role: "admin",
        category: "admin_operational",
        type: "subtitle_auto_generate_completed",
        title: "Auto generate subtitle selesai",
        message: `Subtitle ${savedTrack.label} selesai dibuat dengan ${savedTrack.cues.length} cue.`,
        link: `/admin/subtitle-studio/${prepared.episodeId}`,
        topic: "admin-subtitle",
        payload: {
          jobId,
          episodeId: prepared.episodeId,
          language: savedTrack.language,
          label: savedTrack.label,
          cueCount: savedTrack.cues.length,
        },
        createdById: initiatedById,
      });
    }
  } catch (error) {
    const initiatedById = Number((input as any).userId || 0) || null;
    updateJob(jobId, {
      status: "failed",
      stage: "failed",
      message: "Auto generate subtitle gagal",
      error: errorMessage(error),
      finishedAt: nowIso(),
    });

    if (initiatedById) {
      await createRoleNotification({
        role: "admin",
        category: "admin_operational",
        type: "subtitle_auto_generate_failed",
        title: "Auto generate subtitle gagal",
        message: errorMessage(error),
        link: `/admin/subtitle-studio/${Number((input as any).episodeId) || ""}`,
        topic: "admin-subtitle",
        payload: {
          jobId,
          episodeId: Number((input as any).episodeId) || null,
          error: errorMessage(error),
        },
        createdById: initiatedById,
      });
    }
  }
}

export function startAutoGenerateSubtitleJob(input: AutoGenerateInput) {
  pruneJobs();
  const job = createJob(input);
  jobs.set(job.id, job);
  void runAutoGenerateJob(job.id, input);
  return toPublicJob(job);
}

export function getAutoGenerateSubtitleJob(jobId: string) {
  pruneJobs();
  const job = jobs.get(jobId);
  if (!job) throw notFound("Job auto generate tidak ditemukan");
  return toPublicJob(job);
}
