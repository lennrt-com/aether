import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import { SNAPSHOT_BLOB_CONTENT_TYPE } from "../shared/constants.js";
import type { BlobStore } from "./blobStore.js";

export function createConvexBlobStore(
  convex: ConvexHttpClient,
  workerKey: string,
): BlobStore {
  return {
    async put(data) {
      const uploadUrl = await convex.mutation(api.snapshots.generateUploadUrl, {
        workerKey,
      });
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": SNAPSHOT_BLOB_CONTENT_TYPE },
        body: new Uint8Array(data),
      });
      if (!res.ok) throw new Error(`blob upload failed: HTTP ${res.status}`);
      const { storageId } = (await res.json()) as { storageId: string };
      return { ref: storageId };
    },
    async getUrl(ref) {
      const url = await convex.query(api.snapshots.getDownloadUrl, { storageId: ref });
      if (!url) throw new Error(`no download URL for blob ${ref}`);
      return url;
    },
    async del(ref) {
      await convex.mutation(api.snapshots.deleteBlob, { workerKey, storageId: ref });
    },
  };
}
