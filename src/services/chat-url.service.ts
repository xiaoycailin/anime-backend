import { resolveChatPreviewByPath } from "./chat-context.service";
import type { ChatAllowedLink } from "./chat.types";

const URL_PATTERN =
  /\b(?:https?:\/\/[^\s<>"']+|(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/[^\s<>"']*)?)/gi;
const TRAILING_PUNCTUATION = /[.,!?;:)\]}]+$/;
const ALLOWED_HOSTS = new Set(["weebin.site", "www.weebin.site"]);

function normalizeUrl(rawText: string) {
  const hasProtocol = /^https?:\/\//i.test(rawText);
  return hasProtocol ? rawText : `https://${rawText}`;
}

function splitTrailingPunctuation(value: string) {
  const match = value.match(TRAILING_PUNCTUATION);
  if (!match) return { urlText: value, trailing: "" };
  const trailing = match[0];
  return {
    urlText: value.slice(0, -trailing.length),
    trailing,
  };
}

function parseAllowedLink(rawText: string) {
  try {
    const parsed = new URL(normalizeUrl(rawText));
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) return null;
    if (parsed.username || parsed.password) return null;

    const pathname = parsed.pathname || "/";
    return {
      url: `https://weebin.site${pathname}${parsed.search}${parsed.hash}`,
      rawText,
      host: "weebin.site",
      path: `${pathname}${parsed.search}${parsed.hash}`,
    };
  } catch {
    return null;
  }
}

export async function sanitizeChatContent(content: string): Promise<{
  sanitizedContent: string;
  allowedLinks: ChatAllowedLink[];
  blockedUrlsCount: number;
}> {
  const allowedLinks: ChatAllowedLink[] = [];
  let blockedUrlsCount = 0;
  let output = "";
  let cursor = 0;

  const matches = Array.from(content.matchAll(URL_PATTERN));
  for (const match of matches) {
    const rawMatch = match[0];
    const index = match.index ?? 0;
    const { urlText, trailing } = splitTrailingPunctuation(rawMatch);

    output += content.slice(cursor, index);

    const allowed = parseAllowedLink(urlText);
    if (allowed) {
      const preview = await resolveChatPreviewByPath(
        new URL(allowed.url).pathname,
      );
      allowedLinks.push({ ...allowed, preview });
      output += urlText + trailing;
    } else {
      blockedUrlsCount += 1;
      output += "*".repeat(urlText.length) + trailing;
    }

    cursor = index + rawMatch.length;
  }

  output += content.slice(cursor);

  return {
    sanitizedContent: output,
    allowedLinks,
    blockedUrlsCount,
  };
}
