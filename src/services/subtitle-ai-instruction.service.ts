import { prisma } from "../lib/prisma";
import { badRequest, notFound } from "../utils/http-error";
import {
  extractAudioChunk,
  prepareAutoGenerateInput,
  reviseCueWindowWithAi,
  transcribeAudioChunk,
  type SubtitleAiContext,
  type SubtitleInstructionMessage,
} from "./subtitle-auto-generate-core.service";
import {
  loadSubtitleAiMemory,
  rememberSubtitleAiInstruction,
} from "./subtitle-ai-memory.service";
import { saveSubtitleCues } from "./subtitle.service";

type AiRevisionInput = {
  trackId?: number | string;
  userId?: number | string;
  instruction?: string;
  messages?: SubtitleInstructionMessage[];
  currentTime?: number | string;
  selectedCueId?: number | string | null;
  sourceLanguage?: string;
  textModel?: string;
  baseUrl?: string;
  context?: SubtitleAiContext;
};

const TARGET_PADDING_SECONDS = 14;
const MAX_AI_CUES = 18;
const SINGLE_TIME_REVISION_SECONDS = 60;
const MAX_REVISION_AUDIO_SECONDS = 120;

type TargetCue = {
  id: number;
  startTime: number;
  endTime: number;
  text: string;
  orderIndex: number;
};

type NormalizedRevisionPatch = {
  cueId?: number;
  index?: number;
  startTime?: number;
  endTime?: number;
  text?: string;
};

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numericSeconds(value: unknown) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function timestampToSeconds(value: string) {
  const parts = value
    .replace(",", ".")
    .split(":")
    .map((item) => Number(item));

  if (parts.length === 3 && parts.every(Number.isFinite)) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2 && parts.every(Number.isFinite)) {
    return parts[0] * 60 + parts[1];
  }
  return null;
}

function parseInstructionTimes(instruction: string) {
  const text = instruction.toLowerCase();
  const seconds: number[] = [];

  for (const match of text.matchAll(/(?:^|[^\d])(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)(?!\d)/g)) {
    const parsed = timestampToSeconds(match[1]);
    if (parsed !== null) seconds.push(parsed);
  }

  for (const match of text.matchAll(/\b(\d{1,3})\s*m(?:enit)?\s*(\d{1,2})?\s*s?\b/g)) {
    const minutes = Number(match[1]);
    const remain = Number(match[2] ?? 0);
    if (Number.isFinite(minutes) && Number.isFinite(remain)) {
      seconds.push(minutes * 60 + remain);
    }
  }

  for (const match of text.matchAll(/\b(?:menit|minute|min)\s*(?:ke\s*)?(\d{1,3})(?:[.,](\d+))?\b/g)) {
    const minutes = Number(`${match[1]}.${match[2] ?? 0}`);
    if (Number.isFinite(minutes)) seconds.push(minutes * 60);
  }

  for (const match of text.matchAll(/\b(\d{1,5})(?:[.,](\d+))?\s*(?:detik|sec|second|s)\b/g)) {
    const value = Number(`${match[1]}.${match[2] ?? 0}`);
    if (Number.isFinite(value)) seconds.push(value);
  }

  const unique = [...new Set(seconds.map((item) => Math.max(0, item)))];
  if (unique.length >= 2) {
    const [first, second] = unique;
    return {
      startTime: Math.min(first, second),
      endTime: Math.max(first, second),
      matchedBy: "range",
      explicitTime: true,
    };
  }
  if (unique.length === 1) {
    return {
      startTime: unique[0],
      endTime: unique[0] + SINGLE_TIME_REVISION_SECONDS,
      matchedBy: "instruction",
      explicitTime: true,
    };
  }
  return null;
}

function cueDistance(
  cue: { startTime: number; endTime: number },
  center: number,
) {
  if (center >= cue.startTime && center <= cue.endTime) return 0;
  return Math.min(
    Math.abs(center - cue.startTime),
    Math.abs(center - cue.endTime),
  );
}

function selectCueWindow(
  cues: TargetCue[],
  input: AiRevisionInput,
) {
  const sorted = [...cues].sort((left, right) => {
    if (left.orderIndex !== right.orderIndex) return left.orderIndex - right.orderIndex;
    return left.startTime - right.startTime;
  });

  const instructionTarget = parseInstructionTimes(
    cleanString(input.instruction),
  );
  const explicitTime = Boolean(instructionTarget?.explicitTime);
  const selectedCueId = Number(input.selectedCueId);
  const selectedCue = Number.isInteger(selectedCueId)
    ? sorted.find((cue) => cue.id === selectedCueId)
    : null;
  const currentTime = numericSeconds(input.currentTime);

  let matchedBy = instructionTarget?.matchedBy ?? "";
  let startTime = instructionTarget?.startTime;
  let endTime = instructionTarget?.endTime;

  if (startTime === undefined || endTime === undefined) {
    if (selectedCue) {
      startTime = selectedCue.startTime;
      endTime = selectedCue.endTime;
      matchedBy = "selectedCue";
    } else if (currentTime !== null) {
      startTime = currentTime;
      endTime = currentTime;
      matchedBy = "currentTime";
    }
  }

  if (startTime === undefined || endTime === undefined) {
    return {
      matchedBy: "firstWindow",
      explicitTime: false,
      startTime: sorted[0]?.startTime ?? 0,
      endTime: sorted[Math.min(sorted.length - 1, MAX_AI_CUES - 1)]?.endTime ?? 0,
      cues: sorted.slice(0, MAX_AI_CUES),
    };
  }

  const targetCenter = (startTime + endTime) / 2;
  const windowStart = explicitTime
    ? Math.max(0, startTime)
    : Math.max(0, startTime - TARGET_PADDING_SECONDS);
  const windowEnd = explicitTime ? endTime : endTime + TARGET_PADDING_SECONDS;
  let window = sorted.filter(
    (cue) => cue.endTime >= windowStart && cue.startTime <= windowEnd,
  );

  if (window.length === 0) {
    window = [...sorted]
      .sort(
        (left, right) =>
          cueDistance(left, targetCenter) - cueDistance(right, targetCenter),
      )
      .slice(0, 1);
  }

  if (window.length > MAX_AI_CUES) {
    window = explicitTime
      ? window.sort((left, right) => left.startTime - right.startTime).slice(0, MAX_AI_CUES)
      : window
          .sort(
            (left, right) =>
              cueDistance(left, targetCenter) - cueDistance(right, targetCenter),
          )
          .slice(0, MAX_AI_CUES)
          .sort((left, right) => left.startTime - right.startTime);
  }

  return {
    matchedBy,
    explicitTime,
    startTime,
    endTime,
    cues: window,
  };
}

function wantsSplitInstruction(instruction: string) {
  return /\b(pisah|pisahin|pecah|pecahin|split|separate|bagi|sesuai timing|per timing|jangan gabung|jangan digabung)\b/i.test(
    instruction,
  );
}

function splitCueTextForTiming(text: string) {
  const lines = text
    .split(/\r?\n+/)
    .map((line) => cleanString(line))
    .filter(Boolean);
  if (lines.length > 1) return lines;

  const sentenceParts = text
    .split(/(?<=[?!.])\s+/)
    .map((line) => cleanString(line))
    .filter(Boolean);
  return sentenceParts.length > 1 ? sentenceParts : lines;
}

function spreadLinesAcrossCues(lines: string[], cues: TargetCue[]) {
  const cueCount = cues.length;
  if (cueCount === 0 || lines.length === 0) return [];

  const patches: Array<{ cueId: number; index: number; text: string }> = [];
  if (lines.length <= cueCount) {
    return lines.map((text, index) => ({
      cueId: cues[index].id,
      index,
      text,
    }));
  }

  for (let cueIndex = 0; cueIndex < cueCount; cueIndex += 1) {
    const from = Math.floor((cueIndex * lines.length) / cueCount);
    const to = Math.max(
      from + 1,
      Math.floor(((cueIndex + 1) * lines.length) / cueCount),
    );
    const text = lines.slice(from, to).join(" ");
    if (!text) continue;
    patches.push({
      cueId: cues[cueIndex].id,
      index: cueIndex,
      text,
    });
  }
  return patches;
}

function normalizeSplitPatches(
  patches: NormalizedRevisionPatch[],
  targetCues: TargetCue[],
  instruction: string,
): NormalizedRevisionPatch[] {
  if (!wantsSplitInstruction(instruction) || targetCues.length <= 1) {
    return patches;
  }

  const textPatches = patches.filter((patch) => cleanString(patch.text).length > 0);
  if (textPatches.length !== 1) return patches;

  const lines = splitCueTextForTiming(textPatches[0].text ?? "");
  if (lines.length <= 1) return patches;

  const orderedCues = [...targetCues].sort((left, right) => {
    if (left.orderIndex !== right.orderIndex) return left.orderIndex - right.orderIndex;
    return left.startTime - right.startTime;
  });
  const expanded = spreadLinesAcrossCues(lines, orderedCues);
  return expanded.length > 1 ? expanded : patches;
}

async function buildRevisionAudioContext(
  input: AiRevisionInput,
  track: {
    episodeId: number;
    serverUrl: string;
    language: string;
    label: string;
  },
  target: { explicitTime?: boolean; startTime: number; endTime: number },
) {
  if (!target.explicitTime) return null;

  const startTime = Math.max(0, target.startTime);
  const requestedEndTime = Math.max(startTime + 1, target.endTime);
  const requestedDuration = requestedEndTime - startTime;
  if (requestedDuration > MAX_REVISION_AUDIO_SECONDS) {
    throw badRequest(
      `Range audio revisi maksimal ${MAX_REVISION_AUDIO_SECONDS} detik. Pakai mention waktu yang lebih pendek.`,
    );
  }

  const prepared = await prepareAutoGenerateInput({
    episodeId: track.episodeId,
    serverUrl: track.serverUrl,
    language: track.language,
    label: track.label,
    sourceLanguage: cleanString(input.sourceLanguage) || "zh",
    baseUrl: cleanString(input.baseUrl),
  });
  if (startTime >= prepared.durationSeconds) {
    throw badRequest("Waktu mention berada di luar durasi video");
  }
  const endTime = Math.min(prepared.durationSeconds, requestedEndTime);
  const durationSeconds = Math.max(1, endTime - startTime);

  const audioBuffer = await extractAudioChunk(
    prepared.streamUrl,
    startTime,
    durationSeconds,
  );
  if (!audioBuffer) {
    throw badRequest("Potongan audio target revisi kosong atau tidak bisa dibaca");
  }

  const transcript = await transcribeAudioChunk(
    audioBuffer,
    prepared.sourceLanguage,
  );
  if (transcript.length === 0) {
    throw badRequest("OpenAI tidak mendeteksi dialog pada potongan audio itu");
  }

  return {
    startTime,
    endTime: startTime + durationSeconds,
    sourceLanguage: prepared.sourceLanguage,
    segments: transcript.map((segment, index) => ({
      ...segment,
      index,
      startTime: startTime + segment.startTime,
      endTime: startTime + segment.endTime,
    })),
  };
}

export async function reviseSubtitleTrackByInstruction(input: AiRevisionInput) {
  const trackId = Number(input.trackId);
  const instruction = cleanString(input.instruction);
  if (!Number.isInteger(trackId) || trackId <= 0) {
    throw badRequest("trackId tidak valid");
  }
  if (!instruction) throw badRequest("Instruksi AI wajib diisi");

  const track = await prisma.subtitleTrack.findUnique({
    where: { id: trackId },
    include: {
      episode: {
        select: {
          title: true,
          number: true,
          anime: { select: { title: true } },
        },
      },
      cues: { orderBy: [{ orderIndex: "asc" }, { startTime: "asc" }] },
    },
  });

  if (!track) throw notFound("Track subtitle tidak ditemukan");
  if (track.cues.length === 0) throw badRequest("Track belum punya cue subtitle");

  const target = selectCueWindow(track.cues, input);
  const audio = await buildRevisionAudioContext(input, track, target);
  const aiContext = {
    animeTitle: track.episode.anime?.title ?? "",
    episodeTitle: track.episode.title,
    episodeNumber: track.episode.number,
    targetLanguage: track.language,
    targetLabel: track.label,
    ...input.context,
  };
  const memory = await loadSubtitleAiMemory({
    userId: input.userId,
    context: aiContext,
  });
  const aiResult = await reviseCueWindowWithAi({
    instruction,
    textModel: cleanString(input.textModel),
    messages: input.messages,
    context: aiContext,
    audio,
    memory,
    cues: target.cues.map((cue, index) => ({
      cueId: cue.id,
      index,
      startTime: cue.startTime,
      endTime: cue.endTime,
      text: cue.text,
    })),
  });
  const aiPatches = normalizeSplitPatches(
    aiResult.patches,
    target.cues,
    instruction,
  );

  const byCueId = new Map(
    aiPatches
      .filter((patch) => patch.cueId !== undefined)
      .map((patch) => [patch.cueId as number, patch]),
  );
  const byWindowIndex = new Map(
    aiPatches
      .filter((patch) => patch.index !== undefined)
      .map((patch) => [target.cues[patch.index as number]?.id, patch])
      .filter(([cueId]) => cueId !== undefined) as Array<[number, (typeof aiPatches)[number]]>,
  );

  let changedCount = 0;
  const nextCues = track.cues.map((cue) => {
    const patch = byCueId.get(cue.id) ?? byWindowIndex.get(cue.id);
    if (!patch) return cue;

    const startTime =
      patch.startTime !== undefined && Number.isFinite(patch.startTime)
        ? Math.max(0, patch.startTime)
        : cue.startTime;
    const endTimeCandidate =
      patch.endTime !== undefined && Number.isFinite(patch.endTime)
        ? Math.max(0, patch.endTime)
        : cue.endTime;
    const text = patch.text !== undefined ? cleanString(patch.text) : cue.text;
    changedCount += 1;
    return {
      ...cue,
      startTime,
      endTime: Math.max(startTime + 0.1, endTimeCandidate),
      text,
    };
  });

  if (changedCount === 0) {
    throw badRequest("AI tidak mengembalikan patch subtitle yang bisa diterapkan");
  }

  const saved = await saveSubtitleCues(track.id, nextCues);
  await rememberSubtitleAiInstruction({
    userId: input.userId,
    context: aiContext,
    instruction,
    aiMessage: aiResult.message,
  });

  return {
    track: saved,
    message: aiResult.message,
    changedCount,
    target: {
      matchedBy: target.matchedBy,
      startTime: target.startTime,
      endTime: target.endTime,
      cueCount: target.cues.length,
      audioStartTime: audio?.startTime,
      audioEndTime: audio?.endTime,
      audioSegmentCount: audio?.segments.length,
    },
  };
}
