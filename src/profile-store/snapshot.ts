import * as tar from "tar";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import { SNAPSHOT_MARKER_FILE, SNAPSHOT_PRUNE_LIST } from "../shared/constants.js";
import type { BlobStore } from "./blobStore.js";

export interface SnapshotResult {
  snapshotId: Id<"profileSnapshots">;
  contentHash: string;
  sizeBytes: number;
}

// Call ONLY after Stagehand is fully closed — Chrome's SQLite/LevelDB files
// are locked and inconsistent while it runs.
export async function snapshotProfile(opts: {
  profileDir: string;
  blobStore: BlobStore;
  convex: ConvexHttpClient;
  workerKey: string;
  profileId: Id<"profiles">;
  sessionId: Id<"sessions">;
  chromeVersion: string;
}): Promise<SnapshotResult> {
  for (const rel of SNAPSHOT_PRUNE_LIST) {
    fs.rmSync(path.join(opts.profileDir, ...rel.split("/")), {
      recursive: true,
      force: true,
    });
  }

  const tmpFile = path.join(os.tmpdir(), `blessgtm-snap-${process.pid}-${Date.now()}.tgz`);
  try {
    await tar.create(
      {
        gzip: true,
        cwd: opts.profileDir,
        file: tmpFile,
        portable: true,
        filter: (p) => !p.includes(SNAPSHOT_MARKER_FILE),
      },
      ["."],
    );
    const data = fs.readFileSync(tmpFile);
    const contentHash = createHash("sha256").update(data).digest("hex");

    const { ref } = await opts.blobStore.put(data);
    const snapshotId = await opts.convex.mutation(api.snapshots.commit, {
      workerKey: opts.workerKey,
      profileId: opts.profileId,
      sessionId: opts.sessionId,
      storageId: ref,
      contentHash,
      chromeVersion: opts.chromeVersion,
      sizeBytes: data.length,
    });

    fs.writeFileSync(path.join(opts.profileDir, SNAPSHOT_MARKER_FILE), contentHash);
    return { snapshotId, contentHash, sizeBytes: data.length };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}
