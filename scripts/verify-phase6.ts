import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
const client = new ConvexHttpClient(url);

async function makeProfile(suffix: string): Promise<Id<"profiles">> {
  const profileId = await client.mutation(api.profiles.create, {
    workerKey,
    name: `verify-p6-${suffix}-${Date.now()}`,
  });
  await client.mutation(api.profiles.transition, {
    workerKey,
    profileId,
    to: "warming",
    reason: "verify-phase6",
  });
  return profileId;
}

async function appendSignal(
  profileId: Id<"profiles">,
  type: string,
  data: Record<string, unknown>,
  ts = Date.now(),
) {
  await client.mutation(api.events.append, {
    workerKey,
    profileId,
    type,
    ts,
    channel: "system",
    data,
    ctx: {},
  });
}

// --- A: 3 captchas now → score ≈ 45 → warning, not claimable ---
const profileA = await makeProfile("a");
for (let i = 0; i < 3; i++) {
  await appendSignal(profileA, "ChallengeDetected", { pageState: "captcha", n: i });
}
const scoreA = await client.query(api.health.riskScore, { profileId: profileA });
if (Math.abs(scoreA - 45) > 2) throw new Error(`expected riskScore ≈ 45, got ${scoreA}`);
let a = await client.query(api.profiles.get, { profileId: profileA });
if (a?.status !== "warning") throw new Error(`expected warning, got ${a?.status}`);
console.log(`A: 3 captchas → score ${scoreA.toFixed(1)}, status warning`);

await client.mutation(api.tasks.enqueue, {
  workerKey,
  profileId: profileA,
  type: "browse",
  payload: {},
});
const workerId = await client.mutation(api.workers.register, {
  workerKey,
  name: "verify-p6-worker",
});
const claim = await client.mutation(api.tasks.claimNext, { workerKey, workerId });
if (claim !== null) throw new Error("claimNext returned a task for a warning profile");
console.log("A: claimNext correctly returns null for warning profile");

// --- B: warning profile with only decayed-out signals → recovers to active ---
const profileB = await makeProfile("b");
await client.mutation(api.profiles.transition, {
  workerKey,
  profileId: profileB,
  to: "warning",
  reason: "verify-phase6 setup",
});
const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
await appendSignal(profileB, "ChallengeDetected", { pageState: "captcha" }, tenDaysAgo);
const scoreB = await client.query(api.health.riskScore, { profileId: profileB });
if (scoreB >= 20) throw new Error(`expected decayed score < 20, got ${scoreB}`);
const b = await client.query(api.profiles.get, { profileId: profileB });
if (b?.status !== "active") throw new Error(`expected recovery to active, got ${b?.status}`);
console.log(`B: decayed score ${scoreB.toFixed(2)} → recovered warning → active`);

// --- A: RestrictionDetected → restricted immediately ---
await appendSignal(profileA, "RestrictionDetected", { pageState: "restriction_notice" });
a = await client.query(api.profiles.get, { profileId: profileA });
if (a?.status !== "restricted") throw new Error(`expected restricted, got ${a?.status}`);
console.log("A: RestrictionDetected → status restricted");

// cleanup the pending task so later phases see a clean queue
const pending = await client.query(api.tasks.listByStatus, { status: "pending" });
for (const task of pending) {
  if (task.profileId === profileA) {
    await client.mutation(api.tasks.cancel, { workerKey, taskId: task._id });
  }
}

console.log("phase 6 OK");
