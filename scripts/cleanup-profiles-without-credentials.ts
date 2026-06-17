// Remove Convex profiles (and attached rows) that have no accountCredentials row.
import "../src/shared/env.js";
import fs from "node:fs";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
const client = new ConvexHttpClient(url);

const result = (await client.mutation(api.maintenance.removeProfilesWithoutCredentials, {
  workerKey,
})) as {
  deletedProfileIds: string[];
  deletedCount: number;
  preservedCount: number;
};

const profilesDir = process.env.PROFILES_DIR ?? "./.profiles";
for (const id of result.deletedProfileIds) {
  const dir = path.resolve(profilesDir, id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`removed local profile dir: ${dir}`);
  } catch {
    console.log(`could not remove local dir: ${dir}`);
  }
}

console.log(
  `cleanup complete: ${result.deletedCount} profiles deleted, ${result.preservedCount} preserved (have credentials)`,
);
