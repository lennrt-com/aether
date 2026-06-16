// Agent smoke-test runner: launches a profile's hardened Chrome (same clean
// fingerprint, proxy, and WebRTC hardening as automated runs) and then turns a
// real Stagehand agent loose on the page. Default task: find the Fingerprint
// visitor ID, select it with the cursor, and return it — a live end-to-end
// check that act/observe/extract work under the stealth launch.
//
// The browser stays open after the agent finishes so you can inspect the
// highlighted value; close the window or press Ctrl-C to snapshot and exit.
//
// Spawned by `bless agent-test` with TZ set from the profile's launch config.
import "../shared/env.js";
import { ConvexHttpClient } from "convex/browser";
import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import type { Doc, Id } from "../../convex/_generated/dataModel.js";
import { createEmitter } from "./emit.js";
import { launchSession } from "./session.js";
import { resolveAgentModel } from "../shared/agentModels.js";
import { createConvexBlobStore } from "../profile-store/convexBlobStore.js";
import { hydrateProfile } from "../profile-store/hydrate.js";
import { snapshotProfile } from "../profile-store/snapshot.js";

const DEFAULT_START_URL = "https://anti-detect-scanner-production.up.railway.app/";
const DEFAULT_INSTRUCTION = [
  "This page reports a Fingerprint device-intelligence result that includes a 'visitor ID' (visitorId) — a hex string identifying the browser.",
  "Step 1: locate the visitor ID value on the page.",
  "Step 2: select/highlight the visitor ID text with the cursor (double-click the value, or click-and-drag across it so it appears highlighted).",
  "Step 3: return the exact visitor ID string you selected.",
].join(" ");
const DEFAULT_MAX_STEPS = 15;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    instruction: { type: "string" },
    "max-steps": { type: "string" },
    model: { type: "string" },
  },
});

const profileId = positionals[0] as Id<"profiles"> | undefined;
if (!profileId) throw new Error("agent-test: missing profileId argument");

const convexUrl = process.env.CONVEX_URL;
const workerKey = process.env.WORKER_KEY;
if (!convexUrl || !workerKey) throw new Error("agent-test: CONVEX_URL/WORKER_KEY not set");

const convex = new ConvexHttpClient(convexUrl);

const bundle = await convex.mutation(api.sessions.openManual, { workerKey, profileId });
const profile = bundle.profile as Doc<"profiles">;
const launchConfig = bundle.launchConfig as Doc<"launchConfigs"> | null;
const proxyBinding = bundle.proxyBinding as Doc<"proxyBindings"> | null;
const currentSnapshot = bundle.currentSnapshot as Doc<"profileSnapshots"> | null;
const sessionId = bundle.sessionId as Id<"sessions">;

const emit = createEmitter({
  convex,
  workerKey,
  profileId: profile._id,
  sessionId,
  channel: "browser",
  ctx: { launchConfigHash: launchConfig?.hash },
});

const profilesDir = process.env.PROFILES_DIR ?? "./.profiles";
const userDataDir = path.resolve(profilesDir, profile._id);
fs.mkdirSync(userDataDir, { recursive: true });

const blobStore = createConvexBlobStore(convex, workerKey);
const hydrateOutcome = await hydrateProfile({
  profileDir: userDataDir,
  blobStore,
  latest: currentSnapshot
    ? { storageId: currentSnapshot.storageId, contentHash: currentSnapshot.contentHash }
    : null,
});
await emit("FingerprintLoaded", {
  hydrate: hydrateOutcome,
  launchConfigHash: launchConfig?.hash ?? null,
  snapshotHash: currentSnapshot?.contentHash ?? null,
});

const session = await launchSession({
  userDataDir,
  headless: false, // watch it live
  model: resolveAgentModel(values.model),
  locale: launchConfig?.locale,
  viewport: launchConfig
    ? { width: launchConfig.windowWidth, height: launchConfig.windowHeight }
    : undefined,
  proxy: proxyBinding
    ? {
        server: proxyBinding.server,
        username: proxyBinding.username,
        password: proxyBinding.password,
      }
    : undefined,
  fingerprint:
    process.env.FINGERPRINT_SPOOF !== "false" && launchConfig?.fingerprintSeed
      ? {
          seed: launchConfig.fingerprintSeed,
          hardwareConcurrency: launchConfig.hardwareConcurrency ?? undefined,
          deviceMemory: launchConfig.deviceMemory ?? undefined,
          languages: localeToLanguages(launchConfig.locale),
        }
      : undefined,
  args: ["--password-store=basic"],
});

await convex.mutation(api.tasks.setSessionEgress, {
  workerKey,
  sessionId,
  egressIp: session.egressIp,
  launchConfigHash: launchConfig?.hash,
});

const startUrl =
  values.url ?? process.env.MANUAL_START_URL ?? process.env.FINGERPRINT_SCANNER_URL ?? DEFAULT_START_URL;
const instruction = values.instruction ?? DEFAULT_INSTRUCTION;
const maxSteps = values["max-steps"] ? Number(values["max-steps"]) : DEFAULT_MAX_STEPS;
const model = resolveAgentModel(values.model);

console.log("\n=== agent test live ===");
console.log(`profile:          ${profile.name} (${profile._id})`);
console.log(`model:            ${model}`);
console.log(`egress IP:        ${session.egressIp}`);
console.log(`proxy:            ${proxyBinding ? `${proxyBinding.server} (${proxyBinding.geo})` : "none (direct)"}`);
console.log(`fingerprint seed: ${launchConfig?.fingerprintSeed ?? "(none — re-provision to enable)"}`);
console.log(`start URL:        ${startUrl}`);
console.log(`max steps:        ${maxSteps}`);
console.log("\ninstruction:\n  " + instruction + "\n");

let visitorId: string | null = null;
try {
  const page = session.stagehand.context.activePage();
  if (!page) throw new Error("no active page after launch");
  // The scanner holds long-lived connections open, so Stagehand's lifecycle
  // watcher may never report the page "loaded" even though it is fully usable.
  // Navigation still works; we just don't block on the load state. Cap the wait
  // short and treat a timeout as normal — the fixed settle below gives
  // Fingerprint time to compute + render the visitorId (slower via proxy).
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeoutMs: 10000 }).catch(() => {});
  console.log("[agent] page open — settling 7s for Fingerprint to render the visitorId...");
  await new Promise((r) => setTimeout(r, 7000));

  console.log("[agent] running...\n");
  const agent = session.stagehand.agent({ mode: "hybrid" });
  const result = await agent.execute({
    instruction,
    maxSteps,
    output: z.object({
      visitorId: z
        .string()
        .describe("The exact Fingerprint visitor ID string shown on the page ('' if none was found)"),
    }),
  });

  const out = result.output as { visitorId?: string } | undefined;
  visitorId = out?.visitorId?.trim() || null;

  console.log("\n=== agent result ===");
  console.log(`success:    ${result.success}`);
  console.log(`steps:      ${result.actions.length}`);
  console.log(`message:    ${result.message}`);
  console.log(`visitorId:  ${visitorId ?? "(not returned)"}`);
  console.log("\nactions:");
  result.actions.forEach((a: Record<string, unknown>, i: number) => {
    const reasoning = typeof a.reasoning === "string" ? ` — ${a.reasoning.slice(0, 120)}` : "";
    console.log(`  ${i + 1}. ${a.type}${reasoning}`);
  });

  await emit(result.success ? "ActionSucceeded" : "ActionFailed", {
    taskType: "agent-test",
    visitorId,
    steps: result.actions.length,
    message: result.message,
  });
} catch (err) {
  console.error("\n[agent] failed:", err instanceof Error ? err.message : String(err));
  await emit("ActionFailed", { taskType: "agent-test", error: String(err) });
}

console.log(
  "\nThe browser is still open so you can inspect the highlighted value.\n" +
    "Close the window or press Ctrl-C here to snapshot the profile and exit.\n",
);

await waitForEnd(userDataDir);

console.log("\n[agent-test] closing browser and snapshotting profile...");
await session.close();

const snapshot = await snapshotProfile({
  profileDir: userDataDir,
  blobStore,
  convex,
  workerKey,
  profileId: profile._id,
  sessionId,
  chromeVersion: profile.chromeVersion,
});
await emit("SnapshotCommitted", {
  snapshotId: snapshot.snapshotId,
  contentHash: snapshot.contentHash,
  sizeBytes: snapshot.sizeBytes,
});

await convex.mutation(api.sessions.closeManual, { workerKey, sessionId, outcome: "manual" });
console.log(`session closed, snapshot committed (${snapshot.sizeBytes} bytes).`);
if (visitorId) console.log(`\nvisitorId = ${visitorId}`);
process.exit(0);

// Resolves when the user either closes the browser window (chrome.pid dies) or
// presses Ctrl-C in this terminal — whichever happens first.
function waitForEnd(dir: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      resolve();
    };
    process.once("SIGINT", () => {
      console.log("\n[agent-test] SIGINT received.");
      finish();
    });
    const pidFile = path.join(dir, "chrome.pid");
    const timer = setInterval(() => {
      let pid: number | null = null;
      try {
        pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      } catch {
        return; // pid file not written yet
      }
      if (!pid || Number.isNaN(pid)) return;
      try {
        process.kill(pid, 0); // existence check only
      } catch {
        console.log("\n[agent-test] browser window closed.");
        finish();
      }
    }, 1000);
  });
}

function localeToLanguages(locale: string): string[] {
  const base = locale.split("-")[0];
  return base && base !== locale ? [locale, base] : [locale];
}
