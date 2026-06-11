// Dev utility: cancel all pending tasks (stale verification leftovers).
import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
const client = new ConvexHttpClient(url);

const pending = await client.query(api.tasks.listByStatus, { status: "pending" });
for (const task of pending) {
  await client.mutation(api.tasks.cancel, { workerKey, taskId: task._id });
  console.log(`cancelled ${task._id} (${task.type})`);
}
console.log(`cancelled ${pending.length} pending tasks`);
