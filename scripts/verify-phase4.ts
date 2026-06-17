import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const url = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!url || !workerKey) throw new Error("CONVEX_URL/WORKER_KEY not set");
const client = new ConvexHttpClient(url);

const marker = `p4-${Date.now()}`;

const profileId = await client.mutation(api.profiles.create, {
  workerKey,
  name: `verify-p4-${Date.now()}`,
});
await client.mutation(api.profiles.transition, {
  workerKey,
  profileId,
  to: "warming",
  reason: "verify-phase4",
});

async function runBrowseTask(payload: Record<string, unknown>): Promise<Id<"tasks">> {
  const taskId = await client.mutation(api.tasks.enqueue, {
    workerKey,
    profileId,
    type: "browse",
    payload,
  });
  const deadline = Date.now() + 4 * 60 * 1000;
  for (;;) {
    const task = await client.query(api.tasks.get, { taskId });
    if (task?.status === "done") return taskId;
    if (task?.status === "failed") throw new Error(`task ${taskId} failed: ${task.lastError}`);
    if (Date.now() > deadline) throw new Error(`task ${taskId} timed out (status ${task?.status})`);
    await sleep(5000);
  }
}

let worker: ChildProcess | null = null;
try {
  worker = spawn("pnpm", ["worker"], { stdio: "inherit", shell: true });

  console.log("task 1: set cookie + localStorage");
  await runBrowseTask({
    url: "https://example.com",
    evaluate:
      `document.cookie = 'blessgtm=${marker}; max-age=31536000; path=/';` +
      `localStorage.setItem('blessgtm', '${marker}');` +
      `'set:' + document.cookie + '|' + localStorage.getItem('blessgtm')`,
  });

  const snap1 = await client.query(api.snapshots.latestFor, { profileId });
  if (!snap1) throw new Error("no snapshot committed after task 1");
  console.log(`snapshot 1 OK — ${snap1.contentHash.slice(0, 12)} (${snap1.sizeBytes} bytes)`);

  const profileDir = path.resolve(process.env.PROFILES_DIR ?? "./.profiles", profileId);
  fs.rmSync(profileDir, { recursive: true, force: true });
  if (fs.existsSync(profileDir)) throw new Error("failed to delete local profile dir");
  console.log(`deleted local profile dir ${profileDir}`);

  console.log("task 2: read back cookie + localStorage after rehydrate");
  const task2 = await runBrowseTask({
    url: "https://example.com",
    evaluate: `'read:' + document.cookie + '|' + localStorage.getItem('blessgtm')`,
  });

  const session2 = await client.query(api.tasks.sessionForTask, { taskId: task2 });
  if (!session2) throw new Error("no session for task 2");
  const events = await client.query(api.events.forSession, { sessionId: session2._id });

  const fingerprintLoaded = events.find((e) => e.type === "FingerprintLoaded");
  if (!fingerprintLoaded) throw new Error("missing FingerprintLoaded event");
  const hydrate = (fingerprintLoaded.data as { hydrate?: string }).hydrate;
  if (hydrate !== "downloaded") throw new Error(`expected hydrate=downloaded, got ${hydrate}`);

  const evalEvent = events.find(
    (e) => e.type === "ActionSucceeded" && e.actionId?.endsWith(":eval"),
  );
  if (!evalEvent) throw new Error("missing eval result event");
  const evalResult = String((evalEvent.data as { evalResult?: unknown }).evalResult);
  console.log(`eval result: ${evalResult}`);
  const cookieOk = evalResult.includes(`blessgtm=${marker}`);
  const localStorageOk = evalResult.split("|")[1]?.includes(marker);
  if (!cookieOk) throw new Error("cookie did not survive snapshot/hydrate");
  if (!localStorageOk) throw new Error("localStorage did not survive snapshot/hydrate");

  const snapshotCommitted = events.find((e) => e.type === "SnapshotCommitted");
  if (!snapshotCommitted) throw new Error("missing SnapshotCommitted event");

  // Latest-only retention: commit deletes the prior snapshot, so after two
  // sessions exactly one row (the newest) remains.
  const allSnaps = await client.query(api.snapshots.listFor, { profileId });
  if (allSnaps.length !== 1) throw new Error(`expected 1 snapshot row (latest-only), got ${allSnaps.length}`);

  console.log("phase 4 OK — cookie + localStorage survived a wiped local profile");
} finally {
  if (worker) {
    worker.kill();
    if (process.platform === "win32" && worker.pid) {
      spawn("taskkill", ["/pid", String(worker.pid), "/T", "/F"], { stdio: "ignore", shell: true });
    }
  }
}
