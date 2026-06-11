import * as tar from "tar";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SNAPSHOT_MARKER_FILE } from "../shared/constants.js";
import type { BlobStore } from "./blobStore.js";

export type HydrateOutcome = "fresh" | "reused" | "downloaded";

export async function hydrateProfile(opts: {
  profileDir: string;
  blobStore: BlobStore;
  latest: { storageId: string; contentHash: string } | null;
}): Promise<HydrateOutcome> {
  fs.mkdirSync(opts.profileDir, { recursive: true });
  if (!opts.latest) return "fresh";

  const markerPath = path.join(opts.profileDir, SNAPSHOT_MARKER_FILE);
  if (
    fs.existsSync(markerPath) &&
    fs.readFileSync(markerPath, "utf8").trim() === opts.latest.contentHash
  ) {
    return "reused";
  }

  fs.rmSync(opts.profileDir, { recursive: true, force: true });
  fs.mkdirSync(opts.profileDir, { recursive: true });

  const url = await opts.blobStore.getUrl(opts.latest.storageId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`snapshot download failed: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());

  const tmpFile = path.join(os.tmpdir(), `blessgtm-hydrate-${process.pid}-${Date.now()}.tgz`);
  try {
    fs.writeFileSync(tmpFile, data);
    await tar.extract({ cwd: opts.profileDir, file: tmpFile });
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }

  fs.writeFileSync(markerPath, opts.latest.contentHash);
  return "downloaded";
}
