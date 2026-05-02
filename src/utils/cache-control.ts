import type { FastifyReply } from "fastify";

type PublicCacheOptions = {
  sMaxAge: number;
  staleWhileRevalidate?: number;
};

export const PUBLIC_CACHE = {
  FAST: { sMaxAge: 60, staleWhileRevalidate: 300 },
  SECTION: { sMaxAge: 300, staleWhileRevalidate: 1800 },
  STATIC_META: { sMaxAge: 3600, staleWhileRevalidate: 86400 },
} as const;

export function setPublicCache(
  reply: FastifyReply,
  options: PublicCacheOptions,
) {
  const stale = options.staleWhileRevalidate ?? options.sMaxAge;

  reply
    .header(
      "Cache-Control",
      `public, max-age=0, s-maxage=${options.sMaxAge}, stale-while-revalidate=${stale}`,
    )
    .header("Vary", "Accept-Encoding");
}
