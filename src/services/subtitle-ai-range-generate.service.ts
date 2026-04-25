import {
  extractAudioChunk,
  prepareAutoGenerateInput,
  transcribeAudioChunk,
  translateSegments,
  type AutoGenerateInput,
  type SubtitleAiContext,
  type SubtitleInstructionMessage,
  type TranscriptionSegment,
} from "./subtitle-auto-generate-core.service";
import { badRequest } from "../utils/http-error";

type SubtitleAiRangeGenerateInput = {
  episodeId?: number | string;
  serverUrl?: string;
  rangeStart?: number | string;
  rangeEnd?: number | string;
  language?: string;
  label?: string;
  sourceLanguage?: string;
  transcribeModel?: string;
  textModel?: string;
  baseUrl?: string;
  instructions?: string;
  instructionMessages?: SubtitleInstructionMessage[];
  context?: SubtitleAiContext;
  translate?: boolean;
};

type GeneratedCue = {
  startTime: number;
  endTime: number;
  text: string;
};

export type SubtitleAiRangeGenerateResult = {
  episodeId: number;
  serverUrl: string;
  rangeStart: number;
  rangeEnd: number;
  durationSeconds: number;
  translated: boolean;
  cues: GeneratedCue[];
  segmentCount: number;
  message: string;
};

const MIN_RANGE_SECONDS = 0.15;
const MAX_RANGE_SECONDS = 180;
const MIN_CUE_SECONDS = 0.12;

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numericSeconds(value: unknown) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : null;
}

function normalizeRange(input: SubtitleAiRangeGenerateInput) {
  const start = numericSeconds(input.rangeStart);
  const end = numericSeconds(input.rangeEnd);

  if (start === null || end === null) {
    throw badRequest("rangeStart dan rangeEnd wajib angka");
  }

  const rangeStart = Math.max(0, Math.min(start, end));
  const rangeEnd = Math.max(0, Math.max(start, end));
  const durationSeconds = rangeEnd - rangeStart;

  if (durationSeconds < MIN_RANGE_SECONDS) {
    throw badRequest("Range selection terlalu pendek");
  }
  if (durationSeconds > MAX_RANGE_SECONDS) {
    throw badRequest(`Range selection maksimal ${MAX_RANGE_SECONDS} detik`);
  }

  return { rangeStart, rangeEnd, durationSeconds };
}

function normalizeGeneratedCues(
  segments: TranscriptionSegment[],
  rangeStart: number,
  rangeEnd: number,
) {
  const cues: GeneratedCue[] = [];

  for (const segment of segments) {
    const text = cleanString(segment.text);
    if (!text) continue;

    const startTime = Math.max(rangeStart, rangeStart + segment.startTime);
    const endTime = Math.min(rangeEnd, rangeStart + segment.endTime);
    if (endTime - startTime < MIN_CUE_SECONDS) continue;

    const previous = cues[cues.length - 1];
    const nextCue = {
      startTime,
      endTime: Math.max(startTime + MIN_CUE_SECONDS, endTime),
      text,
    };

    if (previous && nextCue.startTime < previous.endTime) {
      nextCue.startTime = previous.endTime;
      nextCue.endTime = Math.max(
        nextCue.startTime + MIN_CUE_SECONDS,
        nextCue.endTime,
      );
    }

    if (nextCue.endTime > rangeEnd) {
      nextCue.endTime = rangeEnd;
    }
    if (nextCue.endTime - nextCue.startTime < MIN_CUE_SECONDS) continue;
    cues.push(nextCue);
  }

  return cues;
}

export async function generateSubtitleRangeWithAi(
  input: SubtitleAiRangeGenerateInput,
): Promise<SubtitleAiRangeGenerateResult> {
  const { rangeStart, rangeEnd, durationSeconds } = normalizeRange(input);
  const language = cleanString(input.language) || "id";
  const label = cleanString(input.label) || language.toUpperCase();
  const shouldTranslate =
    typeof input.translate === "boolean" ? input.translate : Boolean(language);

  const prepared = await prepareAutoGenerateInput({
    ...(input as AutoGenerateInput),
    language,
    label,
    context: {
      ...(input.context ?? {}),
      currentTime: rangeStart,
    },
  });

  const boundedEnd = Math.min(rangeEnd, prepared.durationSeconds);
  const boundedDuration = Math.max(MIN_RANGE_SECONDS, boundedEnd - rangeStart);
  if (boundedEnd <= rangeStart) {
    throw badRequest("Range selection berada di luar durasi video");
  }

  const audioBuffer = await extractAudioChunk(
    prepared.streamUrl,
    rangeStart,
    boundedDuration,
  );
  if (!audioBuffer) {
    throw badRequest("Audio pada range terpilih tidak ditemukan");
  }

  const transcribed = await transcribeAudioChunk(
    audioBuffer,
    prepared.sourceLanguage,
    prepared.transcribeModel,
  );

  const segments = shouldTranslate
    ? await translateSegments(transcribed, prepared.label, {
        textModel: prepared.textModel,
        instructions: prepared.instructions,
        instructionMessages: prepared.instructionMessages,
        context: prepared.context,
      })
    : transcribed;

  const cues = normalizeGeneratedCues(segments, rangeStart, boundedEnd);

  return {
    episodeId: prepared.episodeId,
    serverUrl: prepared.serverUrl,
    rangeStart,
    rangeEnd: boundedEnd,
    durationSeconds: boundedDuration,
    translated: shouldTranslate,
    cues,
    segmentCount: segments.length,
    message: cues.length
      ? `AI menghasilkan ${cues.length} cue untuk range terpilih`
      : "AI tidak menemukan cue subtitle pada range ini",
  };
}
