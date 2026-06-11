// Verify the LinkedIn account-creation engine end to end.
//
// WARNING: this hits REAL LinkedIn signup (against their ToS, highest ban-risk
// action) and creates a real smtp.dev mailbox — it never runs without --real.
//
//   pnpm tsx scripts/verify-signup.ts --real --profile <provisionedProfileId>
//
// The profile must be a fully provisioned bundle still in `provisioning`
// (create one with: pnpm cli provision ... --stay-provisioning).
import "../src/shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { spawn, type ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { api } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { values: args } = parseArgs({
  options: {
    real: { type: "boolean", default: false },
    profile: { type: "string" },
  },
});

if (!args.real) {
  throw new Error(
    "refusing to run: this performs a REAL LinkedIn signup. Re-run with --real to confirm.",
  );
}
if (!args.profile) throw new Error("required: --profile <profileId>");
for (const key of ["SMTP_DEV_API_KEY", "SMTP_DEV_DOMAIN", "CONVEX_URL", "WORKER_KEY"]) {
  if (!process.env[key]) throw new Error(`${key} not set`);
}

const client = new ConvexHttpClient(process.env.CONVEX_URL!);
const workerKey = process.env.WORKER_KEY!;
const profileId = args.profile as Id<"profiles">;

const profile = await client.query(api.profiles.get, { profileId });
if (!profile) throw new Error(`profile not found: ${profileId}`);
if (profile.status !== "provisioning") {
  throw new Error(`profile must be in provisioning, got ${profile.status}`);
}
if (!profile.personaId || !profile.proxyBindingId) {
  throw new Error("profile is missing persona or proxy binding — provision it first");
}

const taskId = await client.mutation(api.tasks.enqueue, {
  workerKey,
  profileId,
  type: "signup",
  payload: {},
});
console.log(`signup task enqueued: ${taskId}`);

let worker: ChildProcess | null = null;
try {
  worker = spawn("pnpm", ["worker"], { stdio: "inherit", shell: true });

  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    const task = await client.query(api.tasks.get, { taskId });
    if (task?.status === "done") break;
    if (task?.status === "failed") throw new Error(`signup task failed: ${task.lastError}`);
    if (Date.now() > deadline) throw new Error(`signup task timed out (status ${task?.status})`);
    await sleep(10_000);
  }
  console.log("signup task done — checking assertions");

  const creds = await client.query(api.credentials.getFor, { workerKey, profileId });
  if (!creds) throw new Error("no accountCredentials row for profile");
  console.log(`credentials OK — ${creds.email} (provider ${creds.emailProvider})`);

  const events: Doc<"events">[] = await client.query(api.events.forProfile, { profileId });
  const accountCreated = events.find((e) => e.type === "AccountCreated");
  if (!accountCreated) throw new Error("missing AccountCreated event");
  console.log(`AccountCreated OK — ${JSON.stringify(accountCreated.data).slice(0, 200)}`);

  const after = await client.query(api.profiles.get, { profileId });
  if (after?.status !== "warming") {
    throw new Error(`expected profile status warming, got ${after?.status}`);
  }
  console.log("profile transitioned provisioning -> warming OK");

  const snapshot = await client.query(api.snapshots.latestFor, { profileId });
  if (!snapshot) throw new Error("no snapshot committed after signup");
  console.log(`snapshot OK — ${snapshot.contentHash.slice(0, 12)} (${snapshot.sizeBytes} bytes)`);

  console.log("\nverify-signup OK — account created, credentials stored, session persisted");
} finally {
  if (worker) {
    worker.kill();
    if (process.platform === "win32" && worker.pid) {
      spawn("taskkill", ["/pid", String(worker.pid), "/T", "/F"], { stdio: "ignore", shell: true });
    }
  }
}
