import {
  translateSegments,
  type SubtitleAiContext,
  type SubtitleInstructionMessage,
  type TranscriptionSegment,
} from "./subtitle-auto-generate-core.service";
import { badRequest } from "../utils/http-error";

type SubtitleTranslateTextCueInput = {
  id?: number | string;
  startTime?: number | string;
  endTime?: number | string;
  text?: string;
};

type SubtitleAiTextTranslateInput = {
  language?: string;
  label?: string;
  textModel?: string;
  instructions?: string;
  instructionMessages?: SubtitleInstructionMessage[];
  context?: SubtitleAiContext;
  cues?: SubtitleTranslateTextCueInput[];
};

type TranslatedCue = {
  id?: number;
  startTime: number;
  endTime: number;
  text: string;
};

export type SubtitleAiTextTranslateResult = {
  translated: boolean;
  cueCount: number;
  message: string;
  cues: TranslatedCue[];
};

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numericValue(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeCues(input: SubtitleTranslateTextCueInput[]) {
  const cues = input
    .map((cue, index) => {
      const startTime = numericValue(cue.startTime);
      const endTime = numericValue(cue.endTime);
      const text = cleanString(cue.text);
      const id = numericValue(cue.id);

      if (startTime === null || endTime === null || endTime <= startTime || !text) {
        return null;
      }

      return {
        id: id === null ? undefined : id,
        startTime,
        endTime,
        text,
        index,
      };
    })
    .filter(Boolean) as Array<{
    id?: number;
    startTime: number;
    endTime: number;
    text: string;
    index: number;
  }>;

  if (cues.length === 0) {
    throw badRequest("Cue text untuk translate tidak valid");
  }

  return cues;
}

export async function translateSubtitleCueTextWithAi(
  input: SubtitleAiTextTranslateInput,
): Promise<SubtitleAiTextTranslateResult> {
  const language = cleanString(input.language) || "id";
  const label = cleanString(input.label) || language.toUpperCase();
  const cues = normalizeCues(input.cues ?? []);

  const segments: TranscriptionSegment[] = cues.map((cue) => ({
    index: cue.index,
    startTime: cue.startTime,
    endTime: cue.endTime,
    text: cue.text,
  }));

  const translated = await translateSegments(segments, label, {
    textModel: cleanString(input.textModel) || undefined,
    instructions: cleanString(input.instructions) || undefined,
    instructionMessages: Array.isArray(input.instructionMessages)
      ? input.instructionMessages
      : undefined,
    context: input.context,
  });

  const translatedCues: TranslatedCue[] = translated.map((segment) => {
    const sourceCue = cues[segment.index];
    return {
      id: sourceCue?.id,
      startTime: sourceCue?.startTime ?? segment.startTime,
      endTime: sourceCue?.endTime ?? segment.endTime,
      text: cleanString(segment.text) || sourceCue?.text || "",
    };
  });

  return {
    translated: true,
    cueCount: translatedCues.length,
    message:
      translatedCues.length > 0
        ? `AI menerjemahkan ${translatedCues.length} cue dari teks yang ada`
        : "AI tidak mengubah teks cue",
    cues: translatedCues,
  };
}
