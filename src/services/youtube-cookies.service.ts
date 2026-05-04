import fs from "fs/promises";
import path from "path";
import { badRequest } from "../utils/http-error";

const MAX_COOKIE_BYTES = 2 * 1024 * 1024;
const ALLOWED_COOKIE_DOMAINS = [
  "youtube.com",
  "google.com",
  "google.co.id",
  "accounts.google.com",
];

export type YouTubeCookiesStatus = {
  exists: boolean;
  path: string;
  size?: number;
  updatedAt?: string;
};

export function youtubeCookiesPath() {
  return (
    process.env.YT_DLP_COOKIES_FILE?.trim() ||
    path.join(process.cwd(), "data", "youtube-cookies.txt")
  );
}

function assertCookieDomainAllowed(domain: string) {
  const normalized = domain.replace(/^\./, "").toLowerCase();
  if (!ALLOWED_COOKIE_DOMAINS.some((allowed) => normalized.endsWith(allowed))) {
    throw badRequest(`Domain cookies tidak diizinkan: ${domain}`);
  }
}

function validateNetscapeCookies(content: string) {
  if (!content.includes("# Netscape HTTP Cookie File")) {
    throw badRequest("File cookies harus format Netscape dari browser export");
  }

  let cookieLineCount = 0;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const columns = trimmed.split("\t");
    if (columns.length < 7) {
      throw badRequest("Format baris cookies tidak valid");
    }
    assertCookieDomainAllowed(columns[0]);
    cookieLineCount++;
  }

  if (cookieLineCount === 0) {
    throw badRequest("File cookies tidak berisi cookies YouTube/Google");
  }
}

export async function saveYouTubeCookies(buffer: Buffer) {
  if (buffer.length <= 0) throw badRequest("File cookies kosong");
  if (buffer.length > MAX_COOKIE_BYTES) {
    throw badRequest("File cookies maksimal 2MB");
  }

  const content = buffer.toString("utf8").replace(/^\uFEFF/, "");
  validateNetscapeCookies(content);

  const target = youtubeCookiesPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, { mode: 0o600 });
  await fs.chmod(target, 0o600).catch(() => undefined);

  return youtubeCookiesStatus();
}

export async function youtubeCookiesStatus(): Promise<YouTubeCookiesStatus> {
  const target = youtubeCookiesPath();
  try {
    const stat = await fs.stat(target);
    return {
      exists: stat.isFile(),
      path: target,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return { exists: false, path: target };
  }
}
