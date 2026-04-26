import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import crypto from "crypto";
import path from "path";

const DEFAULT_BUCKET = "anime-assets";

type R2Config = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
};

type R2UploadInput = {
  buffer: Buffer;
  filename: string;
  contentType: string;
  folder?: string;
  key?: string;
  metadata?: Record<string, string>;
};

let client: S3Client | null = null;
let cachedConfig: R2Config | null = null;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} environment variable`);
  return value;
}

function getR2Config() {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    endpoint: requiredEnv("R2_ENDPOINT"),
    accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    bucket: process.env.R2_BUCKET?.trim() || DEFAULT_BUCKET,
    publicUrl: requiredEnv("R2_PUBLIC_URL"),
  };

  return cachedConfig;
}

function getR2Client() {
  if (client) return client;

  const config = getR2Config();
  client = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });

  return client;
}

function sanitizeFilename(filename: string) {
  const baseName = path
    .basename(filename || "upload")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  return baseName || "upload";
}

function publicUrlForKey(publicUrl: string, key: string) {
  return `${publicUrl.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

export function getR2PublicUrl(key: string) {
  return publicUrlForKey(getR2Config().publicUrl, key);
}

export async function r2ObjectExists(key: string) {
  const config = getR2Config();

  try {
    await getR2Client().send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: key.replace(/^\/+/, ""),
      }),
    );
    return true;
  } catch (error) {
    const err = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    if (
      err.$metadata?.httpStatusCode === 404 ||
      err.name === "NotFound" ||
      err.name === "NoSuchKey"
    ) {
      return false;
    }
    throw error;
  }
}

export async function uploadBufferToR2(input: R2UploadInput) {
  const config = getR2Config();
  const safeFolder =
    (input.folder ?? "uploads").replace(/^\/+|\/+$/g, "") || "uploads";
  const filename = sanitizeFilename(input.filename);
  const key =
    input.key?.replace(/^\/+/, "") ||
    `${safeFolder}/${Date.now()}-${crypto.randomUUID()}-${filename}`;

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: input.buffer,
      ContentType: input.contentType,
      CacheControl: "public, max-age=31536000, immutable",
      Metadata: input.metadata,
    }),
  );

  return {
    key,
    url: publicUrlForKey(config.publicUrl, key),
    filename,
    contentType: input.contentType,
    size: input.buffer.length,
    bucket: config.bucket,
  };
}
