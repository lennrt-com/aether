// Verify the persona-driven warm-up behavior against real LinkedIn.
//
//   pnpm tsx scripts/verify-warmup.ts <profileId>
//
// The profile must already have a logged-in LinkedIn session (signed up via
// the signup engine, or logged in manually once) so its snapshot carries auth.
import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { spawn, type ChildProcess } from "node:child_process";
import { api } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profileId = process.argv[2] as Id<"profiles">;
if (!profileId) throw new Error("usage: verify-warmup.ts <profileId>");

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
const client = new ConvexHttpClient(url);

const profile = await client.query(api.profiles.get, { profileId });
if (!profile) throw new Error(`profile not found: ${profileId}`);

// No payload.instruction — the runner must fall back to the persona-driven
// warmup_feed behavior (LinkedIn feed, not example.com).
const taskId = await client.mutation(api.tasks.enqueue, {
  workerKey,
  profileId,
  type: "warmup_feed",
  payload: {},
});
console.log(`warmup_feed task enqueued: ${taskId}`);

let worker: ChildProcess | null = null;
try {
  worker = spawn("pnpm", ["worker"], { stdio: "inherit", shell: true });

  const deadline = Date.now() + 10 * 60 * 1000;
  let finalStatus = "";
  for (;;) {
    const task = await client.query(api.tasks.get, { taskId });
    if (task?.status === "done" || task?.status === "failed") {
      finalStatus = task.status;
      break;
    }
    if (Date.now() > deadline) throw new Error(`task timed out (status ${task?.status})`);
    await sleep(10_000);
  }

  const session = await client.query(api.tasks.sessionForTask, { taskId });
  if (!session) throw new Error("no session for task");
  const events: Doc<"events">[] = await client.query(api.events.forSession, {
    sessionId: session._id,
  });

  const actionStarted = events.find((e) => e.type === "ActionStarted");
  if (!actionStarted) throw new Error("missing ActionStarted event");
  const startData = actionStarted.data as { url?: string; instruction?: string | null };
  if (!startData.url?.includes("linkedin.com")) {
    throw new Error(`expected a linkedin.com URL, got ${startData.url}`);
  }
  if (!startData.instruction) {
    throw new Error("expected a persona-driven instruction, got none");
  }
  console.log(`behavior OK — url=${startData.url}`);
  console.log(`instruction: ${startData.instruction.slice(0, 140)}...`);

  const pageObserved = events.filter((e) => e.type === "PageObserved");
  if (pageObserved.length === 0) throw new Error("missing PageObserved event");
  const states = pageObserved.map((e) => (e.data as { pageState?: string }).pageState);
  console.log(`page states observed: ${states.join(", ")}`);

  if (states.includes("login")) {
    const anomaly = events.find((e) => e.type === "AnomalyObserved");
    const allTasks: Doc<"tasks">[] = await client.query(api.tasks.listFor, { profileId });
    const loginTasks = allTasks.filter((t) => t.type === "login");
    if (!anomaly) throw new Error("login wall hit but no AnomalyObserved event");
    if (loginTasks.length === 0) throw new Error("login wall hit but no login task enqueued");
    throw new Error(
      "session not authenticated (login wall) — AnomalyObserved + login task correctly produced, " +
        "but warm-up could not run. Log the profile in and re-run.",
    );
  }

  const sessionEnded = events.find((e) => e.type === "SessionEnded");
  if (!sessionEnded) throw new Error("missing SessionEnded event");
  if (finalStatus !== "done") throw new Error(`task ${finalStatus}: see events above`);

  console.log("\nverify-warmup OK — persona-driven LinkedIn warm-up ran and completed");
} finally {
  if (worker) {
    worker.kill();
    if (process.platform === "win32" && worker.pid) {
      spawn("taskkill", ["/pid", String(worker.pid), "/T", "/F"], { stdio: "ignore", shell: true });
    }
  }
}
