import crypto from "crypto";
import zlib from "zlib";

type JsonRecord = Record<string, unknown>;

export type ReelshortPlayInfoItem = {
  PlayURL?: unknown;
  Encode?: unknown;
  Dpi?: unknown;
  Bitrate?: unknown;
  MultiBit?: unknown;
};

const REELSHORT_ORIGIN = "https://www.reelshort.com";
const PLAY_INFO_AES_KEY = "VvRSNGFynLBW7aCP";
const PLAY_INFO_AES_IV = "gLn8sxqpzyNjehDP";

const API_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
};

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decryptPlayInfo(rawPlayInfo: string) {
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    Buffer.from(PLAY_INFO_AES_KEY, "utf8"),
    Buffer.from(PLAY_INFO_AES_IV, "utf8"),
  );
  const compressedBase64 = Buffer.concat([
    decipher.update(Buffer.from(rawPlayInfo, "base64")),
    decipher.final(),
  ]).toString("utf8");

  return zlib.unzipSync(Buffer.from(compressedBase64, "base64")).toString("utf8");
}

function parsePlayInfo(rawPlayInfo: unknown): ReelshortPlayInfoItem[] {
  const encrypted = asString(rawPlayInfo);
  if (!encrypted) return [];

  try {
    const parsed = JSON.parse(decryptPlayInfo(encrypted));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is ReelshortPlayInfoItem => Boolean(asRecord(item)))
      : [];
  } catch {
    return [];
  }
}

export async function fetchReelshortPlayInfo(bookId: string | null) {
  if (!bookId) return [];

  const url = new URL("/api/video/book/getBookInfo", REELSHORT_ORIGIN);
  url.searchParams.set("book_id", bookId);

  const response = await fetch(url, { headers: API_HEADERS });
  if (!response.ok) return [];

  const body = (await response.json().catch(() => null)) as JsonRecord | null;
  const data = asRecord(body?.data);
  const startPlay = asRecord(data?.start_play);
  return parsePlayInfo(startPlay?.play_info);
}
