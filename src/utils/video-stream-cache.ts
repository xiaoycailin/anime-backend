import { createHash } from "node:crypto";
import { getCache, setCache } from "../lib/cache";

const PLAYLIST_TTL_SECONDS = 10 * 60;
const SEGMENT_TTL_SECONDS = 20 * 60;

export const VIDEO_PLAYLIST_CACHE_CONTROL =
  "public, max-age=60, s-maxage=600, stale-while-revalidate=60";

export const VIDEO_SEGMENT_CACHE_CONTROL =
  `public, max-age=${SEGMENT_TTL_SECONDS}, s-maxage=${SEGMENT_TTL_SECONDS}, stale-while-revalidate=60`;

function playlistCacheKey(scope: string, parts: unknown[]) {
  const hash = createHash("sha1")
    .update(JSON.stringify(parts))
    .digest("hex");
  return `video:playlist:${scope}:${hash}`;
}

export async function readVideoPlaylistCache(scope: string, parts: unknown[]) {
  return getCache<string>(playlistCacheKey(scope, parts));
}

export async function writeVideoPlaylistCache(
  scope: string,
  parts: unknown[],
  text: string,
) {
  if (!text.trimStart().startsWith("#EXTM3U")) return false;
  return setCache(playlistCacheKey(scope, parts), text, PLAYLIST_TTL_SECONDS);
}
