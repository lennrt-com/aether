import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { execSync } from "node:child_process";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!url) throw new Error("CONVEX_URL not set");
if (!workerKey) throw new Error("WORKER_KEY not set");

const client = new ConvexHttpClient(url);

execSync("pnpm dlx convex env set LEASE_MS 5000", { stdio: "inherit" });

try {
  const workerId = await client.mutation(api.workers.register, {
    workerKey,
    name: "verify-p2-worker",
  });

  const ts = Date.now();
  const profileIdA = await client.mutation(api.profiles.create, {
    workerKey,
    name: `verify-p2-a-${ts}`,
  });
  const profileIdB = await client.mutation(api.profiles.create, {
    workerKey,
    name: `verify-p2-b-${ts}`,
  });

  for (const profileId of [profileIdA, profileIdB] as const) {
    await client.mutation(api.profiles.transition, {
      workerKey,
      profileId,
      to: "warming",
      reason: "verify-phase2",
    });
  }

  const dueAt = Date.now();
  for (let i = 0; i < 3; i++) {
    await client.mutation(api.tasks.enqueue, {
      workerKey,
      profileId: profileIdA,
      type: "browse",
      payload: { n: i },
      dueAt,
    });
  }
  for (let i = 3; i < 5; i++) {
    await client.mutation(api.tasks.enqueue, {
      workerKey,
      profileId: profileIdB,
      type: "browse",
      payload: { n: i },
      dueAt,
    });
  }

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      client.mutation(api.tasks.claimNext, { workerKey, workerId }),
    ),
  );

  const claimed = results.filter((r): r is NonNullable<(typeof results)[number]> => r !== null);

  if (claimed.length !== 2) {
    throw new Error(`expected exactly 2 non-null claim results, got ${claimed.length}`);
  }

  const taskIds = claimed.map((r) => {
    if (!r.task) throw new Error("claimed bundle missing task");
    return r.task._id;
  });
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error("double-claim detected: duplicate task _id");
  }

  const claimedProfileIds = claimed.map((r) => {
    if (!r.task) throw new Error("claimed bundle missing task");
    return r.task.profileId;
  });
  if (new Set(claimedProfileIds).size !== claimedProfileIds.length) {
    throw new Error("more than one claimed task per profileId");
  }

  console.log("claims OK");

  const [taskIdA, taskIdB] = taskIds;
  const deadline = Date.now() + 150_000;
  let bothPending = false;

  while (Date.now() < deadline) {
    const [taskA, taskB] = await Promise.all([
      client.query(api.tasks.get, { taskId: taskIdA }),
      client.query(api.tasks.get, { taskId: taskIdB }),
    ]);
    console.log(
      `waiting for reclaim: task1=${taskA?.status ?? "missing"} task2=${taskB?.status ?? "missing"}`,
    );
    if (taskA?.status === "pending" && taskB?.status === "pending") {
      bothPending = true;
      break;
    }
    await sleep(5000);
  }

  if (!bothPending) {
    throw new Error("timeout waiting for lease reclaim (150s)");
  }

  const now = Date.now();
  for (const taskId of taskIds) {
    const task = await client.query(api.tasks.get, { taskId });
    if (!task) throw new Error(`task not found after reclaim: ${taskId}`);
    if (task.attempts !== 1) {
      throw new Error(`expected attempts === 1 after reclaim, got ${task.attempts}`);
    }
    if (task.dueAt <= now) {
      throw new Error(`expected dueAt > now after reclaim, got dueAt=${task.dueAt} now=${now}`);
    }
  }

  for (const profileId of [profileIdA, profileIdB] as const) {
    const profile = await client.query(api.profiles.get, { profileId });
    if (!profile) throw new Error(`profile not found: ${profileId}`);
    if (profile.activeSessionId !== undefined && profile.activeSessionId !== null) {
      throw new Error(
        `expected activeSessionId cleared on profile ${profileId}, got ${profile.activeSessionId}`,
      );
    }
  }

  console.log("phase 2 OK");
} finally {
  execSync("pnpm dlx convex env remove LEASE_MS", { stdio: "inherit" });
}
