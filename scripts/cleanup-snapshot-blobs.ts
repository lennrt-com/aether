// One-time / manual: enforce latest-only snapshot retention (delete stale blobs + rows).
import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
const client = new ConvexHttpClient(url);

const result = (await client.mutation(api.snapshots.enforceLatestOnly, {
  workerKey,
})) as { deletedRows: number; bytesReclaimed: number };

console.log(
  `snapshot cleanup: removed ${result.deletedRows} stale rows, ` +
    `~${(result.bytesReclaimed / 1024 / 1024).toFixed(1)} MB reclaimed (per sizeBytes metadata)`,
);
