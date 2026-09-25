import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertKey, type ListingStorage, type StoredObject } from "./storage.ts";

/**
 * D6: Cloudflare R2 `mkt-private` over the S3 API. Private objects only; the browser gets
 * short-lived presigned URLs (CORS for GET/HEAD/PUT on app.<domain>, §13). The client is
 * injectable so tests never touch the network.
 */
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Tests pass a stub with `send`; presigning needs a real S3Client. */
  client?: Pick<S3Client, "send">;
}

export const MAX_PRESIGN_SECONDS = 7 * 24 * 3600;

export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export function r2Client(cfg: Pick<R2Config, "accountId" | "accessKeyId" | "secretAccessKey">): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2Endpoint(cfg.accountId),
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // Path-style keeps presigned URLs on one host, so the bucket CORS rule is the only one needed.
    forcePathStyle: true,
    // R2 doesn't support the SDK's default CRC32 checksums on every operation.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

function ttl(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_PRESIGN_SECONDS) throw new Error(`presign ttl must be 1–${MAX_PRESIGN_SECONDS} s`);
  return seconds;
}

export function r2Storage(cfg: R2Config): ListingStorage {
  const real = cfg.client ? undefined : r2Client(cfg);
  const client = cfg.client ?? real!;
  const Bucket = cfg.bucket;
  const signer = () => {
    if (!real && !(cfg.client instanceof S3Client)) throw new Error("presigning needs a real S3 client");
    return (real ?? cfg.client) as S3Client;
  };

  return {
    async put(key, body, opts) {
      assertKey(key);
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentLength: body.byteLength, ContentType: opts?.contentType }));
    },
    async get(key) {
      assertKey(key);
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!res.Body) throw new Error(`storage object has no body: ${key}`);
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        if (isNotFound(err)) throw new Error(`storage object not found: ${key}`);
        throw err;
      }
    },
    async delete(key) {
      assertKey(key);
      // S3/R2 DELETE is already idempotent: a missing key is a 204.
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async list(prefix) {
      const out: StoredObject[] = [];
      let ContinuationToken: string | undefined;
      do {
        const res = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }));
        for (const o of res.Contents ?? []) {
          if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) });
        }
        ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return out;
    },
    async head(key) {
      assertKey(key);
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: res.ContentLength ?? 0, lastModified: res.LastModified ?? new Date(0), contentType: res.ContentType };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async presignGet(key, ttlSeconds) {
      assertKey(key);
      return getSignedUrl(signer(), new GetObjectCommand({ Bucket, Key: key }), { expiresIn: ttl(ttlSeconds) });
    },
    async presignPut(key, ttlSeconds, contentType) {
      assertKey(key);
      return getSignedUrl(signer(), new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), { expiresIn: ttl(ttlSeconds) });
    },
  };
}
