import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { spawn, type ChildProcess } from "node:child_process";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { createUnipileClient } from "../src/channels/unipile.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const url = process.env.CONVEX_URL;
const siteUrl = process.env.CONVEX_SITE_URL;
const workerKey = process.env.WORKER_KEY;
const secret = process.env.UNIPILE_WEBHOOK_SECRET;
if (!url || !siteUrl || !workerKey || !secret) {
  throw new Error("CONVEX_URL/CONVEX_SITE_URL/WORKER_KEY/UNIPILE_WEBHOOK_SECRET must be set");
}
const client = new ConvexHttpClient(url);

// --- pick the connected Unipile account ---
const unipile = createUnipileClient();
const accounts = await unipile.listAccounts();
const account = (accounts.items ?? [])[0];
if (!account) throw new Error("no Unipile-connected account — connect one via hosted auth first");
console.log(`using unipile account ${account.id} (${account.provider ?? "?"})`);

// --- profile linked to that account ---
const profileId = await client.mutation(api.profiles.create, {
  workerKey,
  name: `verify-p8-${Date.now()}`,
});
await client.mutation(api.profiles.transition, {
  workerKey,
  profileId,
  to: "warming",
  reason: "verify-phase8",
});
await client.mutation(api.profiles.setUnipileAccount, {
  workerKey,
  profileId,
  unipileAccountId: account.id,
});

// --- fetch_profile via API channel, full event chain ---
const taskId = await client.mutation(api.tasks.enqueue, {
  workerKey,
  profileId,
  type: "fetch_profile",
  payload: { userId: "me" },
});

let worker: ChildProcess | null = null;
try {
  worker = spawn("pnpm", ["worker"], { stdio: "inherit", shell: true });

  const deadline = Date.now() + 3 * 60 * 1000;
  for (;;) {
    const task = await client.query(api.tasks.get, { taskId });
    if (task?.status === "done") break;
    if (task?.status === "failed") throw new Error(`task failed: ${task.lastError}`);
    if (Date.now() > deadline) throw new Error(`task timed out (${task?.status})`);
    await sleep(5000);
  }

  const session = await client.query(api.tasks.sessionForTask, { taskId });
  if (!session) throw new Error("no session for api task");
  if (session.channel !== "api") throw new Error(`expected channel api, got ${session.channel}`);
  if (session.egressIp) throw new Error("api session should have no egressIp");

  const events = await client.query(api.events.forSession, { sessionId: session._id });
  const types = events.map((e) => e.type);
  for (const required of ["SessionStarted", "ActionStarted", "ActionSucceeded", "SessionEnded"]) {
    if (!types.includes(required)) throw new Error(`missing ${required}: ${types.join(", ")}`);
  }
  const succeeded = events.find((e) => e.type === "ActionSucceeded");
  console.log(
    `fetch_profile OK via API — ${JSON.stringify(succeeded?.data).slice(0, 120)}`,
  );
  if (events.some((e) => e.channel !== "api")) throw new Error("non-api channel in chain");

  // --- webhook: secret enforcement + event row creation ---
  const badRes = await fetch(`${siteUrl}/unipile/webhook?secret=wrong`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "message.new", account_id: account.id }),
  });
  if (badRes.status !== 401) throw new Error(`expected 401 for bad secret, got ${badRes.status}`);
  console.log("webhook rejects bad secret (401)");

  const goodRes = await fetch(`${siteUrl}/unipile/webhook?secret=${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: "message.new",
      account_id: account.id,
      message: "synthetic verify-phase8 delivery",
    }),
  });
  if (!goodRes.ok) throw new Error(`webhook POST failed: ${goodRes.status}`);
  const webhookResult = (await goodRes.json()) as { stored: boolean; eventId?: Id<"events"> };
  if (!webhookResult.stored) throw new Error(`webhook did not store: ${JSON.stringify(webhookResult)}`);

  const profileEvents = await client.query(api.events.forProfile, { profileId });
  const msgEvent = profileEvents.find((e) => e.type === "MessageReceived");
  if (!msgEvent) throw new Error("no MessageReceived event row");
  if (msgEvent.channel !== "api") throw new Error("MessageReceived not on api channel");
  console.log(`webhook delivery stored as MessageReceived (${msgEvent._id})`);

  console.log("phase 8 OK — API channel + router + webhook all live");
} finally {
  if (worker) {
    worker.kill();
    if (process.platform === "win32" && worker.pid) {
      spawn("taskkill", ["/pid", String(worker.pid), "/T", "/F"], { stdio: "ignore", shell: true });
    }
  }
}
