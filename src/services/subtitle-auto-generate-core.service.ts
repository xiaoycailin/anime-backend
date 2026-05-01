import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { badRequest } from "../utils/http-error";

export type AutoGenerateInput = {
  episodeId?: number | string;
  serverUrl?: string;
  language?: string;
  label?: string;
  userId?: number | string;
  sourceLanguage?: string;
  transcribeModel?: string;
  textModel?: string;
  baseUrl?: string;
  instructions?: string;
  instructionMessages?: SubtitleInstructionMessage[];
  context?: SubtitleAiContext;
};

export type SubtitleInstructionMessage = {
  role?: "user" | "assistant";
  content?: string;
};

export type SubtitleAiContext = {
  animeTitle?: string;
  episodeTitle?: string;
  episodeNumber?: number | string;
  targetLanguage?: string;
  targetLabel?: string;
  currentTime?: number;
};

export type PreparedAutoGenerateInput = {
  episodeId: number;
  serverUrl: string;
  language: string;
  label: string;
  sourceLanguage: string;
  streamUrl: string;
  durationSeconds: number;
  totalChunks: number;
  chunkSeconds: number;
  durationEstimated: boolean;
  transcribeModel: SubtitleTimedTranscribeModel;
  textModel: string;
  instructions: string;
  instructionMessages: SubtitleInstructionMessage[];
  context: SubtitleAiContext;
};

export type TranscriptionSegment = {
  index: number;
  startTime: number;
  endTime: number;
  text: string;
};

export type SubtitleCueRevisionItem = {
  cueId?: number;
  index: number;
  startTime: number;
  endTime: number;
  text: string;
};

export type SubtitleCueRevisionPatch = {
  cueId?: number;
  index?: number;
  startTime?: number;
  endTime?: number;
  text?: string;
};

export type SubtitleRevisionAudioContext = {
  startTime: number;
  endTime: number;
  sourceLanguage: string;
  segments: TranscriptionSegment[];
};

export type SubtitleAiProjectMemoryContext = {
  notes: string[];
  updatedAt?: string;
};

export type SubtitleCueRevisionResult = {
  message: string;
  patches: SubtitleCueRevisionPatch[];
};

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_DURATION_SECONDS = 30 * 60;
const DEFAULT_CHUNK_SECONDS = 120;
const MIN_CHUNK_SECONDS = 60;
const MAX_CHUNK_SECONDS = 180;
const DURATION_CACHE_TTL = 10 * 60 * 1000;

const durationCache = new Map<
  string,
  { durationSeconds: number; fetchedAt: number }
>();

type SubtitleTimedTranscribeModel = "whisper-1" | "gpt-4o-transcribe-diarize";

const SUPPORTED_SUBTITLE_TEXT_MODELS = new Set([
  "gpt-5.4-mini",
  "gpt-5.4",
  "gpt-4o-mini",
]);
const SUPPORTED_TIMED_TRANSCRIBE_MODELS = new Set<SubtitleTimedTranscribeModel>(
  ["whisper-1", "gpt-4o-transcribe-diarize"],
);
const KNOWN_UNTIMED_TRANSCRIBE_MODELS = new Set([
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
]);

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function compactText(value: unknown, maxLength: number) {
  const text = cleanString(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function cleanInstructionText(value: unknown) {
  return compactText(value, 700);
}

function cleanRequiredInstruction(value: unknown) {
  const instruction = cleanInstructionText(value);
  if (!instruction) throw badRequest("Instruksi AI wajib diisi");
  assertSubtitleInstructionContext(instruction);
  return instruction;
}

function hasTimestampMention(text: string) {
  return (
    /(?:^|[^\d])\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?!\d)/.test(text) ||
    /\b\d{1,3}\s*m(?:enit)?\s*\d{0,2}\s*s?\b/i.test(text) ||
    /\b(?:menit|minute|min|detik|second|sec)\b/i.test(text)
  );
}

function assertSubtitleInstructionContext(instruction: string) {
  const text = instruction.toLowerCase();
  const allowed =
    hasTimestampMention(text) ||
    /\b(subtitle|sub|caption|translate|translation|terjemah|terjemahan|dialog|cue|timing|durasi|duration|sync|sinkron|kalimat|teks|kata|bahasa|indonesia|mandarin|china|jepang|korea|english|tone|style|gaya|formal|santai|natural|kasual|anime|karakter|nama|panggilan|revisi|ubah|ganti|perbaiki|typo|typo|maju|mundur|cepat|lambat|telat|scene|adegan|generate|auto generate)\b/i.test(
      text,
    );

  if (!allowed) {
    throw badRequest(
      "Maaf, aku tidak mengerti maksud kamu. Instruksi cuma bisa untuk translate, auto generate, timing, tone, nama karakter, atau revisi subtitle.",
    );
  }
}

function normalizeInstructionMessages(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .map((raw) => {
      const item: Partial<SubtitleInstructionMessage> =
        raw && typeof raw === "object"
          ? (raw as SubtitleInstructionMessage)
          : {};
      if (item.role === "assistant") return null;
      const content = compactText(item.content, 260);
      if (!content) return null;
      assertSubtitleInstructionContext(content);
      return { role: "user" as const, content };
    })
    .filter(Boolean)
    .slice(-6) as SubtitleInstructionMessage[];
}

function normalizeAiContext(value: unknown): SubtitleAiContext {
  const context = value && typeof value === "object" ? (value as any) : {};
  const currentTime = Number(context.currentTime);
  return {
    animeTitle: compactText(context.animeTitle, 120),
    episodeTitle: compactText(context.episodeTitle, 120),
    episodeNumber:
      typeof context.episodeNumber === "number" ||
      typeof context.episodeNumber === "string"
        ? context.episodeNumber
        : undefined,
    targetLanguage: compactText(context.targetLanguage, 24),
    targetLabel: compactText(context.targetLabel, 80),
    currentTime: Number.isFinite(currentTime) ? currentTime : undefined,
  };
}

function normalizeLanguage(language?: string) {
  const value = language?.trim().toLowerCase();
  if (!value) throw badRequest("Language target wajib diisi");
  if (!/^[a-z0-9-]{2,20}$/i.test(value)) {
    throw badRequest("Language target tidak valid");
  }
  return value;
}

function normalizeBaseUrl(input?: string) {
  const fallback = `http://localhost:${process.env.PORT || 3000}`;
  const value = cleanString(input) || fallback;
  return value.replace(/\/+$/, "");
}

function resolveChunkSeconds() {
  const value = Number(process.env.SUBTITLE_AUTO_CHUNK_SECONDS ?? "");
  if (!Number.isFinite(value)) return DEFAULT_CHUNK_SECONDS;
  return Math.max(MIN_CHUNK_SECONDS, Math.min(MAX_CHUNK_SECONDS, value));
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isDirectMediaUrl(value: string) {
  return /\.(m3u8|mp4|m4v|m4a|mp3|webm|wav)(\?|#|$)/i.test(value);
}

function extractOkruId(url: string) {
  return url.match(/ok\.ru\/video(?:embed)?\/(\d+)/)?.[1] ?? null;
}

function extractAnichinId(url: string) {
  return (
    url.match(/[?&]id=([^&]+)/)?.[1] ??
    url.match(/\/hls\/([^.]+)\.m3u8/)?.[1] ??
    null
  );
}

function extractDailymotionId(url: string) {
  return (
    url.match(/[?&]video=([a-zA-Z0-9]+)/)?.[1] ??
    url.match(/dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/)?.[1] ??
    null
  );
}

function extractRubyId(url: string) {
  return url.match(/rubyvidhub\.com\/embed-([^.]+)\.html/)?.[1] ?? null;
}

function extractSbchillId(url: string) {
  return url.match(/sbchill\.com\/e\/([^.\/?#]+)(?:\.html)?/)?.[1] ?? null;
}

function resolveStreamUrl(serverUrl: string, baseUrl: string) {
  if (isHttpUrl(serverUrl) && isDirectMediaUrl(serverUrl)) return serverUrl;

  if (serverUrl.includes("ok.ru")) {
    const id = extractOkruId(serverUrl);
    if (id) return `${baseUrl}/api/video-stream/okru-stream/playlist/${id}`;
  }

  if (serverUrl.includes("anichin.stream")) {
    const id = extractAnichinId(serverUrl);
    if (id) return `${baseUrl}/api/video-stream/ac-stream/playlist/${id}`;
  }

  if (serverUrl.includes("dailymotion.com")) {
    const id = extractDailymotionId(serverUrl);
    if (id) return `${baseUrl}/api/video-stream/dm-stream/playlist?v=${id}`;
  }

  if (serverUrl.includes("rubyvidhub.com")) {
    const id = extractRubyId(serverUrl);
    if (id) return `${baseUrl}/api/video-stream/ruby-stream/playlist/${id}`;
  }

  if (serverUrl.includes("sbchill.com")) {
    const id = extractSbchillId(serverUrl);
    if (id)
      return `${baseUrl}/api/video-stream/okru-stream/playlist/${id}?host=sbchill.com`;
  }

  return null;
}

function parseVariantBandwidth(attributes: string) {
  const value = attributes.match(/(?:^|,)BANDWIDTH=(\d+)/i)?.[1];
  return value ? Number(value) : Number.POSITIVE_INFINITY;
}

function parseVariantHeight(attributes: string) {
  const match = attributes.match(/(?:^|,)RESOLUTION=\d+x(\d+)/i)?.[1];
  return match ? Number(match) : Number.POSITIVE_INFINITY;
}

async function resolveLightestStreamUrl(inputUrl: string) {
  if (!inputUrl.toLowerCase().includes(".m3u8")) return inputUrl;

  try {
    const response = await fetch(inputUrl, {
      headers: {
        accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) return inputUrl;

    const manifest = await response.text();
    if (!manifest.includes("#EXT-X-STREAM-INF")) return inputUrl;

    const lines = manifest
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const variants: Array<{
      url: string;
      bandwidth: number;
      height: number;
    }> = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

      let nextUrl = "";
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (!lines[cursor].startsWith("#")) {
          nextUrl = lines[cursor];
          break;
        }
      }
      if (!nextUrl) continue;

      variants.push({
        url: new URL(nextUrl, inputUrl).toString(),
        bandwidth: parseVariantBandwidth(line),
        height: parseVariantHeight(line),
      });
    }

    if (variants.length === 0) return inputUrl;

    variants.sort((left, right) => {
      if (left.bandwidth !== right.bandwidth) {
        return left.bandwidth - right.bandwidth;
      }
      return left.height - right.height;
    });

    return variants[0]?.url ?? inputUrl;
  } catch {
    return inputUrl;
  }
}

function ffmpegExecutable() {
  const executable = typeof ffmpegPath === "string" ? ffmpegPath : null;
  if (!executable) throw badRequest("ffmpeg tidak tersedia di server");
  return executable;
}

async function runFfmpeg(args: string[]) {
  const stderrChunks: Buffer[] = [];
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(ffmpegExecutable(), args, { windowsHide: true });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  return {
    exitCode,
    stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
  };
}

async function probeDurationSeconds(streamUrl: string) {
  const cached = durationCache.get(streamUrl);
  if (cached && Date.now() - cached.fetchedAt < DURATION_CACHE_TTL) {
    return cached.durationSeconds;
  }

  const { stderr } = await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "info",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_on_network_error",
    "1",
    "-reconnect_delay_max",
    "5",
    "-i",
    streamUrl,
    "-t",
    "0",
    "-f",
    "null",
    "-",
  ]).catch(() => ({ exitCode: 1, stderr: "" }));

  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const durationSeconds = hours * 3600 + minutes * 60 + seconds;

  if (durationSeconds > 0) {
    durationCache.set(streamUrl, { durationSeconds, fetchedAt: Date.now() });
  }
  return durationSeconds || null;
}

function requireOpenAiKey() {
  const value = cleanString(process.env.OPENAI_API_KEY);
  if (!value) {
    throw badRequest(
      "OPENAI_API_KEY belum diatur di backend, auto subtitle belum bisa dipakai",
    );
  }
  return value;
}

function resolveTranscribeModel(
  requested?: unknown,
): SubtitleTimedTranscribeModel {
  const model = cleanString(requested);
  if (model) {
    if (
      SUPPORTED_TIMED_TRANSCRIBE_MODELS.has(
        model as SubtitleTimedTranscribeModel,
      )
    ) {
      return model as SubtitleTimedTranscribeModel;
    }
    if (KNOWN_UNTIMED_TRANSCRIBE_MODELS.has(model)) {
      throw badRequest(
        "Model transcribe itu belum bisa dipakai di editor subtitle ini karena tidak mengembalikan segment timestamp. Pakai whisper-1 atau gpt-4o-transcribe-diarize.",
      );
    }
    throw badRequest(
      `Model transcribe tidak didukung. Pilih salah satu: ${[
        ...SUPPORTED_TIMED_TRANSCRIBE_MODELS,
      ].join(", ")}`,
    );
  }

  const configured = cleanString(process.env.OPENAI_TRANSCRIBE_MODEL);
  if (
    SUPPORTED_TIMED_TRANSCRIBE_MODELS.has(
      configured as SubtitleTimedTranscribeModel,
    )
  ) {
    return configured as SubtitleTimedTranscribeModel;
  }
  return "whisper-1";
}

function resolveTextModel(requested?: unknown) {
  const model = cleanString(requested);
  if (model) {
    if (!SUPPORTED_SUBTITLE_TEXT_MODELS.has(model)) {
      throw badRequest(
        `Model AI tidak didukung untuk subtitle. Pilih salah satu: ${[
          ...SUPPORTED_SUBTITLE_TEXT_MODELS,
        ].join(", ")}`,
      );
    }
    return model;
  }
  return cleanString(process.env.OPENAI_TEXT_MODEL) || "gpt-5.4-mini";
}

function normalizeSegments(payload: {
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    speaker?: string;
  }>;
}) {
  return (payload.segments ?? [])
    .map((segment, index) => {
      const startTime = Number(segment.start ?? 0);
      const endCandidate = Number(segment.end ?? segment.start ?? 0);
      return {
        index,
        startTime,
        endTime: Math.max(endCandidate, startTime + 0.1),
        text: cleanString(segment.text),
      };
    })
    .filter((segment) => segment.text.length > 0);
}

export async function prepareAutoGenerateInput(
  input: AutoGenerateInput,
): Promise<PreparedAutoGenerateInput> {
  const episodeId = Number(input.episodeId);
  const serverUrl = cleanString(input.serverUrl);
  const language = normalizeLanguage(input.language);
  const label = cleanString(input.label) || language.toUpperCase();
  const sourceLanguage =
    cleanString(input.sourceLanguage).toLowerCase() || "zh";
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const instructions = cleanInstructionText(input.instructions);
  if (instructions) assertSubtitleInstructionContext(instructions);
  const instructionMessages = normalizeInstructionMessages(
    input.instructionMessages,
  );
  const context = normalizeAiContext(input.context);
  const transcribeModel = resolveTranscribeModel(input.transcribeModel);
  const textModel = resolveTextModel(input.textModel);

  if (!Number.isInteger(episodeId) || episodeId <= 0) {
    throw badRequest("episodeId tidak valid");
  }
  if (!serverUrl) throw badRequest("serverUrl wajib diisi");

  const resolvedStreamUrl = resolveStreamUrl(serverUrl, baseUrl);
  const streamUrl = resolvedStreamUrl
    ? await resolveLightestStreamUrl(resolvedStreamUrl)
    : "";
  if (!streamUrl) {
    throw badRequest(
      "Server ini belum didukung untuk auto subtitle. Pastikan server memiliki URL stream langsung atau provider yang didukung.",
    );
  }

  const probedDuration = await probeDurationSeconds(streamUrl);
  const durationEstimated = !probedDuration || probedDuration <= 0;
  const durationSeconds =
    probedDuration && probedDuration > 0
      ? probedDuration
      : DEFAULT_DURATION_SECONDS;
  const chunkSeconds = resolveChunkSeconds();

  return {
    episodeId,
    serverUrl,
    language,
    label,
    sourceLanguage,
    streamUrl,
    durationSeconds,
    totalChunks: Math.max(1, Math.ceil(durationSeconds / chunkSeconds)),
    chunkSeconds,
    durationEstimated,
    transcribeModel,
    textModel,
    instructions,
    instructionMessages,
    context,
  };
}

export async function extractAudioChunk(
  streamUrl: string,
  startTime: number,
  durationSeconds: number,
) {
  const outputPath = path.join(
    tmpdir(),
    `subtitle-auto-${randomUUID()}-${Math.floor(startTime)}.mp3`,
  );

  try {
    const { exitCode, stderr } = await runFfmpeg([
      "-y",
      "-loglevel",
      "error",
      "-ss",
      String(Math.max(0, startTime)),
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_on_network_error",
      "1",
      "-reconnect_delay_max",
      "5",
      "-i",
      streamUrl,
      "-t",
      String(Math.max(1, durationSeconds)),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "24k",
      "-acodec",
      "libmp3lame",
      outputPath,
    ]);

    if (exitCode !== 0) {
      throw badRequest(
        stderr
          ? `Gagal ekstrak audio dari video: ${stderr}`
          : "Gagal ekstrak audio dari video",
      );
    }

    const audioBuffer = await fs.readFile(outputPath).catch(() => null);
    if (!audioBuffer || audioBuffer.byteLength === 0) return null;
    if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
      throw badRequest("Potongan audio terlalu besar untuk diproses");
    }
    return audioBuffer;
  } finally {
    await fs.unlink(outputPath).catch(() => {});
  }
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const match = trimmed.match(/\{[\s\S]*\}$/);
  if (match) return match[0];

  throw badRequest("Respons terjemahan AI bukan JSON yang valid");
}

export async function transcribeAudioChunk(
  audioBuffer: Buffer,
  sourceLanguage: string,
  requestedModel?: string,
) {
  const model = resolveTranscribeModel(requestedModel);
  const form = new FormData();
  form.set("model", model);
  form.set("language", sourceLanguage);
  if (model === "gpt-4o-transcribe-diarize") {
    form.set("response_format", "diarized_json");
    form.set("chunking_strategy", "auto");
  } else {
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.set(
      "prompt",
      "This is Mandarin Chinese dialogue from an anime episode. Preserve names and timing naturally.",
    );
  }
  form.set(
    "file",
    new Blob([new Uint8Array(audioBuffer)], { type: "audio/mpeg" }),
    "subtitle-source.mp3",
  );

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${requireOpenAiKey()}` },
      body: form,
    },
  );

  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
    segments?: Array<{
      start?: number;
      end?: number;
      text?: string;
      speaker?: string;
    }>;
  } | null;

  if (!response.ok) {
    throw badRequest(
      payload?.error?.message ?? "Gagal transkripsi audio dengan OpenAI",
    );
  }

  return normalizeSegments(payload ?? {});
}

function translationUserPayload(
  segments: TranscriptionSegment[],
  targetLabel: string,
  options?: {
    textModel?: string;
    instructions?: string;
    instructionMessages?: SubtitleInstructionMessage[];
    context?: SubtitleAiContext;
  },
) {
  return {
    task: `Translate every subtitle item into ${targetLabel} using casual Indonesian anime subtitle style (hard sub). Use conversational tone, avoid formal language, and keep it short and natural. Do not merge or split items.`,
    context: normalizeAiContext(options?.context),
    userInstructions: cleanInstructionText(options?.instructions) || null,
    recentInstructionChat: normalizeInstructionMessages(
      options?.instructionMessages,
    ),
    items: segments.map((segment) => ({
      index: segment.index,
      text: segment.text,
    })),
  };
}

async function translateBatch(
  segments: TranscriptionSegment[],
  targetLabel: string,
  options?: {
    textModel?: string;
    instructions?: string;
    instructionMessages?: SubtitleInstructionMessage[];
    context?: SubtitleAiContext;
  },
) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireOpenAiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: resolveTextModel(options?.textModel),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You translate subtitle cue text from Mandarin Chinese into Indonesian anime subtitle style (hard sub). Use casual, natural Indonesian commonly used in anime subtitles. Replace formal words with casual ones (e.g., 'saya' → 'aku', 'kamu' → 'kau' or 'kamu' depending on tone). Preserve character names. Keep sentences short, expressive, and subtitle-friendly. Do not sound formal or stiff. Keep the item count and indices exactly the same. Return only JSON.",
        },
        {
          role: "system",
          content:
            "When userInstructions or recentInstructionChat are present, apply only relevant tone, name, term, context, or correction instructions. Do not add extra cues. Return only JSON.",
        },
        {
          role: "user",
          content: JSON.stringify(
            translationUserPayload(segments, targetLabel, options),
          ),
        },
      ],
    }),
  });

  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | null } }>;
  } | null;

  if (!response.ok) {
    throw badRequest(
      payload?.error?.message ?? "Gagal menerjemahkan subtitle dengan OpenAI",
    );
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw badRequest("Respons terjemahan AI kosong");

  const parsed = JSON.parse(extractJsonObject(content)) as {
    items?: Array<{ index?: number; text?: string }>;
  };

  const translated = new Map<number, string>();
  for (const item of parsed.items ?? []) {
    const index = Number(item.index);
    if (!Number.isInteger(index)) continue;
    translated.set(index, cleanString(item.text));
  }

  const missing = segments.find((segment) => !translated.has(segment.index));
  if (missing) throw badRequest("Respons terjemahan AI tidak lengkap");

  return segments.map((segment) => ({
    ...segment,
    text: translated.get(segment.index) || segment.text,
  }));
}

export async function translateSegments(
  segments: TranscriptionSegment[],
  targetLabel: string,
  options?: {
    textModel?: string;
    instructions?: string;
    instructionMessages?: SubtitleInstructionMessage[];
    context?: SubtitleAiContext;
  },
) {
  if (segments.length === 0) return [];

  const translated: TranscriptionSegment[] = [];
  for (let offset = 0; offset < segments.length; offset += 80) {
    translated.push(
      ...(await translateBatch(
        segments.slice(offset, offset + 80),
        targetLabel,
        options,
      )),
    );
  }
  return translated;
}

export async function reviseCueWindowWithAi(input: {
  instruction: string;
  cues: SubtitleCueRevisionItem[];
  textModel?: string;
  messages?: SubtitleInstructionMessage[];
  context?: SubtitleAiContext;
  audio?: SubtitleRevisionAudioContext | null;
  memory?: SubtitleAiProjectMemoryContext | null;
}) {
  const instruction = cleanRequiredInstruction(input.instruction);
  const cues = input.cues
    .map((cue) => ({
      cueId: cue.cueId,
      index: cue.index,
      startTime: Number(cue.startTime),
      endTime: Number(cue.endTime),
      text: cleanString(cue.text),
    }))
    .filter(
      (cue) =>
        Number.isInteger(cue.index) &&
        Number.isFinite(cue.startTime) &&
        Number.isFinite(cue.endTime) &&
        cue.text.length > 0,
    );

  if (cues.length === 0) throw badRequest("Cue target revisi tidak ditemukan");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireOpenAiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: resolveTextModel(input.textModel),
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You revise a small window of Indonesian anime subtitle cues. Apply the user's instruction only to relevant cues. If audioTranscript is present, use it as source evidence for what is actually spoken, then correct the Indonesian subtitle text and timing when needed. Keep cue count stable. Never delete dialogue. Never merge several dialogue turns into one cue. Each cue text must fit its own timing window. If the user asks to split/pisah/pecah, preserve good wording and distribute it across the existing cue timings instead of rewriting into one long cue. Preserve timing unless the instruction, transcript, or audio range clearly requires timing correction. Keep text short and subtitle-friendly. Return only JSON with message and patches.",
        },
        {
          role: "user",
          content: JSON.stringify({
            instruction,
            context: normalizeAiContext(input.context),
            recentInstructionChat: normalizeInstructionMessages(input.messages),
            projectMemory: input.memory
              ? {
                  updatedAt: input.memory.updatedAt,
                  notes: input.memory.notes.map((note) =>
                    compactText(note, 520),
                  ),
                }
              : null,
            audioTranscript: input.audio
              ? {
                  startTime: input.audio.startTime,
                  endTime: input.audio.endTime,
                  sourceLanguage: input.audio.sourceLanguage,
                  segments: input.audio.segments.map((segment) => ({
                    index: segment.index,
                    startTime: segment.startTime,
                    endTime: segment.endTime,
                    text: segment.text,
                  })),
                }
              : null,
            cues: cues.map((cue) => ({
              cueId: cue.cueId,
              index: cue.index,
              startTime: cue.startTime,
              endTime: cue.endTime,
              text: cue.text,
            })),
            responseShape: {
              message: "short Indonesian summary",
              patches:
                "array of changed cues only, one patch per affected cue. Never return empty text. Do not combine multiple speaker turns into one patch.",
            },
          }),
        },
      ],
    }),
  });

  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | null } }>;
  } | null;

  if (!response.ok) {
    throw badRequest(
      payload?.error?.message ?? "Gagal merevisi subtitle dengan OpenAI",
    );
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw badRequest("Respons revisi AI kosong");

  const parsed = JSON.parse(extractJsonObject(content)) as {
    message?: string;
    patches?: SubtitleCueRevisionPatch[];
  };

  const allowedIds = new Set(cues.map((cue) => cue.cueId).filter(Boolean));
  const allowedIndexes = new Set(cues.map((cue) => cue.index));
  const patches = (parsed.patches ?? [])
    .map((patch) => {
      const cueId = Number(patch.cueId);
      const index = Number(patch.index);
      const text =
        patch.text === undefined ? undefined : cleanString(patch.text);
      const startTime = Number(patch.startTime);
      const endTime = Number(patch.endTime);
      return {
        ...(Number.isInteger(cueId) && allowedIds.has(cueId) ? { cueId } : {}),
        ...(Number.isInteger(index) && allowedIndexes.has(index)
          ? { index }
          : {}),
        ...(text !== undefined ? { text } : {}),
        ...(Number.isFinite(startTime) ? { startTime } : {}),
        ...(Number.isFinite(endTime) ? { endTime } : {}),
      };
    })
    .filter(
      (patch) =>
        (patch.cueId !== undefined || patch.index !== undefined) &&
        ((patch.text !== undefined && patch.text.length > 0) ||
          patch.startTime !== undefined ||
          patch.endTime !== undefined),
    );

  return {
    message: compactText(parsed.message, 180) || "Revisi subtitle selesai",
    patches,
  } satisfies SubtitleCueRevisionResult;
}
