import * as tar from "tar";
import { decompress } from "fzstd";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SNAPSHOT_MARKER_FILE } from "../shared/constants.js";
import type { BlobStore } from "./blobStore.js";

export type HydrateOutcome = "fresh" | "reused" | "downloaded";

function isZstd(data: Buffer): boolean {
  return data.length >= 4 && data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd;
}

function isGzip(data: Buffer): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

async function extractArchive(profileDir: string, data: Buffer): Promise<void> {
  const tmpBase = path.join(os.tmpdir(), `blessgtm-hydrate-${process.pid}-${Date.now()}`);
  try {
    if (isZstd(data)) {
      const tarData = Buffer.from(decompress(new Uint8Array(data)));
      const tmpTar = `${tmpBase}.tar`;
      fs.writeFileSync(tmpTar, tarData);
      await tar.extract({ cwd: profileDir, file: tmpTar });
      fs.rmSync(tmpTar, { force: true });
      return;
    }
    if (isGzip(data)) {
      const tmpTgz = `${tmpBase}.tgz`;
      fs.writeFileSync(tmpTgz, data);
      await tar.extract({ cwd: profileDir, file: tmpTgz, gzip: true });
      fs.rmSync(tmpTgz, { force: true });
      return;
    }
    throw new Error("snapshot archive has unknown format (expected zstd tar or legacy gzip tar)");
  } finally {
    fs.rmSync(`${tmpBase}.tar`, { force: true });
    fs.rmSync(`${tmpBase}.tgz`, { force: true });
  }
}

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

  await extractArchive(opts.profileDir, data);

  fs.writeFileSync(markerPath, opts.latest.contentHash);
  return "downloaded";
}
