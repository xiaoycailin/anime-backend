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

export type ReelshortChapterApiDetail = {
  playInfo: ReelshortPlayInfoItem[];
  isLocked: boolean | null;
  unlockCost: number | null;
};

const REELSHORT_ORIGIN = "https://www.reelshort.com";
const API_HMAC_KEY = "zj8N6zKEdrK8d1MxwHSvExdgQ868q1yT";
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

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getEnvString(...keys: string[]) {
  for (const key of keys) {
    const value = asString(process.env[key]);
    if (value) return value;
  }

  return null;
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

function decryptApiResponse(rawResponse: string) {
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    Buffer.from(PLAY_INFO_AES_KEY, "utf8"),
    Buffer.from(PLAY_INFO_AES_IV, "utf8"),
  );
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(rawResponse, "base64")),
    decipher.final(),
  ]);
  const compressedBase64 = Buffer.from(decrypted.toString("base64"), "base64").toString("binary");
  const compressedBinary = Buffer.from(compressedBase64, "base64").toString("binary");
  const compressed = Uint8Array.from(compressedBinary, (char) => char.charCodeAt(0));
  return zlib.unzipSync(Buffer.from(compressed)).toString("utf8");
}

export function parseReelshortPlayInfo(rawPlayInfo: unknown): ReelshortPlayInfoItem[] {
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

function signRequest(payload: JsonRecord) {
  const sortedPayload = Object.keys(payload)
    .map((key) => ({
      key,
      value: typeof payload[key] === "object" ? JSON.stringify(payload[key]) : payload[key],
    }))
    .filter(({ value }) => value !== "" && value !== null && value !== undefined && value !== "null")
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ key, value }) => `${key}=${value}`)
    .join("&");

  return crypto.createHmac("sha256", API_HMAC_KEY).update(sortedPayload).digest("hex");
}

function buildSignedHeaders(data: JsonRecord, locale: string) {
  const session = getEnvString("RLS_SESSION", "REELSHORT_SESSION");
  const uid = getEnvString("RLS_UID", "REELSHORT_UID", "RLS_VUID", "REELSHORT_VUID");
  if (!session || !uid) return null;

  const baseHeaders: JsonRecord = {
    apiVersion: "1.0.4",
    channelId: "WEB41001",
    session,
    clientVer: "2.4.00",
    devId:
      getEnvString("RLS_DEVID", "REELSHORT_DEVID") ??
      `${Math.random().toString(36).slice(2, 14)}${Date.now()}`,
    lang: locale || "id",
    ts: Math.floor(Date.now() / 1000),
    uid,
  };

  return {
    ...baseHeaders,
    sign: signRequest({ ...data, ...baseHeaders }),
  };
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
  return parseReelshortPlayInfo(startPlay?.play_info);
}

export async function fetchReelshortChapterApiDetail(input: {
  bookId: string | null;
  chapterId: string | null;
  referer: string;
  locale: string;
}): Promise<ReelshortChapterApiDetail | null> {
  if (!input.bookId || !input.chapterId) return null;

  const data = {
    book_id: input.bookId,
    chapter_id: input.chapterId,
  };
  const signedHeaders = buildSignedHeaders(data, input.locale);
  if (!signedHeaders) return null;

  const response = await fetch(`${REELSHORT_ORIGIN}/api/video/book/getChapterContent`, {
    method: "POST",
    headers: {
      ...API_HEADERS,
      "Content-Type": "application/json",
      Origin: REELSHORT_ORIGIN,
      Referer: input.referer,
      ...signedHeaders,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) return null;

  const rawBody = await response.text();
  const textBody = rawBody.trim().startsWith("{") ? rawBody : decryptApiResponse(rawBody);
  const body = JSON.parse(textBody) as JsonRecord;
  if (body.code !== 0) return null;

  const bodyData = asRecord(body.data);
  return {
    playInfo: parseReelshortPlayInfo(bodyData?.play_info),
    isLocked: asNumber(bodyData?.is_lock) === null ? null : asNumber(bodyData?.is_lock) === 1,
    unlockCost: asNumber(bodyData?.unlock_cost),
  };
}

export async function fetchReelshortChapterPlayInfo(input: {
  bookId: string | null;
  chapterId: string | null;
  referer: string;
  locale: string;
}) {
  return (await fetchReelshortChapterApiDetail(input))?.playInfo ?? [];
}
