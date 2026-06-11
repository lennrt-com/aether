// Worker loop: register → poll claimNext every 15s → spawn runner subprocess
// per claim (crash isolation + per-profile TZ) → heartbeat → complete/fail.
import "../shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { spawn } from "node:child_process";
import { api } from "../../convex/_generated/api.js";
import type { FunctionReturnType } from "convex/server";

type ClaimBundle = NonNullable<FunctionReturnType<typeof api.tasks.claimNext>>;

const POLL_MS = 15_000;
const TASK_HEARTBEAT_MS = 2 * 60 * 1000;
const WORKER_HEARTBEAT_MS = 60_000;

const convexUrl = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!convexUrl || !workerKey) throw new Error("worker: CONVEX_URL/WORKER_KEY not set");
const key = workerKey;

const convex = new ConvexHttpClient(convexUrl);
const maxSessions = Number(process.env.MAX_SESSIONS ?? 2);
const workerName = process.env.WORKER_NAME ?? "local-1";

const workerId = await convex.mutation(api.workers.register, {
  workerKey: key,
  name: workerName,
  maxSessions,
});
console.log(`[worker] registered ${workerName} (${workerId}), maxSessions=${maxSessions}`);

setInterval(() => {
  convex
    .mutation(api.workers.heartbeat, { workerKey: key, workerId })
    .catch((err) => console.error("[worker] heartbeat failed:", err));
}, WORKER_HEARTBEAT_MS);

let activeSessions = 0;

function runTask(bundle: ClaimBundle): Promise<void> {
  return new Promise((resolve) => {
    const task = bundle.task;
    if (!task) {
      resolve();
      return;
    }
    const tz = bundle.launchConfig?.timezone ?? process.env.TZ ?? "UTC";
    console.log(`[worker] spawning runner for task ${task._id} (${task.type}), TZ=${tz}`);

    const child = spawn(
      "node",
      ["--import", "tsx", "src/runner/main.ts", JSON.stringify(bundle)],
      { env: { ...process.env, TZ: tz }, stdio: "inherit" },
    );

    const heartbeat = setInterval(() => {
      convex
        .mutation(api.tasks.heartbeatTask, { workerKey: key, taskId: task._id })
        .catch((err) => console.error("[worker] task heartbeat failed:", err));
    }, TASK_HEARTBEAT_MS);

    const finish = async (result: { code: number | null; error?: Error }) => {
      clearInterval(heartbeat);
      try {
        if (result.code === 0) {
          await convex.mutation(api.tasks.complete, {
            workerKey: key,
            taskId: task._id,
            outcome: "ok",
          });
          console.log(`[worker] task ${task._id} done`);
        } else {
          const error = result.error
            ? String(result.error)
            : `runner exited with code ${result.code}`;
          await convex.mutation(api.tasks.fail, { workerKey: key, taskId: task._id, error });
          console.log(`[worker] task ${task._id} failed: ${error}`);
        }
      } catch (err) {
        console.error(`[worker] failed to report task ${task._id} result:`, err);
      }
      resolve();
    };

    child.on("exit", (code) => void finish({ code }));
    child.on("error", (error) => void finish({ code: 1, error }));
  });
}

console.log(`[worker] polling every ${POLL_MS / 1000}s`);
for (;;) {
  if (activeSessions < maxSessions) {
    try {
      const bundle = await convex.mutation(api.tasks.claimNext, {
        workerKey: key,
        workerId,
      });
      if (bundle) {
        activeSessions += 1;
        void runTask(bundle).finally(() => {
          activeSessions -= 1;
        });
        continue; // immediately try to claim more if capacity remains
      }
    } catch (err) {
      console.error("[worker] claimNext failed:", err);
    }
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
