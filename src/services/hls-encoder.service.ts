import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const FFMPEG_BIN: string = (ffmpegStatic as unknown as string) || "ffmpeg";
const FFPROBE_BIN: string =
  (ffprobeStatic as unknown as { path: string })?.path || "ffprobe";

export const RESOLUTION_LADDER: Record<
  number,
  { width: number; height: number; videoBitrate: string; audioBitrate: string; maxrate: string; bufsize: string }
> = {
  144: {
    width: 256,
    height: 144,
    videoBitrate: "200k",
    audioBitrate: "64k",
    maxrate: "240k",
    bufsize: "400k",
  },
  240: {
    width: 426,
    height: 240,
    videoBitrate: "400k",
    audioBitrate: "96k",
    maxrate: "480k",
    bufsize: "800k",
  },
  480: {
    width: 854,
    height: 480,
    videoBitrate: "1000k",
    audioBitrate: "128k",
    maxrate: "1200k",
    bufsize: "2000k",
  },
  720: {
    width: 1280,
    height: 720,
    videoBitrate: "2500k",
    audioBitrate: "128k",
    maxrate: "3000k",
    bufsize: "5000k",
  },
  1080: {
    width: 1920,
    height: 1080,
    videoBitrate: "5000k",
    audioBitrate: "192k",
    maxrate: "6000k",
    bufsize: "10000k",
  },
};

export type ProbeInfo = {
  durationSec: number;
  width: number;
  height: number;
  videoCodec: string | null;
  audioCodec: string | null;
};

export async function probeVideo(filePath: string): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE_BIN, [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=index,codec_type,codec_name,width,height",
      "-of",
      "json",
      filePath,
    ]);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr || `exit ${code}`}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        const duration = Number(parsed?.format?.duration ?? 0);
        const streams: any[] = Array.isArray(parsed?.streams)
          ? parsed.streams
          : [];
        const video = streams.find((s) => s.codec_type === "video");
        const audio = streams.find((s) => s.codec_type === "audio");

        resolve({
          durationSec: Number.isFinite(duration) ? duration : 0,
          width: Number(video?.width ?? 0),
          height: Number(video?.height ?? 0),
          videoCodec: video?.codec_name ?? null,
          audioCodec: audio?.codec_name ?? null,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export type EncodeOptions = {
  inputPath: string;
  outputDir: string;
  resolution: number;
  segmentDuration?: number;
  streamCopy?: boolean;
  onProgress?: (progress: number) => void;
  durationSec?: number;
};

export async function encodeToHls(options: EncodeOptions): Promise<{
  playlistPath: string;
  segmentFiles: string[];
}> {
  const ladder = RESOLUTION_LADDER[options.resolution];
  if (!ladder) {
    throw new Error(`Unsupported resolution: ${options.resolution}`);
  }

  await fs.mkdir(options.outputDir, { recursive: true });

  const segmentDuration = options.segmentDuration ?? 10;
  const playlistPath = path.join(options.outputDir, "index.m3u8");
  const segmentPattern = path.join(options.outputDir, "segment_%05d.ts");

  const args: string[] = [
    "-y",
    "-i",
    options.inputPath,
    "-progress",
    "pipe:1",
    "-loglevel",
    "error",
  ];

  if (options.streamCopy) {
    args.push(
      "-c:v",
      "copy",
      "-c:a",
      "copy",
    );
  } else {
    args.push(
      "-vf",
      `scale=w=${ladder.width}:h=${ladder.height}:force_original_aspect_ratio=decrease,pad=${ladder.width}:${ladder.height}:(ow-iw)/2:(oh-ih)/2`,
      "-c:v",
      "libx264",
      "-profile:v",
      "main",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-b:v",
      ladder.videoBitrate,
      "-maxrate",
      ladder.maxrate,
      "-bufsize",
      ladder.bufsize,
      "-pix_fmt",
      "yuv420p",
      "-g",
      String(segmentDuration * 2),
      "-keyint_min",
      String(segmentDuration * 2),
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-b:a",
      ladder.audioBitrate,
      "-ac",
      "2",
    );
  }

  args.push(
    "-hls_time",
    String(segmentDuration),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    segmentPattern,
    "-f",
    "hls",
    playlistPath,
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args);
    let stderrBuf = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (!options.onProgress) return;

      const matches = text.matchAll(/out_time_ms=(\d+)/g);
      for (const match of matches) {
        const outMs = Number(match[1]);
        if (!Number.isFinite(outMs) || !options.durationSec) continue;
        const seconds = outMs / 1_000_000;
        const ratio = Math.min(1, seconds / options.durationSec);
        options.onProgress(ratio);
      }

      if (text.includes("progress=end")) {
        options.onProgress(1);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `ffmpeg encode failed (code=${code}): ${stderrBuf.slice(-2000)}`,
          ),
        );
      }
    });
  });

  const entries = await fs.readdir(options.outputDir);
  const segmentFiles = entries
    .filter((entry) => entry.endsWith(".ts"))
    .sort()
    .map((entry) => path.join(options.outputDir, entry));

  return { playlistPath, segmentFiles };
}

export function buildMasterPlaylist(input: {
  resolutions: number[];
}): string {
  const lines: string[] = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const resolution of input.resolutions) {
    const ladder = RESOLUTION_LADDER[resolution];
    if (!ladder) continue;
    const bandwidth =
      Number.parseInt(ladder.videoBitrate.replace(/[^\d]/g, ""), 10) * 1000 +
      Number.parseInt(ladder.audioBitrate.replace(/[^\d]/g, ""), 10) * 1000;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${ladder.width}x${ladder.height}`,
      `${resolution}p/index.m3u8`,
    );
  }
  return lines.join("\n") + "\n";
}

export function resolutionsToProcess(
  initialResolution: number,
): number[] {
  const ladders = [144, 240, 480, 720, 1080];
  return ladders.filter((res) => res <= initialResolution);
}
