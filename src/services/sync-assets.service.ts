import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { CacheInvalidator } from "../lib/cache";
import { getR2PublicUrl, r2ObjectExists, uploadBufferToR2 } from "../utils/r2";

const CDN_PREFIX = "https://cdn-static.weebin.site";
const MAX_ASSETS = 100;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROCESSED_TTL_MS = 24 * 60 * 60 * 1000;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

const ALLOWED_ANIME_FIELDS = new Set(["thumbnail", "bigCover"]);

type AssetContext = "anime" | "episode";
type AssetField = "thumbnail" | "bigCover";

export type SyncAssetInput = {
  url: string;
  context: AssetContext;
  id: string;
  field?: AssetField;
};

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string, error?: unknown) => void;
};

type DecodedAsset = {
  url: string;
  context: AssetContext;
  id: number;
  field: AssetField;
  sourceHash: string;
  ext: string;
  key: string;
  cdnUrl: string;
};

type PreparedAsset = DecodedAsset & {
  uploaded: boolean;
};

let isProcessing = false;
const processedUntil = new Map<string, number>();

function decodeHex(value: string) {
  if (!/^[a-fA-F0-9]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error("Invalid hex URL");
  }
  return Buffer.from(value, "hex").toString("utf8");
}

function isCdnUrl(url: string) {
  return url.trim().startsWith(CDN_PREFIX);
}

function sourceHash(url: string) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 24);
}

function extFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/);
    if (match?.[1]) return match[1] === "jpeg" ? "jpg" : match[1];
  } catch {
    return "jpg";
  }
  return "jpg";
}

function r2ImageKey(asset: {
  context: AssetContext;
  id: number;
  field: AssetField;
  sourceHash: string;
  ext: string;
}) {
  return `images/${asset.context}/${asset.id}/${asset.field}/${asset.sourceHash}.${asset.ext}`;
}

function parseAsset(raw: SyncAssetInput): DecodedAsset | null {
  if (raw.context !== "anime" && raw.context !== "episode") return null;

  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) return null;

  const field = raw.context === "episode" ? "thumbnail" : (raw.field ?? "thumbnail");
  if (!ALLOWED_ANIME_FIELDS.has(field)) return null;

  const url = decodeHex(raw.url).trim();
  if (!url || isCdnUrl(url)) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    const normalizedUrl = parsed.href;
    const hash = sourceHash(normalizedUrl);
    const ext = extFromUrl(normalizedUrl);
    const key = r2ImageKey({
      context: raw.context,
      id,
      field,
      sourceHash: hash,
      ext,
    });

    return {
      url: normalizedUrl,
      context: raw.context,
      id,
      field,
      sourceHash: hash,
      ext,
      key,
      cdnUrl: getR2PublicUrl(key),
    };
  } catch {
    return null;
  }
}

function processedCacheKey(asset: DecodedAsset) {
  return `${asset.context}:${asset.id}:${asset.field}:${asset.sourceHash}`;
}

function isRecentlyProcessed(asset: DecodedAsset) {
  const key = processedCacheKey(asset);
  const expiresAt = processedUntil.get(key);
  if (!expiresAt) return false;
  if (expiresAt > Date.now()) return true;
  processedUntil.delete(key);
  return false;
}

function markProcessed(asset: DecodedAsset) {
  processedUntil.set(processedCacheKey(asset), Date.now() + PROCESSED_TTL_MS);
}

function assetLogId(asset: DecodedAsset) {
  return `${asset.context}:${asset.id}:${asset.field}:${asset.sourceHash}`;
}

async function downloadImage(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
    },
  });

  if (!response.ok) return null;

  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (!contentType?.startsWith("image/")) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;

  return {
    buffer,
    contentType,
    actualExt: IMAGE_EXTENSIONS[contentType] ?? "jpg",
  };
}

async function prepareAsset(
  asset: DecodedAsset,
  logger: Logger,
): Promise<PreparedAsset | null> {
  if (await r2ObjectExists(asset.key)) {
    logger.info?.(
      `[sync-assets] r2 exists ${assetLogId(asset)} key=${asset.key}`,
    );
    return { ...asset, uploaded: false };
  }

  logger.info?.(
    `[sync-assets] download start ${assetLogId(asset)} url=${asset.url}`,
  );
  const image = await downloadImage(asset.url);
  if (!image) {
    logger.info?.(`[sync-assets] download skipped ${assetLogId(asset)}`);
    return null;
  }

  logger.info?.(
    `[sync-assets] download ok ${assetLogId(asset)} bytes=${image.buffer.length} contentType=${image.contentType}`,
  );
  logger.info?.(
    `[sync-assets] r2 upload start ${assetLogId(asset)} key=${asset.key}`,
  );

  await uploadBufferToR2({
    buffer: image.buffer,
    filename: `${asset.sourceHash}.${asset.ext}`,
    contentType: image.contentType,
    key: asset.key,
    metadata: {
      source_hash: asset.sourceHash,
      original_url: asset.url.slice(0, 1024),
      context: asset.context,
      entity_id: String(asset.id),
      field: asset.field,
      detected_ext: image.actualExt,
    },
  });

  logger.info?.(
    `[sync-assets] r2 upload ok ${assetLogId(asset)} url=${asset.cdnUrl}`,
  );

  return { ...asset, uploaded: true };
}

async function applyBatchUpdates(assets: PreparedAsset[], logger: Logger) {
  if (assets.length === 0) {
    logger.info?.("[sync-assets] db batch skipped assets=0");
    return;
  }

  const uploadedCount = assets.filter((asset) => asset.uploaded).length;
  const existingCount = assets.length - uploadedCount;
  logger.info?.(
    `[sync-assets] db batch update start assets=${assets.length} uploaded=${uploadedCount} existing=${existingCount}`,
  );

  const operations = assets.map((asset) => {
    if (asset.context === "anime") {
      return prisma.anime.updateMany({
        where: { id: asset.id, [asset.field]: asset.url },
        data: { [asset.field]: asset.cdnUrl },
      });
    }

    return prisma.episode.updateMany({
      where: {
        id: asset.id,
        OR: [{ thumbnail: asset.url }, { thumbnail: null }],
      },
      data: { thumbnail: asset.cdnUrl },
    });
  });

  const results = await prisma.$transaction(operations);
  const changedCount = results.reduce((sum, result) => sum + result.count, 0);

  for (const asset of assets) markProcessed(asset);

  if (changedCount > 0) {
    await CacheInvalidator.onBulkAnimeChange().catch((error) =>
      logger.warn?.(`[sync-assets] cache invalidate bulk failed: ${String(error)}`),
    );
  }

  logger.info?.(
    `[sync-assets] db batch update ok changed=${changedCount} assets=${assets.length} uploaded=${uploadedCount} existing=${existingCount}`,
  );
}

async function processAssets(assets: DecodedAsset[], logger: Logger) {
  const preparedAssets: PreparedAsset[] = [];

  for (const asset of assets) {
    try {
      const prepared = await prepareAsset(asset, logger);
      if (prepared) preparedAssets.push(prepared);
    } catch (error) {
      logger.error?.(
        `[sync-assets] failed ${asset.context}:${asset.id}:${asset.field} ${asset.url}`,
        error,
      );
    }
  }

  await applyBatchUpdates(preparedAssets, logger);
}

export function isAssetSyncProcessing() {
  return isProcessing;
}

export function enqueueAssetSync(rawAssets: SyncAssetInput[], logger: Logger) {
  const unique = new Map<string, DecodedAsset>();

  for (const raw of rawAssets.slice(0, MAX_ASSETS)) {
    try {
      const asset = parseAsset(raw);
      if (!asset || isRecentlyProcessed(asset)) continue;
      unique.set(`${asset.context}:${asset.id}:${asset.field}:${asset.url}`, asset);
    } catch {
      continue;
    }
  }

  const assets = Array.from(unique.values());
  if (assets.length === 0) return false;

  logger.info?.(`[sync-assets] queue accepted assets=${assets.length}`);
  isProcessing = true;
  setImmediate(() => {
    processAssets(assets, logger)
      .catch((error) => logger.error?.("[sync-assets] queue failed", error))
      .finally(() => {
        isProcessing = false;
        logger.info?.(`[sync-assets] queue finished (${assets.length} assets)`);
      });
  });

  return true;
}
