import type { Readable } from 'node:stream';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Tigris (S3-compatible) object storage for uploaded PDFs.
 *
 * Credentials + endpoint come from runtime env (Fly secrets per install), never
 * hardcoded:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  — Tigris key pair
 *   AWS_ENDPOINT_URL_S3  — https://fly.storage.tigris.dev
 *   AWS_REGION           — 'auto'
 *   BUCKET_NAME          — the install's bucket
 *
 * Provider-generic: the same code C&M's bid-indexer uses, with document-scoped
 * keys instead of bid-scoped ones. The S3 client picks up the key pair from the
 * standard AWS_* env vars via the default credential provider chain.
 */

let cachedClient: S3Client | null = null;

function client(): S3Client {
  if (cachedClient) return cachedClient;
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  if (!endpoint) throw new Error('document-parser storage: AWS_ENDPOINT_URL_S3 not set');
  cachedClient = new S3Client({
    endpoint,
    region: process.env.AWS_REGION ?? 'auto',
    forcePathStyle: true,
  });
  return cachedClient;
}

function bucket(): string {
  const name = process.env.BUCKET_NAME;
  if (!name) throw new Error('document-parser storage: BUCKET_NAME not set');
  return name;
}

/** Upload arbitrary bytes to `key` with an explicit content type. */
export async function putObject(
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  await client().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: bytes, ContentType: contentType }),
  );
}

/**
 * Stream `stream` to `key` without buffering the whole payload in memory.
 * `@aws-sdk/lib-storage`'s `Upload` consumes the Readable in bounded parts via
 * S3 multipart, so a large plan set never lives fully in RAM.
 */
export async function putStream(
  key: string,
  stream: Readable,
  contentType: string,
): Promise<void> {
  const upload = new Upload({
    client: client(),
    params: { Bucket: bucket(), Key: key, Body: stream, ContentType: contentType },
  });
  await upload.done();
}

/** Whether an object exists at `key`. */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (status === 404 || (err as { name?: string })?.name === 'NotFound') return false;
    throw err;
  }
}

/** Delete the object at `key`. */
export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/** Fetch the object at `key` and return its full bytes. */
export async function getObject(key: string): Promise<Uint8Array> {
  const out = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!out.Body) throw new Error(`document-parser storage: empty body for key ${key}`);
  return out.Body.transformToByteArray();
}

/** Presign a time-limited GET URL for `key`. */
export async function presignGet(key: string, ttlSeconds: number): Promise<string> {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: ttlSeconds,
  });
}
