import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { createSubtitleTrack, parseSubtitleCues, saveSubtitleCues } from "./subtitle.service";
import { youtubeCookiesStatus } from "./youtube-cookies.service";

const execFileAsync = promisify(execFile);
const DEFAULT_LANGUAGES = ["id", "en", "ms"];
const YT_DLP_TIMEOUT_MS = 60_000;
const YT_DLP_COOLDOWN_MS = 60 * 60 * 1000;

const cooldownByVideo = new Map<string, number>();

type ImportInput = {
  episodeId: number;
  serverUrl: string;
  languages?: string[];
};

type ImportedTrack = {
  language: string;
  label: string;
  cueCount: number;
};

type ImportResult = {
  attempted: boolean;
  available: boolean;
  imported: ImportedTrack[];
  message?: string;
};

function isYouTubeUrl(value: string) {
  return /(?:youtube\.com\/watch|youtu\.be\/)/i.test(value);
}

function extractYouTubeVideoId(value: string) {
  const match = value.match(
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  );
  return match?.[1] ?? "";
}

function ytDlpCommand() {
  const configured = process.env.YT_DLP_PATH?.trim();
  if (configured) return { file: configured, args: [] };
  return { file: "python", args: ["-m", "yt_dlp"] };
}

function ytDlpJsRuntimeArgs() {
  const runtime = process.env.YT_DLP_JS_RUNTIME?.trim();
  if (runtime) return ["--js-runtimes", runtime];

  const nodePath = process.env.YT_DLP_NODE_PATH?.trim() || process.execPath;
  return nodePath ? ["--js-runtimes", `node:${nodePath}`] : [];
}

function cleanLanguage(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9-]/g, "");
}

function configuredLanguages() {
  return (process.env.YOUTUBE_SUBTITLE_LANGS ?? "")
    .split(/[,\s]+/)
    .map(cleanLanguage)
    .filter(Boolean);
}

function subtitleLabel(language: string) {
  const labels: Record<string, string> = {
    id: "Indonesia",
    en: "Inggris",
    ar: "Arab",
    ja: "Jepang",
    ko: "Korea",
    ms: "Melayu",
    es: "Spanyol",
    th: "Thai",
    zh: "Tionghoa",
    "zh-TW": "Tionghoa (Taiwan)",
    vi: "Vietnam",
  };
  return labels[language] ?? language.toUpperCase();
}

async function runYtDlp(url: string, tempDir: string, languages: string[]) {
  const command = ytDlpCommand();
  const cookies = await youtubeCookiesStatus();
  const cookieArgs = cookies.exists ? ["--cookies", cookies.path] : [];

  await execFileAsync(
    command.file,
    [
      ...command.args,
      ...cookieArgs,
      ...ytDlpJsRuntimeArgs(),
      "--ignore-no-formats-error",
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-format",
      "vtt",
      "--sub-langs",
      languages.join(","),
      "--paths",
      tempDir,
      "-o",
      "subtitle.%(ext)s",
      url,
    ],
    {
      timeout: YT_DLP_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
}

function languageFromFileName(fileName: string) {
  const match = fileName.match(/^subtitle\.([^.]+)\.vtt$/i);
  return cleanLanguage(match?.[1] ?? "");
}

export async function importYouTubeSubtitlesWithYtDlp(
  input: ImportInput,
): Promise<ImportResult> {
  if (!isYouTubeUrl(input.serverUrl)) {
    return { attempted: false, available: false, imported: [] };
  }

  const videoId = extractYouTubeVideoId(input.serverUrl);
  const cooldownUntil = videoId ? cooldownByVideo.get(videoId) ?? 0 : 0;
  if (cooldownUntil > Date.now()) {
    const minutes = Math.ceil((cooldownUntil - Date.now()) / 60_000);
    return {
      attempted: true,
      available: false,
      imported: [],
      message: `yt-dlp cooldown aktif, coba lagi sekitar ${minutes} menit`,
    };
  }

  const requestedLanguages =
    input.languages?.length ? input.languages : configuredLanguages();
  const languages = (requestedLanguages.length ? requestedLanguages : DEFAULT_LANGUAGES)
    .map(cleanLanguage)
    .filter(Boolean);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "weebin-yt-subs-"));

  try {
    await runYtDlp(input.serverUrl, tempDir, languages);
    const files = (await fs.readdir(tempDir)).filter((file) => file.endsWith(".vtt"));
    const imported: ImportedTrack[] = [];

    for (const file of files) {
      const language = languageFromFileName(file);
      if (!language) continue;

      const content = await fs.readFile(path.join(tempDir, file), "utf8");
      const cues = parseSubtitleCues(content);
      if (cues.length === 0) continue;

      const track = await createSubtitleTrack({
        episodeId: input.episodeId,
        serverUrl: input.serverUrl,
        language,
        label: subtitleLabel(language),
      });
      const saved = await saveSubtitleCues(track.id, cues);
      imported.push({
        language,
        label: saved.label,
        cueCount: saved.cues.length,
      });
    }

    return {
      attempted: true,
      available: true,
      imported,
      message:
        imported.length > 0
          ? `${imported.length} subtitle YouTube diimport`
          : "yt-dlp jalan, tapi tidak ada cue subtitle yang valid",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "yt-dlp gagal dijalankan";
    if (videoId && /(429|too many requests|not a bot|confirm)/i.test(message)) {
      cooldownByVideo.set(videoId, Date.now() + YT_DLP_COOLDOWN_MS);
    }
    return {
      attempted: true,
      available: false,
      imported: [],
      message,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
