import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { spawn } from "node:child_process";
import { api } from "../convex/_generated/api.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
const client = new ConvexHttpClient(url);

const profileId = await client.mutation(api.profiles.create, {
  workerKey,
  name: `verify-p3-${Date.now()}`,
});
await client.mutation(api.profiles.transition, {
  workerKey,
  profileId,
  to: "warming",
  reason: "verify-phase3",
});
const taskId = await client.mutation(api.tasks.enqueue, {
  workerKey,
  profileId,
  type: "browse",
  payload: {
    url: process.env.START_URL ?? "https://example.com",
    instruction: "Summarize the page in one sentence.",
    maxSteps: 8,
  },
});
console.log(`enqueued browse task ${taskId} for profile ${profileId}`);

const worker = spawn("pnpm", ["worker"], { stdio: "inherit", shell: true });

try {
  const deadline = Date.now() + 5 * 60 * 1000;
  let status = "pending";
  while (Date.now() < deadline) {
    const task = await client.query(api.tasks.get, { taskId });
    status = task?.status ?? "missing";
    if (status === "done" || status === "failed") break;
    await sleep(5000);
  }
  if (status !== "done") throw new Error(`task ended as '${status}', expected 'done'`);

  const session = await client.query(api.tasks.sessionForTask, { taskId });
  if (!session) throw new Error("no session row for task");
  if (!session.egressIp) throw new Error("session has no egressIp");
  if (session.status !== "done") throw new Error(`session status ${session.status}`);
  console.log(`session OK — egressIp=${session.egressIp}`);

  const events = await client.query(api.events.forSession, { sessionId: session._id });
  const types = events.map((e) => e.type);
  for (const required of ["SessionStarted", "ActionStarted", "ActionSucceeded", "SessionEnded"]) {
    if (!types.includes(required)) throw new Error(`missing ${required} in chain: ${types.join(", ")}`);
  }
  console.log(`event chain OK — ${types.join(" → ")}`);

  const profile = await client.query(api.profiles.get, { profileId });
  if (profile?.activeSessionId) throw new Error("activeSessionId not cleared");

  console.log("phase 3 OK");
} finally {
  worker.kill();
  // pnpm wraps the actual node process on Windows; make sure nothing lingers
  if (process.platform === "win32" && worker.pid) {
    spawn("taskkill", ["/pid", String(worker.pid), "/T", "/F"], { stdio: "ignore", shell: true });
  }
}
