import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const DEFAULT_BUCKET = "video-storage";

type R2StreamingConfig = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
};

let client: S3Client | null = null;
let cachedConfig: R2StreamingConfig | null = null;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} environment variable`);
  return value;
}

function getStreamingConfig(): R2StreamingConfig {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    endpoint: requiredEnv("R2_ENDPOINT"),
    accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    bucket: process.env.R2_BUCKET_STREAMING?.trim() || DEFAULT_BUCKET,
    publicUrl: requiredEnv("R2_STREAMING_URL"),
  };

  return cachedConfig;
}

function getStreamingClient(): S3Client {
  if (client) return client;

  const config = getStreamingConfig();
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

function publicUrlForKey(publicUrl: string, key: string) {
  return `${publicUrl.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

export function getStreamingPublicUrl(key: string) {
  return publicUrlForKey(getStreamingConfig().publicUrl, key);
}

export async function uploadStreamingObject(input: {
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
}) {
  const config = getStreamingConfig();
  const key = input.key.replace(/^\/+/, "");

  await getStreamingClient().send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: input.body,
      ContentType: input.contentType,
      CacheControl: input.cacheControl ?? "public, max-age=31536000, immutable",
    }),
  );

  return {
    key,
    url: publicUrlForKey(config.publicUrl, key),
    size: input.body.length,
    bucket: config.bucket,
  };
}

export async function streamingObjectExists(key: string) {
  const config = getStreamingConfig();
  try {
    await getStreamingClient().send(
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

export async function deleteStreamingObject(key: string) {
  const config = getStreamingConfig();
  await getStreamingClient().send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: key.replace(/^\/+/, ""),
    }),
  );
}

export function getStreamingBucket(): string {
  return getStreamingConfig().bucket;
}
