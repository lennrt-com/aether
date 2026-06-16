// Dev utility: release stuck activeSessionId locks and enqueue one engage_post.
import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");

const client = new ConvexHttpClient(url);

const profiles = await client.query(api.profiles.list, {});
let released = 0;
for (const p of profiles) {
  if (!p.activeSessionId) continue;
  const res = await client.mutation(api.sessions.forceRelease, {
    workerKey,
    profileId: p._id,
  });
  if (res.released) {
    released += 1;
    console.log(`released stale session on ${p.name} (${p._id})`);
  }
}
console.log(`released ${released} profile(s)`);

const pending = await client.query(api.tasks.listByStatus, { status: "pending" });
console.log(`\npending tasks (${pending.length}):`);
for (const t of pending) {
  const prof = profiles.find((p) => p._id === t.profileId);
  console.log(
    `  ${t._id}  ${t.type.padEnd(14)}  ${prof?.name ?? t.profileId}  due ${new Date(t.dueAt).toISOString()}`,
  );
}

const warming = profiles.filter((p) => p.status === "warming");
const target = warming.find((p) => p.linkedInProfileUrl) ?? warming[0];
if (!target) throw new Error("no warming profile to run engage_post on");

const taskId = await client.mutation(api.tasks.enqueue, {
  workerKey,
  profileId: target._id as Id<"profiles">,
  type: "engage_post",
  payload: {},
  priority: 10,
});
console.log(`\nenqueued engage_post ${taskId} on ${target.name} (${target._id})`);
console.log("\nStart the worker:  bless worker");
