import * as tar from "tar";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import {
  SNAPSHOT_MARKER_FILE,
  SNAPSHOT_MUST_KEEP,
  SNAPSHOT_PRUNE_LIST,
} from "../shared/constants.js";
import type { BlobStore } from "./blobStore.js";

export interface SnapshotResult {
  snapshotId: Id<"profileSnapshots">;
  contentHash: string;
  sizeBytes: number;
  reused: boolean;
}

function existingKeepPaths(profileDir: string): string[] {
  return SNAPSHOT_MUST_KEEP.filter((rel) =>
    fs.existsSync(path.join(profileDir, ...rel.split("/"))),
  );
}

function pruneProfileDir(profileDir: string): void {
  for (const rel of SNAPSHOT_PRUNE_LIST) {
    fs.rmSync(path.join(profileDir, ...rel.split("/")), {
      recursive: true,
      force: true,
    });
  }
}

// Whitelist archive: tar ONLY the identity paths (architecture.md §5.4) + gzip.
// Pruning still runs so the local working copy stays small between sessions.
async function buildArchive(profileDir: string, keepPaths: string[]): Promise<Buffer> {
  const tmpFile = path.join(os.tmpdir(), `aether-snap-${process.pid}-${Date.now()}.tgz`);
  try {
    await tar.create(
      {
        gzip: true,
        cwd: profileDir,
        file: tmpFile,
        portable: true,
        filter: (p) => !p.includes(SNAPSHOT_MARKER_FILE),
      },
      keepPaths,
    );
    return fs.readFileSync(tmpFile);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
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
  pruneProfileDir(opts.profileDir);

  const keepPaths = existingKeepPaths(opts.profileDir);
  if (keepPaths.length === 0) {
    throw new Error(`snapshot: no identity paths found under ${opts.profileDir}`);
  }

  const data = await buildArchive(opts.profileDir, keepPaths);
  const contentHash = createHash("sha256").update(data).digest("hex");

  // Hash-dedup: if the archive is byte-identical to the current snapshot,
  // skip upload + commit and reuse the existing blob.
  const latest = await opts.convex.query(api.snapshots.latestFor, {
    profileId: opts.profileId,
  });
  if (latest && latest.contentHash === contentHash) {
    fs.writeFileSync(path.join(opts.profileDir, SNAPSHOT_MARKER_FILE), contentHash);
    return {
      snapshotId: latest._id,
      contentHash,
      sizeBytes: latest.sizeBytes,
      reused: true,
    };
  }

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
  return { snapshotId, contentHash, sizeBytes: data.length, reused: false };
}
