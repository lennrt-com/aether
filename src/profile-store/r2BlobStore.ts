// Optional object-store backend for profile archives (swap via createBlobStore factory).
// Configure: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL (optional).
import type { BlobStore } from "./blobStore.js";

export interface R2BlobStoreConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Base URL for presigned GETs, e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
}

export function createR2BlobStore(_config: R2BlobStoreConfig): BlobStore {
  throw new Error(
    "R2 BlobStore is not wired yet — use createConvexBlobStore. " +
      "See src/profile-store/r2BlobStore.ts when migrating off Convex file storage.",
  );
}

export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2BlobStoreConfig | null {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET;
  const endpoint = env.R2_ENDPOINT;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !endpoint) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, endpoint };
}
